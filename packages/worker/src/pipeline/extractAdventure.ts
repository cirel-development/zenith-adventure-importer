import { z } from 'zod';
import type { AiClient } from '../ai/client.js';
import type { ExtractedPdf } from '../pdf/extract.js';

// ============================================================================
// Phase 1 simplified schema
// ============================================================================
// We don't ask Claude to fill in the full contract — that's too much for one
// call and most fields aren't useful without further processing. Instead, we
// extract a focused subset that captures the *essential* adventure shape:
// title, chapters, encounters, NPCs, key items, key locations. The bundle
// assembler then maps this into the full contract shape.
//
// Phase 2 will split this into separate extractions (outline first, then
// per-section details) and exercise more of the contract.

const EncounterDataZ = z.object({
  name: z.string(),
  summary: z.string(),
  difficulty: z.enum(['trivial', 'low', 'moderate', 'severe', 'extreme']).optional(),
  creatures: z.array(z.string()).default([]), // names only, Phase 2 resolves to UUIDs
});

const NpcDataZ = z.object({
  name: z.string(),
  role: z.string(),
  description: z.string(),
  /** PF2e creature level if mentioned, otherwise null. */
  level: z.number().nullable().default(null),
  /**
   * 'npc' for named individual characters (Stella, Carl the Cobbler).
   * 'creature' for generic stat blocks shared across multiple tokens
   * (Jinkin Ripclaw — the type, not the individual). Drives folder placement
   * and the kind of token Foundry creates.
   */
  category: z.enum(['npc', 'creature']).default('npc'),
  size: z
    .enum(['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'])
    .default('medium'),
  rarity: z.enum(['common', 'uncommon', 'rare', 'unique']).default('common'),
  alignment: z
    .enum(['LG', 'NG', 'CG', 'LN', 'N', 'CN', 'LE', 'NE', 'CE', 'no-alignment'])
    .default('N'),
  /** Lowercase trait keywords, e.g. ['fey', 'gremlin']. Excludes rarity/size/alignment. */
  traits: z.array(z.string()).default([]),
  /** Spoken languages, e.g. ['Common', 'Sylvan']. */
  languages: z.array(z.string()).default([]),
});

const HazardDataZ = z.object({
  name: z.string(),
  /** PF2e hazard level. */
  level: z.number().nullable().default(null),
  description: z.string(),
  /**
   * Raw mechanics block (Stealth DC, Disable, AC, saves, trigger, effect, reset).
   * Phase 1.5 preserves verbatim so the GM has the numbers — Phase 2 will
   * parse it into structured fields.
   */
  mechanics: z.string().optional(),
});

const ItemDataZ = z.object({
  name: z.string(),
  description: z.string(),
  /** Free-text item type — Phase 2 maps to a compendium item if possible. */
  kind: z.string().optional(),
});

const LocationDataZ = z.object({
  name: z.string(),
  /** Code like "A1", "B3" if Paizo-style numbering is used. */
  area_code: z.string().nullable().default(null),
  description: z.string(),
  /** Boxed/italic read-aloud text if found, otherwise null. */
  read_aloud: z.string().nullable().default(null),
});

const ChapterDataZ = z.object({
  name: z.string(),
  summary: z.string(),
  locations: z.array(LocationDataZ).default([]),
});

export const ExtractedAdventureZ = z.object({
  title: z.string(),
  /** A one or two paragraph description of the whole adventure. */
  synopsis: z.string(),
  /** Recommended PC level. Null if not specified. */
  party_level: z.number().nullable().default(null),
  /** Recommended PC count. Null if not specified. */
  party_size: z.number().nullable().default(null),
  /** Tone descriptor like "horror", "high fantasy", "gritty". */
  tone: z.string().optional(),
  chapters: z.array(ChapterDataZ).default([]),
  encounters: z.array(EncounterDataZ).default([]),
  npcs: z.array(NpcDataZ).default([]),
  hazards: z.array(HazardDataZ).default([]),
  items: z.array(ItemDataZ).default([]),
});

export type ExtractedAdventure = z.infer<typeof ExtractedAdventureZ>;

// ============================================================================
// Tool schema (for Claude tool-use)
// ============================================================================
// JSON Schema equivalent of the Zod schema above. We could derive this with
// a library (zod-to-json-schema) but for Phase 1 it's clearer to write by
// hand. The two need to stay in sync — when we add fields, update both.

