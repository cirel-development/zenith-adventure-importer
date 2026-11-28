import { MODULE_ID, MODULE_TITLE } from './constants.js';
import { registerSettings } from './settings.js';
import { buildImportDialog } from './apps/ImportDialog.js';
import { log } from './log.js';
import { selfTest, registerQuench } from './testing/fixtureSuite.js';
import { Importer } from './pipeline/Importer.js';
import { UndoHandler } from './apps/UndoHandler.js';
import { getImportRecord } from './settings.js';
import { buildManageImportsDialog, openManageImports } from './apps/ManageImportsDialog.js';

// ============================================================================
// Init: register settings before world is ready
// ============================================================================

Hooks.once('init', () => {
  log.info(`${MODULE_TITLE} initializing`);
  registerSettings();
  // Module Settings -> "Manage Imports": browse, undo or forget past imports.
  (game.settings as any).registerMenu(MODULE_ID, 'manageImports', {
    name: 'Adventure imports',
    label: 'Manage Imports',
    hint: 'See every adventure imported into this world, and undo or forget an import.',
    icon: 'fas fa-list',
    type: buildManageImportsDialog(),
    restricted: true,
  });
});

// ============================================================================
// Ready: world is loaded, can now expose UI
// ============================================================================

Hooks.once('ready', () => {
  log.info(`${MODULE_TITLE} ready`);

  // Expose a tiny public API on the module record so other modules and macros
  // can call into us.
  const module = (game as any).modules.get(MODULE_ID);
  if (module) {
    module.api = {
      openImportDialog,
      /** Lists past imports with Undo / Forget (GM only). */
      openManageImports,
      /** Imports zenith-fixtures/test-bundle.zip, checks every fixture, undoes it. */
      selfTest,
      /** Scripted import (same pipeline as the dialog's URL mode). GM only. */
      importBundle: async (url: string) => {
        if (!game.user.isGM) throw new Error('GM only');
        return new Importer().run({ kind: 'url', value: url });
      },
      /** Undo one import by bundle id (same as the dialog's Undo button). GM only. */
      undoImport: async (bundleId: string) => {
        if (!game.user.isGM) throw new Error('GM only');
        const record = getImportRecord(bundleId);
        if (!record) throw new Error(`no import record for ${bundleId}`);
        return new UndoHandler().undo(record);
      },
    };
  }
});

// Quench (optional): registers the same fixture cases as a Quench batch.
Hooks.on('quenchReady', ((quench: unknown) => registerQuench(quench)) as (...args: unknown[]) => void);

// ============================================================================
// Sidebar buttons — add an "Import" button to relevant directory headers
// ============================================================================

// ============================================================================
// Scene controls toolbar — primary entry point
// ============================================================================
// Add a button to Foundry's left-side scene controls toolbar. This is the
// canonical place for module entry points in v13: always visible, always
// accessible, no dependence on which sidebar tab is active.
//
// In v13, getSceneControlButtons receives a keyed object (not an array as in
// v12). We add a tool to the "tokens" control set since it's the default-
// selected one and almost always visible.
Hooks.on('getSceneControlButtons', ((controls: Record<string, any>) => {
  if (!game.user.isGM) return;

  // Try a few known control set names — v13 settled on "tokens" but defensive
  // coding doesn't hurt
  const targetSet =
    controls['tokens'] ?? controls['token'] ?? Object.values(controls)[0];
  if (!targetSet) return;

  // v13 tools are also a keyed object on each control set
  const tools = targetSet.tools ?? (targetSet.tools = {});

  tools['zenith-importer'] = {
    name: 'zenith-importer',
    title: 'Import Zenith Adventure',
    icon: 'fas fa-book-open',
    button: true,
    onChange: () => openImportDialog(),
  };
}) as (...args: unknown[]) => void);

// ============================================================================
// Sidebar tab buttons — secondary entry point
// ============================================================================
// In v13 the sidebar tab hook is `renderAbstractSidebarTab` (or just per-tab
// hooks like `renderSceneDirectory`). We try each known approach.

function injectSidebarButton(root: HTMLElement | null | undefined): void {
  if (!root) return;
  if (!game.user.isGM) return;
  if (root.querySelector('.zenith-importer-button')) return;

  // v13 directory headers — try several selector variants since the DOM has
  // shifted across point releases
  const header =
    root.querySelector('.directory-header .header-actions') ??
    root.querySelector('.directory-header .action-buttons') ??
    root.querySelector('header.directory-header') ??
    root.querySelector('.directory-header');

  if (!header) return;

  const button = document.createElement('button');
  button.className = 'zenith-importer-button';
  button.type = 'button';
  button.title = 'Import Zenith Adventure';
  button.innerHTML = '<i class="fas fa-book-open"></i> Import';
  button.addEventListener('click', (e) => {
    e.preventDefault();
    openImportDialog();
  });
  header.appendChild(button);
}

// Per-directory hooks — these fire reliably in v13
for (const tabHook of [
  'renderSceneDirectory',
  'renderJournalDirectory',
  'renderActorDirectory',
  'renderItemDirectory',
]) {
  Hooks.on(tabHook, ((_app: unknown, html: HTMLElement | JQuery) => {
    const root = html instanceof HTMLElement ? html : (html as JQuery)[0];
    injectSidebarButton(root);
  }) as (...args: unknown[]) => void);
}

// ============================================================================
// Public API
// ============================================================================

let activeDialog: any = null;

export async function openImportDialog(): Promise<void> {
  if (!game.user.isGM) {
    ui.notifications.warn(
      game.i18n.localize('ZENITH_IMPORTER.Errors.GMOnly'),
    );
    return;
  }

  // Prevent duplicate dialogs
  if (activeDialog) {
    try {
      await activeDialog.bringToFront?.();
    } catch {
      // bringToFront is the v13 name; older versions had bringToTop
    }
    return;
  }

  const ImportDialog = buildImportDialog();
  activeDialog = new (ImportDialog as any)();
  await activeDialog.render(true);

  // Clear the reference when the dialog closes so a future open works
  const originalClose = activeDialog.close.bind(activeDialog);
  activeDialog.close = async (...args: unknown[]) => {
    activeDialog = null;
    return originalClose(...args);
  };
}
