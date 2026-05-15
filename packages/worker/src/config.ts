import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Find the .env file. pnpm runs workspace scripts with CWD set to the package
// directory, so we can't just call `dotenv/config` and trust the default. We
// walk upward from this file's location looking for either:
//   - a sibling .env file at the monorepo root (containing pnpm-workspace.yaml)
//   - a .env file in the directly resolved working directory
// First hit wins.
function findEnvFile(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, '.env'))) {
      return join(dir, '.env');
    }
    const next = dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  // Fallback: CWD (works for users who set the env var directly or who run
  // the worker outside the monorepo)
  if (existsSync(join(process.cwd(), '.env'))) {
    return join(process.cwd(), '.env');
  }
  return null;
}

const envPath = findEnvFile();
if (envPath) {
  loadDotenv({ path: envPath });
}

/**
 * Worker configuration. All values come from environment variables or have
 * sensible defaults. Loaded once at startup; reads from process.env which
 * dotenv has populated from the monorepo root .env file.
 */
export interface WorkerConfig {
  /** Anthropic API key for Claude calls. Required. */
  apiKey: string;
  /** Claude model identifier. */
  model: string;
  /** Maximum output tokens per call. Sonnet supports up to 8192. */
  maxOutputTokens: number;
  /** Soft cap on input tokens before we abort. Prevents runaway costs. */
  maxInputTokens: number;
  /** When true, skip the cost-confirmation prompt. */
  skipConfirmation: boolean;
}

export function loadConfig(): WorkerConfig {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const looked = envPath ?? '(no .env file found)';
    throw new Error(
      `ANTHROPIC_API_KEY is not set.\n` +
        `  Looked at: ${looked}\n` +
        `  Add the key to .env at the monorepo root (containing pnpm-workspace.yaml),\n` +
        `  or set ANTHROPIC_API_KEY in your shell before running.`,
    );
  }

  return {
    apiKey,
    // Default to the latest Sonnet. Override via CLI flag when needed.
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    // 32K is conservative for full-adventure extractions. Sonnet 4.5 supports
    // up to 64K output tokens. The cost is per actual output, not the cap.
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS ?? 32000),
    maxInputTokens: Number(process.env.MAX_INPUT_TOKENS ?? 150000),
    skipConfirmation: process.env.SKIP_CONFIRMATION === 'true',
  };
}

/**
 * Pricing in dollars per million tokens. Used for cost estimation only —
 * actual billing comes from Anthropic. Keep this updated when prices change.
 *
 * Source: https://www.anthropic.com/pricing (Sonnet 4.5 at time of writing)
 */
export const PRICING = {
  inputPerMillion: 3.0,
  outputPerMillion: 15.0,
} as const;

export function estimateCost(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICING.inputPerMillion +
    (outputTokens / 1_000_000) * PRICING.outputPerMillion
  );
}

/**
 * Rough heuristic: ~4 characters per token for English text. Good enough for
 * a cost-estimate prompt before we make the actual call.
 */
export function estimateTokensFromText(text: string): number {
  return Math.ceil(text.length / 4);
}
