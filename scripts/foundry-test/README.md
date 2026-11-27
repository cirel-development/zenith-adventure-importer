# Local Foundry v14 test instance

A disposable Foundry v14 + PF2e install for testing the importer, separate from the desktop app
(v13, `%LOCALAPPDATA%\FoundryVTT`) and from foundry.zenithsector.com.

| What | Where |
|---|---|
| Foundry code | the installed desktop app (`C:\Program Files\Foundry Virtual Tabletop\resources\app`) when it is v14+, otherwise a Node.js build in `%USERPROFILE%\FoundryTest\app\<build>` |
| Node | Foundry 14.371 needs Node 24; found on PATH or in fnm (`fnm install 24`) |
| Data (systems, modules, worlds) | `%USERPROFILE%\FoundryTest\data` |
| URL | http://localhost:30001 |
| World | `zenith-test` (PF2e, disposable) |
| Module | junction to `packages\foundry-module\dist`: `pnpm build` updates it in place |
| Fixture | `packages\worker\test-bundle.zip`, served at `/zenith-fixtures/test-bundle.zip` |

## One-time setup

1. Have Foundry v14 available: update the desktop app to v14, or download the **Node.js** build
   of Version 14 from foundryvtt.com (Purchased Licenses) and pass it with `-FoundryZip`.
2. Have Node 24 (`fnm install 24`). The scripts find it by path, so it need not be your default.
3. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File ".\scripts\foundry-test\setup.ps1"
   ```
   This installs PF2e 8.7.1 and Quench 0.10.0 from their GitHub releases (about 118 MB total).
4. Run `start.ps1` (below). On first launch: enter your license key and accept the EULA, launch
   **Zenith Test (v14)** (accept the one-time world migration prompt), join as Gamemaster, and
   enable **Zenith Adventure Importer** (and **Quench**) in Manage Modules.

## Every test run

```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\foundry-test\start.ps1"
```

This builds all packages, regenerates the test bundle, copies it into the fixture folder, and
starts Foundry with the test world. Then, in the browser console (F12):

```javascript
await game.modules.get('zenith-adventure-importer').api.selfTest()
```

`selfTest()` imports the fixture, checks every mapping (rarity, alignment, hazard type, notes,
inline rolls, traits, size, languages, item, journal, folders), undoes the import, checks that
undo removed everything, and prints a pass/fail table. If Quench is enabled, the same cases also
show up in the Quench window as **Zenith: test bundle import**.

Add a case to `packages/foundry-module/src/testing/fixtureSuite.ts` for every new fixture you
add to `packages/worker/tests/build-test-bundle.ts`.
