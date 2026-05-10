# GitHub Deployment Walkthrough

This is the one-time setup to get the repo onto GitHub with working CI and releases.

## Prerequisites

- A GitHub account
- `git` installed locally
- `pnpm` 9+ installed locally (`npm install -g pnpm@9`)
- Node 20+

## Step 1 — Verify it builds locally

Before pushing anything, make sure the monorepo builds cleanly on your machine.

```bash
cd zenith-monorepo
pnpm install
pnpm build
pnpm typecheck
pnpm sample
```

Expected output: a sample zip at `packages/foundry-module/samples/the-haunted-mill.zip`, "Round-trip OK" at the end.

If anything fails here, fix it before pushing — debugging local builds is much faster than debugging CI.

## Step 2 — Create the GitHub repo

In your browser:

1. Go to <https://github.com/new>
2. Repo name: `zenith-adventure-importer` (or whatever you want — `zenith` would also work since it's a monorepo)
3. Visibility: **Public** (so Foundry users can install from the manifest URL) or **Private** (you can switch later)
4. **Do NOT** check "Initialize with README" — you already have one
5. **Do NOT** add a `.gitignore` or license — same reason
6. Click "Create repository"

GitHub will show you a "Quick setup" page with the repo URL. Copy the SSH URL (`git@github.com:<your-username>/<repo-name>.git`).

## Step 3 — Initialize and push

In your monorepo directory:

```bash
git init
git branch -M main
git add -A
git commit -m "Initial commit: contract + foundry module"
git remote add origin git@github.com:<your-username>/<repo-name>.git
git push -u origin main
```

If you don't have SSH set up with GitHub, use HTTPS with a personal access token instead:

```bash
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
# When prompted, use your GitHub username and a Personal Access Token (not password)
```

## Step 4 — Verify CI runs

After pushing, go to your repo on GitHub and click the **Actions** tab. You should see a workflow run named "CI" starting up.

What to watch for:

- **Install dependencies** — should take 30-60 seconds
- **Build all packages** — about a minute
- **Typecheck** — fast, a few seconds
- **Verify sample bundle round-trips** — also fast
- **Upload module artifact** — completes the run

If everything is green, you're set up. The artifact `zenith-adventure-importer-dev` is downloadable from that run page — it's the built `dist/` you can install manually for testing.

If CI fails, click into the failing step. Most common issues:

| Symptom | Fix |
|---|---|
| `ERR_PNPM_FROZEN_LOCKFILE_WITH_OUTDATED_LOCKFILE` | Run `pnpm install` locally, commit the updated `pnpm-lock.yaml`, push again |
| `tsc` errors | Build/typecheck passed locally but fails in CI — paste the error and we'll diagnose |
| `Cannot find module '@ai-adventure/contract'` | The `pnpm build` step needs to run before typecheck. Check that `.github/workflows/ci.yml` has them in the right order. |

## Step 5 — Set up branch protection (optional but recommended)

In your repo settings → Branches → "Add branch ruleset" (or "Add rule" on older UI):

1. Branch name pattern: `main`
2. Check "Require a pull request before merging"
3. Check "Require status checks to pass before merging"
4. Add `build` (the CI job name) as a required check
5. Save

This means you can't accidentally push broken code straight to main — every change goes through a PR with green CI first.

For solo work this can feel like overkill, but it's saved me from breaking my own deployments more than once.

## Step 6 — Cut the first release

Once the CI is green on main, tag a release. The release workflow will build a Foundry-installable zip and attach it to a GitHub release.

```bash
# Make sure you're on main and clean
git checkout main
git pull

# Tag the current version (matches package.json's 0.1.0)
git tag v0.1.0
git push origin v0.1.0
```

Within a minute or two, check the **Actions** tab for the "Release" workflow run. When it finishes, go to the **Releases** section of your repo. You should see:

- **Release v0.1.0**
- Two attachments: `zenith-adventure-importer.zip` and `module.json`

The `module.json` in the release is the manifest with the right URLs baked in. Foundry uses two URLs:

- `manifest` — points to `.../releases/latest/download/module.json` so updates work
- `download` — points to this specific tag's zip

## Step 7 — Install the module in Foundry

Now anyone (including you) can install the module via Foundry's normal flow.

In Foundry's setup screen:

1. Go to **Add-on Modules**
2. Click **Install Module**
3. In the "Manifest URL" field at the bottom, paste:
   ```
   https://github.com/<your-username>/<repo-name>/releases/latest/download/module.json
   ```
4. Click **Install**

Foundry will download the zip, extract it, and the module appears in your module list. Enable it in your world via Game Settings → Manage Modules.

## Step 8 — Test the import

Open the world's browser console (F12). You should see:

```
[Zenith Importer] Zenith Adventure Importer initializing
[Zenith Importer] Zenith Adventure Importer ready
```

Now download `the-haunted-mill.zip` from the release page (or generate it locally with `pnpm sample`).

In Foundry, run this in the console:

```js
game.modules.get('zenith-adventure-importer').api.openImportDialog()
```

The import dialog should open. Switch to "Upload file" mode, drop in the sample zip, click Import. Watch the progress dialog walk through phases.

When done, check your sidebar — you should see the folders, scenes, journals, actor, item, and playlists from the sample.

## Releasing future versions

The flow once everything is set up:

```bash
# Bump version
cd packages/foundry-module
node scripts/bump-version.mjs patch
cd ../..

# Commit and tag
git add -A
git commit -m "Release v0.1.1"
git tag v0.1.1
git push origin main --tags
```

The release workflow handles the rest. Foundry users get the update offer the next time they check for module updates.

## Troubleshooting

**"It built locally but CI fails."** Almost always one of:
- A file you didn't commit (check `git status`)
- A dependency in `node_modules` that isn't in `package.json` — run `pnpm install` from a clean state to verify
- Lockfile drift — run `pnpm install` and commit the updated `pnpm-lock.yaml`

**"The release workflow ran but no zip appeared."** Check the workflow logs — the upload step might have failed if the `permissions: contents: write` directive didn't take effect. Verify it's in the YAML.

**"Foundry says the manifest URL is invalid."** The URL works for *installs* via the latest release, but only AFTER you've cut at least one release. Before that, Foundry has nothing to download. Cut a v0.1.0 release first.

**"My CI still uses npm/yarn."** The workflows assume pnpm. If you commit a `package-lock.json` or `yarn.lock`, GitHub Actions caching gets confused. The `.gitignore` excludes both — let pnpm manage the lockfile.
