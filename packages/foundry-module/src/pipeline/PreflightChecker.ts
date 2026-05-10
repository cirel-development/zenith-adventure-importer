import type { Bundle } from '@ai-adventure/contract';
import type { LoadedBundle } from './BundleLoader.js';
import { log } from '../log.js';

export interface PreflightIssue {
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

/**
 * Runs all the cheap checks we can do before touching Foundry. The contract's
 * validateBundle() catches schema and ref issues; this catches things only
 * visible at import time:
 *   - asset references that point to files not in the zip
 *   - existing import that would collide on the bundle id
 *   - Foundry being in an unexpected state (no canvas, wrong system, etc.)
 *
 * NOT included here (deferred to Pass 2):
 *   - compendium UUID resolution against installed packs
 *   - rune lookup validation
 */
export class PreflightChecker {
  check(loaded: LoadedBundle, alreadyImportedIds: Set<string>): PreflightResult {
    const issues: PreflightIssue[] = [];
    this.checkSystem(loaded.bundle, issues);
    this.checkBundleNotAlreadyImported(loaded.bundle, alreadyImportedIds, issues);
    this.checkAllAssetsPresent(loaded, issues);
    this.checkUserIsGM(issues);

    const ok = !issues.some((i) => i.severity === 'error');
    log.debug('preflight done', { ok, issueCount: issues.length });
    return { ok, issues };
  }

  // ============================================================================

  private checkSystem(bundle: Bundle, issues: PreflightIssue[]): void {
    const expected = bundle.manifest.adventure.system;
    const actual = game.system.id;
    if (expected !== actual) {
      issues.push({
        severity: 'error',
        message: `Bundle is for "${expected}" but this world uses "${actual}". Switch worlds or import a compatible bundle.`,
        path: 'manifest.adventure.system',
      });
    }
  }

  private checkBundleNotAlreadyImported(
    bundle: Bundle,
    alreadyImportedIds: Set<string>,
    issues: PreflightIssue[],
  ): void {
    if (alreadyImportedIds.has(bundle.manifest.bundle_id)) {
      issues.push({
        severity: 'error',
        message: `Bundle "${bundle.manifest.bundle_id}" has already been imported. Undo the previous import first if you want to re-import.`,
        path: 'manifest.bundle_id',
      });
    }
  }

  private checkAllAssetsPresent(loaded: LoadedBundle, issues: PreflightIssue[]): void {
    // Collect every asset path referenced from any entity, then check the zip
    // contains all of them.
    const referenced = new Set<string>();
    const { bundle } = loaded;

    for (const j of bundle.journals.entities) {
      for (const p of j.pages) {
        if (p.page_type === 'image') referenced.add(p.image);
      }
    }
    for (const a of bundle.actors.entities) {
      if (a.portrait) referenced.add(a.portrait);
      if (a.token_image) referenced.add(a.token_image);
    }
    for (const i of bundle.items.entities) {
      if (i.image) referenced.add(i.image);
    }
    for (const s of bundle.scenes.entities) {
      referenced.add(s.background);
    }

    for (const path of referenced) {
      if (!loaded.assets.has(path)) {
        issues.push({
          severity: 'error',
          message: `Asset referenced but not in bundle: ${path}`,
          path,
        });
      }
    }
  }

  private checkUserIsGM(issues: PreflightIssue[]): void {
    if (!game.user.isGM) {
      issues.push({
        severity: 'error',
        message: 'Only the GM can import adventure bundles.',
      });
    }
  }
}
