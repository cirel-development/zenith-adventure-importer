/**
 * Phase 2B task 7 (worker side): connect extracted NPCs to the stat blocks
 * scanned from the same PDF, and turn a parse into a contract `custom` stat
 * block with real values.
 *
 * Linking is by normalized name, tolerant of printed plurals and counts
 * ("JINKIN RIPCLAWS (3)" -> "Jinkin Ripclaw"). Variant blocks ("Variant
 * jinkin ripclaw (page 5)") are merged onto their base when the base is a
 * full block in the same PDF; the variant's own fields win.
 */
import type { Bundle } from '@ai-adventure/contract';
import { normalizeName, type CompendiumIndex } from '../compendium/index.js';
import type { ScannedBlock } from './scan.js';
import { parseStatBlock, type ParseResult, type ParsedStatBlock } from './parse.js';
import { LEGACY_SPELL_NAMES, type ParsedSpellcasting } from './spells.js';
import { parseInventoryLine, singular, type InventoryLine } from './inventory.js';
import { planItem, type ItemPlan } from '../compendium/items.js';

type CustomStatBlock = Extract<Bundle['actors']['entities'][number]['stat_block'], { kind: 'custom' }>;

export interface LinkedBlock {
  scanned: ScannedBlock;
  parse: ParseResult;
  /** Set when a variant was merged onto a base block from the same PDF. */
  base?: ScannedBlock;
}

/** Name forms to try: as printed, then common English plural endings removed. */
export function nameKeys(name: string): string[] {
  const n = normalizeName(name);
  const out = [n, n.replace(/ves$/, 'f'), n.replace(/ies$/, 'y'), n.replace(/(?<=[sxz]|ch|sh)es$/, ''), n.replace(/s$/, '')];
  return [...new Set(out)];
}

/** Index full and variant blocks by every name key; the first block printed wins. */
export function indexBlocks(blocks: ScannedBlock[]): Map<string, ScannedBlock> {
  const map = new Map<string, ScannedBlock>();
  for (const b of blocks) {
    if (b.form !== 'full' && b.form !== 'variant') continue;
    for (const k of nameKeys(b.name)) if (!map.has(k)) map.set(k, b);
  }
  return map;
}

/** Overlay a variant's parsed fields on its base parse. */
export function mergeVariant(base: ParsedStatBlock, variant: ParsedStatBlock): ParsedStatBlock {
  const pick = <T>(v: T | null | undefined, b: T): T => (v === null || v === undefined ? b : v);
  const listOr = <T>(v: T[], b: T[]): T[] => (v.length ? v : b);
  const skills = new Map(base.skills.map((s) => [s.name.toLowerCase(), s]));
  for (const s of variant.skills) skills.set(s.name.toLowerCase(), s);
  return {
    ...base,
    name: variant.name,
    level: variant.level,
    rarity: variant.rarity !== 'common' ? variant.rarity : base.rarity,
    alignment: pick(variant.alignment, base.alignment),
    size: pick(variant.size, base.size),
    traits: listOr(variant.traits, base.traits),
    perception: pick(variant.perception, base.perception),
    senses: listOr(variant.senses, base.senses),
    languages: listOr(variant.languages, base.languages),
    skills: [...skills.values()],
    attributes: pick(variant.attributes, base.attributes),
    items: listOr(variant.items, base.items),
    ac: pick(variant.ac, base.ac),
    saves: pick(variant.saves, base.saves),
    hp: pick(variant.hp, base.hp),
    immunities: listOr(variant.immunities, base.immunities),
    weaknesses: listOr(variant.weaknesses, base.weaknesses),
    resistances: listOr(variant.resistances, base.resistances),
    speeds: pick(variant.speeds, base.speeds),
    strikes: listOr(variant.strikes, base.strikes),
    spellcasting: listOr(variant.spellcasting, base.spellcasting),
    abilitiesText: [variant.abilitiesText, base.abilitiesText].filter(Boolean).join(' '),
    defensiveText: [variant.defensiveText, base.defensiveText].filter(Boolean).join(' '),
  };
}

