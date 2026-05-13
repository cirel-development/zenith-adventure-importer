import { MODULE_ID } from '../constants.js';
import { Importer, type ImportSource } from '../pipeline/Importer.js';
import { ProgressDialog } from './ProgressDialog.js';
import { UndoHandler } from './UndoHandler.js';
import { log } from '../log.js';

/**
 * Builds the ImportDialog ApplicationV2 class. Factory pattern because
 * `foundry.applications.api` is only available at runtime, not parse time.
 *
 * Carried forward from ai-map-scanner where this pattern was proven to work.
 */
export function buildImportDialog(): typeof foundry.applications.api.ApplicationV2 {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  return class ImportDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static override DEFAULT_OPTIONS = {
      id: 'zenith-import-dialog',
      tag: 'form',
      window: {
        title: 'Import Adventure Bundle',
        icon: 'fas fa-book-open',
        resizable: false,
      },
      position: { width: 520, height: 'auto' as const },
      classes: ['zenith-importer'],
    };

    static override PARTS = {
      form: {
        template: `modules/${MODULE_ID}/templates/import-dialog.hbs`,
      },
    };

    private selectedFile: File | null = null;

    override async _prepareContext(options: unknown): Promise<unknown> {
      const baseContext = await (super._prepareContext as any)(options);
      const latest = UndoHandler.latestImport();
      return Object.assign({}, baseContext, {
        moduleId: MODULE_ID,
        latestImport: latest
          ? {
              title: latest.adventureTitle,
              entityCount: latest.createdEntities.length,
              importedAt: formatRelativeTime(latest.importedAt),
              bundleId: latest.bundleId,
            }
          : null,
      });
    }

    override _onRender(context: unknown, options: unknown): void {
      (super._onRender as any)(context, options);
      const root = (this as any).element as HTMLElement;

      // Source mode toggle
      const radios = root.querySelectorAll<HTMLInputElement>('input[name="source"]');
      radios.forEach((radio) =>
        radio.addEventListener('change', () => this.updateSourceMode(root)),
      );
      this.updateSourceMode(root);

      // File input handling
      const fileInput = root.querySelector<HTMLInputElement>('#zenith-file-input');
      const fileLabel = root.querySelector<HTMLElement>('#zenith-file-label');
      const dropZone = root.querySelector<HTMLElement>('#zenith-drop-zone');

      fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0] ?? null;
        this.handleFileSelection(file, fileLabel);
      });

      // Drag-and-drop
      if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
          e.preventDefault();
          dropZone.classList.add('dragover');
        });
        dropZone.addEventListener('dragleave', () => {
          dropZone.classList.remove('dragover');
        });
        dropZone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropZone.classList.remove('dragover');
          const file = (e as DragEvent).dataTransfer?.files[0] ?? null;
          this.handleFileSelection(file, fileLabel);
        });
      }

      // Submit button
      const submitButton = root.querySelector<HTMLButtonElement>('#zenith-submit');
      submitButton?.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleSubmit(root);
      });

      const cancelButton = root.querySelector<HTMLButtonElement>('#zenith-cancel');
      cancelButton?.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });

      // Undo last import button — only present when there's history.
      const undoButton = root.querySelector<HTMLButtonElement>('#zenith-undo-last');
      undoButton?.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleUndoLast();
      });
    }

    // ============================================================================

    private updateSourceMode(root: HTMLElement): void {
      const selected = root.querySelector<HTMLInputElement>(
        'input[name="source"]:checked',
      )?.value;
      root.querySelectorAll<HTMLElement>('[data-source-section]').forEach((section) => {
        const sourceFor = section.dataset['sourceSection'];
        section.style.display = sourceFor === selected ? 'block' : 'none';
      });
    }

    private handleFileSelection(file: File | null, label: HTMLElement | null): void {
      this.selectedFile = file;
      if (label) {
        label.textContent = file ? `${file.name} (${formatBytes(file.size)})` : 'No file selected';
      }
    }

    private async handleSubmit(root: HTMLElement): Promise<void> {
      const sourceMode = root.querySelector<HTMLInputElement>(
        'input[name="source"]:checked',
      )?.value;

      let source: ImportSource | null = null;

      if (sourceMode === 'bundle-id') {
        const value = root.querySelector<HTMLInputElement>('#zenith-bundle-id')?.value.trim();
        if (!value) {
          ui.notifications.warn('Enter a bundle ID.');
          return;
        }
        source = { kind: 'bundle-id', value };
      } else if (sourceMode === 'url') {
        const value = root.querySelector<HTMLInputElement>('#zenith-url')?.value.trim();
        if (!value) {
          ui.notifications.warn('Enter a download URL.');
          return;
        }
        source = { kind: 'url', value };
      } else if (sourceMode === 'file') {
        if (!this.selectedFile) {
          ui.notifications.warn('Select a bundle file.');
          return;
        }
        source = { kind: 'file', value: this.selectedFile };
      }

      if (!source) return;

      // Hand off to ProgressDialog. Close this one.
      await this.close();
      const progress = new (ProgressDialog as any)();
      progress.setMode('import');
      await progress.render(true);

      const importer = new Importer();
      importer.onProgress((p) => progress.updateProgress(p));

      try {
        const summary = await importer.run(source);
        progress.showSummary(summary);
      } catch (err) {
        log.error('import error surfaced to UI:', err);
        progress.showError(err instanceof Error ? err.message : String(err));
      }
    }

    private async handleUndoLast(): Promise<void> {
      const latest = UndoHandler.latestImport();
      if (!latest) {
        ui.notifications.info('No imports to undo.');
        return;
      }

      // Build a confirmation dialog. Foundry v13 ships DialogV2 on
      // foundry.applications.api — use it for native styling.
      const DialogV2 = (foundry.applications.api as any).DialogV2;
      const confirmed = await DialogV2.confirm({
        window: { title: 'Undo Last Import' },
        content: `
          <p>This will permanently delete <strong>${latest.createdEntities.length} entities</strong> created by the import of <strong>${escapeHtml(latest.adventureTitle)}</strong>.</p>
          <p>All folders, journals, actors, items, and playlists from that import will be removed. This cannot be undone — but the bundle can be re-imported afterwards.</p>
          <p>Proceed?</p>
        `,
        rejectClose: false,
        modal: true,
      });

      if (!confirmed) return;

      await this.close();

      const progress = new (ProgressDialog as any)();
      progress.setMode('undo');
      await progress.render(true);

      const handler = new UndoHandler();
      handler.onProgress((p) => progress.updateProgress(p));

      try {
        const summary = await handler.undo(latest);
        progress.showUndoSummary(summary);
      } catch (err) {
        log.error('undo error surfaced to UI:', err);
        progress.showError(err instanceof Error ? err.message : String(err));
      }
    }
  } as unknown as typeof foundry.applications.api.ApplicationV2;
}

// ============================================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Human-readable relative time for the imported-at timestamp. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'recently';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}
