/**
 * v0.2.2: a stat block's printed "Items" list -> inventory lookups.
 *
 *   "+1 striking scimitar, daggers (2), heavy crossbow (10 bolts),
 *    durable farm clothes (counts as padded armor)"
 *
 * Each entry gives the printed text, the name to look up, a quantity
 * ("(2)", a leading "2"), any parenthetical note ("10 bolts"), and a
 * stand-in base when the book says "functions as a dagger" / "counts as
 * padded armor". Item names print in lowercase, so text from the first
 * Capitalized word outside parentheses on is an ability that ran into the
 * list ("... (functions as a dagger) Cloud of Visions (aura) ..."); it is
 * returned as `leftover`.
 */

export interface InventoryLine {
  printed: string;
  name: string;
  quantity: number;
  note?: string;
  /** "functions as a dagger" -> "dagger". */
  standIn?: string;
}

const WORD_NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twenty: 20 };

/** Cut at the first Capitalized word outside parentheses, keeping what follows. */
function cutAtCapital(s: string): { head: string; tail: string } {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && /[A-Z]/.test(ch) && (i === 0 || s[i - 1] === ' ') && /[a-z]/.test(s[i + 1] ?? '')) {
      if (i === 0) return { head: '', tail: s };
      return { head: s.slice(0, i).trim(), tail: s.slice(i).trim() };
    }
  }
  return { head: s.trim(), tail: '' };
}

/** "daggers" -> "dagger", "javelins" -> "javelin"; leaves "glass" alone. */
export function singular(name: string): string {
  return name
    .replace(/(\w)ies$/, '$1y')
    .replace(/(\w(?:ch|sh|x))es$/, '$1')
    .replace(/(\w[^s])s$/, '$1');
}

export function parseInventoryLine(items: string[]): { entries: InventoryLine[]; leftover: string } {
  const entries: InventoryLine[] = [];
  let leftover = '';
  for (let i = 0; i < items.length; i++) {
    const { head, tail } = cutAtCapital(items[i]!.replace(/’/g, "'"));
    if (tail) {
      // Everything after an ability name begins is ability text, including later "items".
      leftover = [tail, ...items.slice(i + 1)].join(', ');
      if (!head) break;
    }
    let name = head;
    let quantity = 1;
    let note: string | undefined;
    let standIn: string | undefined;
    const notes: string[] = [];
    name = name.replace(/\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_m, inner: string) => {
      const t = inner.trim();
      if (/^\d+$/.test(t)) quantity = Number(t);
      else {
        const s = /^(?:functions|counts)\s+as\s+(?:an?\s+)?(.+)$/i.exec(t);
        if (s) standIn = s[1]!.trim();
        else if (!/^page\s\d+$/i.test(t)) notes.push(t);
      }
      return '';
    });
    const lead = /^(\d+|two|three|four|five|six|ten|twenty)\s+(.+)$/i.exec(name.trim());
    if (lead) {
      quantity = /^\d+$/.test(lead[1]!) ? Number(lead[1]) : WORD_NUM[lead[1]!.toLowerCase()]!;
      name = lead[2]!;
    }
    if (notes.length) note = notes.join('; ');
    name = name.trim();
    if (!name) continue;
    entries.push({ printed: head, name, quantity, ...(note ? { note } : {}), ...(standIn ? { standIn } : {}) });
    if (tail) break;
  }
  return { entries, leftover };
}
