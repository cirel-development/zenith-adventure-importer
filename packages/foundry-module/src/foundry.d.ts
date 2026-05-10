// Minimal Foundry v13 type shim. We only declare the surfaces this module
// touches. If you need more types, add them here rather than reaching for
// the unmaintained @league-of-foundry-developers types package.

// JQuery shim — Foundry hooks sometimes pass jQuery objects depending on version
declare global {
  type JQuery = { [index: number]: HTMLElement; length: number };

  // ============================================================================
  // Globals
  // ============================================================================

  const game: Game;
  const ui: UI;
  const canvas: Canvas;
  const Hooks: HooksAPI;
  const CONFIG: Record<string, unknown>;
  const foundry: FoundryNamespace;
  const Folder: FolderConstructor;
  const Scene: SceneConstructor;
  const JournalEntry: JournalEntryConstructor;
  const FilePicker: FilePickerStatic;

  // ============================================================================
  // Game
  // ============================================================================

  interface Game {
    user: { isGM: boolean; id: string; name: string };
    system: { id: string; version: string };
    settings: GameSettings;
    folders: Collection<FolderDoc>;
    scenes: Collection<SceneDoc>;
    journal: Collection<JournalEntryDoc>;
    actors: Collection<ActorDoc>;
    items: Collection<ItemDoc>;
    playlists: Collection<PlaylistDoc>;
    i18n: { localize(key: string): string; format(key: string, data: Record<string, unknown>): string };
  }

  // ============================================================================
  // Settings
  // ============================================================================

  interface SettingConfig<T> {
    name: string;
    hint?: string;
    scope: 'world' | 'client';
    config: boolean;
    type: unknown;
    default: T;
    choices?: Record<string, string>;
    onChange?: (value: T) => void;
  }

  interface GameSettings {
    register<T>(module: string, key: string, config: SettingConfig<T>): void;
    get<T = unknown>(module: string, key: string): T;
    set<T>(module: string, key: string, value: T): Promise<T>;
  }

  // ============================================================================
  // UI
  // ============================================================================

  interface UI {
    notifications: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
    };
  }

  // ============================================================================
  // Canvas
  // ============================================================================

  interface Canvas {
    ready: boolean;
    scene: SceneDoc | null;
  }

  // ============================================================================
  // Hooks
  // ============================================================================

  interface HooksAPI {
    on(event: string, fn: (...args: unknown[]) => void): number;
    once(event: string, fn: (...args: unknown[]) => void): number;
    off(event: string, id: number): void;
  }

  // ============================================================================
  // Collections
  // ============================================================================

  interface Collection<T> extends Iterable<T> {
    get(id: string): T | undefined;
    find(predicate: (doc: T) => boolean): T | undefined;
    filter(predicate: (doc: T) => boolean): T[];
    contents: T[];
    size: number;
  }

  // ============================================================================
  // Documents — minimal surface
  // ============================================================================

  interface BaseDoc {
    id: string;
    name: string;
    delete(options?: { deleteSubfolders?: boolean; deleteContents?: boolean }): Promise<this>;
    update(data: Partial<unknown>): Promise<this>;
    uuid: string;
  }

  interface FolderDoc extends BaseDoc {
    type: 'Actor' | 'Item' | 'JournalEntry' | 'Scene' | 'Playlist';
    folder: string | null; // parent folder id
  }

  interface FolderConstructor {
    create(data: {
      name: string;
      type: FolderDoc['type'];
      folder?: string | null;
      sort?: number;
      color?: string;
    }): Promise<FolderDoc>;
  }

  interface SceneDoc extends BaseDoc {
    background: { src: string };
    width: number;
    height: number;
    grid: { type: number; size: number };
  }

  interface SceneConstructor {
    create(data: unknown): Promise<SceneDoc>;
  }

  interface JournalEntryDoc extends BaseDoc {
    pages: Collection<JournalEntryPageDoc>;
  }

  interface JournalEntryPageDoc extends BaseDoc {
    type: 'text' | 'image' | 'pdf' | 'video';
    text?: { content: string };
  }

  interface JournalEntryConstructor {
    create(data: unknown): Promise<JournalEntryDoc>;
  }

  interface ActorDoc extends BaseDoc {}
  interface ItemDoc extends BaseDoc {}
  interface PlaylistDoc extends BaseDoc {}

  // ============================================================================
  // FilePicker
  // ============================================================================

  interface FilePickerStatic {
    upload(
      source: string,
      path: string,
      file: File,
      options?: { notify?: boolean },
    ): Promise<{ path: string; status: string } | false>;
    browse(source: string, target: string): Promise<{ files: string[]; dirs: string[] }>;
    createDirectory(source: string, target: string, options?: unknown): Promise<unknown>;
  }

  // ============================================================================
  // foundry namespace (v13 ApplicationV2 lives here)
  // ============================================================================

  interface FoundryNamespace {
    applications: {
      api: {
        ApplicationV2: ApplicationV2Constructor;
        HandlebarsApplicationMixin: <T extends ApplicationV2Constructor>(base: T) => T;
        DialogV2: DialogV2Static;
      };
      handlebars: {
        loadTemplates(paths: string[]): Promise<Record<string, unknown>>;
      };
    };
    utils: {
      randomID(length?: number): string;
      mergeObject<T, U>(target: T, source: U): T & U;
    };
  }

  interface ApplicationV2Constructor {
    new (options?: unknown): ApplicationV2;
    DEFAULT_OPTIONS: unknown;
    PARTS?: unknown;
  }

  interface ApplicationV2 {
    render(force?: boolean | { force?: boolean }): Promise<this>;
    close(): Promise<this>;
    element: HTMLElement;
    _prepareContext(options: unknown): Promise<unknown>;
    _onRender(context: unknown, options: unknown): void;
    bringToFront?(): void;
    window?: { title: string };
  }

  interface DialogV2Static {
    confirm(options: { window: { title: string }; content: string; rejectClose?: boolean }): Promise<boolean>;
    prompt(options: { window: { title: string }; content: string; ok?: { label: string } }): Promise<unknown>;
  }
}

export {};
