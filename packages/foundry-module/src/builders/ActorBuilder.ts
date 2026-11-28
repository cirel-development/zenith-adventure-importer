import type {
  Bundle,
  ActorEntry,
  StatBlock,
} from '@ai-adventure/contract';
import type { FolderBuilder } from './FolderBuilder.js';
import type { AssetMap } from '../pipeline/AssetUploader.js';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import type { CompendiumLookup } from '../compendium/CompendiumLookup.js';
import { log } from '../log.js';
import { RuneApplicator } from '../compendium/RuneApplicator.js';
import {
  isLoreSkill,
  splitKnownDefenses,
  toPf2eAttackEffects,
  toPf2eDamageRolls,
  toPf2eHazardTraits,
  toPf2eLanguages,
  toPf2eSenses,
  toPf2eSize,
  toPf2eSkillSlug,
  toPf2eSpellLabel,
  toPf2eSpellPlacement,
  toPf2eStrikeTraits,
} from './pf2eMappings.js';

/** Language slugs PF2e knows at runtime; undefined outside Foundry. */
function pf2eLanguageSlugs(): string[] | undefined {
  const langs = (CONFIG as any)?.PF2E?.languages;
  return langs ? Object.keys(langs) : undefined;
}

/** Hazard trait slugs PF2e keeps at runtime; undefined outside Foundry. */
function pf2eHazardTraitSlugs(): string[] | undefined {
  const traits = (CONFIG as any)?.PF2E?.hazardTraits;
  return traits ? Object.keys(traits) : undefined;
}

declare const Actor: { create(data: unknown): Promise<ActorDoc> };

const TOKEN_DISPOSITION_MAP = {
  // Foundry CONST.TOKEN_DISPOSITIONS values
  hostile: -1,
  neutral: 0,
  friendly: 1,
  secret: -2,
} as const;

/**
 * Three creation paths, branching on stat_block.kind:
 *
 *   - "compendium-ref"     → look up UUID, copy source data, override portrait/folder
 *   - "custom"             → build a PF2e NPC schema from the structured fields
 *   - "loot-container"     → PF2e loot-type actor with currency + items
 *
 * Compendium misses fall through to a placeholder actor with the bundle's
 * `name` and a warning flag. We don't fail the whole import on a single miss.
 */
export class ActorBuilder {
  private readonly runes: RuneApplicator;

  constructor(
    private readonly folders: FolderBuilder,
    private readonly compendium: CompendiumLookup,
  ) {
    this.runes = new RuneApplicator(compendium);
  }

  async build(
    bundle: Bundle,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const actors = bundle.actors.entities;
    if (actors.length === 0) {
      log.debug('no actors to build');
      return;
    }
    log.info(`building ${actors.length} actors`);

    for (const entry of actors) {
      await this.createOne(entry, registry, assetMap);
    }
  }

  // ============================================================================

