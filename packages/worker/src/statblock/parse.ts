/**
 * Regex parser for Paizo-format PF2e creature stat blocks (Phase 2B task 4).
 *
 * Input is one ScannedBlock (full or variant form) from scan.ts. Output is a
 * ParsedStatBlock plus a confidence in [0, 1]: the weighted share of core
 * fields found, minus penalties for an uncertain block end. Blocks under
 * 0.7 are meant for the AI fallback (task 5).
 *
 * Scope (decided 2026-11-27): stats, strikes and spellcasting entries are
 * parsed; special abilities are kept verbatim in `abilitiesText`.
 */
import type { ScannedBlock } from './scan.js';
import { extractSpellcasting, type ParsedSpellcasting } from './spells.js';

export interface ParsedStrike {
  kind: 'melee' | 'ranged';
  name: string;
  bonus: number;
  traits: string[];
  damage: { formula: string; type: string | null; persistent: boolean }[];
  /** "Grab", "Knockdown", "weeping wounds" ... */
  effects: string[];
  /** Printed with "Effect" instead of "Damage" (e.g. a push or a condition). */
  effectOnly: boolean;
}

export interface ParsedStatBlock {
  name: string;
  level: number;
  rarity: 'common' | 'uncommon' | 'rare' | 'unique';
  alignment: string | null;
  size: 'tiny' | 'small' | 'medium' | 'large' | 'huge' | 'gargantuan' | null;
  traits: string[];
  perception: number | null;
  senses: string[];
  languages: string[];
  skills: { name: string; bonus: number; note?: string }[];
  attributes: { str: number; dex: number; con: number; int: number; wis: number; cha: number } | null;
  items: string[];
  ac: number | null;
  saves: { fortitude: number; reflex: number; will: number } | null;
  hp: number | null;
  immunities: string[];
  weaknesses: { type: string; value: number }[];
  resistances: { type: string; value: number }[];
  speeds: { land: number; [other: string]: number } | null;
  strikes: ParsedStrike[];
  /** Spellcasting entries read from the ability text (see spells.ts). */
  spellcasting: ParsedSpellcasting[];
  /** Special abilities and anything after the strikes, verbatim, minus parsed spell entries. */
  abilitiesText: string;
  /** Reactions/auras printed between HP and Speed (e.g. "Ferocity [reaction]"). */
  defensiveText: string;
}

export interface ParseResult {
  block: ParsedStatBlock;
  confidence: number;
  /** Core fields that could not be read. */
  missing: string[];
}

const RARITIES = new Set(['UNCOMMON', 'RARE', 'UNIQUE']);
const ALIGNMENTS = new Set(['LG', 'NG', 'CG', 'LN', 'N', 'CN', 'LE', 'NE', 'CE']);
const SIZES: Record<string, ParsedStatBlock['size']> = {
  TINY: 'tiny', SMALL: 'small', MEDIUM: 'medium', LARGE: 'large', HUGE: 'huge', GARGANTUAN: 'gargantuan',
};
const DAMAGE_TYPES = new Set([
  'bludgeoning', 'piercing', 'slashing', 'acid', 'cold', 'electricity', 'fire', 'sonic', 'poison', 'mental',
  'force', 'bleed', 'spirit', 'vitality', 'void', 'positive', 'negative', 'chaotic', 'evil', 'good', 'lawful',
  'precision', 'untyped',
]);
const ACTION = String.raw`\[(?:one-action|two-actions|three-actions|reaction|free-action)\]`;

/** Labels in print order; each segment runs to the next label found. */
const LABELS = [
  'Perception', 'Languages', 'Skills', 'Str', 'Items', 'AC', 'HP', 'Immunities', 'Weaknesses', 'Resistances', 'Speed',
] as const;
type Label = (typeof LABELS)[number];

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s.replace(/\s/g, ''));
  return Number.isFinite(n) ? n : null;
};

