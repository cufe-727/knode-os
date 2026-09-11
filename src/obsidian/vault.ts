import fs from 'node:fs';
import path from 'node:path';

/**
 * Obsidian stores per-vault settings in `<vault>/.obsidian`. These defaults
 * keep a knode-os wiki portable: newly-authored links use standard markdown
 * (also OKF), while existing [[wikilinks]] continue to work natively.
 */
export const OBSIDIAN_APP_CONFIG = {
  alwaysUpdateLinks: true,
  newFileLocation: 'folder',
  newFileFolderPath: 'concepts',
  attachmentFolderPath: 'attachments',
  useMarkdownLinks: true,
  showUnsupportedFiles: true,
} as const;

const OBSIDIAN_GITIGNORE = `# Obsidian updates workspace state on every navigation.
workspace*.json
cache/
`;

export interface ObsidianVaultInitResult {
  vaultDir: string;
  created: string[];
}

export interface ObsidianVaultStatus {
  vaultDir: string;
  ready: boolean;
  configDir: boolean;
  appConfig: boolean;
  appConfigValid: boolean;
  attachmentsDir: boolean;
}

/**
 * Make a directory directly openable as an Obsidian Vault. Idempotent and
 * deliberately non-destructive: existing user settings are never rewritten.
 */
export function initObsidianVault(vaultDir: string): ObsidianVaultInitResult {
  const root = path.resolve(vaultDir);
  const created: string[] = [];
  const ensureDir = (rel: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(`${rel}/`);
    }
  };
  const ensureFile = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      created.push(rel);
    }
  };

  fs.mkdirSync(root, { recursive: true });
  ensureDir('.obsidian');
  ensureDir('attachments');
  ensureFile('.obsidian/app.json', JSON.stringify(OBSIDIAN_APP_CONFIG, null, 2) + '\n');
  ensureFile('.obsidian/.gitignore', OBSIDIAN_GITIGNORE);
  return { vaultDir: root, created };
}

export function getObsidianVaultStatus(vaultDir: string): ObsidianVaultStatus {
  const root = path.resolve(vaultDir);
  const configDir = fs.existsSync(path.join(root, '.obsidian')) && fs.statSync(path.join(root, '.obsidian')).isDirectory();
  const appPath = path.join(root, '.obsidian', 'app.json');
  const appConfig = fs.existsSync(appPath) && fs.statSync(appPath).isFile();
  let appConfigValid = false;
  if (appConfig) {
    try {
      const parsed = JSON.parse(fs.readFileSync(appPath, 'utf8'));
      appConfigValid = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
    } catch {
      appConfigValid = false;
    }
  }
  const attachmentsDir = fs.existsSync(path.join(root, 'attachments')) && fs.statSync(path.join(root, 'attachments')).isDirectory();
  return {
    vaultDir: root,
    ready: configDir && appConfig && appConfigValid && attachmentsDir,
    configDir,
    appConfig,
    appConfigValid,
    attachmentsDir,
  };
}