  private async createOne(
    entry: ActorEntry,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const folderId = this.folders.pathToId.get(entry.folder);
    if (!folderId) {
      throw new Error(
        `ActorBuilder: folder "${entry.folder}" not found for actor "${entry.slug}"`,
      );
    }

    const data = await this.buildActorData(entry, assetMap);
    if (!data) {
      log.warn(`actor "${entry.slug}" could not be built, skipping`);
      return;
    }

    // Apply common fields (folder, name override, portrait, flags)
    data['folder'] = folderId;
    data['name'] = entry.name;
    // Merge, don't replace: buildFromCompendium may already have set
    // driftWarning / placeholder flags under our namespace.
    const existingFlags = (data['flags'] as Record<string, any> | undefined) ?? {};
    data['flags'] = {
      ...existingFlags,
      'zenith-adventure-importer': {
        ...(existingFlags['zenith-adventure-importer'] ?? {}),
        slug: entry.slug,
        category: entry.category,
        ...(entry.ai_metadata?.review_required
          ? {
              reviewRequired: true,
              reviewReasons: entry.ai_metadata.review_reasons,
              confidence: entry.ai_metadata.confidence,
            }
          : {}),
      },
    };

    if (entry.portrait) {
      const portraitPath = assetMap.get(entry.portrait);
      if (portraitPath) data['img'] = portraitPath;
    }

    // Token configuration is on prototypeToken in v13
    const tokenSrc = entry.token_image
      ? assetMap.get(entry.token_image)
      : entry.portrait
        ? assetMap.get(entry.portrait)
        : undefined;
    const tokenConfig = entry.token_config ?? {
      disposition: 'hostile' as const,
      scale: 1,
      unlinked: true,
    };

    data['prototypeToken'] = {
      ...(data['prototypeToken'] as Record<string, unknown> ?? {}),
      name: entry.name,
      disposition: TOKEN_DISPOSITION_MAP[tokenConfig.disposition],
      width: tokenConfig.scale,
      height: tokenConfig.scale,
      actorLink: !tokenConfig.unlinked,
      ...(tokenSrc ? { texture: { src: tokenSrc } } : {}),
    };

    const created = await this.tryCreateActor(data, entry.slug);
    if (!created) {
      log.warn(`actor "${entry.slug}" could not be created, skipping`);
      return;
    }
    registry.record({
      slug: entry.slug,
      type: 'actor',
      foundryId: created.id,
      collection: 'Actor',
    });
    log.debug('actor created', entry.slug, '→', created.id);
  }

  /**
   * Try to create the actor. If PF2e rejects it (usually because of a trait
   * or schema mismatch in the embedded items), retry once without the items —
   * the actor still gets created with all its core stats; the GM just has to
   * add the strikes/abilities by hand. Better than no actor at all.
   */
  private async tryCreateActor(
    data: Record<string, unknown>,
    slug: string,
  ): Promise<ActorDoc | null> {
    try {
      return await Actor.create(data);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      log.warn(
        `actor "${slug}" rejected by validation, retrying without embedded items:`,
        msg,
      );
    }

    // Spells and gear are copied from the compendium; drop them before giving
    // up on the strikes, abilities and lore built from the stat block.
    const items = Array.isArray(data['items']) ? (data['items'] as { type?: string }[]) : [];
    const ownItems = items.filter((i) => i.type === 'melee' || i.type === 'action' || i.type === 'lore');
    if (ownItems.length > 0 && ownItems.length < items.length) {
      try {
        const created = await Actor.create({ ...data, items: ownItems });
        log.warn(`actor "${slug}" created without spells/gear — GM must add them manually`);
        return created;
      } catch (err) {
        log.warn(`actor "${slug}" still rejected without spells/gear:`, (err as Error)?.message ?? String(err));
      }
    }

    // Retry path — strip the items array. Most validation errors come from
    // trait/schema mismatches on the embedded melee/action items.
    try {
      const stripped = { ...data, items: [] };
      const created = await Actor.create(stripped);
      log.warn(
        `actor "${slug}" created without strikes/abilities — GM must add them manually`,
      );
      return created;
    } catch (err) {
      log.error(`actor "${slug}" failed even without items:`, err);
      return null;
    }
  }

  /**
   * Dispatches on stat_block.kind. Returns null if the actor truly can't
   * be built (e.g. compendium-ref to a missing pack with no fallback data).
   */
  private async buildActorData(
    entry: ActorEntry,
    assetMap: AssetMap,
  ): Promise<Record<string, unknown> | null> {
    switch (entry.stat_block.kind) {
      case 'compendium-ref':
        return this.buildFromCompendium(entry, entry.stat_block);
      case 'custom':
        return this.buildCustom(entry, entry.stat_block, assetMap);
      case 'loot-container':
        return this.buildLootContainer(entry, entry.stat_block);
    }
  }

  // ----------------------------------------------------------------------------
  // Compendium-ref path
  // ----------------------------------------------------------------------------

