/**
 * Spell lines in Paizo-format stat blocks -> structured spellcasting entries.
 *
 * Reads the printed form:
 *
 *   Primal Innate Spells DC 17, attack +9; 2nd invisibility (×2), translate
 *   (at will); Cantrips (1st) detect magic; Constant (5th) truespeech
 *   Occult Spontaneous Spells DC 28, attack +20; 3rd (4 slots) haste, slow
 *   Cleric Domain Spells 1 Focus Point, DC 18; 1st death's call
 *
 * Spell names print in lowercase, so a list ends at the first Capitalized
 * word that isn't a source code ("SoM") — that's the next ability. Entries
 * that can't be read cleanly (no DC, unknown tradition, no spells) are left
 * in the text. Rituals have no PF2e spellcasting entry and stay as text.
 */

export type Tradition = 'arcane' | 'divine' | 'occult' | 'primal';
export type CastingType = 'innate' | 'prepared' | 'spontaneous' | 'focus';

export interface ParsedSpell {
  name: string;
  /** Printed restrictions, e.g. "at will", "self only", "constant". */
  note?: string;
  /** Printed "(×N)". */
  uses?: number;
}

export interface ParsedSpellRank {
  /** 0 for cantrips; for cantrips and constant spells the printed rank is `heightened`. */
  rank: number;
  cantrip: boolean;
  constant: boolean;
  /** Spontaneous "3rd (4 slots)". */
  slots?: number;
  spells: ParsedSpell[];
}

export interface ParsedSpellcasting {
  name: string;
  tradition: Tradition;
  type: CastingType;
  dc: number;
  attack: number | null;
  focusPoints: number | null;
  ranks: ParsedSpellRank[];
}

const TRADITIONS = new Set<Tradition>(['arcane', 'divine', 'occult', 'primal']);

/** Focus entries name the class, not the tradition. */
const CLASS_TRADITION: Record<string, Tradition> = {
  cleric: 'divine',
  champion: 'divine',
  oracle: 'divine',
  druid: 'primal',
  ranger: 'primal',
  wizard: 'arcane',
  magus: 'arcane',
  bard: 'occult',
  psychic: 'occult',
};

const ORD = String.raw`(\d+)(?:st|nd|rd|th)`;
const HEADER = new RegExp(
  String.raw`\b(?:(Arcane|Divine|Occult|Primal)\s(Innate|Prepared|Spontaneous|Focus)\s|([A-Z][a-z]+)\s(?:[A-Z][a-z]+\s)?)Spells\s`,
  'g',
);

