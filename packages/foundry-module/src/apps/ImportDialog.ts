import { MODULE_ID } from '../constants.js';
import { Importer, type ImportSource } from '../pipeline/Importer.js';
import { ProgressDialog } from './ProgressDialog.js';
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
      return Object.assign({}, baseContext, {
        moduleId: MODULE_ID,
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
  } as unknown as typeof foundry.applications.api.ApplicationV2;
}

// ============================================================================

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
