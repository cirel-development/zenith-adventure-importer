import { MODULE_ID } from '../constants.js';
import type { PhaseProgress, ImportSummary } from '../pipeline/Importer.js';
import type { UndoSummary } from './UndoHandler.js';

/**
 * Progress dialog with two operation modes (import or undo) and three states
 * (running / complete / error). Mode affects window title and the labels in
 * the complete and error views — the running view is generic enough to share.
 */
export const ProgressDialog = (() => {
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  return class ProgressDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    static override DEFAULT_OPTIONS = {
      id: 'zenith-progress-dialog',
      tag: 'div',
      window: {
        title: 'Importing...',
        icon: 'fas fa-cog fa-spin',
        resizable: false,
      },
      position: { width: 520, height: 'auto' as const },
      classes: ['zenith-importer'],
    };

    static override PARTS = {
      content: {
        template: `modules/${MODULE_ID}/templates/progress-dialog.hbs`,
      },
    };

    private state: 'running' | 'complete' | 'error' = 'running';
    private mode: 'import' | 'undo' = 'import';
    private currentProgress: PhaseProgress = {
      phase: 'idle',
      message: 'Starting...',
    };
    private summary: ImportSummary | null = null;
    private undoSummary: UndoSummary | null = null;
    private errorMessage = '';

    /** Set before showing the dialog so the running view uses correct title. */
    setMode(mode: 'import' | 'undo'): void {
      this.mode = mode;
      const window = (this as any).window;
      if (window) {
        window.title = mode === 'undo' ? 'Undoing...' : 'Importing...';
      }
    }

    override async _prepareContext(options: unknown): Promise<unknown> {
      const baseContext = await (super._prepareContext as any)(options);
      const percent =
        this.currentProgress.current && this.currentProgress.total
          ? Math.floor((this.currentProgress.current / this.currentProgress.total) * 100)
          : null;

      return Object.assign({}, baseContext, {
        state: this.state,
        mode: this.mode,
        isUndo: this.mode === 'undo',
        progress: this.currentProgress,
        percent,
        summary: this.summary,
        undoSummary: this.undoSummary,
        errorMessage: this.errorMessage,
        phaseDisplay: this.formatPhase(this.currentProgress.phase),
      });
    }

    override _onRender(context: unknown, options: unknown): void {
      (super._onRender as any)(context, options);
      const root = (this as any).element as HTMLElement;

      const closeButton = root.querySelector<HTMLButtonElement>('#zenith-close');
      closeButton?.addEventListener('click', (e) => {
        e.preventDefault();
        this.close();
      });
    }

    // ============================================================================
    // Public state-update methods
    // ============================================================================

    async updateProgress(progress: PhaseProgress): Promise<void> {
      this.currentProgress = progress;
      this.state = 'running';
      await this.render(false);
    }

    async showSummary(summary: ImportSummary): Promise<void> {
      this.summary = summary;
      this.state = 'complete';
      this.mode = 'import';
      const window = (this as any).window;
      if (window) {
        window.title = 'Import Complete';
      }
      await this.render(false);
    }

    async showUndoSummary(summary: UndoSummary): Promise<void> {
      this.undoSummary = summary;
      this.state = 'complete';
      this.mode = 'undo';
      const window = (this as any).window;
      if (window) {
        window.title = 'Undo Complete';
      }
      await this.render(false);
    }

    async showError(message: string): Promise<void> {
      this.errorMessage = message;
      this.state = 'error';
      const window = (this as any).window;
      if (window) {
        window.title = this.mode === 'undo' ? 'Undo Failed' : 'Import Failed';
      }
      await this.render(false);
    }

    // ============================================================================

    private formatPhase(phase: PhaseProgress['phase']): string {
      switch (phase) {
        case 'loading':
          return 'Loading bundle';
        case 'preflight':
          return 'Preflight checks';
        case 'uploading-assets':
          return 'Uploading assets';
        case 'building-folders':
          return 'Building folders';
        case 'building-journals':
          return 'Building journals';
        case 'building-items':
          return 'Building items';
        case 'building-actors':
          return 'Building actors';
        case 'building-scenes':
          return 'Building scenes';
        case 'building-playlists':
          return 'Building playlists';
        case 'resolving-refs':
          return 'Resolving references';
        case 'finalizing':
          return 'Finalizing';
        case 'rolling-back':
          return this.mode === 'undo' ? 'Removing entities' : 'Rolling back';
        case 'complete':
          return 'Complete';
        case 'error':
          return 'Error';
        default:
          return 'Working';
      }
    }
  } as unknown as typeof foundry.applications.api.ApplicationV2;
})();
