import type { Bundle, RefType } from '@ai-adventure/contract';
import { extractRefs } from '@ai-adventure/contract';
import type { EntityRegistry } from './EntityRegistry.js';
import { log } from '../log.js';

/**
 * Resolves [[REF:type:slug]] tokens after all entities have been created.
 *
 * Two distinct resolution targets:
 *   1. Journal page HTML — replace tokens with @UUID[] links Foundry renders as clickable.
 *   2. Scene notes — set the entryId field to the resolved journal's Foundry ID.
 *
 * The contract's validateBundle already verified every ref has a matching
 * entity, so we don't expect missing refs at this stage. If we hit one,
 * it means an entity creation failed silently — log warning and leave token in place.
 */
export class RefResolver {
  async resolve(bundle: Bundle, registry: EntityRegistry): Promise<void> {
    log.info('resolving cross-references');

    let journalsUpdated = 0;
    let notesUpdated = 0;

    // ----- Journal HTML pass -----
    for (const journalEntry of bundle.journals.entities) {
      const journalRecord = registry.lookup('journal', journalEntry.slug);
      if (!journalRecord) {
        log.warn(`journal "${journalEntry.slug}" not in registry, skipping ref pass`);
        continue;
      }
      const foundryJournal = game.journal.get(journalRecord.foundryId);
      if (!foundryJournal) {
        log.warn(`journal "${journalEntry.slug}" was created but not found in collection`);
        continue;
      }

      let pageUpdates: Array<Record<string, unknown>> = [];
      for (const pageData of journalEntry.pages) {
        if (pageData.page_type !== 'text') continue;
        if (!pageData.content_html.includes('[[REF:')) continue;

        const resolved = this.resolveContent(pageData.content_html, registry);
        if (resolved === pageData.content_html) continue;

        // Find the Foundry page by its slug flag
        const foundryPage = foundryJournal.pages.find(
          (p: any) =>
            p.flags?.['zenith-adventure-importer']?.slug === pageData.slug,
        );
        if (!foundryPage) {
          log.warn(
            `page "${pageData.slug}" of journal "${journalEntry.slug}" not found, skipping`,
          );
          continue;
        }

        pageUpdates.push({
          _id: foundryPage.id,
          'text.content': resolved,
        });
      }

      if (pageUpdates.length > 0) {
        // Foundry batch update — much faster than one update per page
        await (foundryJournal as any).updateEmbeddedDocuments(
          'JournalEntryPage',
          pageUpdates,
        );
        journalsUpdated += pageUpdates.length;
      }
    }

    // ----- Scene notes pass -----
    for (const sceneEntry of bundle.scenes.entities) {
      const sceneRecord = registry.lookup('scene', sceneEntry.slug);
      if (!sceneRecord) continue;
      const foundryScene = game.scenes.get(sceneRecord.foundryId);
      if (!foundryScene) continue;

      const noteUpdates: Array<Record<string, unknown>> = [];
      for (const note of (foundryScene as any).notes ?? []) {
        const ref = note.flags?.['zenith-adventure-importer']?.unresolvedJournalRef;
        if (!ref) continue;

        const parsed = extractRefs(ref)[0];
        if (!parsed || parsed.type !== 'journal') {
          log.warn(`scene "${sceneEntry.slug}" has invalid note ref: ${ref}`);
          continue;
        }
        const target = registry.lookup('journal', parsed.slug);
        if (!target) {
          log.warn(`scene "${sceneEntry.slug}" note refs missing journal "${parsed.slug}"`);
          continue;
        }

        // For page anchors, look up the page id within the journal
        let pageId: string | undefined;
        if (parsed.anchor) {
          const journal = game.journal.get(target.foundryId);
          const page = journal?.pages.find(
            (p: any) =>
              p.flags?.['zenith-adventure-importer']?.slug === parsed.anchor,
          );
          pageId = page?.id;
        }

        noteUpdates.push({
          _id: note.id,
          entryId: target.foundryId,
          ...(pageId ? { pageId } : {}),
          // Clear the unresolved flag now that it's wired up
          'flags.zenith-adventure-importer.-=unresolvedJournalRef': null,
        });
      }

      if (noteUpdates.length > 0) {
        await (foundryScene as any).updateEmbeddedDocuments('Note', noteUpdates);
        notesUpdated += noteUpdates.length;
      }
    }

    // ----- Item descriptions pass -----
    // PF2e items have descriptions at system.description.value. Custom items
    // may include [[REF:]] tokens (e.g. "see [[REF:journal:npc#captain-marrow]]").
    let itemsUpdated = 0;
    for (const itemEntry of bundle.items.entities) {
      const record = registry.lookup('item', itemEntry.slug);
      if (!record) continue;
      const foundryItem = game.items.get(record.foundryId);
      if (!foundryItem) continue;

      const description = (foundryItem as any).system?.description?.value;
      if (typeof description !== 'string' || !description.includes('[[REF:')) {
        continue;
      }

      const resolved = this.resolveContent(description, registry);
      if (resolved === description) continue;

      await (foundryItem as any).update({
        'system.description.value': resolved,
      });
      itemsUpdated++;
    }

    // ----- Actor tactics + linked-journal pass -----
    // Custom NPC tactics (system.details.publicNotes for PF2e) and the
    // linked_journal field can both contain refs.
    let actorsUpdated = 0;
    for (const actorEntry of bundle.actors.entities) {
      const record = registry.lookup('actor', actorEntry.slug);
      if (!record) continue;
      const foundryActor = game.actors.get(record.foundryId);
      if (!foundryActor) continue;

      const updates: Record<string, unknown> = {};
      const publicNotes = (foundryActor as any).system?.details?.publicNotes;
      if (typeof publicNotes === 'string' && publicNotes.includes('[[REF:')) {
        const resolved = this.resolveContent(publicNotes, registry);
        if (resolved !== publicNotes) {
          updates['system.details.publicNotes'] = resolved;
        }
      }

      if (Object.keys(updates).length > 0) {
        await (foundryActor as any).update(updates);
        actorsUpdated++;
      }
    }

    log.info(
      `resolved refs: ${journalsUpdated} pages updated, ${notesUpdated} notes pinned, ${itemsUpdated} items updated, ${actorsUpdated} actors updated`,
    );
  }

