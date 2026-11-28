import { MODULE_ID } from '../constants.js';
import { deleteImportRecord, getAllImportRecords, getImportRecord, type ImportRecord } from '../settings.js';
import { ProgressDialog } from './ProgressDialog.js';
import { UndoHandler } from './UndoHandler.js';
import { escapeHtml, formatRelativeTime } from './format.js';
import { log } from '../log.js';

/** Document types in the order a GM thinks about an adventure. */
const TYPE_LABELS: [string, string][] = [
  ['scene', 'scenes'],
  ['journal', 'journals'],
  ['actor', 'actors'],
  ['item', 'items'],
  ['playlist', 'playlists'],
  ['folder', 'folders'],
];

/** How many of a record's documents still exist in the world. */
function stillPresent(record: ImportRecord): number {
  const collections = (game as any).collections;
  return record.createdEntities.filter((e) => collections.get(e.collection)?.get(e.foundryId)).length;
}

export function describeRecord(record: ImportRecord) {
  const counts = TYPE_LABELS.map(([type, label]) => ({ label, n: record.createdEntities.filter((e) => e.type === type).length })).filter((c) => c.n > 0);
  const total = record.createdEntities.length;
  const present = stillPresent(record);
  return {
    bundleId: record.bundleId,
    title: record.adventureTitle,
    importedAt: formatRelativeTime(record.importedAt),
    importedAtFull: new Date(record.importedAt).toLocaleString(),
    counts: counts.map((c) => `${c.n} ${c.label}`).join(' · '),
    total,
    present,
    // Everything already deleted by hand: only the record is left to forget.
    stale: present === 0,
    partial: present > 0 && present < total,
  };
}

/**
 * "Manage Imports": every import still on record, with Undo (delete what the
 * import created) and Forget (drop the record only, for imports whose
 * documents were already removed by hand). Built at runtime like
 * ImportDialog because foundry.applications.api only exists in Foundry.
 */
export function buildManageImportsDialog(): typeof foundry.applications.api.ApplicationV2 {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  return class ManageImportsDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static override DEFAULT_OPTIONS = {
      id: 'zenith-manage-imports',
      tag: 'div',
      window: { title: 'Manage Adventure Imports', icon: 'fas fa-list', resizable: true },
      position: { width: 560, height: 'auto' as const },
      classes: ['zenith-importer'],
      actions: {
        undoImport: function (this: any, _event: Event, target: HTMLElement) {
          return this.undoImport(target.dataset['bundleId']);
        },
        forgetImport: function (this: any, _event: Event, target: HTMLElement) {
          return this.forgetImport(target.dataset['bundleId']);
        },
      },
    };

    static override PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/manage-imports.hbs` },
    };

    override async _prepareContext(options: unknown): Promise<unknown> {
      const base = await (super._prepareContext as any)(options);
      return Object.assign({}, base, { imports: getAllImportRecords().map(describeRecord) });
    }

    private async undoImport(bundleId: string | undefined): Promise<void> {
      const record = bundleId ? getImportRecord(bundleId) : null;
      if (!record) return;
      const info = describeRecord(record);
      const DialogV2 = (foundry.applications.api as any).DialogV2;
      const confirmed = await DialogV2.confirm({
        window: { title: 'Undo Import' },
        content: `<p>This will permanently delete the <strong>${info.present}</strong> documents still left from <strong>${escapeHtml(record.adventureTitle)}</strong> (${escapeHtml(info.counts)}).</p>
          <p>It cannot be undone, but the bundle can be imported again afterwards. Uploaded images stay in the data folder.</p>`,
        rejectClose: false,
        modal: true,
      });
      if (!confirmed) return;

      const progress = new (ProgressDialog as any)();
      progress.setMode('undo');
      await progress.render(true);
      const handler = new UndoHandler();
      handler.onProgress((p) => progress.updateProgress(p));
      try {
        progress.showUndoSummary(await handler.undo(record));
      } catch (err) {
        log.error('undo error surfaced to UI:', err);
        progress.showError(err instanceof Error ? err.message : String(err));
      }
      await (this as any).render();
    }

    private async forgetImport(bundleId: string | undefined): Promise<void> {
      const record = bundleId ? getImportRecord(bundleId) : null;
      if (!record) return;
      const info = describeRecord(record);
      const DialogV2 = (foundry.applications.api as any).DialogV2;
      const confirmed = await DialogV2.confirm({
        window: { title: 'Forget Import' },
        content: info.stale
          ? `<p>Remove the record of <strong>${escapeHtml(record.adventureTitle)}</strong>? Its documents are already gone; this only clears the list entry so the bundle can be imported again.</p>`
          : `<p><strong>${info.present}</strong> documents from <strong>${escapeHtml(record.adventureTitle)}</strong> still exist. Forgetting keeps them, but they can no longer be undone from here. Continue?</p>`,
        rejectClose: false,
        modal: true,
      });
      if (!confirmed) return;
      await deleteImportRecord(record.bundleId);
      ui.notifications.info(`Forgot the import of "${record.adventureTitle}".`);
      await (this as any).render();
    }
  } as unknown as typeof foundry.applications.api.ApplicationV2;
}

let openDialog: any = null;

/** Open (or bring forward) the Manage Imports window. GM only. */
export async function openManageImports(): Promise<void> {
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize('ZENITH_IMPORTER.Errors.GMOnly'));
    return;
  }
  if (openDialog?.rendered) {
    openDialog.bringToFront?.();
    return;
  }
  const Dialog = buildManageImportsDialog();
  openDialog = new (Dialog as any)();
  await openDialog.render(true);
}
