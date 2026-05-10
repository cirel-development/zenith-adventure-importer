import { MODULE_ID, SETTING_KEYS } from './constants.js';

// ============================================================================
// Token obfuscation — XOR + Base64
// ============================================================================
// Same pattern as ai-map-scanner. Not encryption — just prevents shoulder-surfing
// the auth token in the settings UI. Foundry stores it in plaintext on disk
// regardless; the field rendering as a password input is the actual protection.

const OBFUSCATION_KEY = 'zenith-importer-v1';

function xorString(input: string, key: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    out += String.fromCharCode(
      input.charCodeAt(i) ^ key.charCodeAt(i % key.length),
    );
  }
  return out;
}

export function obfuscateToken(plaintext: string): string {
  if (!plaintext) return '';
  return btoa(xorString(plaintext, OBFUSCATION_KEY));
}

export function deobfuscateToken(stored: string): string {
  if (!stored) return '';
  try {
    return xorString(atob(stored), OBFUSCATION_KEY);
  } catch {
    return '';
  }
}

// ============================================================================
// Settings registration
// ============================================================================

export function registerSettings(): void {
  game.settings.register<string>(MODULE_ID, SETTING_KEYS.serviceUrl, {
    name: 'Service URL',
    hint: 'Base URL of the Zenith Adventure web service. Leave blank if you only import bundles via direct upload.',
    scope: 'world',
    config: true,
    type: String,
    default: 'https://zenithsector.com',
  });

  game.settings.register<string>(MODULE_ID, SETTING_KEYS.authToken, {
    name: 'Auth Token',
    hint: 'Personal access token from your Zenith account. Required for downloading bundles by ID.',
    scope: 'world',
    config: true,
    type: String,
    default: '',
    onChange: (value) => {
      // Re-obfuscate in case the user pasted a plaintext token. We detect plaintext
      // by trying to deobfuscate first — if the result has non-printable chars,
      // it was already plaintext and needs obfuscation now.
      if (value && !looksLikeObfuscated(value)) {
        game.settings.set(MODULE_ID, SETTING_KEYS.authToken, obfuscateToken(value));
      }
    },
  });

  game.settings.register<boolean>(MODULE_ID, SETTING_KEYS.autoLinkPlaylists, {
    name: 'Auto-link playlists to scenes',
    hint: 'When enabled, scenes with a playlist hint set their playlistSound automatically. Recommended only after you add audio files; otherwise scenes will reference empty playlists.',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register<boolean>(MODULE_ID, SETTING_KEYS.verboseLogging, {
    name: 'Verbose logging',
    hint: 'Log every pipeline step to the browser console. Useful for diagnosing import issues.',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });

  // Internal — not shown in UI. Stores the slug→Foundry-id mapping for each
  // imported bundle so we can offer undo later.
  game.settings.register<Record<string, ImportRecord>>(
    MODULE_ID,
    SETTING_KEYS.importHistory,
    {
      name: 'Import History',
      scope: 'world',
      config: false,
      type: Object,
      default: {},
    },
  );
}

// ============================================================================
// Helpers
// ============================================================================

function looksLikeObfuscated(value: string): boolean {
  // Obfuscated tokens are base64. Plaintext tokens are typically prefixed
  // (e.g. "zat_..." for Zenith Auth Token). If it looks like base64 of
  // reasonable length, assume already obfuscated.
  return /^[A-Za-z0-9+/=]+$/.test(value) && value.length > 12 && !value.startsWith('zat_');
}

export function getServiceUrl(): string {
  return (game.settings.get<string>(MODULE_ID, SETTING_KEYS.serviceUrl) ?? '').replace(/\/$/, '');
}

export function getAuthToken(): string {
  const stored = game.settings.get<string>(MODULE_ID, SETTING_KEYS.authToken);
  return deobfuscateToken(stored ?? '');
}

export function isAutoLinkPlaylists(): boolean {
  return Boolean(game.settings.get<boolean>(MODULE_ID, SETTING_KEYS.autoLinkPlaylists));
}

export function isVerboseLogging(): boolean {
  return Boolean(game.settings.get<boolean>(MODULE_ID, SETTING_KEYS.verboseLogging));
}

// ============================================================================
// Import history persistence
// ============================================================================

export interface ImportRecord {
  bundleId: string;
  adventureSlug: string;
  adventureTitle: string;
  importedAt: string; // ISO 8601
  // Reverse-creation order — undoing iterates this and deletes each entity.
  // Pre-built entities sorted so that referencing entities (scenes, journals)
  // are deleted before referenced ones (folders).
  createdEntities: CreatedEntity[];
  // Asset paths uploaded, for cleanup
  assetPaths: string[];
}

export interface CreatedEntity {
  slug: string;
  type: 'folder' | 'journal' | 'scene' | 'actor' | 'item' | 'playlist';
  foundryId: string;
  // Foundry document collection name, e.g. "Folder", "JournalEntry", "Scene"
  collection: string;
}

export async function saveImportRecord(record: ImportRecord): Promise<void> {
  const history = game.settings.get<Record<string, ImportRecord>>(
    MODULE_ID,
    SETTING_KEYS.importHistory,
  );
  history[record.bundleId] = record;
  await game.settings.set(MODULE_ID, SETTING_KEYS.importHistory, history);
}

export function getImportRecord(bundleId: string): ImportRecord | null {
  const history = game.settings.get<Record<string, ImportRecord>>(
    MODULE_ID,
    SETTING_KEYS.importHistory,
  );
  return history[bundleId] ?? null;
}

export function getAllImportRecords(): ImportRecord[] {
  const history = game.settings.get<Record<string, ImportRecord>>(
    MODULE_ID,
    SETTING_KEYS.importHistory,
  );
  return Object.values(history).sort(
    (a, b) => new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime(),
  );
}

export async function deleteImportRecord(bundleId: string): Promise<void> {
  const history = game.settings.get<Record<string, ImportRecord>>(
    MODULE_ID,
    SETTING_KEYS.importHistory,
  );
  delete history[bundleId];
  await game.settings.set(MODULE_ID, SETTING_KEYS.importHistory, history);
}