  // ============================================================================

  /**
   * Replace every [[REF:type:slug]] token in HTML with the appropriate Foundry link.
   * Tokens that don't resolve are left in place with a warning.
   */
  private resolveContent(html: string, registry: EntityRegistry): string {
    return html.replace(
      /\[\[REF:(actor|journal|scene|item|playlist):([a-z0-9]+(?:-[a-z0-9]+)*)(?:#([a-z0-9]+(?:-[a-z0-9]+)*))?\]\]/g,
      (match, type: RefType, slug: string, anchor?: string) => {
        const record = registry.lookup(type, slug);
        if (!record) {
          log.warn(`unresolved ref ${match}; entity not in registry`);
          return match;
        }
        // Foundry @UUID syntax. For journal page anchors, append .JournalEntryPage.<pageId>
        // We resolve the page ID by looking through the journal in memory.
        if (type === 'journal' && anchor) {
          const journal = game.journal.get(record.foundryId);
          const page = journal?.pages.find(
            (p: any) => p.flags?.['zenith-adventure-importer']?.slug === anchor,
          );
          if (page) {
            return `@UUID[JournalEntry.${record.foundryId}.JournalEntryPage.${page.id}]{${page.name}}`;
          }
          log.warn(`page "${anchor}" not found in journal "${slug}"`);
        }
        return `@UUID[${this.collectionFor(type)}.${record.foundryId}]`;
      },
    );
  }

  private collectionFor(type: RefType): string {
    switch (type) {
      case 'actor':
        return 'Actor';
      case 'journal':
        return 'JournalEntry';
      case 'scene':
        return 'Scene';
      case 'item':
        return 'Item';
      case 'playlist':
        return 'Playlist';
    }
  }
}
