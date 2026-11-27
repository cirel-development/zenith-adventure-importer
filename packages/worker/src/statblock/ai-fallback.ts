/**
 * Phase 2B task 5: AI fallback for stat blocks the regex parser could not
 * read with confidence (default: below 0.7).
 *
 * Decided 2026-11-27: one batched request for all misses, split
 * automatically when the estimated output would exceed the budget.
 * The model sees each block's verbatim text and returns the same fields the
 * regex parser produces; the merge keeps every value the regex DID read and
 * only fills what it missed.
 *
 * Until release, tests run this through a simulated model (see sim.ts);
 * runFallback() is the production path and is not called in testing.
 */
import { z } from 'zod';
import type { AiClient } from '../ai/client.js';
import { normalizeName } from '../compendium/index.js';
import type { CompendiumIndex } from '../compendium/index.js';
import { planActorMatches } from '../compendium/match.js';
import { indexBlocks, linkStatBlock } from './link.js';
import { normalizeDashes, scanStatBlocks } from './scan.js';
import type { ParsedStatBlock } from './parse.js';

export const FALLBACK_THRESHOLD = 0.7;
export const FALLBACK_TOOL_NAME = 'submit_stat_blocks';

export interface FallbackCandidate {
  /** Key used to merge the answer back: normalized NPC name. */
  id: string;
  name: string;
  text: string;
  regex: ParsedStatBlock;
  missing: string[];
  confidence: number;
}

/** NPCs that will use a parsed block (no compendium match) whose parse is below the threshold. */
export function collectFallbackCandidates(
  extracted: { title: string; npcs: { name: string; level: number | null }[]; hazards: { name: string; level: number | null }[] },
  pdfText: string,
  compendium: CompendiumIndex | undefined,
  threshold = FALLBACK_THRESHOLD,
): FallbackCandidate[] {
  const plan = compendium ? planActorMatches(compendium, extracted) : null;
  const blocks = scanStatBlocks(pdfText);
  const byName = indexBlocks(blocks);
  // Block offsets refer to the dash-normalized text the scanner works on.
  const pdfTextNorm = normalizeDashes(pdfText);
  const out: FallbackCandidate[] = [];
  extracted.npcs.forEach((npc, i) => {
    if (plan?.npcs[i]) return; // compendium wins; no parse needed
    const linked = linkStatBlock(npc.name, byName);
    if (!linked || linked.parse.confidence >= threshold) return;
    // Low confidence often means the block was cut short (page break,
    // sidebar), so include the text that follows it, up to the next block,
    // for the model to find the rest. The system prompt says to ignore noise.
    const nextStart = blocks.find((b) => b.start > linked.scanned.start)?.start ?? pdfText.length;
    const tail = pdfTextNorm.slice(linked.scanned.end, Math.min(nextStart, linked.scanned.end + 2500)).trim();
    const own = linked.base ? `${linked.base.text}\n\n${linked.scanned.text}` : linked.scanned.text;
    const text = tail ? `${own}\n[text that follows the block in the PDF, may contain its continuation:]\n${tail}` : own;
    out.push({
      id: normalizeName(npc.name),
      name: npc.name,
      text,
      regex: linked.parse.block,
      missing: linked.parse.missing,
      confidence: linked.parse.confidence,
    });
  });
  return out;
}

/** Output-token estimate for one block: structured JSON runs ~1.3x the block's text tokens. */
export function estimateOutputTokens(c: FallbackCandidate): number {
  return Math.ceil((c.text.length / 4) * 1.3) + 200;
}

