/**
 * Phase 3: the vision step for battle maps.
 *
 * One request per candidate image (an image with a detected grid, see
 * maps/grid.ts). The model looks at the image with the adventure's context
 * (page text, locations and area codes) and answers with the battle maps it
 * contains: each map's region (so a combined image splits into scenes), its
 * walls/doors/windows, light sources, and the printed labels to pin.
 *
 * Coordinates are pixels of the image as sent. Production sends the request
 * to Claude with the image; testing writes it to disk for a stand-in model
 * (see sim.ts), and both answers go through parseVisionAnswer.
 */
import { z } from 'zod';

export const VISION_TOOL_NAME = 'submit_map_analysis';

export const VISION_SYSTEM = `You analyze one image from a tabletop RPG adventure PDF for Foundry VTT.

Decide whether it contains one or more battle maps (top-down encounter maps with a square grid).
Character art, cover art and decorative images are not maps: answer with "maps": [].

For each battle map in the image:
- region: the pixel rectangle of that map alone. When one image holds several maps (for
  example two encounter areas stacked and divided by a line or gap), report each separately
  and keep dividers, compass roses and margins out of the regions.
- name: the location it shows, using the adventure's own name for it (see the context).
- area_codes: the adventure's area codes this map covers ("A1", "B2"), from the context.
- walls: every wall segment that blocks movement and sight, as straight segments in image
  pixels. Follow walls along their centre line; split curved walls into short segments; join
  segments end to end where walls meet. Mark doors ("door"), secret doors ("secret_door"),
  windows ("window", block movement but not sight) and low walls / fences / rubble that block
  movement only ("terrain"). Leave out the outer edge of the map unless a wall is drawn there.
  Open areas (fields, forests) may have no walls at all; do not invent them.
- lights: visible light sources (torches, braziers, campfires, glowing magic) with a radius in
  grid cells (bright and dim) and a colour. Leave lights out for outdoor daylight maps.
- pins: each printed label on the map (area codes like "A1", letters like "S" or "T") at its
  centre, with the area_code it refers to when the context says.

Measure carefully: the grid is given in the context (cell size and offset in pixels), so walls
usually run along grid lines or cross cells at regular points. Report numbers in image pixels.`;

export const VISION_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    is_map: { type: 'boolean', description: 'True when the image contains at least one battle map.' },
    reason: { type: 'string', description: 'One sentence: what the image shows.' },
    maps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          area_codes: { type: 'array', items: { type: 'string' } },
          region: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
            required: ['x', 'y', 'width', 'height'],
          },
          walls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
                kind: { type: 'string', enum: ['wall', 'door', 'secret_door', 'window', 'terrain'] },
              },
              required: ['x1', 'y1', 'x2', 'y2', 'kind'],
            },
          },
          lights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                x: { type: 'number' },
                y: { type: 'number' },
                bright_cells: { type: 'number' },
                dim_cells: { type: 'number' },
                color: { type: 'string', description: 'Hex colour, e.g. #ff9329 for firelight.' },
                kind: { type: 'string', enum: ['fire', 'torch', 'magic', 'other'] },
              },
              required: ['x', 'y', 'bright_cells', 'dim_cells'],
            },
          },
          pins: {
            type: 'array',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, area_code: { type: 'string' } },
              required: ['label', 'x', 'y'],
            },
          },
        },
        required: ['name', 'region', 'walls', 'lights', 'pins'],
      },
    },
  },
  required: ['is_map', 'reason', 'maps'],
} as const;

const PointZ = z.number().finite();
export const VisionAnswerZ = z.object({
  is_map: z.boolean(),
  reason: z.string().default(''),
  maps: z
    .array(
      z.object({
        name: z.string().min(1),
        area_codes: z.array(z.string()).default([]),
        region: z.object({ x: PointZ, y: PointZ, width: PointZ.positive(), height: PointZ.positive() }),
        walls: z
          .array(z.object({ x1: PointZ, y1: PointZ, x2: PointZ, y2: PointZ, kind: z.enum(['wall', 'door', 'secret_door', 'window', 'terrain']).default('wall') }))
          .default([]),
        lights: z
          .array(
            z.object({
              x: PointZ,
              y: PointZ,
              bright_cells: z.number().nonnegative(),
              dim_cells: z.number().nonnegative(),
              color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
              kind: z.enum(['fire', 'torch', 'magic', 'other']).optional(),
            }),
          )
          .default([]),
        pins: z.array(z.object({ label: z.string().min(1), x: PointZ, y: PointZ, area_code: z.string().optional() })).default([]),
      }),
    )
    .default([]),
});
export type VisionAnswer = z.infer<typeof VisionAnswerZ>;
export type VisionMap = VisionAnswer['maps'][number];

/** Validate a tool answer (throws on a malformed one). */
export function parseVisionAnswer(data: unknown): VisionAnswer {
  return VisionAnswerZ.parse(data);
}

export interface MapContext {
  imageId: string;
  page: number;
  width: number;
  height: number;
  grid: { cellPx: number; offsetX: number; offsetY: number } | null;
  /** The adventure's locations: area code, name and chapter. */
  locations: { area_code: string | null; name: string; chapter: string }[];
  /** Text of the image's page and its neighbours, for captions and area keys. */
  pageText: string;
}

const PAGE_TEXT_LIMIT = 4000;

/** Page text around an image: its own page, then one page either side. */
export function pageContext(pages: string[], page: number): string {
  const pick = [page, page - 1, page + 1].filter((p) => p >= 1 && p <= pages.length);
  return pick
    .map((p) => `--- page ${p} ---\n${pages[p - 1]!.trim()}`)
    .join('\n\n')
    .slice(0, PAGE_TEXT_LIMIT);
}

/** The user turn sent with the image. */
export function buildVisionMessage(ctx: MapContext): string {
  const grid = ctx.grid
    ? `Detected grid: cells of ${ctx.grid.cellPx.toFixed(1)} px; the first vertical grid line is at x=${ctx.grid.offsetX.toFixed(1)}, the first horizontal at y=${ctx.grid.offsetY.toFixed(1)}.`
    : 'No grid was detected in this image.';
  const locs = ctx.locations.length
    ? ctx.locations.map((l) => `- ${l.area_code ? `${l.area_code}. ` : ''}${l.name} (${l.chapter})`).join('\n')
    : '(none extracted)';
  return `Image ${ctx.imageId} from PDF page ${ctx.page}, ${ctx.width}x${ctx.height} px.
${grid}

Locations in this adventure:
${locs}

Text near the image:
${ctx.pageText}`;
}
