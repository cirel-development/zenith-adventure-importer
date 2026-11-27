/**
 * Find PF2e stat blocks in extracted PDF text (Phase 2B task 4).
 *
 * pdfjs gives each page as one long run of text, so a block is located by
 * its header ("JINKIN RIPCLAWS (3) CREATURE 1") and classified by what follows:
 *
 *   full       "... CREATURE 2 UNIQUE N MEDIUM ANIMAL Perception +8; ..."
 *   variant    "... CREATURE 1 UNIQUE CE TINY FEY GREMLIN Variant jinkin ripclaw (page 5) ..."
 *   reference  "... CREATURE 3 Pathfinder Bestiary 40 Initiative ..." or "... Page 63 Initiative ..."
 *   hazard     "... HAZARD 2 MECHANICAL TRAP Stealth DC 20 ..."
 *
 * A block ends at the next header, at an all-caps sidebar heading after its
 * Speed line ("FIRST FIGHT As the battle..."), or after MAX_BLOCK characters.
 */

export type BlockForm = 'full' | 'variant' | 'reference' | 'hazard';

export interface ScannedBlock {
  /** Name as printed, title-cased: "Jinkin Ripclaws". */
  name: string;
  /** "(3)" after the name, when printed. */
  count: number | null;
  kind: 'creature' | 'hazard';
  level: number;
  form: BlockForm;
  /** Offsets into the scanned text. */
  start: number;
  end: number;
  /** Header through end, with dashes/minus signs normalized to "-". */
  text: string;
  /** For references: "Pathfinder Bestiary 40" or "Page 63". */
  reference?: string;
  /** For variants: base creature name and where it is printed. */
  variantOf?: { name: string; source: string };
  /** True when the end was found by MAX_BLOCK, not a header or heading. */
  endUncertain: boolean;
}

const MAX_BLOCK = 4000;
const HEADER_RE =
  /(?<![A-Za-z])((?:[A-Z][A-Z'’-]*\s){0,6}[A-Z][A-Z'’-]+)(?:\s\((\d+)\))?\s(CREATURE|HAZARD)\s(-?\d+)\b/g;

/** Unicode dashes and minus before digits become ASCII "-" so numbers parse. */
export function normalizeDashes(s: string): string {
  return s.replace(/[‐-―−](?=\s?\d)/g, '-').replace(/ /g, ' ');
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|[\s-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/\s(Of|The|And|In|On|An?)\b/g, (w) => w.toLowerCase());
}

export function scanStatBlocks(rawText: string): ScannedBlock[] {
  const text = normalizeDashes(rawText);
  const headers: { m: RegExpExecArray }[] = [];
  for (let m = HEADER_RE.exec(text); m; m = HEADER_RE.exec(text)) headers.push({ m });

  const blocks: ScannedBlock[] = [];
  headers.forEach(({ m }, i) => {
    const start = m.index;
    const headerEnd = m.index + m[0].length;
    const nextHeader = headers[i + 1]?.m.index ?? text.length;
    const after = text.slice(headerEnd, Math.min(nextHeader, headerEnd + MAX_BLOCK));
    const kind = m[3] === 'HAZARD' ? 'hazard' : 'creature';

    let form: BlockForm;
    let reference: string | undefined;
    let variantOf: ScannedBlock['variantOf'];
    const ref = /^\s*((?:Pathfinder|Starfinder) [A-Z][A-Za-z' ]*?\s\d+(?:,\s?\d+)*|Page \d+)\s+Initiative/.exec(after);
    if (kind === 'hazard') {
      form = 'hazard';
    } else if (ref) {
      form = 'reference';
      reference = ref[1]!.trim();
    } else {
      const variant = /^\s*(?:[A-Z]{1,12}\s){0,8}Variant\s+(.+?)\s*\(([^)]+)\)/.exec(after);
      form = variant ? 'variant' : 'full';
      if (variant) variantOf = { name: variant[1]!.trim(), source: variant[2]!.trim() };
    }

    // End: references are short; full/variant/hazard blocks end at an
    // all-caps heading that appears after their Speed (or Reset) line.
    let endRel = after.length;
    let endUncertain = headerEnd + MAX_BLOCK < nextHeader;
    let blockText: string | null = null;
    if (form === 'reference') {
      const r = /Initiative:?\s*Perception\s*[+-]?\d+[^A-Z]*/.exec(after);
      endRel = r ? r.index + r[0].length : Math.min(after.length, 120);
      endUncertain = false;
    } else {
      // An all-caps sidebar/section heading followed by prose ends the block.
      // Search only after the defense lines, so the trait line
      // ("LARGE ELEMENTAL FIRE Perception") is never mistaken for one.
      const headingAt = (from: number): number | null => {
        const re = /\s([A-Z][A-Z'’]+(?:\s[A-Z][A-Z'’]+)+[?!:]?)\s(?=[A-Z][a-z])/g;
        re.lastIndex = from;
        const h = re.exec(after);
        return h ? h.index : null;
      };
      const firstAt = (re: RegExp): number | null => re.exec(after)?.index ?? null;
      const speed = firstAt(/\bSpeed\s(?:\d|fly|swim|climb|burrow)/);
      const defense =
        form === 'hazard'
          ? firstAt(/\bReset\b|\bRoutine\b|\bDisable\b/)
          : firstAt(/\bHP\s\d/) ?? firstAt(/\bAC\s\d/) ?? firstAt(/\bPerception\b/);
      const from = speed ?? defense ?? 0;
      const h = headingAt(from);
      if (h !== null) {
        endRel = h;
        endUncertain = false;
        // Page split: the block continues after a sidebar, page footer or
        // chapter-navigation strip. Join the two parts and end at the next
        // heading. Two cases:
        //   - defenses, then the break, then "Speed ..." and the strikes;
        //   - "Speed ..." printed, then the break, then the strikes.
        if (form !== 'hazard') {
          const window = after.slice(h, Math.min(after.length, h + 3000));
          const strikeBeforeCut = speed !== null && /\b(?:Melee|Ranged)\s\[/.test(after.slice(speed, h));
          const cont =
            speed === null
              ? /\bSpeed\s(?:\d+\s?feet|fly|swim|climb|burrow)/.exec(window)
              : strikeBeforeCut
                ? null
                : /\b(?:Melee|Ranged)\s\[/.exec(window);
          if (cont) {
            const contStart = h + cont.index;
            const contEnd = headingAt(contStart) ?? after.length;
            blockText = `${text.slice(start, headerEnd + h)} ${after.slice(contStart, contEnd)}`;
            endRel = contEnd;
          }
        }
      }
    }

    blocks.push({
      name: titleCase(m[1]!.trim()),
      count: m[2] ? Number(m[2]) : null,
      kind,
      level: Number(m[4]),
      form,
      start,
      end: headerEnd + endRel,
      text: (blockText ?? text.slice(start, headerEnd + endRel)).trim(),
      ...(reference ? { reference } : {}),
      ...(variantOf ? { variantOf } : {}),
      endUncertain,
    });
  });
  return blocks;
}