/** A source abbreviation printed after a spell name: "SoM", "APG", "LOCG". */
const SOURCE_CODE = /^(?:[A-Z][a-z]?[A-Z][A-Za-z]*|[A-Z]{2,5})(?![a-z])/;
const NAME_WORD = /^[a-z][a-z’'-]*/;

function parseParams(s: string): { dc: number | null; attack: number | null; focusPoints: number | null } {
  const dc = /\bDC\s(\d+)/.exec(s);
  const attack = /\battack\s([+-]\d+)/.exec(s);
  const focus = /\b(\d+)\sFocus\sPoints?\b/.exec(s);
  return { dc: dc ? Number(dc[1]) : null, attack: attack ? Number(attack[1]) : null, focusPoints: focus ? Number(focus[1]) : null };
}

function parseNote(inner: string): { note?: string; uses?: number } {
  // Drop "×N" and "page N" items but keep the note's own punctuation:
  // "at will; to Astral Plane, Elemental Planes, or the Universe only".
  let uses: number | undefined;
  const ITEM = /(^|[;,])\s*(?:[×x]\s?(\d+)|page\s\d+)\s*(?=[;,]|$)/gi;
  const note = inner
    .replace(ITEM, (_m, sep: string, n?: string) => {
      if (n) uses = Number(n);
      return sep;
    })
    .replace(/^[\s;,]+|[\s;,]+$/g, '')
    .replace(/\s*([;,])(?:\s*[;,])+/g, '$1')
    .replace(/\s*([;,])\s*/g, '$1 ');
  return { ...(note ? { note } : {}), ...(uses ? { uses } : {}) };
}

/** Read one spell list starting at `s[i]`; returns the spells and where the list ended. */
function readSpellList(s: string, i: number): { spells: ParsedSpell[]; end: number } {
  const spells: ParsedSpell[] = [];
  let pos = i;
  for (;;) {
    let j = pos;
    while (s[j] === ' ') j++;
    const words: string[] = [];
    for (;;) {
      const m = NAME_WORD.exec(s.slice(j));
      if (!m) break;
      words.push(m[0]);
      j += m[0].length;
      if (s[j] === ' ' && NAME_WORD.test(s.slice(j + 1))) j++;
      else break;
    }
    if (!words.length) break;
    // Optional source code, then an optional (note).
    if (s[j] === ' ') {
      const src = SOURCE_CODE.exec(s.slice(j + 1));
      if (src && /^[\s,;(]|^$/.test(s.slice(j + 1 + src[0].length, j + 2 + src[0].length))) j += 1 + src[0].length;
    }
    let notes: { note?: string; uses?: number } = {};
    const paren = /^\s?\(((?:[^()]|\([^()]*\))*)\)/.exec(s.slice(j));
    if (paren) {
      notes = parseNote(paren[1]!);
      j += paren[0].length;
    }
    spells.push({ name: words.join(' ').replace(/’/g, "'"), ...notes });
    pos = j;
    // Next item: "," (possibly after a stray space, "light , detect magic").
    const sep = /^\s?,\s?/.exec(s.slice(pos));
    if (!sep) break;
    if (!NAME_WORD.test(s.slice(pos + sep[0].length))) break;
    pos += sep[0].length;
  }
  return { spells, end: pos };
}

/** Parse the entry whose header starts at `start`; null when it isn't a clean spell entry. */
function readEntry(s: string, start: number, header: RegExpExecArray): { entry: ParsedSpellcasting; end: number } | null {
  const name = header[0].trim();
  const paramsEnd = s.indexOf(';', start + header[0].length);
  if (paramsEnd < 0 || paramsEnd - start > 120) return null;
  const { dc, attack, focusPoints } = parseParams(s.slice(start + header[0].length, paramsEnd));
  if (dc === null) return null;

  let tradition: Tradition | undefined;
  let type: CastingType;
  if (header[1]) {
    tradition = header[1].toLowerCase() as Tradition;
    type = header[2]!.toLowerCase() as CastingType;
  } else {
    if (focusPoints === null) return null; // "All Made One Spells", "Air Spells" headings ...
    tradition = CLASS_TRADITION[header[3]!.toLowerCase()];
    type = 'focus';
  }
  if (!tradition || !TRADITIONS.has(tradition)) return null;

  const ranks: ParsedSpellRank[] = [];
  let pos = paramsEnd;
  let end = paramsEnd;
  while (s[pos] === ';') {
    let j = pos + 1;
    while (s[j] === ' ') j++;
    const rest = s.slice(j);
    let rank: ParsedSpellRank | undefined;
    let m: RegExpExecArray | null;
    if ((m = new RegExp(`^Cantrips\\s\\(${ORD}\\)\\s`).exec(rest))) {
      rank = { rank: Number(m[1]), cantrip: true, constant: false, spells: [] };
    } else if ((m = new RegExp(`^Constant\\s\\(${ORD}\\)\\s`).exec(rest))) {
      rank = { rank: Number(m[1]), cantrip: false, constant: true, spells: [] };
    } else if ((m = new RegExp(`^${ORD}(?:\\s\\((\\d+)\\sslots?\\))?\\s`).exec(rest))) {
      rank = { rank: Number(m[1]), cantrip: false, constant: false, ...(m[2] ? { slots: Number(m[2]) } : {}), spells: [] };
    } else if (ranks.length && NAME_WORD.test(rest)) {
      // A rank label lost in extraction ("4th invisibility (×2); read omens ;"):
      // the list belongs to the rank before it.
      const prev = ranks[ranks.length - 1]!;
      const { spells, end: e } = readSpellList(s, j);
      if (!spells.length) break;
      prev.spells.push(...spells);
      pos = end = e;
      while (s[pos] === ' ') pos++;
      continue;
    } else break;
    if (rank.rank < 1 || rank.rank > 10) break;
    const { spells, end: e } = readSpellList(s, j + m[0].length);
    if (!spells.length) break;
    rank.spells = spells;
    ranks.push(rank);
    pos = end = e;
    while (s[pos] === ' ') pos++;
  }
  if (!ranks.length) return null;
  return { entry: { name, tradition, type, dc, attack, focusPoints, ranks }, end };
}

/**
 * Pull every readable spellcasting entry out of a stat block's ability text.
 * `rest` is the text with those entries removed (rituals and unreadable
 * entries stay in it).
 */
export function extractSpellcasting(text: string): { entries: ParsedSpellcasting[]; rest: string } {
  const entries: ParsedSpellcasting[] = [];
  const cuts: [number, number][] = [];
  HEADER.lastIndex = 0;
  for (let h = HEADER.exec(text); h; h = HEADER.exec(text)) {
    const got = readEntry(text, h.index, h);
    if (!got) continue;
    entries.push(got.entry);
    cuts.push([h.index, got.end]);
    HEADER.lastIndex = got.end;
  }
  let rest = text;
  for (const [a, b] of cuts.reverse()) rest = `${rest.slice(0, a).trimEnd()} ${rest.slice(b).replace(/^\s*;?\s*/, '')}`;
  return { entries, rest: rest.replace(/\s{2,}/g, ' ').trim() };
}

/**
 * PF2e Remaster renamed many spells and PF2e's spell pack carries only the
 * new names. Older books (e.g. The Fall of Plaguestone) print the old ones.
 */
export const LEGACY_SPELL_NAMES: Record<string, string> = {
  'acid splash': 'caustic blast',
  'burning hands': 'breathe fire',
  'calm emotions': 'calm',
  'chill touch': 'void warp',
  'color spray': 'dizzying colors',
  'comprehend language': 'translate',
  'dancing lights': 'light',
  'disrupt undead': 'vitality lash',
  'faerie fire': 'revealing light',
  'false life': 'false vitality',
  'feather fall': 'gentle landing',
  'flaming sphere': 'floating flame',
  'freedom of movement': 'unfettered movement',
  'ghost sound': 'figment',
  'glitterdust': 'revealing light',
  'hideous laughter': 'laughing fit',
  'mage armor': 'mystic armor',
  'mage hand': 'telekinetic hand',
  'magnificent mansion': 'planar palace',
  'magic fang': 'runic body',
  'magic missile': 'force barrage',
  'magic weapon': 'runic weapon',
  'meld into stone': 'one with stone',
  'neutralize poison': 'cleanse affliction',
  'obscuring mist': 'mist',
  'produce flame': 'ignition',
  'ray of frost': 'frostbite',
  'remove fear': 'clear mind',
  'remove paralysis': 'clear mind',
  'restore senses': 'sound body',
  'remove curse': 'cleanse affliction',
  'remove disease': 'cleanse affliction',
  'see invisibility': 'see the unseen',
  'stoneskin': 'mountain resilience',
  'tanglefoot': 'tangle vine',
  'tongues': 'truespeech',
  'touch of idiocy': 'stupefy',
  'true seeing': 'truesight',
  'true strike': 'sure strike',
};
