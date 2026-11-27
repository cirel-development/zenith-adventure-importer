import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import {
  validateBundle,
  CONTRACT_VERSION,
  type Bundle,
} from '@ai-adventure/contract';
import type { ExtractedAdventure } from '../pipeline/extractAdventure.js';
import type { CompendiumIndex } from '../compendium/index.js';
import { planActorMatches, type ActorMatchDecision } from '../compendium/match.js';
import { scanStatBlocks } from '../statblock/scan.js';
import { indexBlocks, linkStatBlock, toCustomStatBlock } from '../statblock/link.js';
import { scoreParsed, type ParsedStatBlock } from '../statblock/parse.js';
import { normalizeName } from '../compendium/index.js';

// ============================================================================
// Slug helpers
// ============================================================================

/** Convert "The Foul Cellar" → "the-foul-cellar". URL-safe, deterministic. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 80);
}

/** Tracks slug usage to disambiguate collisions with -2, -3, etc. */
class SlugBook {
  private readonly counts = new Map<string, number>();
  next(base: string): string {
    const slug = slugify(base) || 'unnamed';
    const seen = this.counts.get(slug) ?? 0;
    this.counts.set(slug, seen + 1);
    return seen === 0 ? slug : `${slug}-${seen + 1}`;
  }
}

// ============================================================================
// Bundle assembly
// ============================================================================

export interface AssembleOptions {
  /** Source PDF buffer — used to compute the manifest's source_pdf_hash. */
  pdfBytes: Uint8Array;
  /** Adventure slug. Defaults to slugified title. */
  adventureSlug?: string;
  /** Token usage from the extraction call, recorded in the manifest. */
  aiTokens?: { input: number; output: number };
  /**
   * PF2e compendium index. When given, NPCs/creatures/hazards that match
   * (see compendium/match.ts) become compendium-refs; the rest stay custom.
   */
  compendium?: CompendiumIndex;
  /**
   * The PDF's extracted text. When given, NPCs not matched in the compendium
   * get real stats parsed from their stat block (statblock/link.ts).
   */
  pdfText?: string;
  /**
   * AI-fallback results (statblock/ai-fallback.ts), keyed by normalized NPC
   * name: a regex parse merged with the model's answer for blocks the regex
   * could not read with confidence.
   */
  statBlockFixes?: Map<string, ParsedStatBlock>;
}

