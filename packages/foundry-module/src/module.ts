import { MODULE_ID, MODULE_TITLE } from './constants.js';
import { registerSettings } from './settings.js';
import { buildImportDialog } from './apps/ImportDialog.js';
import { log } from './log.js';

// ============================================================================
// Init: register settings before world is ready
// ============================================================================

Hooks.once('init', () => {
  log.info(`${MODULE_TITLE} initializing`);
  registerSettings();
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
    };
  }
});

// ============================================================================
// Sidebar buttons — add an "Import" button to relevant directory headers
// ============================================================================

// Foundry v13 hook: renderSidebarTab fires once per directory tab. We add a
// button to the Scenes, Journal, and Actor directories so the GM can launch
// the importer from any of those contexts.
Hooks.on('renderSidebarTab', ((app: any, html: HTMLElement | JQuery) => {
  if (!game.user.isGM) return;

  // The directories we want to surface the importer in
  const targetTabs = ['scenes', 'journal', 'actors', 'items'];
  const tabName: string = app.tabName ?? app.constructor?.name?.toLowerCase();
  if (!targetTabs.some((t) => tabName?.toLowerCase().includes(t))) return;

  // Find the header action area. v13 has different DOM than v12 — try a few.
  const root = html instanceof HTMLElement ? html : (html as JQuery)[0];
  if (!root) return;
  const header =
    root.querySelector('.directory-header .action-buttons') ??
    root.querySelector('.directory-header .header-actions') ??
    root.querySelector('.directory-header');

  if (!header) return;

  // Avoid double-adding if the hook fires multiple times
  if (root.querySelector('.zenith-importer-button')) return;

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
}) as (...args: unknown[]) => void);

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
