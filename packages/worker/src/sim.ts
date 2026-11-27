/**
 * Simulated extraction: run the worker pipeline without calling the API.
 *
 *   prepare  <input.pdf> [--output <dir>]
 *     Extracts the PDF and writes exactly what the API would receive:
 *       system-prompt.md, user-message.md, tool-schema.json, and
 *       INSTRUCTIONS.md for whoever plays the model (a Claude Code subagent).
 *     Cost: $0.
 *
 *   assemble <input.pdf> --extraction <extraction.json> [--output bundle.zip]
 *     Validates a tool-call JSON with the same Zod schema as the API path,
 *     then runs the real assembler + contract validator and writes the zip.
 *     Cost: $0.
 *
 * Everything except the model call is the production code path.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { extractPdf } from './pdf/extract.js';
import {
  EXTRACT_TOOL_DESCRIPTION,
  EXTRACT_TOOL_NAME,
  EXTRACT_TOOL_SCHEMA,
  SYSTEM_PROMPT,
  buildUserMessage,
  parseExtraction,
} from './pipeline/extractAdventure.js';
import { assembleBundle, validateAndZip } from './bundle/assemble.js';
import { estimateTokensFromText } from './config.js';
import { CompendiumIndex } from './compendium/index.js';
import type { Bundle } from '@ai-adventure/contract';
import {
  FALLBACK_SYSTEM,
  FALLBACK_TOOL_NAME,
  FALLBACK_TOOL_SCHEMA,
  applyFallbackAnswers,
  buildFallbackMessage,
  collectFallbackCandidates,
  parseFallbackAnswer,
  planFallbackBatches,
  type FallbackCandidate,
} from './statblock/ai-fallback.js';
import type { ParsedStatBlock } from './statblock/parse.js';

/** MAX_OUTPUT_TOKENS without requiring an API key (sim runs have none). */
function loadMaxOutputTokens(): number {
  const n = Number(process.env['MAX_OUTPUT_TOKENS']);
  return Number.isFinite(n) && n > 0 ? n : 32000;
}

/** One line per actor: compendium match (pack, review flag) or custom. */
export function printMatchSummary(bundle: Bundle): void {
  const actors = bundle.actors.entities;
  const refs = actors.filter((a) => a.stat_block.kind === 'compendium-ref');
  const parsed = actors.filter((a) => a.ai_metadata?.prompt_version?.startsWith('statblock-'));
  console.log(`Compendium matches: ${refs.length}, parsed from PDF: ${parsed.length}, of ${actors.length} actors`);
  for (const a of actors) {
    const sb = a.stat_block;
    const where =
      sb.kind === 'compendium-ref'
        ? sb.uuid.split('.').slice(2, 3)[0]
        : a.ai_metadata?.prompt_version?.startsWith('statblock-')
          ? `parsed (conf ${a.ai_metadata.confidence})`
          : 'placeholder';
    const flag = a.ai_metadata?.review_required ? '  [review]' : '';
    console.log(`  ${a.category.padEnd(9)} ${a.name.padEnd(26)} ${where}${flag}`);
  }
}

export async function runPrepare(inputPdf: string, outDir?: string): Promise<void> {
  const inputPath = resolve(inputPdf);
  const dir = resolve(outDir ?? inputPath.replace(/\.pdf$/i, '.sim'));
  await mkdir(dir, { recursive: true });

  const pdf = await extractPdf(inputPath);
  if (pdf.totalCharacters === 0) throw new Error('extracted 0 characters from PDF (scanned/image-only?)');
  const userMessage = buildUserMessage(pdf);

  await writeFile(join(dir, 'system-prompt.md'), SYSTEM_PROMPT, 'utf8');
  await writeFile(join(dir, 'user-message.md'), userMessage, 'utf8');
  await writeFile(
    join(dir, 'tool-schema.json'),
    JSON.stringify({ name: EXTRACT_TOOL_NAME, description: EXTRACT_TOOL_DESCRIPTION, input_schema: EXTRACT_TOOL_SCHEMA }, null, 2),
    'utf8',
  );
  await writeFile(
    join(dir, 'INSTRUCTIONS.md'),
    `# Simulated extraction for ${basename(inputPath)}

You are standing in for the production model in a single tool-use call.

1. Read \`system-prompt.md\`: it is your system prompt. Follow it exactly.
2. Read \`user-message.md\`: it is the user turn (the full adventure text).
3. Read \`tool-schema.json\`: the \`${EXTRACT_TOOL_NAME}\` tool you must call once.
4. Write the tool call's \`input\` object (only that object, valid JSON) to
   \`extraction.json\` in this folder.

Rules: work only from the adventure text; invent nothing it does not say;
respect every \`required\` field and enum in the schema.
`,
    'utf8',
  );

  console.log(`Prepared simulated extraction in ${dir}`);
  console.log(`  pages: ${pdf.pageCount}, characters: ${pdf.totalCharacters.toLocaleString()}`);
  console.log(`  user message tokens (estimate): ~${estimateTokensFromText(userMessage).toLocaleString()}`);
  console.log(`Next: have the model write ${join(dir, 'extraction.json')}, then run:`);
  console.log(`  zenith-worker assemble "${inputPath}" --extraction "${join(dir, 'extraction.json')}"`);
}

