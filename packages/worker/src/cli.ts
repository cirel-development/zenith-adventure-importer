#!/usr/bin/env node
import { writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, estimateCost, estimateTokensFromText } from './config.js';
import { extractPdf } from './pdf/extract.js';
import { AiClient } from './ai/client.js';
import { extractAdventure } from './pipeline/extractAdventure.js';
import { assembleBundle, validateAndZip } from './bundle/assemble.js';

// ============================================================================
// Arg parsing — simple, no external dependency
// ============================================================================

interface ParsedArgs {
  command: string;
  input?: string;
  output?: string;
  yes: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { command: '', yes: false, help: false };
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    out.help = true;
    return out;
  }

  out.command = args[0]!;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--output' || a === '-o') {
      out.output = args[++i];
    } else if (a === '--input' || a === '-i') {
      out.input = args[++i];
    } else if (a === '--yes' || a === '-y') {
      out.yes = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else if (!out.input && !a.startsWith('-')) {
      // Positional input: `zenith-worker process foo.pdf`
      out.input = a;
    }
  }
  return out;
}

function printUsage(): void {
  console.log(`zenith-worker — Phase 1

Usage:
  zenith-worker process <input.pdf> [--output bundle.zip] [--yes]

Options:
  --output, -o  Output zip path (default: <input>.bundle.zip)
  --yes,    -y  Skip the cost confirmation prompt
  --help,   -h  Show this message

Required environment variables:
  ANTHROPIC_API_KEY   Your Anthropic API key (or set it in .env)

Optional environment variables:
  ANTHROPIC_MODEL     Model to use (default: claude-sonnet-4-5)
  MAX_INPUT_TOKENS    Abort if PDF estimate exceeds this (default: 150000)
  MAX_OUTPUT_TOKENS   Maximum response tokens (default: 8192)
`);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} (y/N): `);
  rl.close();
  return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
}

// ============================================================================
// Main: process command
// ============================================================================

async function runProcess(args: ParsedArgs): Promise<void> {
  if (!args.input) {
    console.error('Error: missing input PDF path');
    printUsage();
    process.exit(1);
  }

  const inputPath = resolve(args.input);
  const outputPath = resolve(
    args.output ?? args.input.replace(/\.pdf$/i, '.bundle.zip'),
  );

  // Verify the input exists before doing anything else
  try {
    await stat(inputPath);
  } catch {
    console.error(`Error: input file not found: ${inputPath}`);
    process.exit(1);
  }

  const config = loadConfig();
  const totalStart = performance.now();

  // -------- Step 1: extract PDF --------
  console.log(`\n[1/4] Reading PDF: ${inputPath}`);
  const step1Start = performance.now();
  const pdf = await extractPdf(inputPath);
  const step1Ms = Math.round(performance.now() - step1Start);
  console.log(
    `      ${pdf.pageCount} pages, ${pdf.totalCharacters.toLocaleString()} characters (${step1Ms}ms)`,
  );

  if (pdf.totalCharacters === 0) {
    console.error('Error: extracted 0 characters from PDF. Is the PDF scanned (image-only)?');
    console.error('       Phase 1 does not include OCR. Try a born-digital PDF.');
    process.exit(1);
  }

  // -------- Cost estimate + confirmation --------
  const inputTokenEstimate = estimateTokensFromText(pdf.pages.join('\n\n'));
  // Heuristic: structured extraction outputs typically run 20-40% of input
  // size in tokens (locations have prose, NPCs have descriptions, etc).
  // Use 30% as a midpoint, capped at the configured max.
  const expectedOutputTokens = Math.min(
    config.maxOutputTokens,
    Math.ceil(inputTokenEstimate * 0.3),
  );
  const costEstimate = estimateCost(inputTokenEstimate, expectedOutputTokens);

  console.log(`\n[2/4] Cost estimate`);
  console.log(`      Model:           ${config.model}`);
  console.log(`      Input tokens:    ~${inputTokenEstimate.toLocaleString()}`);
  console.log(
    `      Output tokens:   ~${expectedOutputTokens.toLocaleString()} estimated (cap: ${config.maxOutputTokens.toLocaleString()})`,
  );
  console.log(`      Estimated cost:  $${costEstimate.toFixed(3)}`);

  if (inputTokenEstimate > config.maxInputTokens) {
    console.error(
      `\nError: input estimate (${inputTokenEstimate.toLocaleString()} tokens) exceeds MAX_INPUT_TOKENS (${config.maxInputTokens.toLocaleString()}).`,
    );
    console.error('       Use a shorter PDF, or set MAX_INPUT_TOKENS higher.');
    process.exit(1);
  }

  if (!args.yes && !config.skipConfirmation) {
    const proceed = await confirm('\nProceed with this run?');
    if (!proceed) {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // -------- Step 3: AI extraction --------
  console.log(`\n[3/4] Calling Claude for adventure extraction`);
  const step3Start = performance.now();
  const ai = new AiClient(config);
  const { adventure, usage } = await extractAdventure(ai, pdf);
  const step3Ms = Math.round(performance.now() - step3Start);

  console.log(`      Title:           ${adventure.title}`);
  console.log(`      Chapters:        ${adventure.chapters.length}`);
  console.log(
    `      Locations:       ${adventure.chapters.reduce((n, c) => n + c.locations.length, 0)}`,
  );
  console.log(`      NPCs:            ${adventure.npcs.length}`);
  console.log(`      Items:           ${adventure.items.length}`);
  console.log(`      Encounters:      ${adventure.encounters.length}`);
  console.log(`      Input tokens:    ${usage.inputTokens.toLocaleString()}`);
  console.log(`      Output tokens:   ${usage.outputTokens.toLocaleString()}`);
  console.log(`      Actual cost:     $${usage.estimatedCost.toFixed(4)}`);
  console.log(`      Time:            ${(step3Ms / 1000).toFixed(1)}s`);

  // -------- Step 4: assemble + validate + write --------
  console.log(`\n[4/4] Assembling bundle`);
  const step4Start = performance.now();

  // Re-read PDF bytes for the hash (cheap on small files). Could optimize by
  // keeping the buffer from step 1 — not worth it for a few MB of memory.
  const { readFile } = await import('node:fs/promises');
  const pdfBytes = new Uint8Array(await readFile(inputPath));

  const bundle = assembleBundle(adventure, {
    pdfBytes,
    aiTokens: { input: usage.inputTokens, output: usage.outputTokens },
  });
  const { zip, warnings } = validateAndZip(bundle);
  await writeFile(outputPath, zip);
  const step4Ms = Math.round(performance.now() - step4Start);

  console.log(`      Output:          ${outputPath}`);
  console.log(`      Size:            ${(zip.length / 1024).toFixed(1)} KB`);
  console.log(`      Time:            ${step4Ms}ms`);

  if (warnings.length > 0) {
    console.log(`\nWarnings (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }

  const totalMs = Math.round(performance.now() - totalStart);
  console.log(`\nDone in ${(totalMs / 1000).toFixed(1)}s. Import via the Foundry module to test.`);
}

// ============================================================================
// Entry point
// ============================================================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printUsage();
    return;
  }

  switch (args.command) {
    case 'process':
      await runProcess(args);
      break;
    default:
      console.error(`Unknown command: ${args.command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`\nError: ${err.message}`);
  if (process.env.DEBUG) {
    console.error(err.stack);
  }
  process.exit(1);
});
