export * from './shared.js';
export * from './manifest.js';
export * from './folders.js';
export * from './journals.js';
export * from './actors.js';
export * from './items.js';
export * from './scenes.js';
export * from './playlists.js';

import {
  ManifestSchema,
  type Manifest,
} from './manifest.js';
import { FoldersFileSchema, type FoldersFile } from './folders.js';
import { JournalsFileSchema, type JournalsFile } from './journals.js';
import { ActorsFileSchema, type ActorsFile } from './actors.js';
import { ItemsFileSchema, type ItemsFile } from './items.js';
import { ScenesFileSchema, type ScenesFile } from './scenes.js';
import { PlaylistsFileSchema, type PlaylistsFile } from './playlists.js';
import {
  extractRefs,
  type RefType,
  CONTRACT_VERSION,
} from './shared.js';

// ============================================================================
// Aggregate Bundle type
// ============================================================================

export interface Bundle {
  manifest: Manifest;
  folders: FoldersFile;
  journals: JournalsFile;
  actors: ActorsFile;
  items: ItemsFile;
  scenes: ScenesFile;
  playlists: PlaylistsFile;
}

// ============================================================================
// Validation result
// ============================================================================

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  bundle?: Bundle;
}

// ============================================================================
// validateBundle — single entry point, does all checks
// ============================================================================

/**
 * Parse and validate a complete bundle. Runs four passes:
 *   1. Manifest schema validation
 *   2. Per-entity-file schema validation
 *   3. Slug uniqueness within each entity type
 *   4. Cross-reference resolution (every [[REF:type:slug]] points to a known entity)
 *
 * Returns a single result with all issues collected. Both the worker (before
 * zipping) and the Foundry module (on import) call this with the same code path.
 */
