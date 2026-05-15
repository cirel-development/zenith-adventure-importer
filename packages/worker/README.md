# @ai-adventure/worker

Phase 1 worker: takes a PDF adventure, produces an adventure bundle the Foundry module can import.

## What this does (Phase 1)

- Extracts text from a PDF (no OCR — born-digital PDFs only)
- Sends the text to Claude with a structured-output tool schema
- Assembles the response into a validated adventure bundle
- Writes a zip the Foundry module can import

## What this does NOT do (yet)

- **Image extraction**: scenes are created without map backgrounds. Upload maps manually after import.
- **OCR**: scanned PDFs won't extract any text. Use born-digital PDFs.
- **PF2e stat blocks**: every NPC gets placeholder stats. Replace before play.
- **Compendium matching**: every NPC and item is custom. Phase 2 will match to PF2e compendium entries.
- **Map vision**: no walls, lights, sounds are detected. Add them manually.
- **Outline-then-content split**: Phase 1 makes one big call. Phase 2 will chunk for better quality on large adventures.
- **Resume**: if anything fails, you re-run from scratch.

## Setup

From the monorepo root:

```bash
pnpm install
pnpm build
```

Then add your Anthropic API key to a `.env` file at the monorepo root:

```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

## Usage

```bash
# Process a PDF
pnpm --filter @ai-adventure/worker process path/to/adventure.pdf

# Skip the cost confirmation prompt
pnpm --filter @ai-adventure/worker process path/to/adventure.pdf --yes

# Specify output location
pnpm --filter @ai-adventure/worker process path/to/adventure.pdf --output ./out.zip
```

## Expected output

```
[1/4] Reading PDF: /path/to/adventure.pdf
      24 pages, 48,231 characters (340ms)

[2/4] Cost estimate
      Model:           claude-sonnet-4-5
      Input tokens:    ~12,058
      Output tokens:   ~4,000 (max)
      Estimated cost:  $0.096

Proceed with this run? (y/N): y

[3/4] Calling Claude for adventure extraction
      Title:           The Haunted Mill
      Chapters:        3
      Locations:       8
      NPCs:            4
      Items:           3
      Encounters:      5
      Input tokens:    12,094
      Output tokens:   2,847
      Actual cost:     $0.0790
      Time:            18.4s

[4/4] Assembling bundle
      Output:          /path/to/adventure.bundle.zip
      Size:            18.7 KB
      Time:            42ms

Done in 19.1s. Import via the Foundry module to test.
```

## Troubleshooting

**"extracted 0 characters from PDF"** — The PDF is scanned (image-only). Phase 1 doesn't include OCR.

**"input estimate exceeds MAX_INPUT_TOKENS"** — Adventure is larger than ~150K tokens. Either use a shorter PDF, or temporarily raise `MAX_INPUT_TOKENS` in your `.env`. Phase 2 will chunk large adventures automatically.

**"Claude returned data that failed Zod validation"** — The tool schema and the AI response disagree. Re-run; if it keeps happening, file an issue with the PDF (or a small reproduction).

**"Expected a tool_use block in response"** — Claude tried to respond in prose instead of calling the tool. Usually transient; re-run.