  private async buildFromCompendium(
    entry: ActorEntry,
    statBlock: Extract<StatBlock, { kind: 'compendium-ref' }>,
  ): Promise<Record<string, unknown> | null> {
    // Pass the entry's name as fallback for when the UUID drifts across versions
    const result = await this.compendium.resolveSource(statBlock.uuid, entry.name);
    if (!result) {
      // Compendium miss — create a placeholder so the GM at least sees
      // the entity is supposed to exist, with a clear flag.
      log.warn(
        `actor "${entry.slug}": compendium UUID ${statBlock.uuid} not found, creating placeholder`,
      );
      return {
        type: this.placeholderType(entry.category),
        flags: {
          'zenith-adventure-importer': {
            unresolvedCompendium: statBlock.uuid,
            placeholder: true,
          },
        },
      };
    }

    const source = result.source;
    // Note: _id/folder/sort were already stripped by CompendiumLookup.toSource

    if (statBlock.name_override) {
      source['name'] = statBlock.name_override;
    }

    // Variant numbers on top of the compendium base.
    if (statBlock.overrides) this.applyOverrides(source, statBlock.overrides);

    // Adventure-specific text goes after the compendium's own text. NPCs keep
    // notes in details.publicNotes; PF2e hazards have no publicNotes, so for
    // them it goes in details.description (see buildPF2eHazardSystem).
    if (statBlock.notes_html) {
      const system = (source['system'] ??= {}) as Record<string, any>;
      const details = (system['details'] ??= {}) as Record<string, unknown>;
      const field = source['type'] === 'hazard' ? 'description' : 'publicNotes';
      const existing = typeof details[field] === 'string' ? (details[field] as string) : '';
      details[field] = `${existing}${existing ? '<hr>' : ''}<h3>In this adventure</h3>${statBlock.notes_html}`;
    }

    // If we matched by name fallback, flag the actor so the GM knows
    // to check that the matched entity is what they expected.
    if (result.driftWarning) {
      source['flags'] = {
        ...((source['flags'] as Record<string, unknown>) ?? {}),
        'zenith-adventure-importer': {
          ...((source['flags'] as any)?.['zenith-adventure-importer'] ?? {}),
          driftWarning: true,
          originalUuid: statBlock.uuid,
          resolvedUuid: result.resolvedUuid,
        },
      };
    }
    return source;
  }

  /** Write a variant's numbers into a compendium NPC's source data (PF2e 8.x paths). */
  private applyOverrides(
    source: Record<string, unknown>,
    o: NonNullable<Extract<StatBlock, { kind: 'compendium-ref' }>['overrides']>,
  ): void {
    const set = (path: string, value: unknown) => {
      const keys = path.split('.');
      let o = source as Record<string, any>;
      for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, any>;
      o[keys[keys.length - 1]!] = value;
    };
    if (o.level !== undefined) set('system.details.level.value', o.level);
    if (o.rarity) set('system.traits.rarity', o.rarity);
    if (o.hp !== undefined) {
      set('system.attributes.hp.max', o.hp);
      set('system.attributes.hp.value', o.hp);
    }
    if (o.ac !== undefined) set('system.attributes.ac.value', o.ac);
    if (o.perception !== undefined) set('system.perception.mod', o.perception);
    if (o.saves) for (const k of ['fortitude', 'reflex', 'will'] as const) set(`system.saves.${k}.value`, o.saves[k]);
    if (o.attributes) for (const [k, v] of Object.entries(o.attributes)) set(`system.abilities.${k}.mod`, v);
    if (o.skills) for (const s of o.skills.filter((x) => !isLoreSkill(x.name))) set(`system.skills.${toPf2eSkillSlug(s.name)}.base`, s.bonus);
    if (o.speed !== undefined) set('system.attributes.speed.value', o.speed);
    // PF2e applies Elite/Weak itself (level, AC, HP, saves, strikes).
    if (o.adjustment) set('system.attributes.adjustment', o.adjustment);
  }

