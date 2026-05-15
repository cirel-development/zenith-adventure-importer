import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import {
  validateBundle,
  CONTRACT_VERSION,
  type Bundle,
} from '@ai-adventure/contract';
import type { ExtractedAdventure } from '../pipeline/extractAdventure.js';

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
  // Path slugs are suffixed by type to keep them unique within the bundle's
  // folder list. The display name is just the adventure title for all four.
  const actorsPath = `${adventureSlug}-actors`;
  const itemsPath = `${adventureSlug}-items`;
  const journalsPath = `${adventureSlug}-journals`;
  const playlistsPath = `${adventureSlug}-playlists`;

  // ----- Folders -----
  const folders: Bundle['folders']['entities'] = [
    {
      slug: journalsPath,
      name: extracted.title,
      parent_path: null,
      type: 'journal',
      sort: 0,
    },
    {
      slug: actorsPath,
      name: extracted.title,
      parent_path: null,
      type: 'actor',
      sort: 0,
    },
    {
      slug: itemsPath,
      name: extracted.title,
      parent_path: null,
      type: 'item',
      sort: 0,
    },
    {
      slug: playlistsPath,
      name: extracted.title,
      parent_path: null,
      type: 'playlist',
      sort: 0,
    },
  ];

  // ----- Journals -----
  // Overview journal (synopsis + how-to-run) at the adventure root.
  const overviewSlug = slugs.next(`${adventureSlug}-overview`);
  const journals: Bundle['journals']['entities'] = [
    {
      slug: overviewSlug,
      name: `${extracted.title} — Overview`,
      type: 'instructional',
      folder: journalsPath,
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
      folder: journalsPath,
      default_permission: 'none',
      pages,
      sort: idx,
    });
  });

  // ----- Actors -----
  // Every NPC, creature, AND hazard becomes a custom-kind actor. Stats are
  // placeholder pending Phase 2 stat-block parsing — the manifest warns the
  // GM about this. What 2A did change: traits, size, rarity, alignment,
  // category, languages all come from the AI extraction instead of being
  // hardcoded to "humanoid medium common N".
  const npcActors = extracted.npcs.map((npc) => ({
    slug: slugs.next(`${npc.category === 'creature' ? 'creature' : 'npc'}-${npc.name}`),
    name: npc.name,
    category: npc.category,
    folder: actorsPath,
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
      tactics_html: `<p><strong>Role:</strong> ${escapeHtml(npc.role)}</p><p>${escapeHtml(npc.description)}</p>`,
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
  }));

  // Hazards are also actors in PF2e (category: 'hazard'). Stat numbers are
  // placeholder; the mechanics block goes into tactics_html so the GM can
  // read the real DCs and damage formulas pending Phase 2 parsing.
  const hazardActors = extracted.hazards.map((haz) => {
    const mechanicsHtml = haz.mechanics
      ? `<hr><h4>Mechanics</h4><pre style="white-space:pre-wrap">${escapeHtml(haz.mechanics)}</pre>`
      : '';
    return {
      slug: slugs.next(`hazard-${haz.name}`),
      name: haz.name,
      category: 'hazard' as const,
      folder: actorsPath,
      stat_block: {
        kind: 'custom',
        level: haz.level ?? 0,
        size: 'medium',
        rarity: 'common',
        alignment: 'no-alignment',
        traits: ['hazard'],
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
    };
  });

  const actors: Bundle['actors']['entities'] = [...npcActors, ...hazardActors];

  // ----- Items -----
  const items: Bundle['items']['entities'] = extracted.items.map((item) => ({
    slug: slugs.next(`item-${item.name}`),
    name: item.name,
    // Phase 1 defaults to 'equipment' since the AI doesn't yet classify item
    // type. Phase 2 will map "kind" hints from the extraction into proper
    // categories (magic_item, consumable, etc).
    category: 'equipment',
    folder: itemsPath,
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
  // Two per chapter (ambience + combat) plus one adventure-wide.
  const playlists: Bundle['playlists']['entities'] = [
    {
      slug: slugs.next(`${adventureSlug}-themes`),
      name: `${extracted.title} — Themes`,
      folder: playlistsPath,
      mode: 'sequential',
    },
  ];
  extracted.chapters.forEach((chapter, idx) => {
    playlists.push({
      slug: slugs.next(`ch-${idx + 1}-ambience`),
      name: `Chapter ${idx + 1}: ${chapter.name} — Ambience`,
      folder: playlistsPath,
      mode: 'sequential',
    });
    playlists.push({
      slug: slugs.next(`ch-${idx + 1}-combat`),
      name: `Chapter ${idx + 1}: ${chapter.name} — Combat`,
      folder: playlistsPath,
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
        compendium: 0,
        custom: actors.length,
        review_needed: actors.length, // every Phase 1 NPC has placeholder stats
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
      {
        kind: 'partial_extraction',
        message:
          'Phase 1 extraction: NPC, creature, and hazard stats are placeholders. Replace with real PF2e stat blocks before play.',
      },
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