export interface AssembleSimOptions {
  /** Answer from the stand-in model for the stat-block fallback request. */
  fallbackPath?: string;
  /** Confidence below which a parsed block goes to the fallback (default 0.7). */
  fallbackThreshold?: number;
  /** Testing: skip compendium matching so every NPC goes through the parser. */
  noCompendium?: boolean;
}

/**
 * Write the stat-block fallback request exactly as the API would receive it
 * (one request file per batch), for a stand-in model to answer.
 */
async function writeFallbackRequest(dir: string, candidates: FallbackCandidate[], maxOutputTokens: number): Promise<void> {
  const batches = planFallbackBatches(candidates, maxOutputTokens);
  await writeFile(join(dir, 'fallback-system-prompt.md'), FALLBACK_SYSTEM, 'utf8');
  await writeFile(
    join(dir, 'fallback-tool-schema.json'),
    JSON.stringify({ name: FALLBACK_TOOL_NAME, description: 'Submit the parsed stat blocks.', input_schema: FALLBACK_TOOL_SCHEMA }, null, 2),
    'utf8',
  );
  for (const [i, batch] of batches.entries()) {
    await writeFile(join(dir, `fallback-request-${i + 1}.md`), buildFallbackMessage(batch), 'utf8');
  }
  await writeFile(
    join(dir, 'FALLBACK-INSTRUCTIONS.md'),
    `# Simulated stat-block fallback

You are standing in for the production model. For each fallback-request-N.md
(${batches.length} batch${batches.length === 1 ? '' : 'es'}), follow fallback-system-prompt.md and answer as one call
of the \`${FALLBACK_TOOL_NAME}\` tool (schema: fallback-tool-schema.json).
Write all batches' blocks into ONE file, fallback.json, shaped as the tool
input: { "blocks": [ ... ] }. Keep every block's id exactly as given.
`,
    'utf8',
  );
}

export async function runAssemble(inputPdf: string, extractionPath: string, output?: string, simOpts: AssembleSimOptions = {}): Promise<void> {
  const inputPath = resolve(inputPdf);
  const outputPath = resolve(output ?? inputPath.replace(/\.pdf$/i, '.sim.bundle.zip'));

  const raw = JSON.parse(await readFile(resolve(extractionPath), 'utf8')) as unknown;
  // Accept either the bare tool input or a wrapper { input: {...} }.
  const data =
    raw && typeof raw === 'object' && 'input' in raw && !('title' in raw) ? (raw as { input: unknown }).input : raw;
  const adventure = parseExtraction(data, 'Simulated extraction');

  const pdfBytes = new Uint8Array(await readFile(inputPath));
  const compendium = simOpts.noCompendium ? undefined : CompendiumIndex.load();
  const pdf = await extractPdf(inputPath);
  const pdfText = pdf.pages.join('\n\n');

  // Stat-block fallback: blocks the regex parser could not read with confidence.
  const candidates = collectFallbackCandidates(adventure, pdfText, compendium, simOpts.fallbackThreshold);
  let statBlockFixes: Map<string, ParsedStatBlock> | undefined;
  if (candidates.length) {
    console.log(`Stat-block fallback: ${candidates.length} low-confidence block(s): ${candidates.map((c) => `${c.name} (${c.confidence})`).join(', ')}`);
    if (simOpts.fallbackPath) {
      const answers = parseFallbackAnswer(JSON.parse(await readFile(resolve(simOpts.fallbackPath), 'utf8')));
      statBlockFixes = applyFallbackAnswers(candidates, answers);
      console.log(`  applied answers for ${statBlockFixes.size} of ${candidates.length}`);
    } else {
      const dir = dirname(resolve(extractionPath));
      await writeFallbackRequest(dir, candidates, loadMaxOutputTokens());
      console.log(`  wrote the fallback request to ${dir} (FALLBACK-INSTRUCTIONS.md); bundle built from the regex parse only.`);
      console.log(`  after the stand-in model writes fallback.json, rerun with --fallback "${join(dir, 'fallback.json')}"`);
    }
  }

  const bundle = assembleBundle(adventure, { pdfBytes, compendium, pdfText, statBlockFixes });
  printMatchSummary(bundle);
  const { zip, warnings } = validateAndZip(bundle);
  await writeFile(outputPath, zip);

  const locations = adventure.chapters.reduce((n, c) => n + c.locations.length, 0);
  console.log(`Assembled ${outputPath} (${(zip.length / 1024).toFixed(1)} KB)`);
  console.log(
    `  chapters ${adventure.chapters.length}, locations ${locations}, npcs ${adventure.npcs.length}, ` +
      `hazards ${adventure.hazards.length}, items ${adventure.items.length}, encounters ${adventure.encounters.length}`,
  );
  if (warnings.length) {
    console.log(`Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
}