  // ----------------------------------------------------------------------------
  // Custom NPC/creature path — full PF2e schema
  // ----------------------------------------------------------------------------

  private async buildCustom(
    entry: ActorEntry,
    statBlock: Extract<StatBlock, { kind: 'custom' }>,
    assetMap: AssetMap,
  ): Promise<Record<string, unknown>> {
    // Hazards have an entirely different PF2e schema than NPCs. We could keep
    // forcing them through the NPC schema, but the Foundry UI then renders
    // them as Creature 2 sheets which loses the trap/disable/reset semantics
    // entirely. Better: branch on category at the top and build the right
    // shape for each.
    if (entry.category === 'hazard') {
      return {
        type: 'hazard',
        system: this.buildPF2eHazardSystem(statBlock),
        items: [], // hazards don't have embedded strikes/actions the same way
      };
    }

    // Future: handle category === 'loot' here. For now NPC, creature, and
    // any other category all share the NPC sheet — that matches what Paizo
    // does (creatures and NPCs are both `type: 'npc'` in their data files).
    const system = this.buildPF2eNpcSystem(statBlock);
    const items = this.buildPF2eEmbeddedItems(statBlock, assetMap);
    items.push(...(await this.buildSpellcastingItems(statBlock)));
    items.push(...(await this.buildInventoryItems(statBlock)));
    const focus = statBlock.spellcasting.reduce((n, e) => n + (e.focus_points ?? 0), 0);
    if (focus > 0) system['resources'] = { focus: { max: Math.min(3, focus), value: Math.min(3, focus) } };

    return {
      type: this.npcOrCharacterType(entry.category),
      system,
      items,
    };
  }

  /**
   * Map our category to a PF2e actor `type`. NPCs and creatures both use the
   * 'npc' type — that's the PF2e convention. Hazards branch off elsewhere
   * (see buildCustom). Loot will branch off when we add it. Character type
   * is reserved for the four-pregens case if we ever want them as proper PCs;
   * for Phase 2A pregens come through as 'npc' which is the safer default.
   */
  private npcOrCharacterType(_category: ActorEntry['category']): string {
    return 'npc';
  }