export function assembleBundle(
  extracted: ExtractedAdventure,
  opts: AssembleOptions,
): Bundle {
  const slugs = new SlugBook();

  const adventureSlug =
    opts.adventureSlug ?? (slugify(extracted.title) || 'untitled-adventure');

  // Folder paths. Foundry doesn't allow folder hierarchies across types — a
  // type=actor folder cannot be nested inside a type=journal folder. So we
  // produce four sibling top-level folders, one per entity type, all sharing
  // the adventure title as their display name. This is how official Paizo
  // adventure modules organize themselves in Foundry: one "Adventure Name"
  // folder in each of the Actors, Items, Journals, and Playlists sidebars.
  //
  // Inside each top-level folder we add per-chapter subfolders so the GM's
  // sidebar mirrors the adventure structure. Entities without a chapter_slug
  // assignment go into an "Overview" subfolder under each type.
  //
  // Folder identity in the contract: each folder has a flat slug (no
  // slashes) plus a parent_path that defines hierarchy. Entities reference
  // their folder via path (parent_path + slug joined by /).
  const actorsPath = `${adventureSlug}-actors`;
  const itemsPath = `${adventureSlug}-items`;
  const journalsPath = `${adventureSlug}-journals`;
  const playlistsPath = `${adventureSlug}-playlists`;

  type EntityType = 'actor' | 'item' | 'journal' | 'playlist';

  const topLevelOf = (type: EntityType): string =>
    ({ actor: actorsPath, item: itemsPath, journal: journalsPath, playlist: playlistsPath }[type]);

  /** Bare slug of a chapter subfolder, distinct per type for cross-type uniqueness. */
  const chapterSubSlug = (type: EntityType, chapterSlug: string): string =>
    `${chapterSlug}-${type}`;

  /** Bare slug of an Overview subfolder for a given entity type. */
  const overviewSubSlug = (type: EntityType): string => `overview-${type}`;

  // Chapter slugs come from the AI, so normalize them and drop duplicates.
  // Maps every raw slug the AI used for a chapter to the folder slug we emit.
  const chapterSlugMap = new Map<string, string>();
  /** Unique, normalized chapter slugs in chapter order (one folder each). */
  const chapterFolderSlugs: { slug: string; name: string }[] = [];
  for (const chapter of extracted.chapters) {
    const normalized = slugify(chapter.slug) || slugify(chapter.name);
    if (!normalized) continue;
    chapterSlugMap.set(chapter.slug, normalized);
    chapterSlugMap.set(normalized, normalized);
    if (!chapterFolderSlugs.some((c) => c.slug === normalized)) {
      chapterFolderSlugs.push({ slug: normalized, name: chapter.name });
    }
  }

  /**
   * Path used by entities to declare folder placement: parent + own slug.
   * An unknown chapter_slug (AI typo or hallucination) falls back to Overview
   * so the entity never points at a folder that does not exist.
   */
  const chapterFolderFor = (type: EntityType, chapterSlug: string | null | undefined): string => {
    const parent = topLevelOf(type);
    const known = chapterSlug ? chapterSlugMap.get(chapterSlug) ?? chapterSlugMap.get(slugify(chapterSlug)) : undefined;
    const own = known ? chapterSubSlug(type, known) : overviewSubSlug(type);
    return `${parent}/${own}`;
  };

  // ----- Folders -----
  const folders: Bundle['folders']['entities'] = [];

  // Four top-level adventure folders
  const topLevelTypes: EntityType[] = ['journal', 'actor', 'item', 'playlist'];
  for (const type of topLevelTypes) {
    folders.push({
      slug: topLevelOf(type),
      name: extracted.title,
      parent_path: null,
      type,
      sort: 0,
    });
  }

  // Per-chapter subfolders + an Overview subfolder under each type
  for (const type of topLevelTypes) {
    folders.push({
      slug: overviewSubSlug(type),
      name: 'Overview',
      parent_path: topLevelOf(type),
      type,
      sort: 0,
    });
  }
  chapterFolderSlugs.forEach((chapter, idx) => {
    for (const type of topLevelTypes) {
      folders.push({
        slug: chapterSubSlug(type, chapter.slug),
        name: chapter.name,
        parent_path: topLevelOf(type),
        type,
        sort: idx + 1, // Overview at 0 stays on top
      });
    }
  });

  // ----- Journals -----
  // Overview journal (synopsis + how-to-run) at the adventure root.
  const overviewSlug = slugs.next(`${adventureSlug}-overview`);
  const journals: Bundle['journals']['entities'] = [
    {
      slug: overviewSlug,
      name: `${extracted.title} — Overview`,
      type: 'instructional',
      folder: chapterFolderFor('journal', null), // overview subfolder
      default_permission: 'none',
      pages: [
        {
          page_type: 'text',
          slug: 'synopsis',
          name: 'Synopsis',
          permission: 'none',
          content_html: `<p>${escapeHtml(extracted.synopsis)}</p>`,
          sort: 0,
        },
        ...(extracted.party_level !== null ||
        extracted.party_size !== null ||
        extracted.tone ||
        extracted.encounters.length > 0
          ? [
              {
                page_type: 'text' as const,
                slug: 'running-this-adventure',
                name: 'Running This Adventure',
                permission: 'none' as const,
                content_html: buildRunningPage(extracted),
                sort: 10,
              },
            ]
          : []),
      ],
      sort: 0,
    },
  ];

  // One journal per chapter, with chapter summary as the first page and one
  // page per location. Note: PermissionLevelSchema is 'none' | 'limited' |
  // 'observer' | 'owner'. We use 'none' for GM-only content.
  extracted.chapters.forEach((chapter, idx) => {
    const journalSlug = slugs.next(`ch-${idx + 1}-${chapter.name}`);

    const pages: Bundle['journals']['entities'][number]['pages'] = [
      {
        page_type: 'text',
        slug: 'overview',
        name: `Chapter ${idx + 1}: ${chapter.name}`,
        permission: 'none',
        content_html: `<p>${escapeHtml(chapter.summary)}</p>`,
        sort: 0,
      },
    ];

    chapter.locations.forEach((location, locIdx) => {
      // Make page slug unique within this journal — slug book is global, but
      // page slugs only need to be unique within their journal. Easiest: use
      // the global book for guaranteed uniqueness.
      const pageSlug = slugs.next(location.area_code ?? location.name);
      const content: string[] = [];
      if (location.read_aloud) {
        content.push(
          `<blockquote class="read-aloud"><em>${escapeHtml(location.read_aloud)}</em></blockquote>`,
        );
      }
      content.push(`<p>${escapeHtml(location.description)}</p>`);

      pages.push({
        page_type: 'text',
        slug: pageSlug,
        name: location.area_code
          ? `${location.area_code}. ${location.name}`
          : location.name,
        permission: 'none',
        content_html: content.join('\n'),
        sort: 10 + locIdx,
      });
    });

    journals.push({
      slug: journalSlug,
      name: chapter.name,
      type: 'scene_entry',
      folder: chapterFolderFor('journal', chapter.slug),
      default_permission: 'none',
      pages,
      sort: idx,
    });
  });

  // ----- Actors -----
  // NPCs, creatures and hazards that match the PF2e compendium (Phase 2B,
  // see compendium/match.ts) become compendium-refs carrying the adventure's
  // own text as notes_html. Everything else is a custom actor with
  // placeholder stats pending stat-block parsing — the manifest warns the GM.
  const plan = opts.compendium ? planActorMatches(opts.compendium, extracted) : null;
  const blockIndex = opts.pdfText ? indexBlocks(scanStatBlocks(opts.pdfText)) : null;
  const versionPin = opts.compendium ? `pf2e@${opts.compendium.version}` : undefined;

  const compendiumActor = (
    base: { slug: string; name: string; category: Bundle['actors']['entities'][number]['category']; folder: string },
    decision: ActorMatchDecision,
    notesHtml: string,
  ): Bundle['actors']['entities'][number] => ({
    ...base,
    stat_block: {
      kind: 'compendium-ref',
      uuid: decision.match.uuid,
      ...(versionPin ? { version_pin: versionPin } : {}),
      notes_html: notesHtml,
      ...(decision.adjustment ? { overrides: { adjustment: decision.adjustment } } : {}),
    },
    ai_metadata: {
      confidence: decision.confidence,
      extracted_at: new Date().toISOString(),
      prompt_version: 'worker-phase-2b',
      review_required: decision.reviewReasons.length > 0,
      review_reasons: decision.reviewReasons,
    },
  });

  const npcActors = extracted.npcs.map((npc, i) => {
    const base = {
      slug: slugs.next(`${npc.category === 'creature' ? 'creature' : 'npc'}-${npc.name}`),
      name: npc.name,
      category: npc.category,
      folder: chapterFolderFor('actor', npc.chapter_slug),
    };
    const notesHtml = `<p><strong>Role:</strong> ${escapeHtml(npc.role)}</p><p>${escapeHtml(npc.description)}</p>`;
    const decision = plan?.npcs[i];
    if (decision) return compendiumActor(base, decision, notesHtml);

    // Parsed stat block from the PDF (Phase 2B task 4/7).
    const linked = blockIndex ? linkStatBlock(npc.name, blockIndex) : null;

    // A variant whose base is printed elsewhere ("Variant redcap (Pathfinder
    // Bestiary 278)"): compendium base + the variant's own numbers.
    if (linked && linked.scanned.form === 'variant' && !linked.base && linked.scanned.variantOf && opts.compendium) {
      const baseMatch = opts.compendium.findCreature(linked.scanned.variantOf.name);
      if (baseMatch) {
        const v = linked.parse.block;
        const overrides = {
          level: v.level,
          ...(v.rarity !== 'common' ? { rarity: v.rarity } : {}),
          ...(v.hp !== null ? { hp: v.hp } : {}),
          ...(v.ac !== null ? { ac: v.ac } : {}),
          ...(v.perception !== null ? { perception: v.perception } : {}),
          ...(v.saves ? { saves: v.saves } : {}),
          ...(v.attributes ? { attributes: v.attributes } : {}),
          ...(v.skills.length ? { skills: v.skills.map((s) => ({ name: s.name, bonus: s.bonus })) } : {}),
          ...(v.speeds ? { speed: v.speeds.land } : {}),
        };
        const decision: ActorMatchDecision = {
          match: baseMatch,
          confidence: 0.7,
          reviewReasons: [
            `Variant of ${baseMatch.name} (${baseMatch.packLabel}); the variant's printed numbers were applied. Check strikes and abilities against the PDF.`,
          ],
        };
        const actor = compendiumActor(base, decision, notesHtml);
        (actor.stat_block as { overrides?: typeof overrides }).overrides = overrides;
        return actor;
      }
    }

    if (linked) {
      const { scanned } = linked;
      const fix = opts.statBlockFixes?.get(normalizeName(npc.name));
      const parse = fix ? { block: fix, ...scoreParsed(fix) } : linked.parse;
      const reasons: string[] = [];
      if (fix) reasons.push(`Regex parse was low-confidence (${linked.parse.confidence}); missing fields were filled by the AI fallback. Check them against the PDF.`);
      if (parse.missing.length) reasons.push(`Stat block parse is missing: ${parse.missing.join(', ')} (placeholder values used).`);
      if (scanned.form === 'variant' && !linked.base && scanned.variantOf)
        reasons.push(`Variant of ${scanned.variantOf.name} (${scanned.variantOf.source}); fields the variant doesn't list are placeholders.`);
      if (parse.confidence < 0.7) reasons.push(`Low parse confidence (${parse.confidence}).`);
      return {
        ...base,
        stat_block: toCustomStatBlock(parse.block, notesHtml),
        ai_metadata: {
          confidence: parse.confidence,
          extracted_at: new Date().toISOString(),
          prompt_version: fix ? 'statblock-ai-1' : 'statblock-regex-1',
          review_required: reasons.length > 0,
          review_reasons: reasons,
        },
      } as Bundle['actors']['entities'][number];
    }
    return {
    ...base,
    stat_block: {
      kind: 'custom',
      level: npc.level ?? 0,
      size: npc.size,
      rarity: npc.rarity,
      alignment: npc.alignment,
      traits: npc.traits.length > 0 ? npc.traits : ['humanoid'],
      languages: npc.languages.length > 0 ? npc.languages : ['Common'],
      hp: Math.max(10, 10 + (npc.level ?? 0) * 5),
      ac: 10 + (npc.level ?? 0),
      saves: {
        fortitude: 0 + (npc.level ?? 0),
        reflex: 0 + (npc.level ?? 0),
        will: 0 + (npc.level ?? 0),
      },
      abilities: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
      perception: 0 + (npc.level ?? 0),
      senses: [],
      skills: [],
      speeds: { land: 25 },
      immunities: [],
      weaknesses: [],
      resistances: [],
      strikes: [],
      actions: [],
      spellcasting: [],
      inventory: [],
      tactics_html: notesHtml,
    } as Bundle['actors']['entities'][number]['stat_block'],
    ai_metadata: {
      confidence: 0.4,
      extracted_at: new Date().toISOString(),
      prompt_version: 'worker-phase-2a',
      review_required: true,
      review_reasons: [
        'Phase 1 placeholder stats — replace with real PF2e stat block before play.',
      ],
    },
  } as Bundle['actors']['entities'][number];
  });

  // Hazards are also actors in PF2e (category: 'hazard'). Stat numbers are
  // placeholder; the mechanics block goes into tactics_html so the GM can
  // read the real DCs and damage formulas pending Phase 2 parsing.
  const hazardActors = extracted.hazards.map((haz, i) => {
    const mechanicsHtml = haz.mechanics
      ? `<hr><h4>Mechanics</h4><pre style="white-space:pre-wrap">${escapeHtml(haz.mechanics)}</pre>`
      : '';
    const base = {
      slug: slugs.next(`hazard-${haz.name}`),
      name: haz.name,
      category: 'hazard' as const,
      folder: chapterFolderFor('actor', haz.chapter_slug),
    };
    const decision = plan?.hazards[i];
    // A compendium hazard has real structured stats, so the overlay only
    // needs the adventure's prose, not the verbatim mechanics block.
    if (decision) return compendiumActor(base, decision, `<p>${escapeHtml(haz.description)}</p>`);
    return {
      ...base,
      stat_block: {
        kind: 'custom',
        level: haz.level ?? 0,
        size: 'medium',
        rarity: 'common',
        alignment: 'no-alignment',
        // "hazard" is the stat-block header word, not a PF2e trait (PF2e drops it).
        traits: haz.traits.map((t) => t.trim().toLowerCase()).filter((t) => t && t !== 'hazard'),
        languages: [],
        hp: Math.max(10, 10 + (haz.level ?? 0) * 5),
        ac: 10 + (haz.level ?? 0),
        saves: {
          fortitude: haz.level ?? 0,
          reflex: haz.level ?? 0,
          will: haz.level ?? 0,
        },
        abilities: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
        perception: haz.level ?? 0,
        senses: [],
        skills: [],
        speeds: { land: 0 },
        immunities: ['critical-hits', 'precision'],
        weaknesses: [],
        resistances: [],
        strikes: [],
        actions: [],
        spellcasting: [],
        inventory: [],
        tactics_html: `<p>${escapeHtml(haz.description)}</p>${mechanicsHtml}`,
      } as Bundle['actors']['entities'][number]['stat_block'],
      ai_metadata: {
        confidence: 0.4,
        extracted_at: new Date().toISOString(),
        prompt_version: 'worker-phase-2a',
        review_required: true,
        review_reasons: [
          'Phase 1 placeholder stats — replace mechanics block contents with real hazard stat values before play.',
        ],
      },
    } as Bundle['actors']['entities'][number];
  });

  const actors: Bundle['actors']['entities'] = [...npcActors, ...hazardActors];
  const compendiumActorCount = actors.filter((a) => a.stat_block.kind === 'compendium-ref').length;
  const parsedActorCount = actors.filter((a) => a.ai_metadata?.prompt_version?.startsWith('statblock-')).length;
  const placeholderActorCount = actors.length - compendiumActorCount - parsedActorCount;

  // ----- Items -----
  const items: Bundle['items']['entities'] = extracted.items.map((item) => ({
    slug: slugs.next(`item-${item.name}`),
    name: item.name,
    // Phase 1 defaults to 'equipment' since the AI doesn't yet classify item
    // type. Phase 2 will map "kind" hints from the extraction into proper
    // categories (magic_item, consumable, etc).
    category: 'equipment',
    folder: chapterFolderFor('item', item.chapter_slug),
    data: {
      kind: 'custom',
      item_type: 'equipment',
      level: 0,
      rarity: 'common',
      traits: [],
      bulk: 'L',
      price_cp: 0,
      description_html: `<p>${escapeHtml(item.description)}</p>${
        item.kind ? `<p><em>Type: ${escapeHtml(item.kind)}</em></p>` : ''
      }`,
      effects: [],
      requires_investiture: false,
    } as Bundle['items']['entities'][number]['data'],
    ai_metadata: {
      confidence: 0.5,
      extracted_at: new Date().toISOString(),
      prompt_version: 'worker-phase-1',
      review_required: false,
      review_reasons: [],
    },
  }));

  // ----- Scenes -----
  // Phase 1 doesn't extract map images, and the contract requires every scene
  // to have a background asset. So we create zero scenes. The Foundry module's
  // SceneBuilder simply iterates an empty list. Phase 2 adds image extraction
  // and proper scene creation.
  const scenes: Bundle['scenes']['entities'] = [];

  // ----- Playlists -----
  // Two per chapter (ambience + combat) plus one adventure-wide. The
  // adventure-wide themes playlist goes in the Overview subfolder so the
  // GM has a clear "where do I drop cross-chapter music" slot.
  const playlists: Bundle['playlists']['entities'] = [
    {
      slug: slugs.next(`${adventureSlug}-themes`),
      name: `${extracted.title} — Themes`,
      folder: chapterFolderFor('playlist', null),
      mode: 'sequential',
    },
  ];
  extracted.chapters.forEach((chapter, idx) => {
    playlists.push({
      slug: slugs.next(`ch-${idx + 1}-ambience`),
      name: `Chapter ${idx + 1}: ${chapter.name} — Ambience`,
      folder: chapterFolderFor('playlist', chapter.slug),
      mode: 'sequential',
    });
    playlists.push({
      slug: slugs.next(`ch-${idx + 1}-combat`),
      name: `Chapter ${idx + 1}: ${chapter.name} — Combat`,
      folder: chapterFolderFor('playlist', chapter.slug),
      mode: 'shuffle',
    });
  });

  // ----- Manifest -----
  const sha = createHash('sha256').update(opts.pdfBytes).digest('hex');
  const bundleId = `bnd_${randomToken()}`;

  // Phase 1 doesn't know the level range or party size with certainty. The AI
  // extracted a single `party_level` value when present — we expand that into
  // a [n, n] range. When absent, default to [1, 1].
  const partyLevel = extracted.party_level ?? 1;

  const manifest: Bundle['manifest'] = {
    contract_version: CONTRACT_VERSION,
    bundle_id: bundleId,
    adventure: {
      title: extracted.title,
      slug: adventureSlug,
      system: 'pf2e',
      level_range: [partyLevel, partyLevel],
      party_size: extracted.party_size ?? 4,
      source_pdf_hash: `sha256:${sha}`,
      imported_at: new Date().toISOString(),
    },
    entities: {
      folders: 'entities/folders.json',
      journals: 'entities/journals.json',
      actors: 'entities/actors.json',
      items: 'entities/items.json',
      scenes: 'entities/scenes.json',
      playlists: 'entities/playlists.json',
    },
    build_order: ['folders', 'journals', 'items', 'actors', 'scenes', 'playlists'],
    stats: {
      scenes: scenes.length,
      journals: journals.length,
      playlists: playlists.length,
      actors: {
        compendium: compendiumActorCount,
        custom: actors.length - compendiumActorCount,
        review_needed: actors.filter((a) => a.ai_metadata?.review_required).length,
      },
      items: {
        compendium: 0,
        custom: items.length,
        review_needed: 0,
      },
      ai_tokens: opts.aiTokens
        ? {
            input: opts.aiTokens.input,
            output: opts.aiTokens.output,
            cached: 0,
          }
        : undefined,
    },
    warnings: [
      ...(placeholderActorCount > 0
        ? [
            {
              kind: 'partial_extraction' as const,
              message:
                placeholderActorCount < actors.length
                  ? `${compendiumActorCount} of ${actors.length} NPCs/creatures/hazards matched the PF2e compendium and ${parsedActorCount} use stats parsed from the PDF; the other ${placeholderActorCount} have placeholder stats. Replace them with real PF2e stat blocks before play.`
                  : 'Phase 1 extraction: NPC, creature, and hazard stats are placeholders. Replace with real PF2e stat blocks before play.',
            },
          ]
        : []),
      {
        kind: 'partial_extraction',
        message:
          'Phase 1 extraction: no scenes were created. Maps must be added manually after import.',
      },
    ],
  };

  return {
    manifest,
    folders: { entities: folders },
    journals: { entities: journals },
    actors: { entities: actors },
    items: { entities: items },
    scenes: { entities: scenes },
    playlists: { entities: playlists },
  };
}