/**
 * Find and parse the stat block for an extracted NPC. Variants are merged
 * onto a same-PDF base when one exists; a variant whose base is elsewhere
 * (another book) is returned unmerged with its gaps listed as missing.
 */
export function linkStatBlock(npcName: string, byName: Map<string, ScannedBlock>): LinkedBlock | null {
  const scanned = nameKeys(npcName).map((k) => byName.get(k)).find(Boolean);
  if (!scanned) return null;
  const parse = parseStatBlock(scanned);
  if (scanned.form !== 'variant' || !scanned.variantOf) return { scanned, parse };

  const base = nameKeys(scanned.variantOf.name)
    .map((k) => byName.get(k))
    .find((b) => b && b.form === 'full' && b !== scanned);
  if (!base) return { scanned, parse };
  const baseParse = parseStatBlock(base);
  const merged = mergeVariant(baseParse.block, parse.block);
  const reparsed: ParseResult = {
    block: merged,
    // The merge fills the variant's gaps from the base, so trust the base.
    confidence: Math.min(baseParse.confidence, 1),
    missing: baseParse.missing,
  };
  return { scanned, parse: reparsed, base };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Spell name -> PF2e spells-srd UUID, trying the Remaster name for renamed spells. */
export type SpellResolver = (name: string) => string | null;

export function spellResolver(idx: CompendiumIndex): SpellResolver {
  return (name) => {
    // "mountain's resilience" is printed for PF2e's "Mountain Resilience".
    for (const n of new Set([normalizeName(name), normalizeName(name.replace(/['’]s(?=\s|$)/g, ''))])) {
      const hit = idx.findSpell(n) ?? (LEGACY_SPELL_NAMES[n] ? idx.findSpell(LEGACY_SPELL_NAMES[n]!) : null);
      if (hit) return hit.uuid;
    }
    return null;
  };
}

/** Parsed entries -> contract spellcasting. Cantrips go under "0"; constant spells carry note "constant". */
export function toContractSpellcasting(entries: ParsedSpellcasting[], resolve?: SpellResolver): CustomStatBlock['spellcasting'] {
  return entries.map((e) => {
    const spells: CustomStatBlock['spellcasting'][number]['spells'] = {};
    const rankSlots: Record<string, number> = {};
    for (const r of e.ranks) {
      const key = r.cantrip ? '0' : String(r.rank);
      if (r.slots !== undefined) rankSlots[key] = r.slots;
      for (const sp of r.spells) {
        const uuid = resolve?.(sp.name) ?? null;
        const note = [r.constant ? 'constant' : '', sp.note ?? ''].filter(Boolean).join('; ');
        (spells[key] ??= []).push({
          name: sp.name,
          ...(uuid ? { uuid } : {}),
          ...(sp.uses ? { uses: sp.uses } : {}),
          ...(note ? { note } : {}),
        });
      }
    }
    return {
      name: e.name,
      tradition: e.tradition,
      type: e.type,
      dc: e.dc,
      ...(e.attack !== null ? { attack_bonus: e.attack } : {}),
      ...(e.focusPoints !== null ? { focus_points: e.focusPoints } : {}),
      ...(Object.keys(rankSlots).length ? { rank_slots: rankSlots } : {}),
      spells,
    };
  });
}

type InventoryEntry = CustomStatBlock['inventory'][number];
/** One printed inventory line -> a compendium inventory entry, or null (stays text). */
export type ItemResolver = (line: InventoryLine) => InventoryEntry | null;

const titleCase = (s: string) => s.replace(/(^|\s)([a-z])/g, (_m, sp: string, c: string) => sp + c.toUpperCase());

export function inventoryResolver(idx: CompendiumIndex): ItemResolver {
  const plan = (name: string): ItemPlan | null => planItem(idx, { name });
  return (line) => {
    // "+1 striking jambiya (functions as a dagger)": the stand-in takes the base's place.
    const standInName = line.standIn ? line.name.replace(/[a-z'-]+$/i, line.standIn) : null;
    const p =
      plan(line.name) ??
      (line.quantity > 1 || /s$/.test(line.name) ? plan(singular(line.name)) : null) ??
      (standInName ? plan(standInName) ?? plan(line.standIn!) : null);
    if (!p) return null;
    const base = p.kind === 'match' ? p.match : p.base;
    return {
      uuid: base.uuid,
      quantity: line.quantity,
      equipped: ['weapon', 'armor', 'shield'].includes(base.type),
      ...(p.kind === 'runes' || line.standIn ? { name: titleCase(line.name) } : {}),
      ...(p.kind === 'runes' ? { runes: p.runes.map((r) => ({ type: r.type, uuid: r.uuid, ...(r.rank ? { rank: r.rank } : {}) })) } : {}),
      ...(p.material ? { material: p.material } : {}),
      ...(line.note ? { note: line.note } : {}),
    };
  };
}

/** Spell names in a custom stat block that have no compendium UUID. */
export function unresolvedSpells(sb: CustomStatBlock): string[] {
  return sb.spellcasting.flatMap((e) => Object.values(e.spells).flat().filter((s) => !s.uuid).map((s) => s.name));
}

/**
 * Contract custom stat block from a parse. Fields the parse could not read
 * fall back to the level-based placeholders, and are listed in `missing`.
 */
export function toCustomStatBlock(
  p: ParsedStatBlock,
  notesHtml: string,
  resolveSpell?: SpellResolver,
  resolveItem?: ItemResolver,
): CustomStatBlock {
  const lvl = p.level;
  // Printed items that match the compendium become inventory; the rest (and
  // any ability text that ran into the list) stay as text in the notes.
  const { entries: lines, leftover } = resolveItem ? parseInventoryLine(p.items) : { entries: [], leftover: '' };
  const inventory: InventoryEntry[] = [];
  const unmatchedItems: string[] = resolveItem ? [] : p.items;
  for (const line of lines) {
    const hit = resolveItem!(line);
    if (hit) inventory.push(hit);
    else unmatchedItems.push(line.printed);
  }
  const abilityText = [p.defensiveText, leftover, p.abilitiesText].filter(Boolean).join(' ');
  return {
    kind: 'custom',
    level: Math.max(-1, Math.min(30, lvl)),
    size: p.size ?? 'medium',
    rarity: p.rarity,
    alignment: (p.alignment as CustomStatBlock['alignment']) ?? 'no-alignment',
    traits: p.traits.length ? p.traits : ['humanoid'],
    languages: p.languages,
    hp: p.hp ?? Math.max(10, 10 + lvl * 5),
    ac: p.ac ?? 10 + lvl,
    saves: p.saves ?? { fortitude: lvl, reflex: lvl, will: lvl },
    abilities: p.attributes ?? { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 },
    perception: p.perception ?? lvl,
    senses: p.senses,
    skills: p.skills.map((s) => ({ name: s.name, bonus: s.bonus, ...(s.note ? { note: s.note } : {}) })),
    speeds: { land: 25, ...(p.speeds ?? {}) },
    immunities: p.immunities,
    weaknesses: p.weaknesses,
    resistances: p.resistances,
    strikes: p.strikes.map((s) => ({
      name: s.name,
      type: s.kind,
      attack_bonus: s.bonus,
      damage_formula: s.damage
        .map((d) => [d.formula, d.persistent ? 'persistent' : '', d.type ?? ''].filter(Boolean).join(' '))
        .join(' plus '),
      ...(s.effects.length ? { effects: s.effects } : {}),
      traits: s.traits,
    })),
    actions: [],
    spellcasting: toContractSpellcasting(p.spellcasting, resolveSpell),
    inventory,
    tactics_html:
      notesHtml +
      (abilityText ? `<h3>Abilities (from the stat block)</h3><p>${escapeHtml(abilityText)}</p>` : '') +
      (unmatchedItems.length ? `<p><strong>Items</strong> ${escapeHtml(unmatchedItems.join(', '))}</p>` : ''),
  };
}
