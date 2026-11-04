import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../llm/cli.js';
import { ExternalId, EXTERNAL_SYSTEMS, venvDir, venvPython } from './systems/external.js';

/**
 * `knode-os eval systems install <id>` (docs/design/23 §3): one virtualenv
 * per external system under `~/knode-eval/venvs`, made with uv on Python
 * 3.12, holding the system at a pinned version. The pin is the newest release
 * at least two weeks old unless one is given, and it is written into the venv
 * (`knode-eval-version`) so a run records exactly what it compared against.
 */

export const PACKAGES: Record<ExternalId, string> = { graphrag: 'graphrag', lightrag: 'lightrag-hku', hipporag: 'hipporag' };

/** Packages an adapter needs beside the system itself. */
const EXTRAS: Record<ExternalId, string[]> = { graphrag: ['pandas', 'pyarrow'], lightrag: ['numpy', 'openai', 'nano-vectordb', 'networkx'], hipporag: [] };

async function pickVersion(pkg: string, minAgeDays = 14): Promise<string> {
  const res = await fetch(`https://pypi.org/pypi/${pkg}/json`);
  if (!res.ok) throw new Error(`PyPI lookup for ${pkg} failed (${res.status})`);
  const json = (await res.json()) as { releases: Record<string, { upload_time_iso_8601?: string; yanked?: boolean }[]> };
  const cutoff = Date.now() - minAgeDays * 86_400_000;
  const ok = Object.entries(json.releases)
    .filter(([v, files]) => /^\d+(\.\d+)*$/.test(v) && files.length && files.every((f) => !f.yanked))
    .map(([v, files]) => ({ v, at: Math.min(...files.map((f) => Date.parse(f.upload_time_iso_8601 ?? '') || Infinity)) }))
    .filter((r) => r.at <= cutoff)
    .sort((a, b) => b.at - a.at);
  if (!ok.length) throw new Error(`no release of ${pkg} older than ${minAgeDays} days`);
  return ok[0].v;
}

export async function installExternal(id: string, opts: { version?: string; python?: string; log?: (m: string) => void } = {}): Promise<{ dir: string; version: string }> {
  if (!(EXTERNAL_SYSTEMS as readonly string[]).includes(id)) throw new Error(`unknown external system ${id} (${EXTERNAL_SYSTEMS.join(', ')})`);
  const sys = id as ExternalId;
  const log = opts.log ?? (() => {});
  const dir = venvDir(sys);
  const version = opts.version ?? (await pickVersion(PACKAGES[sys]));
  log(`${PACKAGES[sys]}==${version} into ${dir}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const run = async (args: string[]) => {
    const r = await runProcess('uv', args, '', 60 * 60_000, { cwd: path.dirname(dir), onStdout: (c) => log(c.trimEnd()), onStderr: (c) => log(c.trimEnd()) });
    if (r.code !== 0) throw new Error(`uv ${args.slice(0, 2).join(' ')} failed (${r.code}): ${r.stderr.slice(-800)}`);
  };
  if (!fs.existsSync(venvPython(sys))) await run(['venv', '--python', opts.python ?? '3.12', dir]);
  await run(['pip', 'install', '--python', venvPython(sys), `${PACKAGES[sys]}==${version}`, ...EXTRAS[sys]]);
  fs.writeFileSync(path.join(dir, 'knode-eval-version'), `${PACKAGES[sys]}==${version}\n`);
  return { dir, version };
}

export function installedVersion(id: string): string | null {
  const f = path.join(venvDir(id), 'knode-eval-version');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
}