// ============================================================================
// HTML helpers
// ============================================================================

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildRunningPage(extracted: ExtractedAdventure): string {
  const parts: string[] = [];
  if (extracted.party_level !== null) {
    parts.push(`<p><strong>Party Level:</strong> ${extracted.party_level}</p>`);
  }
  if (extracted.party_size !== null) {
    parts.push(`<p><strong>Party Size:</strong> ${extracted.party_size}</p>`);
  }
  if (extracted.tone) {
    parts.push(`<p><strong>Tone:</strong> ${escapeHtml(extracted.tone)}</p>`);
  }
  if (extracted.encounters.length > 0) {
    parts.push('<h3>Encounters</h3><ul>');
    for (const enc of extracted.encounters) {
      parts.push(
        `<li><strong>${escapeHtml(enc.name)}</strong>: ${escapeHtml(enc.summary)}</li>`,
      );
    }
    parts.push('</ul>');
  }
  return parts.join('\n');
}

function randomToken(): string {
  // 12 hex chars, lowercase, alphanumeric. Matches /^bnd_[a-z0-9]+$/.
  return Math.random().toString(36).substring(2, 14).replace(/[^a-z0-9]/g, '0');
}

// ============================================================================
// Validate and zip
// ============================================================================

export interface AssemblyResult {
  bundle: Bundle;
  zip: Uint8Array;
  warnings: string[];
}

export function validateAndZip(bundle: Bundle): AssemblyResult {
  const validation = validateBundle(bundle);
  if (!validation.valid) {
    const errors = validation.issues
      .filter((i) => i.severity === 'error')
      .map((i) => `  ${i.path}: ${i.message}`)
      .join('\n');
    throw new Error(`Assembled bundle failed contract validation:\n${errors}`);
  }

  const warnings = validation.issues
    .filter((i) => i.severity === 'warning')
    .map((i) => `${i.path}: ${i.message}`);

  // Layout matches what the Foundry module expects: manifest at root,
  // entity files under entities/.
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(bundle.manifest, null, 2)),
    'entities/folders.json': strToU8(JSON.stringify(bundle.folders, null, 2)),
    'entities/journals.json': strToU8(JSON.stringify(bundle.journals, null, 2)),
    'entities/actors.json': strToU8(JSON.stringify(bundle.actors, null, 2)),
    'entities/items.json': strToU8(JSON.stringify(bundle.items, null, 2)),
    'entities/scenes.json': strToU8(JSON.stringify(bundle.scenes, null, 2)),
    'entities/playlists.json': strToU8(JSON.stringify(bundle.playlists, null, 2)),
  });

  return { bundle, zip, warnings };
}