function splitList(s: string): string[] {
  // Split on commas/semicolons that are not inside parentheses.
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if ((ch === ',' || ch === ';') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Locate field labels. The anchors (Perception, AC, HP, Speed) are found in
 * order; each optional label is searched only inside the window where it can
 * appear, so the word "Items" in later prose can't push the AC search past
 * the real "AC 30" (Solar Crow), and defenses may come in any order.
 */
function findLabels(body: string): Map<Label, number> {
  const found = new Map<Label, number>();
  const at = (re: RegExp, from: number, to = body.length): number | null => {
    const i = body.slice(from, to).search(re);
    return i >= 0 ? from + i : null;
  };
  const set = (label: Label, i: number | null) => {
    if (i !== null) found.set(label, i);
  };

  const p = at(/\bPerception\b/, 0) ?? 0;
  if (at(/\bPerception\b/, 0) !== null) found.set('Perception', p);
  const ac = at(/\bAC\s\d/, p) ?? at(/\bAC\s\d/, 0);
  // Variant blocks list only what changed, sometimes HP before AC.
  const hp = at(/\bHP\s\d/, ac ?? p) ?? at(/\bHP\s\d/, 0);
  const speed = at(/\bSpeed\s(?:\d|fly|swim|climb|burrow)/, hp ?? ac ?? p);
  set('AC', ac);
  set('HP', hp);
  set('Speed', speed);

  const beforeAc = ac ?? hp ?? speed ?? body.length;
  const str = at(/\bStr\s[+-]\d/, p, beforeAc);
  set('Str', str);
  const preStats = str ?? beforeAc;
  set('Languages', at(/\bLanguages\b/, p, preStats));
  set('Skills', at(/\bSkills\b/, p, preStats));
  set('Items', at(/\bItems\b/, str ?? p, beforeAc));

  if (hp !== null) {
    const end = speed ?? body.length;
    for (const d of ['Immunities', 'Weaknesses', 'Resistances'] as const) set(d, at(new RegExp(`\\b${d}\\b`), hp, end));
  }
  return found;
}

function segment(body: string, labels: Map<Label, number>, label: Label, stopAt?: number): string | null {
  const start = labels.get(label);
  if (start === undefined) return null;
  const later = [...labels.values()].filter((i) => i > start);
  const end = Math.min(...later, stopAt ?? body.length);
  return body.slice(start + label.length, end).trim();
}

function parseResistLike(s: string | null): { type: string; value: number }[] {
  if (!s) return [];
  const out: { type: string; value: number }[] = [];
  for (const part of splitList(s.replace(/^[;,]\s*/, ''))) {
    const m = /^([a-z][a-z -]*?)\s+(\d+)\b\s*(.*)$/.exec(part.trim());
    if (!m) break; // the list ended; an ability or reaction follows
    out.push({ type: m[1]!.trim(), value: Number(m[2]) });
    // "cold 15 Molten Form (fire) As lava otter, but 10 ..." — anything after
    // the value other than an "(except ...)" note means an ability started.
    if (m[3] && !/^\((?:except|double)[^)]*\)$/.test(m[3].trim())) break;
  }
  return out;
}

/** Immunity list: lowercase entries; stops where an ability name (Capitalized) begins. */
function parseImmunities(s: string | null): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const part of splitList(s.replace(/^[;,]\s*/, ''))) {
    const m = /^([a-z][a-z -]*?)(?=\s[A-Z]|\s*$)/.exec(part.trim());
    if (!m) break;
    out.push(m[1]!.trim());
    if (m[0].length < part.trim().length) break; // "visual Clot [reaction] ..." -> stop after "visual"
  }
  return out;
}

export function parseDamage(s: string): { damage: ParsedStrike['damage']; effects: string[]; rest: string } {
  const damage: ParsedStrike['damage'] = [];
  const effects: string[] = [];
  let rest = s.trim();
  const part = /^(\d+d\d+(?:\s?[+-]\s?\d+)?|\d+)(?:\s(persistent))?(?:\s([a-z]+))?/;
  for (let guard = 0; guard < 8; guard++) {
    const m = part.exec(rest);
    if (!m) break;
    const type = m[3] && DAMAGE_TYPES.has(m[3]) ? m[3] : null;
    damage.push({ formula: m[1]!.replace(/\s/g, ''), type, persistent: !!m[2] });
    rest = rest.slice(m[1]!.length + (m[2] ? m[2].length + 1 : 0) + (type ? type.length + 1 : 0)).trim();
    if (!/^plus\s/.test(rest)) break;
    rest = rest.slice(5).trim();
    if (/^\d/.test(rest)) continue;
    // "plus Grab", "plus Improved Knockdown", "plus weeping wounds"
    const eff = /^((?:Improved\s)?[A-Z][a-z]+|[a-z]+(?:\s[a-z]+){0,2}?)(?=\s(?:[A-Z]|$)|$|[,;.])/.exec(rest);
    if (!eff) break;
    effects.push(eff[1]!);
    rest = rest.slice(eff[1]!.length).trim();
    if (!/^plus\s/.test(rest)) break;
    rest = rest.slice(5).trim();
  }
  return { damage, effects, rest };
}

