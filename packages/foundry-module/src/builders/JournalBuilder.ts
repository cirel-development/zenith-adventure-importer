import type { Bundle, JournalEntry, JournalPage } from '@ai-adventure/contract';
import type { FolderBuilder } from './FolderBuilder.js';
import type { AssetMap } from '../pipeline/AssetUploader.js';
import type { EntityRegistry } from '../pipeline/EntityRegistry.js';
import { log } from '../log.js';

/**
 * Foundry permission levels are integers:
 *   0 = NONE, 1 = LIMITED, 2 = OBSERVER, 3 = OWNER
 * The contract uses string names so this is the only place that mapping lives.
 */
const PERMISSION_MAP = {
  none: 0,
  limited: 1,
  observer: 2,
  owner: 3,
} as const;

export class JournalBuilder {
  constructor(private readonly folders: FolderBuilder) {}

  async build(
    bundle: Bundle,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const journals = bundle.journals.entities;
    log.info(`building ${journals.length} journal entries`);

    for (const entry of journals) {
      await this.createOne(entry, registry, assetMap);
    }
  }

  // ============================================================================

  private async createOne(
    entry: JournalEntry,
    registry: EntityRegistry,
    assetMap: AssetMap,
  ): Promise<void> {
    const folderId = this.folders.pathToId.get(entry.folder);
    if (!folderId) {
      throw new Error(
        `JournalBuilder: folder "${entry.folder}" not found for journal "${entry.slug}". ` +
          `Folders must be built before journals.`,
      );
    }

    // Default permission applies to anything not overridden at the page level.
    // Foundry uses ownership.default for the JournalEntry-level default.
    const defaultLevel = PERMISSION_MAP[entry.default_permission];

    const pageData = entry.pages.map((p) => this.buildPage(p, assetMap));

    const created = await JournalEntry.create({
      name: entry.name,
      folder: folderId,
      sort: entry.sort,
      ownership: { default: defaultLevel },
      pages: pageData,
      // Stash our slug in flags so we can find this back later if needed
      flags: {
        'zenith-adventure-importer': {
          slug: entry.slug,
          type: entry.type,
        },
      },
    });

    registry.record({
      slug: entry.slug,
      type: 'journal',
      foundryId: created.id,
      collection: 'JournalEntry',
    });

    log.debug('journal created', entry.slug, '→', created.id, `(${pageData.length} pages)`);
  }

  /** Build a single page's data object for inclusion in the journal create call. */
  private buildPage(page: JournalPage, assetMap: AssetMap): unknown {
    const ownership = { default: PERMISSION_MAP[page.permission] };

    if (page.page_type === 'text') {
      return {
        name: page.name,
        type: 'text',
        sort: page.sort,
        ownership,
        text: {
          // content_html still contains [[REF:]] tokens at this point —
          // RefResolver runs after all entities exist.
          content: page.content_html,
          format: 1, // 1 = HTML in Foundry's text page format
        },
        flags: {
          'zenith-adventure-importer': { slug: page.slug },
        },
      };
    }

    // page_type === 'image'
    const foundryPath = assetMap.get(page.image);
    if (!foundryPath) {
      // PreflightChecker should have caught this, but defensively:
      throw new Error(
        `JournalBuilder: asset "${page.image}" not found in upload map. ` +
          `Preflight should have caught this before build.`,
      );
    }
    return {
      name: page.name,
      type: 'image',
      sort: page.sort,
      ownership,
      src: foundryPath,
      ...(page.caption ? { image: { caption: page.caption } } : {}),
      flags: {
        'zenith-adventure-importer': { slug: page.slug },
      },
    };
  }
}