  /**
   * The system.* portion of a PF2e NPC actor.
   *
   * Schema notes (verified against PF2e Remaster, system version 7.x):
   *   - rarity lives at system.traits.rarity, NOT system.details.rarity
   *   - alignment is system.details.alignment.value, optional
   *   - publicNotes (the GM-facing Notes tab) is system.details.publicNotes
   *     as raw HTML
   *   - traits.value is the array of trait keywords (lowercase)
   *   - traits.size.value is a PF2e slug (tiny/sm/med/lg/huge/grg), and
   *     details.languages.value holds Remaster language slugs (PF2e 8.7.1)
   */
  private buildPF2eNpcSystem(
    sb: Extract<StatBlock, { kind: 'custom' }>,
  ): Record<string, unknown> {
    const P = (CONFIG as any)?.PF2E ?? {};
    const keys = (o: unknown) => (o ? Object.keys(o as object) : undefined);
    const senses = toPf2eSenses(sb.senses, keys(P.senses));
    const imm = splitKnownDefenses(sb.immunities.map((type) => ({ type })), keys(P.immunityTypes));
    const weak = splitKnownDefenses(sb.weaknesses, keys(P.weaknessTypes));
    const res = splitKnownDefenses(sb.resistances, keys(P.resistanceTypes));
    const skillNotes = sb.skills.filter((s) => s.note && !isLoreSkill(s.name)).map((s) => `${s.name} +${s.bonus} (${s.note})`);
    // Anything PF2e can't hold in a structured field is kept as text in the notes.
    const leftovers = [
      imm.unknownText && `Immunities: ${imm.unknownText}`,
      weak.unknownText && `Weaknesses: ${weak.unknownText}`,
      res.unknownText && `Resistances: ${res.unknownText}`,
      skillNotes.length > 0 && `Skills: ${skillNotes.join(', ')}`,
    ].filter(Boolean);
    const notes = (sb.tactics_html ?? '') + (leftovers.length ? `<p>${leftovers.join('<br>')}</p>` : '');

    return {
      details: {
        level: { value: sb.level },
        alliance: 'opposition',
        creatureType: '',
        languages: toPf2eLanguages(sb.languages, pf2eLanguageSlugs()),
        publicNotes: notes,
        privateNotes: '',
        ...(sb.alignment && sb.alignment !== 'no-alignment'
          ? { alignment: { value: sb.alignment } }
          : {}),
      },
      traits: {
        size: { value: toPf2eSize(sb.size) },
        value: sb.traits,
        rarity: sb.rarity,
      },
      abilities: {
        str: { mod: sb.abilities.str },
        dex: { mod: sb.abilities.dex },
        con: { mod: sb.abilities.con },
        int: { mod: sb.abilities.int },
        wis: { mod: sb.abilities.wis },
        cha: { mod: sb.abilities.cha },
      },
      attributes: {
        hp: { value: sb.hp, max: sb.hp },
        ac: { value: sb.ac },
        speed: {
          value: sb.speeds.land,
          otherSpeeds: this.buildOtherSpeeds(sb.speeds),
        },
        immunities: imm.kept,
        weaknesses: weak.kept.map((w) => ({ type: w.type, value: w.value })),
        resistances: res.kept.map((r) => ({ type: r.type, value: r.value })),
      },
      saves: {
        fortitude: { value: sb.saves.fortitude },
        reflex: { value: sb.saves.reflex },
        will: { value: sb.saves.will },
      },
      // Skills are a record on PF2e NPCs keyed by skill slug; lore skills are
      // separate "lore" items (see buildPF2eEmbeddedItems).
      skills: Object.fromEntries(
        sb.skills
          .filter((s) => !isLoreSkill(s.name))
          .map((s) => [toPf2eSkillSlug(s.name), { base: s.bonus }]),
      ),
      // PF2e 8.x keeps Perception here (not attributes.perception).
      perception: {
        mod: sb.perception,
        senses: senses.senses,
        details: senses.details,
      },
    };
  }

  /**
   * The system.* portion of a PF2e Hazard actor.
   *
   * Hazards are simpler than NPCs — no abilities, no senses, no inventory.
   * The mechanics-block prose lives in the description fields. PF2e's hazard
   * sheet then renders Stealth DC, Disable DC, AC, saves separately from the
   * description, but we don't have those parsed out in Phase 2A. The verbatim
   * mechanics block in details.description gives the GM the real numbers.
   *
   * PF2e 8.7.1 hazards have no publicNotes/privateNotes fields (verified on
   * Foundry 14.371): details are description, level, isComplex, disable,
   * routine, reset, publication. Anything else is silently dropped.
   */
  private buildPF2eHazardSystem(
    sb: Extract<StatBlock, { kind: 'custom' }>,
  ): Record<string, unknown> {
    return {
      details: {
        level: { value: sb.level },
        description: sb.tactics_html ?? '',
        isComplex: false,
        disable: '', // disable-action description; left empty in Phase 2A
        reset: '', // reset rules; left empty in Phase 2A
        routine: '', // routine on-trigger text; left empty in Phase 2A
      },
      traits: {
        value: toPf2eHazardTraits(sb.traits, pf2eHazardTraitSlugs()),
        rarity: sb.rarity,
        // Hazards have an `otherTags` field rather than a size field
        otherTags: [],
      },
      attributes: {
        hp: { value: sb.hp, max: sb.hp },
        ac: { value: sb.ac },
        hardness: 0,
        emitsSound: 'encounter' as const,
        stealth: {
          value: sb.perception, // best guess; real value comes in Phase 2B
          dc: 0,
        },
        immunities: sb.immunities.map((type) => ({ type })),
        weaknesses: sb.weaknesses.map((w) => ({ type: w.type, value: w.value })),
        resistances: sb.resistances.map((r) => ({ type: r.type, value: r.value })),
      },
      saves: {
        fortitude: { value: sb.saves.fortitude },
        reflex: { value: sb.saves.reflex },
        will: { value: sb.saves.will },
      },
    };
  }

