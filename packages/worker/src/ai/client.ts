import Anthropic from '@anthropic-ai/sdk';
import type { WorkerConfig } from '../config.js';
import { estimateCost } from '../config.js';

/**
 * The structured response we get back from an AI call. Includes the parsed
 * tool input (the actual data we asked for) plus usage stats so we can
 * report costs after the fact.
 */
export interface AiResult<T> {
  data: T;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema describing the expected tool input shape. */
  input_schema: Record<string, unknown>;
}

export class AiClient {
  private readonly client: Anthropic;

  constructor(private readonly config: WorkerConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
  }

  /**
   * Send a single request to Claude using tool-use to enforce a JSON schema.
   *
   * Claude is told to call a single tool with `input_schema`. The "result"
   * we want IS the tool's input — Claude's job is to populate it correctly
   * given the user message.
   *
   * Why tool-use instead of asking for JSON in prose:
   * - Tool schemas are validated by the API before the response is sent back,
   *   so we get a stronger guarantee that the JSON is well-formed
   * - The schema travels with the request as a separate field, not embedded
   *   in the prompt — keeps prompts cleaner and easier to iterate on
   * - Token usage is the same, but parse-failure rate is dramatically lower
   */
  async generateStructured<T>(opts: {
    system: string;
    userMessage: string;
    tool: ToolSpec;
  }): Promise<AiResult<T>> {
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxOutputTokens,
      system: opts.system,
      messages: [
        {
          role: 'user',
          content: opts.userMessage,
        },
      ],
      tools: [
        {
          name: opts.tool.name,
          description: opts.tool.description,
          input_schema: opts.tool.input_schema as Anthropic.Tool['input_schema'],
        },
      ],
      // Force Claude to use the tool — it cannot just respond with text.
      tool_choice: { type: 'tool', name: opts.tool.name },
    });

    // Check stop_reason BEFORE looking at content. If we hit max_tokens, the
    // tool_use input is partial JSON and the Anthropic API does its best to
    // make it parseable — but the data is incomplete, and we'd be lying to
    // callers if we returned it as a successful extraction.
    if (response.stop_reason === 'max_tokens') {
      throw new Error(
        `Claude hit the max_tokens limit (${response.usage.output_tokens} tokens emitted). ` +
          `The response was truncated and the structured output is incomplete. ` +
          `Raise MAX_OUTPUT_TOKENS in your .env or use a smaller PDF. ` +
          `Sonnet supports up to 64000 output tokens.`,
      );
    }

    // Find the tool_use block in the response. With tool_choice forced,
    // there should be exactly one tool_use block.
    const toolUse = response.content.find((c) => c.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') {
      throw new Error(
        `Expected a tool_use block in response, got: ${response.content
          .map((c) => c.type)
          .join(', ')}` +
          ` (stop_reason: ${response.stop_reason})`,
      );
    }

    if (toolUse.name !== opts.tool.name) {
      throw new Error(
        `Claude called wrong tool: expected "${opts.tool.name}", got "${toolUse.name}"`,
      );
    }

    return {
      data: toolUse.input as T,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        estimatedCost: estimateCost(
          response.usage.input_tokens,
          response.usage.output_tokens,
        ),
      },
    };
  }
}
