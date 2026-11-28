/**
 * Paizo-format hazard stat blocks -> structured hazards.
 *
 *   SPEAR LAUNCHER HAZARD 2 MECHANICAL TRAP Stealth DC 20 (trained)
 *   Description ... Disable Thievery DC 18 (trained) on the rope ...
 *   AC 18; Fort +11, Ref +3 Hardness 8; HP 32 (BT 16); Immunities ...
 *   Spear [reaction] (attack); Trigger ...; Effect ...
 *   Ranged spear +14, Damage 2d6+6 piercing
 *   Routine (2 actions) ...   Reset ...
 *
 * Fields come from their labels in print order. Hazard Strikes carry no
 * action glyph ("Ranged spear +14, Damage ..."). The scanner can't always
 * tell where a hazard ends and the adventure's prose resumes, so the block's
 * `endUncertain` is passed on for review.
 */
import type { ScannedBlock } from './scan.js';
import { parseAbilities, type ParsedAbility } from './abilities.js';
import { parseDamage, type ParsedStrike } from './parse.js';

export interface ParsedHazard {
  name: string;
  level: number;
  rarity: 'common' | 'uncommon' | 'rare' | 'unique';
  traits: string[];
  complex: boolean;
  stealthDc: number | null;
  /** "(trained)", "or DC 0 if the trapdoor is disabled". */
  stealthDetails: string;
  description: string;
  disable: string;
  ac: number | null;
  saves: { fortitude: number | null; reflex: number | null; will: number | null };
  hardness: number | null;
  hp: number | null;
  brokenThreshold: number | null;
  immunities: string[];
  weaknesses: { type: string; value: number }[];
  resistances: { type: string; value: number }[];
  abilities: ParsedAbility[];
  strikes: ParsedStrike[];
  routine: string;
  reset: string;
}

const RARITIES = new Set(['UNCOMMON', 'RARE', 'UNIQUE']);

function between(t: string, start: RegExp, ends: RegExp[]): { text: string; at: number; end: number } | null {
  const m = start.exec(t);
  if (!m) return null;
  const from = m.index + m[0].length;
  let end = t.length;
  for (const e of ends) {
    const rest = t.slice(from);
    const i = rest.search(e);
    if (i >= 0) end = Math.min(end, from + i);
  }
  return { text: t.slice(from, end).trim(), at: m.index, end };
}

function defenseList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/,\s*/)
    .map((x) => x.trim().replace(/[;.]$/, ''))
    .filter((x) => /^[a-z][a-z -]*$/.test(x));
}

function resistLike(s: string | undefined): { type: string; value: number }[] {
  if (!s) return [];
  return s
    .split(/,\s*/)
    .map((x) => /^([a-z][a-z -]*?)\s(\d+)\b/.exec(x.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ type: m[1]!, value: Number(m[2]) }));
}