/** Split candidates into batches whose estimated output fits 80% of the budget. */
export function planFallbackBatches(candidates: FallbackCandidate[], maxOutputTokens: number): FallbackCandidate[][] {
  const budget = Math.floor(maxOutputTokens * 0.8);
  const batches: FallbackCandidate[][] = [];
  let cur: FallbackCandidate[] = [];
  let used = 0;
  for (const c of candidates) {
    const est = estimateOutputTokens(c);
    if (cur.length && used + est > budget) {
      batches.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(c);
    used += est;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

export const FALLBACK_SYSTEM = `You read Pathfinder 2e creature stat blocks and return their numbers as structured data.

Rules:
- Use only what the block text says. If a value is not printed, use null (or an empty list). Never estimate or invent numbers.
- Numbers keep their sign: "+7" is 7, "-2" or "–2" is -2.
- traits: the lowercase trait words from the line under the name, without rarity, alignment or size.
- size: tiny, small, medium, large, huge or gargantuan.
- strikes: every "Melee" and "Ranged" line. damage is a list of parts ("1d8+4 piercing plus 1d6 persistent fire" is two parts). effects: words after "plus" that are not damage, such as "Grab". For a strike printed with "Effect" instead of "Damage", leave damage empty and put the effect text in effects.
- abilitiesText: everything after the strikes (special abilities, spells), verbatim.
- A block may be printed as two parts: a base creature followed by a variant that lists only changes. Return the variant, with the base filling what the variant does not change.
- Return one entry per block, with the block's id exactly as given.`;

export function buildFallbackMessage(batch: FallbackCandidate[]): string {
  return [
    `Here are ${batch.length} stat block(s). Call the \`${FALLBACK_TOOL_NAME}\` tool once with one entry per block.`,
    ...batch.map((c) => `--- BLOCK id="${c.id}" name="${c.name}" ---\n${c.text}`),
  ].join('\n\n');
}

const nullableInt = { type: ['integer', 'null'] };
export const FALLBACK_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          level: { type: 'integer' },
          rarity: { type: 'string', enum: ['common', 'uncommon', 'rare', 'unique'] },
          alignment: { type: ['string', 'null'] },
          size: { type: ['string', 'null'], enum: ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan', null] },
          traits: { type: 'array', items: { type: 'string' } },
          perception: nullableInt,
          senses: { type: 'array', items: { type: 'string' } },
          languages: { type: 'array', items: { type: 'string' } },
          skills: {
            type: 'array',
            items: { type: 'object', properties: { name: { type: 'string' }, bonus: { type: 'integer' }, note: { type: 'string' } }, required: ['name', 'bonus'] },
          },
          attributes: {
            type: ['object', 'null'],
            properties: Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map((k) => [k, { type: 'integer' }])),
          },
          items: { type: 'array', items: { type: 'string' } },
          ac: nullableInt,
          saves: {
            type: ['object', 'null'],
            properties: { fortitude: { type: 'integer' }, reflex: { type: 'integer' }, will: { type: 'integer' } },
          },
          hp: nullableInt,
          immunities: { type: 'array', items: { type: 'string' } },
          weaknesses: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'integer' } } } },
          resistances: { type: 'array', items: { type: 'object', properties: { type: { type: 'string' }, value: { type: 'integer' } } } },
          speeds: {
            type: ['object', 'null'],
            properties: Object.fromEntries(['land', 'fly', 'swim', 'climb', 'burrow'].map((k) => [k, { type: 'integer' }])),
          },
          strikes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['melee', 'ranged'] },
                name: { type: 'string' },
                bonus: { type: 'integer' },
                traits: { type: 'array', items: { type: 'string' } },
                damage: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { formula: { type: 'string' }, type: { type: ['string', 'null'] }, persistent: { type: 'boolean' } },
                    required: ['formula'],
                  },
                },
                effects: { type: 'array', items: { type: 'string' } },
              },
              required: ['kind', 'name', 'bonus'],
            },
          },
          abilitiesText: { type: 'string' },
        },
        required: ['id', 'name', 'level'],
      },
    },
  },
  required: ['blocks'],
};

const intOrNull = z.number().int().nullable().optional().transform((v) => v ?? null);
const AnswerZ = z.object({
  blocks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int(),
      rarity: z.enum(['common', 'uncommon', 'rare', 'unique']).optional().default('common'),
      alignment: z.string().nullable().optional().default(null),
      size: z.enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan']).nullable().optional().default(null),
      traits: z.array(z.string()).optional().default([]),
      perception: intOrNull,
      senses: z.array(z.string()).optional().default([]),
      languages: z.array(z.string()).optional().default([]),
      skills: z.array(z.object({ name: z.string(), bonus: z.number().int(), note: z.string().optional() })).optional().default([]),
      attributes: z
        .object({ str: z.number().int(), dex: z.number().int(), con: z.number().int(), int: z.number().int(), wis: z.number().int(), cha: z.number().int() })
        .nullable()
        .optional()
        .default(null),
      items: z.array(z.string()).optional().default([]),
      ac: intOrNull,
      saves: z.object({ fortitude: z.number().int(), reflex: z.number().int(), will: z.number().int() }).nullable().optional().default(null),
      hp: intOrNull,
      immunities: z.array(z.string()).optional().default([]),
      weaknesses: z.array(z.object({ type: z.string(), value: z.number().int() })).optional().default([]),
      resistances: z.array(z.object({ type: z.string(), value: z.number().int() })).optional().default([]),
      speeds: z.record(z.string(), z.number().int()).nullable().optional().default(null),
      strikes: z
        .array(
          z.object({
            kind: z.enum(['melee', 'ranged']),
            name: z.string(),
            bonus: z.number().int(),
            traits: z.array(z.string()).optional().default([]),
            damage: z
              .array(z.object({ formula: z.string(), type: z.string().nullable().optional().default(null), persistent: z.boolean().optional().default(false) }))
              .optional()
              .default([]),
            effects: z.array(z.string()).optional().default([]),
          }),
        )
        .optional()
        .default([]),
      abilitiesText: z.string().optional().default(''),
    }),
  ),
});

