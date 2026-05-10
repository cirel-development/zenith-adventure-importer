import { MODULE_ID } from '../constants.js';
import type { PhaseProgress, ImportSummary } from '../pipeline/Importer.js';

/**
 * Progress dialog with three states:
 *   1. Running — phase name + progress bar + current item
 *   2. Complete — summary with counts + close button
 *   3. Error — error message + close button
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
    private currentProgress: PhaseProgress = {
      phase: 'idle',
      message: 'Starting...',
    };
    private summary: ImportSummary | null = null;
    private errorMessage = '';

    override async _prepareContext(options: unknown): Promise<unknown> {
      const baseContext = await (super._prepareContext as any)(options);
      const percent =
        this.currentProgress.current && this.currentProgress.total
          ? Math.floor((this.currentProgress.current / this.currentProgress.total) * 100)
          : null;

      return Object.assign({}, baseContext, {
        state: this.state,
        progress: this.currentProgress,
        percent,
        summary: this.summary,
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
    // Public state-update methods called by Importer
    // ============================================================================

    async updateProgress(progress: PhaseProgress): Promise<void> {
      this.currentProgress = progress;
      this.state = 'running';
      await this.render(false);
    }

    async showSummary(summary: ImportSummary): Promise<void> {
      this.summary = summary;
      this.state = 'complete';
      // Update window title
      const window = (this as any).window;
      if (window) {
        window.title = 'Import Complete';
      }
      await this.render(false);
    }

    async showError(message: string): Promise<void> {
      this.errorMessage = message;
      this.state = 'error';
      const window = (this as any).window;
      if (window) {
        window.title = 'Import Failed';
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
          return 'Rolling back';
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
