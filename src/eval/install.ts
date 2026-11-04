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

/**
 * Systems installed without their declared dependencies, with these instead.
 * HippoRAG 2.0.0a4 pins openai==1.91.1 (no longer on PyPI) and vLLM 0.6.6
 * (Linux/CUDA only); the adapter reaches every model through the shim, so
 * neither vLLM nor GritLM is needed.
 */
const OWN_DEPS: Partial<Record<ExternalId, string[]>> = {
  hipporag: ['torch', 'transformers==4.45.2', 'openai==1.91.0', 'litellm==1.73.1', 'networkx==3.4.2', 'python-igraph==0.11.8', 'tiktoken', 'pydantic==2.10.4', 'tenacity==8.5.0', 'einops', 'tqdm', 'boto3', 'numpy', 'pandas', 'pyarrow'],
};

async function pickVersion(pkg: string, minAgeDays = 14): Promise<string> {
  const res = await fetch(`https://pypi.org/pypi/${pkg}/json`);
  if (!res.ok) throw new Error(`PyPI lookup for ${pkg} failed (${res.status})`);
  const json = (await res.json()) as { releases: Record<string, { upload_time_iso_8601?: string; upload_time?: string; yanked?: boolean }[]> };
  const cutoff = Date.now() - minAgeDays * 86_400_000;
  const parts = (v: string) => v.split('.').map(Number);
  const newer = (a: string, b: string) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  // the highest version whose first upload is old enough — not the latest upload, which may be a backport
  const ok = Object.entries(json.releases)
    .filter(([v, files]) => /^\d+(\.\d+)*$/.test(v) && files.length && files.every((f) => !f.yanked))
    .map(([v, files]) => ({ v, at: Math.min(...files.map((f) => Date.parse(f.upload_time_iso_8601 ?? (f.upload_time ? `${f.upload_time}Z` : '')) || Infinity)) }))
    .filter((r) => r.at <= cutoff)
    .sort((a, b) => newer(b.v, a.v));
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
  const own = OWN_DEPS[sys];
  if (own) {
    await run(['pip', 'install', '--python', venvPython(sys), '--no-deps', `${PACKAGES[sys]}==${version}`]);
    await run(['pip', 'install', '--python', venvPython(sys), ...own, ...EXTRAS[sys]]);
  } else {
    await run(['pip', 'install', '--python', venvPython(sys), `${PACKAGES[sys]}==${version}`, ...EXTRAS[sys]]);
  }
  fs.writeFileSync(path.join(dir, 'knode-eval-version'), `${PACKAGES[sys]}==${version}\n`);
  return { dir, version };
}

export function installedVersion(id: string): string | null {
  const f = path.join(venvDir(id), 'knode-eval-version');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
}