export function validateBundle(input: {
  manifest: unknown;
  folders: unknown;
  journals: unknown;
  actors: unknown;
  items: unknown;
  scenes: unknown;
  playlists: unknown;
}): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Pass 1: manifest
  const manifestResult = ManifestSchema.safeParse(input.manifest);
  if (!manifestResult.success) {
    pushZodIssues(issues, manifestResult.error, 'manifest');
    return { valid: false, issues };
  }
  const manifest = manifestResult.data;

  if (manifest.contract_version !== CONTRACT_VERSION) {
    issues.push({
      severity: 'error',
      code: 'incompatible_contract_version',
      path: 'manifest.contract_version',
      message: `expected ${CONTRACT_VERSION}, got ${manifest.contract_version}`,
    });
    return { valid: false, issues };
  }

  // Pass 2: each entity file
  const folders = parseOrCollect(FoldersFileSchema, input.folders, 'folders', issues);
  const journals = parseOrCollect(JournalsFileSchema, input.journals, 'journals', issues);
  const actors = parseOrCollect(ActorsFileSchema, input.actors, 'actors', issues);
  const items = parseOrCollect(ItemsFileSchema, input.items, 'items', issues);
  const scenes = parseOrCollect(ScenesFileSchema, input.scenes, 'scenes', issues);
  const playlists = parseOrCollect(
    PlaylistsFileSchema,
    input.playlists,
    'playlists',
    issues,
  );

  if (!folders || !journals || !actors || !items || !scenes || !playlists) {
    return { valid: false, issues };
  }

  // Pass 3: slug uniqueness within each type
  checkUniqueSlugs(folders.entities, 'folders', issues);
  checkUniqueSlugs(journals.entities, 'journals', issues);
  checkUniqueSlugs(actors.entities, 'actors', issues);
  checkUniqueSlugs(items.entities, 'items', issues);
  checkUniqueSlugs(scenes.entities, 'scenes', issues);
  checkUniqueSlugs(playlists.entities, 'playlists', issues);

  // Pass 4: cross-reference resolution
  const slugIndex: Record<RefType, Set<string>> = {
    actor: new Set(actors.entities.map((a) => a.slug)),
    journal: new Set(journals.entities.map((j) => j.slug)),
    scene: new Set(scenes.entities.map((s) => s.slug)),
    item: new Set(items.entities.map((i) => i.slug)),
    playlist: new Set(playlists.entities.map((p) => p.slug)),
  };

  // Build map of journal slug -> set of page slugs for anchor checking
  const journalPageIndex = new Map<string, Set<string>>();
  for (const j of journals.entities) {
    journalPageIndex.set(j.slug, new Set(j.pages.map((p) => p.slug)));
  }

  // Walk every place a REF token can appear and verify each one resolves
  for (const j of journals.entities) {
    for (const p of j.pages) {
      if (p.page_type === 'text') {
        checkRefs(
          p.content_html,
          slugIndex,
          journalPageIndex,
          `journals[${j.slug}].pages[${p.slug}].content_html`,
          issues,
        );
      }
    }
  }
  for (const a of actors.entities) {
    if (a.linked_journal) {
      checkRefs(
        a.linked_journal,
        slugIndex,
        journalPageIndex,
        `actors[${a.slug}].linked_journal`,
        issues,
      );
    }
  }
  for (const i of items.entities) {
    if (i.linked_journal) {
      checkRefs(
        i.linked_journal,
        slugIndex,
        journalPageIndex,
        `items[${i.slug}].linked_journal`,
        issues,
      );
    }
  }
  for (const s of scenes.entities) {
    for (const note of s.notes) {
      checkRefs(
        note.journal_ref,
        slugIndex,
        journalPageIndex,
        `scenes[${s.slug}].notes.journal_ref`,
        issues,
      );
    }
    if (s.playlist_hint) {
      checkRefs(
        s.playlist_hint,
        slugIndex,
        journalPageIndex,
        `scenes[${s.slug}].playlist_hint`,
        issues,
      );
    }
  }
  // Scene pins on journals
  for (const j of journals.entities) {
    if (j.scene_pin) {
      if (!slugIndex.scene.has(j.scene_pin.scene_slug)) {
        issues.push({
          severity: 'error',
          code: 'unresolved_scene_pin',
          path: `journals[${j.slug}].scene_pin.scene_slug`,
          message: `scene "${j.scene_pin.scene_slug}" not found`,
        });
      }
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const valid = errors.length === 0;

  return {
    valid,
    issues,
    bundle: valid
      ? { manifest, folders, journals, actors, items, scenes, playlists }
      : undefined,
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function parseOrCollect<T extends import('zod').ZodTypeAny>(
  schema: T,
  input: unknown,
  pathPrefix: string,
  issues: ValidationIssue[],
): import('zod').infer<T> | null {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  pushZodIssues(issues, result.error, pathPrefix);
  return null;
}

function pushZodIssues(
  issues: ValidationIssue[],
  error: import('zod').ZodError,
  pathPrefix: string,
): void {
  for (const issue of error.issues) {
    issues.push({
      severity: 'error',
      code: `schema_${issue.code}`,
      path: `${pathPrefix}.${issue.path.join('.')}`,
      message: issue.message,
    });
  }
}

function checkUniqueSlugs(
  entries: { slug: string }[],
  pathPrefix: string,
  issues: ValidationIssue[],
): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.slug)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_slug',
        path: `${pathPrefix}[${e.slug}]`,
        message: `duplicate slug "${e.slug}" in ${pathPrefix}`,
      });
    }
    seen.add(e.slug);
  }
}

function checkRefs(
  content: string,
  slugIndex: Record<RefType, Set<string>>,
  journalPageIndex: Map<string, Set<string>>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const ref of extractRefs(content)) {
    if (!slugIndex[ref.type].has(ref.slug)) {
      issues.push({
        severity: 'error',
        code: 'unresolved_ref',
        path,
        message: `${ref.raw}: no ${ref.type} with slug "${ref.slug}"`,
      });
      continue;
    }
    if (ref.anchor && ref.type === 'journal') {
      const pages = journalPageIndex.get(ref.slug);
      if (!pages || !pages.has(ref.anchor)) {
        issues.push({
          severity: 'error',
          code: 'unresolved_ref_anchor',
          path,
          message: `${ref.raw}: journal "${ref.slug}" has no page "${ref.anchor}"`,
        });
      }
    }
  }
}