/** Hazard Strikes have no action glyph: "Ranged spear +14, Damage 2d6+6 piercing". */
function hazardStrikes(t: string): { strikes: ParsedStrike[]; spans: [number, number][] } {
  const strikes: ParsedStrike[] = [];
  const spans: [number, number][] = [];
  const re = /\b(Melee|Ranged)\s(?:\[[a-z-]+\]\s)?([a-z][a-z' -]*?)\s([+-]\d+)(?:\s\(([^)]*)\))?,\s(Damage|Effect)\s/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const after = t.slice(m.index + m[0].length);
    const { damage, effects, rest } = m[5] === 'Damage' ? parseDamage(after) : { damage: [], effects: [], rest: after };
    strikes.push({
      kind: m[1] === 'Ranged' ? 'ranged' : 'melee',
      name: m[2]!.trim(),
      bonus: Number(m[3]),
      traits: m[4] ? m[4].split(/,\s*/).map((x) => x.toLowerCase()) : [],
      damage,
      effects,
      effectOnly: m[5] === 'Effect',
    });
    spans.push([m.index, t.length - rest.length]);
  }
  return { strikes, spans };
}

export function parseHazardBlock(scanned: ScannedBlock): { hazard: ParsedHazard; confidence: number; missing: string[] } {
  const t = scanned.text.replace(/\s+/g, ' ');
  const head = /HAZARD\s-?\d+\s/.exec(t);
  const body = head ? t.slice(head.index + head[0].length) : t;

  const stealthAt = body.search(/\bStealth\s(?:DC\s\d|[+-]\d)/);
  const traitTokens = (stealthAt >= 0 ? body.slice(0, stealthAt) : '').trim().split(/\s+/).filter(Boolean);
  let rarity: ParsedHazard['rarity'] = 'common';
  const traits: string[] = [];
  for (const tok of traitTokens) {
    if (RARITIES.has(tok)) rarity = tok.toLowerCase() as ParsedHazard['rarity'];
    else if (/^[A-Z][A-Z-]+$/.test(tok)) traits.push(tok.toLowerCase());
  }
  const complex = traits.includes('complex');

  const stealth = /\bStealth\s(?:DC\s(\d+)|([+-]\d+))\s?(.*?)(?=\sDescription\b)/.exec(body);
  const stealthDc = stealth ? (stealth[1] ? Number(stealth[1]) : 10 + Number(stealth[2])) : null;
  const description = between(body, /\bDescription\s/, [/\sDisable\s/])?.text ?? '';
  const disable = between(body, /\bDisable\s/, [/\sAC\s\d/, /\s(?:[A-Z][a-z]+\s)?Hardness\s\d/, /\s(?:[A-Z][a-z]+\s)?HP\s\d/])?.text ?? '';

  const ac = /\bAC\s(\d+)/.exec(body);
  const save = (k: string) => {
    const m = new RegExp(String.raw`\b${k}\s([+-]\d+)`).exec(body);
    return m ? Number(m[1]) : null;
  };
  const hardness = /\bHardness\s(\d+)/.exec(body);
  const hp = /\bHP\s(\d+)(?:\s\(BT\s(\d+)\))?/.exec(body);
  // A complex hazard's defenses run straight into "Routine (2 actions)",
  // a glyph-less Strike or "Reset" with no ";" between them.
  const sectionStart = /\s(?:Routine|Reset|Melee|Ranged)\s/;
  const defEnd = [/;\s/, /\s(?:Weaknesses|Resistances)\s/, /\s[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s\[/, sectionStart];
  const imm = between(body, /\bImmunities\s/, defEnd);
  const weak = between(body, /\bWeaknesses\s/, [/;\s/, /\sResistances\s/, /\s[A-Z][a-z]/, sectionStart]);
  const res = between(body, /\bResistances\s/, [/;\s/, /\s[A-Z][a-z]/, sectionStart]);

  // Actions follow the last defense line.
  const lastDefense = Math.max(imm?.end ?? -1, weak?.end ?? -1, res?.end ?? -1, hp ? hp.index + hp[0].length : -1, hardness ? hardness.index + hardness[0].length : -1);
  let actionText = lastDefense > 0 ? body.slice(lastDefense).replace(/^[;,.\s]+/, '') : '';
  const routine = /\bRoutine\s(\(.*?\)\s.*?)(?=\s(?:Reset|Ranged|Melee)\s|$)/.exec(actionText);
  const reset = /\bReset\s(.*)$/.exec(actionText);
  if (reset) actionText = actionText.slice(0, reset.index);
  if (routine) actionText = actionText.slice(0, routine.index) + actionText.slice(routine.index + routine[0].length);
  // The adventure's prose resumes right after a hazard: drop anything after
  // the Strike line (printed last) and anything from an area key ("F3. ").
  const { strikes, spans } = hazardStrikes(actionText);
  let afflictions: ParsedAbility[] = [];
  if (spans.length) {
    // Keep an affliction printed after the Strike ("Cladis Poison (poison)
    // Saving Throw ..."); everything else after it is prose.
    const tail = actionText.slice(spans[spans.length - 1]![1]);
    afflictions = parseAbilities(tail)
      .abilities.filter((a) => a.traits.length > 0 && /\bSaving Throw\b/.test(a.text))
      // An affliction ends with its last stage: "Stage 2 ... (1 round)".
      .map((a) => {
        const stages = [...a.text.matchAll(/\bStage\s\d+\s[^()]*?\([^)]*\)/g)];
        const last = stages[stages.length - 1];
        return last ? { ...a, text: a.text.slice(0, last.index! + last[0].length) } : a;
      });
    actionText = actionText.slice(0, spans[spans.length - 1]![1]);
  }
  // "... award the party 30 XP." closes the encounter, not the hazard.
  const xp = actionText.search(/[^.]*\b\d+\sXP\b/);
  if (xp >= 0) actionText = actionText.slice(0, xp);
  for (const [a, b] of [...spans].reverse()) actionText = `${actionText.slice(0, a)} ${actionText.slice(b)}`;
  const areaKey = actionText.search(/(?:\(\s?)?\b[A-Z]\d{1,2}\s?\)?\.\s/);
  if (areaKey >= 0) actionText = actionText.slice(0, areaKey);
  // A trait-less passive "ability" after the hazard's real actions is a
  // location heading ("Hidden Window Entrance The window ..."), not part of it.
  const parsedAbilities = parseAbilities(actionText).abilities;
  const firstActive = parsedAbilities.findIndex((a) => a.cost !== 'passive');
  const abilities = [
    ...parsedAbilities.filter((a, i) => a.cost !== 'passive' || a.traits.length > 0 || firstActive < 0 || i < firstActive),
    ...afflictions,
  ];

  const hazard: ParsedHazard = {
    name: scanned.name,
    level: scanned.level,
    rarity,
    traits,
    complex,
    stealthDc,
    stealthDetails: stealth?.[3]?.trim() ?? '',
    description,
    disable,
    ac: ac ? Number(ac[1]) : null,
    saves: { fortitude: save('Fort'), reflex: save('Ref'), will: save('Will') },
    hardness: hardness ? Number(hardness[1]) : null,
    hp: hp ? Number(hp[1]) : null,
    brokenThreshold: hp?.[2] ? Number(hp[2]) : null,
    immunities: defenseList(imm?.text),
    weaknesses: resistLike(weak?.text),
    resistances: resistLike(res?.text),
    abilities,
    strikes,
    routine: routine?.[1]?.trim() ?? '',
    reset: reset?.[1]?.trim() ?? '',
  };
  const core: [string, boolean][] = [
    ['stealth', hazard.stealthDc !== null],
    ['description', !!hazard.description],
    ['disable', !!hazard.disable],
    ['actions', hazard.abilities.length > 0 || !!hazard.routine],
  ];
  let confidence = core.filter((c) => c[1]).length / core.length;
  if (scanned.endUncertain) confidence -= 0.1;
  return { hazard, confidence: Math.max(0, Math.round(confidence * 100) / 100), missing: core.filter((c) => !c[1]).map((c) => c[0]) };
}
