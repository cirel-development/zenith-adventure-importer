# v0.1.3 patch — compendium-ref name fallback

## How to apply

Extract this zip at the **root of your monorepo** (the folder containing `pnpm-workspace.yaml`). It will overwrite five files in place:

```
packages/foundry-module/src/compendium/CompendiumLookup.ts
packages/foundry-module/src/compendium/RuneApplicator.ts
packages/foundry-module/src/builders/ActorBuilder.ts
packages/foundry-module/src/builders/ItemBuilder.ts
packages/foundry-module/samples/build-sample.ts
```

On Windows with built-in zip extraction: right-click the zip, "Extract All...", and point it at your `zenith-monorepo` folder. Choose "yes to all" or "replace files" when prompted.

## What changed

- `CompendiumLookup` now has a name-based fallback when a UUID misses (handles PF2e version drift)
- `RuneApplicator` accepts a fallback name too
- `ActorBuilder` and `ItemBuilder` pass entity names through as fallbacks; flag entities resolved via fallback so the GM can audit
- `build-sample.ts` adds four optional compendium-ref test cases gated on UUIDs you fill in at the top of the file

## After applying

1. Open `packages/foundry-module/samples/build-sample.ts` and fill in the three `COMPENDIUM_UUIDS` constants with values from your installed PF2e (instructions in that file's comments)
2. From the monorepo root:
   ```
   pnpm build
   pnpm sample
   ```
3. Bump the version, commit, tag, push:
   ```
   cd packages/foundry-module
   node scripts/bump-version.mjs patch
   cd ..\..
   git add .
   git commit -m "Add compendium-ref name-fallback for UUID drift"
   git tag v0.1.3
   git push origin main --tags
   ```
