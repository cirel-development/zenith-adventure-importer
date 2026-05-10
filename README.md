# Zenith Adventure Importer — Monorepo

Tooling for importing AI-processed adventure PDFs into Foundry VTT.

## Packages

| Package | Description |
|---|---|
| [`packages/contract`](./packages/contract) | Wire-format schemas (Zod). Shared between the worker that produces bundles and the Foundry module that consumes them. |
| [`packages/foundry-module`](./packages/foundry-module) | Foundry VTT v13 module that imports adventure bundles. |

Future additions: `worker/` (Vultr-side PDF processing pipeline), `web/` (Cloudflare-side SaaS frontend).

## Quickstart

Requires Node 20+ and pnpm 9+.

```bash
# Install all dependencies and link workspace packages
pnpm install

# Build everything
pnpm build

# Generate and round-trip-test a sample adventure bundle
pnpm sample
```

The sample command produces `packages/foundry-module/samples/the-haunted-mill.zip` — a small working bundle you can drop into the Foundry module's import dialog to verify everything works end to end.

## Module installation

For end users, the module is installed via Foundry's module manager. After the first release tag, paste this manifest URL into Foundry → Add-on Modules → Install Module:

```
https://github.com/<your-org>/zenith-adventure-importer/releases/latest/download/module.json
```

Until the first release, manual install instructions live in [`packages/foundry-module/README.md`](./packages/foundry-module/README.md).

## Releasing

Tag a commit with a semver version and push. The `release.yml` workflow handles the rest:

```bash
# Bump version in both manifest files
cd packages/foundry-module
node scripts/bump-version.mjs patch  # or minor / major

# Commit, tag, push
cd ../..
git add -A
git commit -m "Release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

The workflow:

1. Builds all packages
2. Patches `module.json` with the right manifest/download URLs for the tag
3. Zips the foundry-module's `dist/` into `zenith-adventure-importer.zip`
4. Creates a GitHub release with the zip and `module.json` attached

Foundry users will then get the update offer automatically the next time they check for module updates.

## License

MIT — see [LICENSE](./LICENSE).