  private buildOtherSpeeds(speeds: Extract<StatBlock, { kind: 'custom' }>['speeds']): unknown[] {
    const out: unknown[] = [];
    if (speeds.fly !== undefined) out.push({ type: 'fly', value: speeds.fly });
    if (speeds.swim !== undefined) out.push({ type: 'swim', value: speeds.swim });
    if (speeds.climb !== undefined) out.push({ type: 'climb', value: speeds.climb });
    if (speeds.burrow !== undefined) out.push({ type: 'burrow', value: speeds.burrow });
    return out;
  }

  /**
   * Build embedded item documents for strikes, actions, and inventory.
   * On PF2e NPCs, strikes and abilities ARE Items embedded in the actor.
   */
  private buildPF2eEmbeddedItems(
    sb: Extract<StatBlock, { kind: 'custom' }>,
    _assetMap: AssetMap,
  ): unknown[] {
    const items: unknown[] = [];

    // Strikes → "melee" type items in PF2e (ranged ones too: a range or a
    // thrown-N trait makes PF2e treat them as ranged).
    for (const strike of sb.strikes) {
      const { traits, range } = toPf2eStrikeTraits(strike.traits);
      const rolls = toPf2eDamageRolls(strike.damage_formula);
      const effectOnly = rolls.length === 0;
      const effects = strike.effects ?? [];
      const rangeValue =
        range ??
        (strike.range_feet ? { increment: strike.range_feet, max: null } : null) ??
        (strike.type === 'ranged' && !traits.some((t) => t.startsWith('thrown')) ? { increment: null, max: null } : null);
      items.push({
        type: 'melee',
        name: strike.name,
        system: {
          bonus: { value: strike.attack_bonus },
          // PF2e keys damage rolls by an id; stable keys keep output deterministic.
          damageRolls: Object.fromEntries(rolls.map((r, i) => [`zenith${i}`, r])),
          attackEffects: { value: effectOnly ? [] : toPf2eAttackEffects(effects) },
          traits: { value: [...traits, ...(strike.reload ? [`reload-${strike.reload}`] : [])] },
          ...(rangeValue ? { range: rangeValue } : {}),
          ...(effectOnly && effects.length ? { description: { value: `<p>${effects.join('; ')}</p>` } } : {}),
        },
      });
    }

    // Lore skills ("Farming Lore +5") are lore items on PF2e NPCs.
    for (const skill of sb.skills.filter((s) => isLoreSkill(s.name))) {
      items.push({ type: 'lore', name: skill.name, system: { mod: { value: skill.bonus } } });
    }

    // Abilities/actions → "action" type items
    for (const ability of sb.actions) {
      items.push({
        type: 'action',
        name: ability.name,
        system: {
          actionType: { value: this.mapActionType(ability.cost) },
          actions: { value: this.mapActionCount(ability.cost) },
          traits: { value: ability.traits },
          description: { value: ability.description_html },
          ...(ability.frequency ? { frequency: { value: ability.frequency } } : {}),
          ...(ability.trigger ? { trigger: { value: ability.trigger } } : {}),
        },
      });
    }

    return items;
  }