function parseStrikes(s: string): { strikes: ParsedStrike[]; rest: string } {
  const strikes: ParsedStrike[] = [];
  // The name may not run into another strike ("hot air +7 (air), Effect ..."
  // has no Damage); strikes may carry Damage or only an Effect.
  const re = new RegExp(
    String.raw`(Melee|Ranged)\s${ACTION}\s((?:(?!Melee\s|Ranged\s)[^\[\];,])+?)\s([+-]\d+)(?:\s\(([^)]*)\))?\s?[,;]\s?(Damage|Effect)\s`,
    'g',
  );
  let lastEnd = 0;
  let firstStart = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (firstStart < 0) firstStart = m.index;
    const after = s.slice(m.index + m[0].length);
    const effectOnly = m[5] === 'Effect';
    let parsed: ReturnType<typeof parseDamage>;
    if (effectOnly) {
      // Effect text runs to the next strike or the next ability name
      // ("Seed Burst [two-actions]"), or to the end.
      const e = /^(.+?)(?=\s(?:Melee|Ranged)\s\[|\s[A-Z][a-z]+(?:\s[A-Z]?[a-z]+)*\s[[(]|$)/.exec(after);
      const effectText = (e?.[1] ?? '').trim();
      parsed = { damage: [], effects: effectText ? [effectText] : [], rest: after.slice(e?.[1]?.length ?? 0) };
    } else {
      parsed = parseDamage(after);
    }
    const { damage, effects, rest } = parsed;
    strikes.push({
      kind: m[1] === 'Ranged' ? 'ranged' : 'melee',
      name: m[2]!.trim(),
      bonus: Number(m[3]),
      traits: m[4] ? splitList(m[4]).map((t) => t.toLowerCase()) : [],
      damage,
      effects,
      effectOnly,
    });
    lastEnd = s.length - rest.length;
    re.lastIndex = lastEnd;
  }
  return { strikes, rest: firstStart < 0 ? s : s.slice(lastEnd) };
}

export function parseStatBlock(scanned: ScannedBlock): ParseResult {
  const t = scanned.text;
  const headerEnd = /(CREATURE|HAZARD)\s-?\d+/.exec(t);
  const afterHeader = headerEnd ? t.slice(headerEnd.index + headerEnd[0].length).trim() : t;

  // Trait line: all-caps tokens before the first field label.
  const firstLabel = /\b(Perception|Variant|Initiative|Skills|Str\s[+-])/.exec(afterHeader);
  const traitTokens = (firstLabel ? afterHeader.slice(0, firstLabel.index) : '').trim().split(/\s+/).filter(Boolean);
  let rarity: ParsedStatBlock['rarity'] = 'common';
  let alignment: string | null = null;
  let size: ParsedStatBlock['size'] = null;
  const traits: string[] = [];
  for (const tok of traitTokens) {
    if (RARITIES.has(tok)) rarity = tok.toLowerCase() as ParsedStatBlock['rarity'];
    else if (ALIGNMENTS.has(tok)) alignment = tok;
    else if (SIZES[tok]) size = SIZES[tok]!;
    else if (/^[A-Z][A-Z-]+$/.test(tok)) traits.push(tok.toLowerCase());
  }

  const body = firstLabel ? afterHeader.slice(firstLabel.index) : afterHeader;
  const labels = findLabels(body);

  // Everything after Speed: speeds, then strikes, then abilities.
  const speedSeg = segment(body, labels, 'Speed') ?? '';
  // "30 feet", "25 feet, climb 20 feet", or no land speed: "fly 20 feet".
  const speedMatch = /^(?:(\d+)\s?feet)?((?:,?\s?(?:fly|swim|climb|burrow)\s\d+\s?feet)*)/.exec(speedSeg);
  let speeds: ParsedStatBlock['speeds'] = null;
  if (speedMatch && speedMatch[0].trim()) {
    speeds = { land: speedMatch[1] ? Number(speedMatch[1]) : 0 };
    for (const o of speedMatch[2]!.matchAll(/(fly|swim|climb|burrow)\s(\d+)/g)) speeds[o[1]!] = Number(o[2]);
  }
  const afterSpeed = speeds && speedMatch ? speedSeg.slice(speedMatch[0].length) : speedSeg;
  const { strikes, rest: afterStrikes } = parseStrikes(afterSpeed);
  const { entries: spellcasting, rest } = extractSpellcasting(afterStrikes);

  const perceptionSeg = segment(body, labels, 'Perception');
  const perceptionM = perceptionSeg ? /^([+-]\d+)[;,]?\s*(.*)$/.exec(perceptionSeg) : null;

  const attrSeg = segment(body, labels, 'Str');
  const attrM = attrSeg
    ? /^([+-]\d+),\sDex\s([+-]\d+),\sCon\s([+-]\d+),\sInt\s([+-]\d+),\sWis\s([+-]\d+),\sCha\s([+-]\d+)/.exec(attrSeg)
    : null;

  const acSeg = segment(body, labels, 'AC');
  const acM = acSeg ? /^(\d+)/.exec(acSeg) : null;
  const savesM = acSeg ? /Fort\s([+-]\d+).*?Ref\s([+-]\d+).*?Will\s([+-]\d+)/.exec(acSeg) : null;

  const hpSeg = segment(body, labels, 'HP');
  const hpM = hpSeg ? /^(\d+)/.exec(hpSeg) : null;
  // Reactions/auras printed between the defenses and Speed ("Ferocity
  // [reaction]", "Bristle [reaction] Trigger ..."): from the first
  // Capitalized word after the last defense list (lists are lowercase).
  let defensiveText = '';
  const hpAt = labels.get('HP');
  if (hpAt !== undefined) {
    const lastDefense = Math.max(hpAt, ...(['Immunities', 'Weaknesses', 'Resistances'] as const).map((d) => labels.get(d) ?? -1));
    const region = body.slice(lastDefense, labels.get('Speed') ?? body.length).replace(/^\S+\s/, '');
    const i = region.search(/[A-Z][a-z]/);
    defensiveText = i >= 0 ? region.slice(i).trim() : '';
  }

  const block: ParsedStatBlock = {
    name: scanned.name,
    level: scanned.level,
    rarity,
    alignment,
    size,
    traits,
    perception: num(perceptionM?.[1]),
    senses: perceptionM?.[2] ? splitList(perceptionM[2]) : [],
    languages: splitList(segment(body, labels, 'Languages') ?? ''),
    skills: splitList(segment(body, labels, 'Skills') ?? '')
      // No end anchor: a page footer can trail the last skill ("Athletics +10 30 Stone Horse").
      .map((s) => /^(.+?)\s([+-]\d+)(?:\s\(([^)]+)\))?/.exec(s))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => ({ name: m[1]!.trim(), bonus: Number(m[2]), ...(m[3] ? { note: m[3] } : {}) })),
    attributes: attrM
      ? { str: Number(attrM[1]), dex: Number(attrM[2]), con: Number(attrM[3]), int: Number(attrM[4]), wis: Number(attrM[5]), cha: Number(attrM[6]) }
      : null,
    items: splitList(segment(body, labels, 'Items') ?? '').map((s) => s.replace(/\s+,/g, ',')),
    ac: num(acM?.[1]),
    saves: savesM ? { fortitude: Number(savesM[1]), reflex: Number(savesM[2]), will: Number(savesM[3]) } : null,
    hp: num(hpM?.[1]),
    immunities: parseImmunities(segment(body, labels, 'Immunities')),
    weaknesses: parseResistLike(segment(body, labels, 'Weaknesses')),
    resistances: parseResistLike(segment(body, labels, 'Resistances')),
    speeds,
    strikes,
    spellcasting,
    abilitiesText: rest.trim(),
    defensiveText,
  };

  return { block, ...scoreParsed(block, scanned.endUncertain) };
}

/** Confidence: weighted share of core fields found, minus penalties. */
export function scoreParsed(block: ParsedStatBlock, endUncertain = false): { confidence: number; missing: string[] } {
  const core: [string, boolean, number][] = [
    ['perception', block.perception !== null, 1],
    ['attributes', block.attributes !== null, 1],
    ['ac', block.ac !== null, 1],
    ['saves', block.saves !== null, 1],
    ['hp', block.hp !== null, 1],
    ['speed', block.speeds !== null, 1],
    ['strikes', block.strikes.length > 0, 1],
  ];
  const total = core.reduce((n, c) => n + c[2], 0);
  let confidence = core.reduce((n, c) => n + (c[1] ? c[2] : 0), 0) / total;
  if (endUncertain) confidence -= 0.1;
  if (block.strikes.some((s) => !s.effectOnly && s.damage.length === 0)) confidence -= 0.05;
  confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100));
  return { confidence, missing: core.filter((c) => !c[1]).map((c) => c[0]) };
}
