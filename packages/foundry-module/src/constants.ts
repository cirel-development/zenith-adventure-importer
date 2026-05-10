export const MODULE_ID = 'zenith-adventure-importer' as const;
export const MODULE_TITLE = 'Zenith Adventure Importer' as const;

export const SETTING_KEYS = {
  serviceUrl: 'serviceUrl',
  authToken: 'authToken',
  autoLinkPlaylists: 'autoLinkPlaylists',
  verboseLogging: 'verboseLogging',
  // Persisted across sessions: the current undo manifest, keyed by bundle id
  importHistory: 'importHistory',
} as const;

// Where uploaded assets land in Foundry's user data directory.
// Each adventure gets its own subfolder so cleanup is one rm -rf.
export const ASSET_BASE_PATH = 'uploads/zenith-imports' as const;

// FilePicker source — "data" means the user data folder, the default Foundry storage.
// Other options are "public" (modules), "s3", etc. We always use "data".
export const ASSET_SOURCE = 'data' as const;

// Console log prefix
export const LOG_PREFIX = '[Zenith Importer]';

// Translation key prefix
export const I18N_PREFIX = 'ZENITH_IMPORTER';