  /**
   * Printed gear (v0.2.2): each inventory entry with a compendium UUID is
   * copied onto the actor, with its runes, precious material, quantity and
   * printed name. Weapons and shields are held while hands are free, the first
   * armor is worn, bombs are carried. Entries that
   * don't resolve are skipped (the worker keeps unmatched gear as text).
   */
  private async buildInventoryItems(sb: Extract<StatBlock, { kind: 'custom' }>): Promise<unknown[]> {
    const items: unknown[] = [];
    let handsFree = 2;
    let armorWorn = false;
    for (const inv of sb.inventory) {
      if (!inv.uuid) continue;
      const res = await this.compendium.resolveSource(inv.uuid, inv.name);
      if (!res) {
        log.warn(`inventory item ${inv.uuid} (${inv.name ?? '?'}) not found; skipped`);
        continue;
      }
      const src = res.source as Record<string, any>;
      if (inv.runes?.length) await this.runes.applyToSource(src, inv.runes);
      const system = (src['system'] ??= {}) as Record<string, any>;
      if (inv.material) {
        const known = (CONFIG as any)?.PF2E?.preciousMaterials;
        if (!known || inv.material.type in known) system['material'] = { type: inv.material.type, grade: inv.material.grade };
      }
      if (inv.name) src['name'] = inv.name;
      system['quantity'] = inv.quantity;
      if (inv.note) {
        const description = (system['description'] ??= {}) as Record<string, unknown>;
        const existing = typeof description['value'] === 'string' ? (description['value'] as string) : '';
        description['value'] = `<p><em>${inv.note.replace(/</g, '&lt;')}</em></p>${existing}`;
      }
      // Hold weapons/shields while hands are free (two), wear the first armor;
      // bombs and other consumable weapons are carried, not held.
      if (inv.equipped) {
        const type = src['type'];
        const traits: string[] = system['traits']?.value ?? [];
        const hands = system['usage']?.value === 'held-in-two-hands' ? 2 : 1;
        const consumable = traits.includes('bomb') || traits.includes('consumable');
        if ((type === 'weapon' || type === 'shield') && !consumable && handsFree >= hands) {
          system['equipped'] = { carryType: 'held', handsHeld: hands };
          handsFree -= hands;
        } else if (type === 'armor' && !armorWorn) {
          system['equipped'] = { carryType: 'worn', inSlot: true, handsHeld: 0 };
          armorWorn = true;
        }
      }
      src['_stats'] = { ...(src['_stats'] ?? {}), compendiumSource: res.resolvedUuid };
      items.push(src);
    }
    return items;
  }

  /**
   * Spellcasting entries and their spells (PF2e 8.x). Each spell is copied
   * from its compendium UUID and pointed at its entry by _id, so the ids are
   * set here and kept by Actor.create. Spells without a UUID, or whose UUID
   * doesn't resolve, are listed in the entry's description instead: a spell
   * item without real data would fail validation and cost the actor all its
   * embedded items (see tryCreateActor).
   */
  private async buildSpellcastingItems(sb: Extract<StatBlock, { kind: 'custom' }>): Promise<unknown[]> {
    const items: unknown[] = [];
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    for (const e of sb.spellcasting) {
      const entryId = foundry.utils.randomID();
      const slots: Record<string, { max: number; value?: number; prepared?: { id: string }[] }> = {};
      const unresolved: string[] = [];
      for (const [key, list] of Object.entries(e.spells)) {
        const rank = Number(key);
        for (const sp of list) {
          const res = sp.uuid ? await this.compendium.resolveSource(sp.uuid, sp.name) : null;
          if (!res || res.source['type'] !== 'spell') {
            unresolved.push(sp.name);
            continue;
          }
          // resolveSource caches; never mutate the shared copy.
          const src = JSON.parse(JSON.stringify(res.source)) as Record<string, any>;
          const id = foundry.utils.randomID();
          const label = toPf2eSpellLabel(sp.note);
          const { location, preparedCount } = toPf2eSpellPlacement(entryId, e.type, rank, sp.uses);
          src['_id'] = id;
          if (label) src['name'] = `${src['name']} (${label})`;
          src['system'] = { ...(src['system'] ?? {}), location };
          src['_stats'] = { ...(src['_stats'] ?? {}), compendiumSource: res.resolvedUuid };
          items.push(src);
          if (preparedCount > 0) {
            const slot = (slots[`slot${rank}`] ??= { max: 0, prepared: [] });
            for (let i = 0; i < preparedCount; i++) slot.prepared!.push({ id });
            slot.max = slot.prepared!.length;
          }
        }
      }
      if (e.type === 'spontaneous') for (const [k, n] of Object.entries(e.rank_slots ?? {})) slots[`slot${k}`] = { max: n, value: n };
      items.push({
        _id: entryId,
        type: 'spellcastingEntry',
        name: e.name ?? `${cap(e.tradition)} ${cap(e.type)} Spells`,
        system: {
          tradition: { value: e.tradition },
          prepared: { value: e.type, flexible: false },
          // PF2e stores the spell attack modifier in spelldc.value.
          spelldc: { dc: e.dc, value: e.attack_bonus ?? e.dc - 8, mod: 0 },
          slots,
          showSlotlessLevels: { value: false },
          autoHeightenLevel: { value: null },
          description: {
            value: unresolved.length ? `<p>Not found in the PF2e compendium (add by hand): ${unresolved.join(', ')}</p>` : '',
          },
        },
      });
    }
    return items;
  }

