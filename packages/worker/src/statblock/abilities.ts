/**
 * Special abilities in Paizo-format stat blocks -> structured actions.
 *
 *   Pummeling Winds [one-action] to [three-actions] Frequency once per round;
 *   Effect The gale bashes each adjacent enemy ...
 *   Ferocity [reaction] Trigger The boar is reduced to 0 HP; Effect ...
 *   Earth Glide The legion can Burrow through any earthen matter ...
 *   Form Up [one-action] (page 232)
 *
 * An ability starts with a Title Case name at the start of the text or after
 * a sentence end, followed by an action glyph, a lowercase trait list, one
 * of the Frequency/Trigger/Requirements/Effect keywords, or (for passive
 * abilities) a sentence opener like "The" or "When". It runs to the next
 * start. Text before the first start (if any) is returned as `rest`.
 */

export type AbilityCost = 'passive' | '1' | '2' | '3' | 'reaction' | 'free';

export interface ParsedAbility {
  name: string;
  cost: AbilityCost;
  /** Printed "[one-action] to [three-actions]": the upper bound. */
  costTo?: '2' | '3';
  traits: string[];
  frequency?: string;
  trigger?: string;
  requirements?: string;
  /** Everything after the name/glyph/traits, verbatim. */
  text: string;
}

const GLYPH: Record<string, AbilityCost> = {
  'one-action': '1',
  'two-actions': '2',
  'three-actions': '3',
  reaction: 'reaction',
  'free-action': 'free',
};

const SMALL = '(?:of|the|and|to|in|on|a|an|with|from|for|at|by|into|over|through|under|upon|against)';
// "Self-Destruct", "All-Around Vision", "Tight-Knit Family".
const WORD = String.raw`[A-Z][a-z’']+(?:-[A-Za-z][a-z’']*)*`;
// Up to two small words between capitalized ones: "Blessed by the Winds", "Heat of the Forge".
const NAME = String.raw`${WORD}(?:\s(?:${SMALL}\s){0,2}${WORD}){0,4}`;
const GLYPHS = String.raw`\[(?:one-action|two-actions|three-actions|reaction|free-action)\]`;
const KEYWORD = String.raw`(?:Frequency|Trigger|Requirements|Effect)\b`;
const TRAITS = String.raw`\((?:[a-z][a-z0-9 -]*)(?:,\s?[a-z][a-z0-9 -]*)*\)`;
const PAGE = String.raw`\(page\s\d+\)`;
const OPENER = String.raw`(?:The|A|An|This|These|When|While|If|Each|Any|Its|It|Whenever|Creatures?|Enemies|Allies)\s[a-z0-9]`;

/** Rules words that look like names but are part of an ability's text. */
const NOT_NAMES = new Set([
  'frequency', 'trigger', 'requirements', 'effect', 'critical success', 'success', 'failure', 'critical failure',
  'saving throw', 'onset', 'maximum duration', 'stage', 'activate', 'cost', 'special', 'escape', 'hardness',
  'melee', 'ranged', 'range', 'area', 'targets', 'duration', 'defense', 'cast', 'heightened', 'damage',
]);

// Strong starts (an action glyph or a rules keyword follows the name) may
// come right after a list ("... sky signs Collect Thunder [free-action]");
// weak starts (traits, a page reference, a passive ability's first
// sentence) need a sentence end before them.
const START = new RegExp(
  String.raw`(?:(?<=^|\s)(${NAME})(?=\s(?:${GLYPHS}|${KEYWORD}))|(?:^|(?<=[.)\]]\s|\d\s))(${NAME})(?=\s(?:${TRAITS}|${PAGE}|${OPENER})))`,
  'g',
);

/** First words that open a sentence, never an ability name. */
const NOT_FIRST = new Set(['As', 'See', 'Then', 'On', 'In', 'If', 'When', 'While', 'Each', 'The', 'This', 'That', 'Its', 'It', 'Any', 'All', 'For', 'After', 'Until', 'With']);

function field(text: string, key: string): string | undefined {
  const m = new RegExp(String.raw`\b${key}\s(.+?)(?:;\s(?=(?:Frequency|Trigger|Requirements|Effect)\b)|$)`).exec(text);
  return m ? m[1]!.trim().replace(/[;.]$/, '') : undefined;
}

export function parseAbilities(text: string): { abilities: ParsedAbility[]; rest: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  const starts: { at: number; name: string }[] = [];
  START.lastIndex = 0;
  for (let m = START.exec(t); m; m = START.exec(t)) {
    const name = (m[1] ?? m[2])!;
    if (NOT_NAMES.has(name.toLowerCase()) || /^Stage\s\d/.test(name)) continue;
    // A sentence opener ("As Trample ...") is never a name; "All-Around
    // Vision" is fine because its first word is "All-Around".
    if (NOT_FIRST.has(name.split(' ')[0]!)) continue;
    starts.push({ at: m.index, name });
  }
  const abilities: ParsedAbility[] = [];
  for (let i = 0; i < starts.length; i++) {
    const { at, name } = starts[i]!;
    let body = t.slice(at + name.length, starts[i + 1]?.at ?? t.length).trim();
    let cost: AbilityCost = 'passive';
    let costTo: ParsedAbility['costTo'];
    const g = new RegExp(String.raw`^\[(one-action|two-actions|three-actions|reaction|free-action)\](?:\s(?:to|or)\s\[(one-action|two-actions|three-actions)\])?\s*`).exec(body);
    if (g) {
      cost = GLYPH[g[1]!]!;
      // "[one-action] to [three-actions]"; "[free-action] or [one-action]" keeps the first.
      if (g[2] && g[2] !== 'one-action') costTo = GLYPH[g[2]] as '2' | '3';
      body = body.slice(g[0].length);
    }
    let traits: string[] = [];
    const tr = new RegExp(String.raw`^${TRAITS}\s*`).exec(body);
    if (tr && !/^\(page\s\d+\)/.test(tr[0])) {
      traits = tr[0].trim().slice(1, -1).split(/,\s?/).map((x) => x.trim()).filter(Boolean);
      body = body.slice(tr[0].length);
    }
    const frequency = field(body, 'Frequency');
    const trigger = field(body, 'Trigger');
    const requirements = field(body, 'Requirements');
    abilities.push({
      name: name.replace(/’/g, "'"),
      cost,
      ...(costTo ? { costTo } : {}),
      traits,
      ...(frequency ? { frequency } : {}),
      ...(trigger ? { trigger } : {}),
      ...(requirements ? { requirements } : {}),
      text: body.trim(),
    });
  }
  return { abilities, rest: starts.length ? t.slice(0, starts[0]!.at).trim() : t };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * PF2e-style description HTML: Frequency/Trigger/Requirements as bold-led
 * paragraphs, then the effect, then success degrees on their own lines.
 */
export function abilityDescriptionHtml(a: ParsedAbility): string {
  let body = esc(a.text);
  body = body.replace(/\b(Frequency|Trigger|Requirements|Effect)\s/g, '</p><p><strong>$1</strong> ');
  body = body.replace(/\s(Critical Success|Success|Failure|Critical Failure)\s(?=[A-Z])/g, '</p><p><strong>$1</strong> ');
  body = body.replace(/;\s*<\/p>/g, '</p>');
  const html = `<p>${body}</p>`.replace(/<p>\s*<\/p>/g, '');
  const range = a.costTo ? `<p><em>Uses 1 to ${a.costTo} actions.</em></p>` : '';
  return range + html;
}
