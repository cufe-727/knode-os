import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseYaml } from '../compiler/intents.js';
import { AGENTS_DIR } from '../fs/layout.js';

/**
 * The files under `playbooks/agents/`, read and written as plain records.
 *
 * Kept free of any knode-os config import so `config.ts` can use it: the
 * pipeline and the default LLM may run on a CLI agent, so loading the config
 * has to see those files, and `agents.ts` — which builds the typed definition
 * on top of this — imports the config itself.
 */

export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name);
}

export function agentFilePath(dataDir: string, name: string): string {
  return path.join(dataDir, AGENTS_DIR, `${name}.yaml`);
}

/** Every agent file's name, sorted; files whose stem is not a valid name are skipped. */
export function agentFileNames(dataDir: string): string[] {
  const dir = path.join(dataDir, AGENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => /\.ya?ml$/i.test(entry))
    .sort()
    .map((entry) => entry.replace(/\.ya?ml$/i, ''))
    .filter(isValidAgentName);
}

/** One file's raw fields, or null when there is no such file. A `.yml` twin is read too. */
export function readAgentFile(dataDir: string, name: string): Record<string, unknown> | null {
  if (!isValidAgentName(name)) return null;
  for (const ext of ['yaml', 'yml']) {
    const file = path.join(dataDir, AGENTS_DIR, `${name}.${ext}`);
    if (fs.existsSync(file)) return parseYaml(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

/** YAML without the front-matter fences, the way every agent file is written. */
export function agentYamlText(data: Record<string, unknown>): string {
  return matter.stringify('', data).replace(/^---\n/, '').replace(/---\n*$/, '');
}

export function writeAgentFile(dataDir: string, name: string, data: Record<string, unknown>): void {
  const file = agentFilePath(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, agentYamlText(data));
}