  private mapActionType(
    cost: Extract<StatBlock, { kind: 'custom' }>['actions'][number]['cost'],
  ): 'action' | 'reaction' | 'free' | 'passive' {
    if (cost === 'passive') return 'passive';
    if (cost === 'reaction') return 'reaction';
    if (cost === 'free') return 'free';
    return 'action';
  }

  private mapActionCount(
    cost: Extract<StatBlock, { kind: 'custom' }>['actions'][number]['cost'],
  ): number | null {
    if (cost === '1' || cost === '2' || cost === '3') return Number(cost);
    return null;
  }

  // ----------------------------------------------------------------------------
  // Loot container path
  // ----------------------------------------------------------------------------

  private async buildLootContainer(
    _entry: ActorEntry,
    statBlock: Extract<StatBlock, { kind: 'loot-container' }>,
  ): Promise<Record<string, unknown>> {
    const items: unknown[] = [];

    for (const ref of statBlock.contents) {
      // Compendium-resolved items go directly into the container as embedded items
      if (ref.uuid) {
        // No fallback name available for loot contents (the contract doesn't
        // carry a name on each ref). UUID must hit; otherwise log and skip.
        const result = await this.compendium.resolveSource(ref.uuid);
        if (result) {
          const source = result.source;
          (source as any).system = {
            ...(source as any).system,
            quantity: ref.quantity,
          };
          items.push(source);
          continue;
        }
        log.warn(`loot container item ${ref.uuid} not found in compendium`);
      }
      // Items referenced by slug are resolved via cross-reference pass after
      // ItemBuilder has run. Track the ref in flags for the resolver.
      if (ref.ref) {
        items.push({
          type: 'equipment',
          name: `(deferred: ${ref.ref})`,
          system: { quantity: ref.quantity },
          flags: {
            'zenith-adventure-importer': {
              unresolvedItemRef: ref.ref,
              quantity: ref.quantity,
            },
          },
        });
      }
    }

    return {
      type: 'loot',
      system: {
        lootSheetType: 'Loot',
        currency: {
          cp: statBlock.currency.cp,
          sp: statBlock.currency.sp,
          gp: statBlock.currency.gp,
          pp: statBlock.currency.pp,
        },
      },
      items,
    };
  }

  // ----------------------------------------------------------------------------

  private placeholderType(category: ActorEntry['category']): string {
    if (category === 'hazard') return 'hazard';
    if (category === 'loot') return 'loot';
    return 'npc';
  }
}