/** Validate a tool answer; returns blocks keyed by id. Throws on malformed data. */
export function parseFallbackAnswer(data: unknown): Map<string, ParsedStatBlock> {
  const parsed = AnswerZ.parse(data);
  return new Map(
    parsed.blocks.map((b) => [
      b.id,
      {
        name: b.name,
        level: b.level,
        rarity: b.rarity,
        alignment: b.alignment,
        size: b.size,
        traits: b.traits.map((t) => t.toLowerCase()),
        perception: b.perception,
        senses: b.senses,
        languages: b.languages,
        skills: b.skills,
        attributes: b.attributes,
        items: b.items,
        ac: b.ac,
        saves: b.saves,
        hp: b.hp,
        immunities: b.immunities,
        weaknesses: b.weaknesses,
        resistances: b.resistances,
        speeds: b.speeds && typeof b.speeds['land'] === 'number' ? (b.speeds as ParsedStatBlock['speeds']) : b.speeds ? { land: 0, ...b.speeds } : null,
        strikes: b.strikes.map((s) => ({
          ...s,
          damage: s.damage.map((d) => ({ formula: d.formula.replace(/\s/g, ''), type: d.type, persistent: d.persistent })),
          effectOnly: s.damage.length === 0,
        })),
        abilitiesText: b.abilitiesText,
        defensiveText: '',
      },
    ]),
  );
}

/** Keep every value the regex read; take the AI's value only where the regex has none. */
export function mergeFallback(regex: ParsedStatBlock, ai: ParsedStatBlock): ParsedStatBlock {
  const pick = <T>(r: T | null, a: T | null): T | null => (r === null || r === undefined ? a : r);
  const list = <T>(r: T[], a: T[]): T[] => (r.length ? r : a);
  return {
    ...regex,
    size: pick(regex.size, ai.size),
    alignment: pick(regex.alignment, ai.alignment),
    traits: list(regex.traits, ai.traits),
    perception: pick(regex.perception, ai.perception),
    senses: list(regex.senses, ai.senses),
    languages: list(regex.languages, ai.languages),
    skills: list(regex.skills, ai.skills),
    attributes: pick(regex.attributes, ai.attributes),
    items: list(regex.items, ai.items),
    ac: pick(regex.ac, ai.ac),
    saves: pick(regex.saves, ai.saves),
    hp: pick(regex.hp, ai.hp),
    immunities: list(regex.immunities, ai.immunities),
    weaknesses: list(regex.weaknesses, ai.weaknesses),
    resistances: list(regex.resistances, ai.resistances),
    speeds: pick(regex.speeds, ai.speeds),
    strikes: list(regex.strikes, ai.strikes),
    abilitiesText: regex.abilitiesText || ai.abilitiesText,
  };
}

/** Merge answers into the candidates' regex parses. Unanswered candidates are left out. */
export function applyFallbackAnswers(candidates: FallbackCandidate[], answers: Map<string, ParsedStatBlock>): Map<string, ParsedStatBlock> {
  const out = new Map<string, ParsedStatBlock>();
  for (const c of candidates) {
    const a = answers.get(c.id);
    if (a) out.set(c.id, mergeFallback(c.regex, a));
  }
  return out;
}

/** Production path: one request per batch. Not called before release (see sim). */
export async function runFallback(
  client: AiClient,
  candidates: FallbackCandidate[],
  maxOutputTokens: number,
): Promise<{ fixes: Map<string, ParsedStatBlock>; inputTokens: number; outputTokens: number; cost: number; batches: number }> {
  const answers = new Map<string, ParsedStatBlock>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  const batches = planFallbackBatches(candidates, maxOutputTokens);
  for (const batch of batches) {
    const result = await client.generateStructured<unknown>({
      system: FALLBACK_SYSTEM,
      userMessage: buildFallbackMessage(batch),
      tool: { name: FALLBACK_TOOL_NAME, description: 'Submit the parsed stat blocks.', input_schema: FALLBACK_TOOL_SCHEMA },
    });
    for (const [id, block] of parseFallbackAnswer(result.data)) answers.set(id, block);
    inputTokens += result.usage.inputTokens;
    outputTokens += result.usage.outputTokens;
    cost += result.usage.estimatedCost;
  }
  return { fixes: applyFallbackAnswers(candidates, answers), inputTokens, outputTokens, cost, batches: batches.length };
}
