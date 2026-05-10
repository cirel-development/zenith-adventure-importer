# Zenith Adventure Importer

Foundry VTT v13 module that imports adventure bundles produced by the Zenith Adventure web service. PF2e and D&D 5e supported via the bundle's declared system.

**Pass 2 complete — all six builders implemented.** Manage Imports dialog still pending (use settings clear for now).

## What works

- Bundle download from URL, file upload, or by bundle ID + auth token
- Schema and cross-reference validation against the contract
- Asset upload to Foundry user data
- Folder hierarchy (topological build order)
- Multi-page journal entries with per-page permissions
- Items (compendium-ref, compendium-ref-with-runes, custom)
- Actors (compendium-ref, custom NPCs/creatures, loot containers)
- Scenes with v13 walls, lights, ambient sounds, map notes
- Empty playlist scaffolding
- Cross-reference resolution (`[[REF:type:slug]]` → `@UUID[]`)
- Map note pinning (clicking a pin opens the right journal page)
- Compendium UUID resolution with cache
- PF2e rune application for magic weapons/armor
- Per-bundle undo (deletes everything created during the import)
- Failed imports auto-rollback any partial state

## Still pending

- Manage Imports dialog (browse and undo previous imports from a UI)
- Asset cleanup on undo (Foundry's FilePicker has no delete API; manual for now)
- D&D 5e custom-actor builder (compendium-ref works for both systems; custom NPCs are PF2e-flavored)

## Install (dev)

This module depends on `@ai-adventure/contract` from the same monorepo.
Set up workspace dependencies:

```bash
# From repo root
pnpm install

# From this module's directory
pnpm build
```

Then symlink or copy `dist/` into `Data/modules/zenith-adventure-importer/`
on your Foundry server.

## Deploy

```bash
npm run deploy
```

This builds and copies into `/opt/foundrydata/Data/modules/zenith-adventure-importer/`,
then restarts the Foundry pm2 process. Adjust the path in `package.json` to match
your deployment.

After deploy: hard refresh in browser (Ctrl+Shift+R) to bypass Cloudflare cache.

## Testing without the web service

The `samples/` folder contains a working sample bundle ("The Haunted Mill")
you can use to test the importer end-to-end.

```bash
# Generate the sample zip
npx tsx samples/build-sample.ts

# Verify it round-trips through the contract validator
npx tsx samples/round-trip-test.ts
```

This produces `samples/the-haunted-mill.zip` (~5 KB). Open the import dialog
in Foundry, switch to "Upload file" mode, drop the zip in, and watch the
pipeline run. You should end up with:

- 7 folders (one per entity type)
- 3 journal entries (overview, locations, NPCs) with 6 pages total
- 2 scenes (the mill above-ground and the cellar below) with walls, lights, and a sound
- 1 custom NPC (Old Tom) as a PF2e level-0 actor
- 1 custom magic item (Cult Amulet)
- 2 empty playlists (ambience and combat)
- All cross-references wired up — clicking the map note in the mill scene
  should open the locations journal at the right page

The sample's source is in `samples/build-sample.ts` — read it to see the
contract used end-to-end.

## Architecture

The pipeline is 10 phases, each with a clear responsibility:

```
Bundle source (URL / file / ID)
        ↓
[1]  BundleLoader        Fetch zip, unpack, validate schema + refs
        ↓
[2]  PreflightChecker    System match, no duplicate import, all assets present
        ↓
[3]  AssetUploader       Upload images via FilePicker → Data/uploads/zenith-imports/<slug>/
        ↓
[4]  FolderBuilder       Create folders in topological order
        ↓
[5]  JournalBuilder      Multi-page journals with permissions
        ↓
[6]  ItemBuilder         Custom items, compendium refs, runed magic items
        ↓
[7]  ActorBuilder        Custom NPCs, compendium refs, loot containers
        ↓
[8]  SceneBuilder        Walls, lights, sounds, notes (refs unresolved)
        ↓
[9]  PlaylistBuilder     Empty playlist scaffolding
        ↓
[10] RefResolver         Walk all journal HTML and scene notes,
                         replace [[REF:]] tokens with @UUID[] links,
                         pin notes to journal pages
        ↓
Save undo manifest
```

Build order is dependency-driven: items before actors so actor inventories
can resolve item refs; scenes after both because scene notes reference
journals and walls don't depend on anything else; playlists last because
they're decorative scaffolding nothing else points at.

The **EntityRegistry** is shared across phases as the source of truth for
"what have I created so far." If any phase fails, the registry drives
rollback by walking entities in reverse creation order and deleting each.

The **CompendiumLookup** is shared between ActorBuilder and ItemBuilder so
they hit the same cache — if "shadow cultist" appears 12 times in one
adventure, we resolve the UUID once.

Foundry entity creation is not transactional — partial state is always
possible — so the registry is appended to immediately after each successful
create, never batched.

## Settings

| Setting | Scope | Default | Purpose |
|---|---|---|---|
| Service URL | World | `https://zenithsector.com` | Base URL for bundle ID downloads |
| Auth Token | World | empty | Bearer token for service auth (XOR+Base64 obfuscated at rest) |
| Auto-link playlists | World | false | Set scene.playlistSound from playlist_hint |
| Verbose logging | Client | false | Log every pipeline step |

## File Layout

```
src/
├── module.ts                Entry point, hooks, module API
├── settings.ts              Settings registration, obfuscation, import history
├── constants.ts             MODULE_ID, paths, log prefix
├── log.ts                   Tiny logger
├── foundry.d.ts             v13 type shim (minimal)
│
├── apps/
│   ├── ImportDialog.ts      Source picker + submit
│   └── ProgressDialog.ts    Live phase progress + summary/error
│
├── pipeline/
│   ├── Importer.ts          Orchestrates the 10 phases
│   ├── BundleLoader.ts      Fetch + unzip + validate
│   ├── PreflightChecker.ts  System, collisions, assets, GM check
│   ├── AssetUploader.ts     FilePicker uploads
│   ├── EntityRegistry.ts    Build manifest + lookup
│   └── RefResolver.ts       [[REF:]] → @UUID[] pass
│
├── builders/
│   ├── FolderBuilder.ts     Topological folder creation
│   ├── JournalBuilder.ts    Multi-page journals with permissions
│   ├── ItemBuilder.ts       Custom + compendium-ref + runed items
│   ├── ActorBuilder.ts      Custom NPCs + compendium-ref + loot containers
│   ├── SceneBuilder.ts      Walls, lights, sounds, notes
│   └── PlaylistBuilder.ts   Empty playlist scaffolding
│
├── compendium/
│   ├── CompendiumLookup.ts  Cached UUID resolver
│   └── RuneApplicator.ts    PF2e rune application for magic weapons/armor
│
└── undo/
    └── UndoManager.ts       Rollback partial + completed imports

samples/
├── build-sample.ts          Generates a working sample bundle
├── round-trip-test.ts       Validates the sample round-trips through contract
└── the-haunted-mill/        Sample bundle source files

templates/                   Handlebars templates for dialogs
styles/                      Module CSS
lang/                        i18n strings
scripts/                     verify-build.mjs, bump-version.mjs
```

## Open issues

- `bringToFront` may still warn on older v13 builds — track Foundry release notes
- Asset cleanup on undo is best-effort (Foundry's FilePicker has no delete API)
- No "Manage Imports" dialog yet — undo today requires clearing settings manually