const EXTRACT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Adventure title' },
    synopsis: {
      type: 'string',
      description: 'One or two paragraph description of the whole adventure',
    },
    party_level: {
      type: ['number', 'null'],
      description: 'Recommended PC level. Null if not specified.',
    },
    party_size: {
      type: ['number', 'null'],
      description: 'Recommended PC count, usually 4. Null if not specified.',
    },
    tone: {
      type: 'string',
      description: 'Tone descriptor, e.g. "horror", "high fantasy", "gritty noir"',
    },
    chapters: {
      type: 'array',
      description: 'The adventure broken into chapters or major sections',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          locations: {
            type: 'array',
            description: 'Distinct locations or scenes within this chapter',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                area_code: {
                  type: ['string', 'null'],
                  description:
                    'Paizo-style area code like "A1", "B3", or null if absent',
                },
                description: { type: 'string' },
                read_aloud: {
                  type: ['string', 'null'],
                  description:
                    'Boxed/italic read-aloud text for this location, verbatim if present, otherwise null',
                },
              },
              required: ['name', 'description'],
            },
          },
        },
        required: ['name', 'summary'],
      },
    },
    encounters: {
      type: 'array',
      description: 'Combat or skill encounters in the adventure',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          summary: { type: 'string' },
          difficulty: {
            type: 'string',
            enum: ['trivial', 'low', 'moderate', 'severe', 'extreme'],
          },
          creatures: {
            type: 'array',
            description:
              'Creature names involved. Just names — no stat blocks needed at this stage.',
            items: { type: 'string' },
          },
        },
        required: ['name', 'summary'],
      },
    },
    npcs: {
      type: 'array',
      description:
        'One entry per DISTINCT named character or stat block — both unique individuals and generic creature types. ' +
        'See guidelines in the system prompt for category, traits, rarity, size, alignment extraction.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', description: 'Role or occupation' },
          description: { type: 'string' },
          level: {
            type: ['number', 'null'],
            description: 'PF2e creature level if mentioned, otherwise null',
          },
          category: {
            type: 'string',
            enum: ['npc', 'creature'],
            description:
              "'npc' for named individuals (Captain Marrow, Carl the Cobbler). " +
              "'creature' for generic stat blocks (Jinkin Ripclaw, Goblin Warrior) " +
              'where the encounter has multiple identical tokens.',
          },
          size: {
            type: 'string',
            enum: ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'],
            description: 'Creature size from the stat block header.',
          },
          rarity: {
            type: 'string',
            enum: ['common', 'uncommon', 'rare', 'unique'],
            description:
              'Rarity tag from the stat block (UNIQUE for one-of-a-kind individuals, ' +
              'RARE for trait-line "rare", etc). Default common when unmarked.',
          },
          alignment: {
            type: 'string',
            enum: ['LG', 'NG', 'CG', 'LN', 'N', 'CN', 'LE', 'NE', 'CE', 'no-alignment'],
            description:
              'Two-letter alignment from the trait line (CE, NG, etc). Use ' +
              "'no-alignment' for Remaster-era stat blocks that omit alignment. " +
              "Default 'N' when unstated.",
          },
          traits: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Lowercase trait keywords from the trait line (e.g. ["fey", "gremlin"]). ' +
              'Exclude rarity/alignment/size which have their own fields.',
          },
          languages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Languages from the Languages line, e.g. ["Common", "Sylvan"].',
          },
        },
        required: ['name', 'role', 'description'],
      },
    },
    hazards: {
      type: 'array',
      description:
        'Traps and environmental hazards with mechanical stat blocks ' +
        '(typically under a "HAZARD X" header with Stealth DC, Disable, AC, ' +
        'saves, trigger, effect, reset). Skip purely narrative hazards.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          level: {
            type: ['number', 'null'],
            description: 'PF2e hazard level if mentioned.',
          },
          description: {
            type: 'string',
            description: 'Plain-prose summary of what the hazard is and does.',
          },
          mechanics: {
            type: 'string',
            description:
              'Verbatim mechanics block (Stealth DC X, AC Y, Fort +Z, Ref +W, ' +
              'Trigger ..., Effect ..., Reset ...). Preserve numbers and structure ' +
              'exactly as printed.',
          },
        },
        required: ['name', 'description'],
      },
    },
    items: {
      type: 'array',
      description: 'Notable magic items, treasures, or quest objects',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          kind: {
            type: 'string',
            description:
              'Brief item type, e.g. "magic weapon", "key", "treasure", "consumable"',
          },
        },
        required: ['name', 'description'],
      },
    },
  },
  required: ['title', 'synopsis', 'chapters'],
} as const;

// ============================================================================
// The actual extraction call
// ============================================================================

