# @ai-adventure/contract

Shared JSON contract between the AI Adventure Importer worker (server-side, processes PDFs) and the Foundry companion module (client-side, builds Foundry entities).

Single source of truth for the export bundle format. Both sides depend on this package; if a schema changes, both rebuild against the new version.

## Install (workspace setup)

```bash
# In your monorepo root
pnpm add -w @ai-adventure/contract  # or npm/yarn equivalent
```

In the worker and module `package.json`:

```json
"dependencies": {
  "@ai-adventure/contract": "workspace:*"
}
```

## Layout

```
src/
├── shared.ts       Slugs, REF tokens, asset paths, AI metadata, permissions
├── manifest.ts     Top-level manifest
├── folders.ts      Folder hierarchy
├── journals.ts     Multi-page journals (7 types) with page-level permissions
├── actors.ts       Actors (NPCs, creatures, hazards, loot containers)
├── items.ts        Items (compendium-ref / runed / custom)
├── scenes.ts       Scenes with v13 walls/lights/sounds/notes
├── playlists.ts    Empty playlist scaffolding
└── index.ts        validateBundle() + re-exports
```

## Worker side — emit a bundle

```ts
import {
  type Bundle,
  validateBundle,
  CONTRACT_VERSION,
} from '@ai-adventure/contract';

const bundle: Bundle = {
  manifest: {
    contract_version: CONTRACT_VERSION,
    bundle_id: 'bnd_a7f3e9c2',
    adventure: { /* ... */ },
    entities: {
      folders:   'entities/folders.json',
      journals:  'entities/journals.json',
      actors:    'entities/actors.json',
      items:     'entities/items.json',
      scenes:    'entities/scenes.json',
      playlists: 'entities/playlists.json',
    },
    build_order: ['folders', 'journals', 'items', 'actors', 'scenes', 'playlists'],
    stats: { /* ... */ },
    warnings: [],
  },
  folders:   { entities: [/* ... */] },
  journals:  { entities: [/* ... */] },
  actors:    { entities: [/* ... */] },
  items:     { entities: [/* ... */] },
  scenes:    { entities: [/* ... */] },
  playlists: { entities: [/* ... */] },
};

// Validate before writing the zip
const result = validateBundle(bundle);
if (!result.valid) {
  for (const issue of result.issues) {
    console.error(`[${issue.severity}] ${issue.path}: ${issue.message}`);
  }
  throw new Error('bundle failed self-validation');
}

// All clear — write to R2
await writeBundleZip(bundle);
```

## Foundry module side — consume a bundle

```ts
import { validateBundle } from '@ai-adventure/contract';

async function importBundle(zipUrl: string) {
  const zip = await fetchAndExtract(zipUrl);

  const result = validateBundle({
    manifest:  JSON.parse(await zip.read('manifest.json')),
    folders:   JSON.parse(await zip.read('entities/folders.json')),
    journals:  JSON.parse(await zip.read('entities/journals.json')),
    actors:    JSON.parse(await zip.read('entities/actors.json')),
    items:     JSON.parse(await zip.read('entities/items.json')),
    scenes:    JSON.parse(await zip.read('entities/scenes.json')),
    playlists: JSON.parse(await zip.read('entities/playlists.json')),
  });

  if (!result.valid) {
    showImportError(result.issues);
    return;
  }

  await buildFoundryEntities(result.bundle!);
}
```

## What `validateBundle` checks

1. **Manifest schema** — version match, all fields well-formed.
2. **Per-file schemas** — every entity validates against its Zod schema.
3. **Slug uniqueness** — no duplicate slugs within any entity type.
4. **Cross-references** — every `[[REF:type:slug]]` token in journal HTML, scene notes, actor/item linked journals, and scene playlist hints points to a known entity.
5. **Journal anchors** — `[[REF:journal:slug#page]]` references a page that actually exists in that journal.

If any of those fail, the bundle is invalid and the result includes a flat list of issues with paths into the data structure.

## Discriminator pattern

Three places use `kind` discriminators:

### Actor `stat_block.kind`

| Value | Meaning |
|---|---|
| `compendium-ref` | Look up by Foundry compendium UUID |
| `custom` | Full PF2e stat block embedded |
| `loot-container` | Treasure hoard (currency + item refs) |

### Item `data.kind`

| Value | Meaning |
|---|---|
| `compendium-ref` | Look up by UUID |
| `compendium-ref-with-runes` | Base item from compendium + applied runes |
| `custom` | Adventure-specific custom item |

### Journal page `page_type`

| Value | Meaning |
|---|---|
| `text` | HTML content (may contain REF tokens) |
| `image` | Image asset with optional caption |

## Cross-reference syntax

References are opaque tokens until import time:

```
[[REF:actor:captain-marrow]]
[[REF:journal:locations-ch1]]
[[REF:journal:locations-ch1#a2-tavern]]
[[REF:scene:a1-docks]]
[[REF:item:bronze-key]]
[[REF:playlist:chapter-1-ambience]]
```

Resolution happens in the Foundry module's second pass after all entities exist:

```
[[REF:actor:captain-marrow]]  →  @UUID[Actor.xyz123]{Captain Marrow}
```

The slug namespace is flat per type — `actor:captain-marrow` is unique across the whole bundle, regardless of which folder the actor lives in.

## AI metadata

Every entity (except folders and playlists) carries optional `ai_metadata`:

```ts
{
  confidence: 0.62,            // 0.0–1.0 from extraction
  source_page: 47,             // PDF page number
  source_text_id: "...",       // Reference to preserved snippet
  prompt_version: "outline@2.1.0",
  review_required: true,
  review_reasons: ["incomplete_stat_block", "ambiguous_action_costs"]
}
```

When `review_required` is true, the Foundry module routes the entity to a `_Review Needed` subfolder and surfaces the reasons in the entity's notes.

## Versioning

`CONTRACT_VERSION` is the exported constant for the current schema version. Bumped on:

- **Major** — breaking changes that older modules can't import
- **Minor** — additive fields that older modules can ignore safely

The Foundry module checks this on every import. A bundle from a newer version than the module supports is refused with a clear error pointing to the module update.

## What this contract deliberately does NOT cover

- **Foundry runtime IDs** — created at import time, world-scoped
- **Per-world build state** — the module's own undo manifest, not the bundle
- **Server-side billing data** — token usage detail, payment records (D1 territory)
- **AI prompts** — server-internal; the bundle only carries results
- **Original PDF** — kept on R2 server-side, not redistributed to users
- **Resume state** — server resumes server-side; users only ever see complete bundles