const SYSTEM_PROMPT = `You are an expert assistant that extracts structured information from tabletop RPG adventure PDFs.

Your job is to read the adventure text and call the \`extract_adventure\` tool with structured data about the adventure's contents.

GENERAL
- Preserve Paizo's boxed/italic read-aloud text verbatim. Do not paraphrase it.
- For descriptions, write GM-facing prose — concise, useful, no marketing fluff.
- If a value isn't present in the source, use null or sensible defaults rather than inventing.
- If the adventure uses Paizo-style area codes (A1, B3, etc), preserve them. If not, leave area_code null.

NPCS AND CREATURES (the \`npcs\` array)
- Extract one entry per DISTINCT named character OR distinct stat block. If an encounter has "Jinkin Ripclaws (3)" then "Jinkin Ripclaw" gets ONE entry — not three.
- Use \`category: 'npc'\` for named individuals (Stella, Vilm, Carl the Cobbler). Use \`category: 'creature'\` for generic stat blocks shared across multiple tokens (Jinkin Ripclaw).
- Pre-generated player characters with stat blocks ARE extracted, as \`category: 'npc'\`. The GM may convert them to PC actors later, or use them as-is.
- Pull traits, size, rarity, alignment FROM the stat block header. The trait line in PF2e looks like "UNIQUE CE TINY FEY GREMLIN" — split into:
  - \`rarity\`: 'unique' (the rarity tag; defaults to 'common' when unmarked)
  - \`alignment\`: 'CE' (the two-letter alignment; 'no-alignment' for Remaster stat blocks that omit it)
  - \`size\`: 'tiny' (lowercase)
  - \`traits\`: ['fey', 'gremlin'] (the remaining lowercase keywords)
- Languages: extract from the Languages line if present, e.g. ['Common', 'Sylvan']. If absent, leave empty.
- Don't invent stat values — Phase 1 leaves HP/AC/saves/abilities/strikes as placeholders. Only extract what's in your schema fields.

HAZARDS (the \`hazards\` array)
- Extract every hazard or trap with a mechanical stat block. Paizo formats these as "HAZARD X" headers with Stealth DC, Disable, AC, saves, Trigger, Effect, Reset.
- The \`mechanics\` field gets the verbatim mechanics block — preserve DCs, damage formulas, save types exactly.

ITEMS (the \`items\` array)
- Extract items that are specifically named or have mechanical importance. Skip mundane gear like torches.
- Include items mentioned in inventory lines of stat blocks (e.g. Vilm's "Items: boots of elvenkind, pincer claw, shortbow").

INLINE PF2E ROLL SYNTAX
When prose mentions a saving throw, damage roll, or skill check, embed clickable PF2e inline-roll syntax in the description fields (NPC description, item description, hazard description, hazard mechanics). The PF2e Foundry system renders these as buttons that roll dice when clicked:
- Saving throws: @Check[type:fortitude|dc:18|basic:true]   (lowercase save name, basic:true for basic saves)
- Skill checks:  @Check[type:nature|dc:18]                 (lowercase skill name)
- Damage rolls:  @Damage[2d10[bludgeoning]]                (damage type in brackets after formula)
- For multiple damage types: @Damage[1d6[piercing],2[persistent,fire]]

Use inline syntax everywhere it fits in description prose. Examples:
- "deals 2d10 bludgeoning damage (DC 18 basic Fortitude save)" → "deals @Damage[2d10[bludgeoning]] (@Check[type:fortitude|dc:18|basic:true])"
- "DC 20 Perception check to spot" → "@Check[type:perception|dc:20] to spot"
- "1d8 piercing plus Grab" → "@Damage[1d8[piercing]] plus Grab"

DO NOT use inline syntax inside read_aloud text — that's verbatim Paizo prose and must stay clean.

You must call the \`extract_adventure\` tool exactly once. The text provided may be the entire adventure or a chunk of it — extract whatever is present.`;

const USER_MESSAGE_TEMPLATE = (text: string): string => {
  return `Here is the adventure text. Call the \`extract_adventure\` tool with structured data extracted from it.

ADVENTURE TEXT FOLLOWS:

${text}`;
};

export async function extractAdventure(
  client: AiClient,
  pdf: ExtractedPdf,
): Promise<{ adventure: ExtractedAdventure; usage: { inputTokens: number; outputTokens: number; estimatedCost: number } }> {
  // Concatenate all pages into one blob. Page boundaries don't carry semantic
  // value for the AI; what matters is the running text.
  const fullText = pdf.pages.join('\n\n').trim();

  const result = await client.generateStructured<unknown>({
    system: SYSTEM_PROMPT,
    userMessage: USER_MESSAGE_TEMPLATE(fullText),
    tool: {
      name: 'extract_adventure',
      description:
        'Submit the structured representation of the adventure extracted from the source text.',
      input_schema: EXTRACT_TOOL_SCHEMA as unknown as Record<string, unknown>,
    },
  });

  // Validate against Zod — the API enforces JSON Schema but Zod adds defaults
  // and gives us better runtime types.
  const parsed = ExtractedAdventureZ.safeParse(result.data);
  if (!parsed.success) {
    throw new Error(
      `Claude returned data that failed Zod validation:\n${parsed.error.message}`,
    );
  }

  return {
    adventure: parsed.data,
    usage: result.usage,
  };
}
