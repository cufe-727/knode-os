/**
 * Replay search over the index an evaluation run built, without a model or an
 * embedding call: for every question the run asked a system, search a COPY of
 * the built workspace with the question's vector from the run's cache, and
 * count the questions whose gold source documents are among the first results.
 *
 *   cp -R <run>/work/<pack>/knode/ws/.knode <copy>/.knode      # never open the run's own index
 *   npx tsx scripts/replay-retrieval.mts --run <run> --pack <pack dir> --ws <copy> [options]
 *
 *   --system knode-ask     whose answers decide which questions were asked (default knode-ask)
 *   --modes hybrid,sag     search modes to replay (default hybrid)
 *   --k 8                  results a search asks for (default 8, what `ask` searches for)
 *   --variants '{"cap 0.5":{"generatedShare":0.5}}'   SearchOptions per named variant (default {"default":{}})
 *   --strip-prefix         drop a leading （…） from each question (its cached vector is still the original's)
 *   --suites               also print hits per suite/type
 *   --database '<json>'    a DatabaseConfig, to replay on PostgreSQL instead of the copy's PGlite
 *   --model <identity>     the embedding identity of the cached vectors (default: the run's)
 *
 * Two sets of questions are reported: every question with gold documents and
 * a cached vector, and the `usage` suite alone (the set the 2026-11-14
 * measurement of the 10× separation run counted: 232 questions). A hit is a
 * chunk of a gold source document in the first k results; in the reports pack
 * a source document is one chunk, so gold chunks and gold documents coincide.
 *
 * The script reads the run and the pack and writes nothing to them. Opening
 * the copy may migrate it, which is why it must be a copy.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { defaultConfig } from '../src/config.js';
import type { DatabaseConfig } from '../src/config.js';
import type { EmbeddingProvider } from '../src/ingest/embeddings.js';
import { searchExplained } from '../src/search/search.js';
import type { SearchMode, SearchOptions } from '../src/search/search.js';
import { Store } from '../src/store/db.js';

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
function need(name: string): string {
  const v = flag(name);
  if (!v) {
    console.error(`--${name} is required (see the header of ${path.basename(process.argv[1])})`);
    process.exit(2);
  }
  return path.resolve(v);
}

const RUN = need('run');
const PACK = need('pack');
const WS = need('ws');
if (WS === RUN || WS.startsWith(`${RUN}${path.sep}`)) {
  console.error('--ws must be a copy of the built workspace, not the one inside the run');
  process.exit(2);
}
const system = flag('system') ?? 'knode-ask';
const modes = (flag('modes') ?? 'hybrid').split(',') as SearchMode[];
const k = Number(flag('k') ?? 8);
const variants = JSON.parse(flag('variants') ?? '{"default":{}}') as Record<string, Partial<SearchOptions>>;
const database = flag('database') ? (JSON.parse(flag('database')!) as DatabaseConfig) : undefined;

const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
const runMeta = JSON.parse(fs.readFileSync(path.join(RUN, 'run.json'), 'utf8')) as { embedding?: string };
// "pool:bge-m3:1024:l2-v1 (1024)"
const model = flag('model') ?? String(runMeta.embedding ?? '').replace(/\s*\(\d+\)\s*$/, '');
const dimensions = Number(/\((\d+)\)\s*$/.exec(String(runMeta.embedding ?? ''))?.[1] ?? /:(\d+):/.exec(model)?.[1] ?? 1024);

const vectors = new Map<string, number[]>();
for (const line of lines(path.join(RUN, 'cache', 'vectors.jsonl'))) {
  try {
    const r = JSON.parse(line) as { k: string; v: string };
    const buf = Buffer.from(r.v, 'base64');
    vectors.set(r.k, Array.from(new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))));
  } catch {
    /* a torn line */
  }
}
const keyOf = (text: string) => crypto.createHash('sha256').update(`${model}|${text}`).digest('hex');
/** Answers from the run's cache only: a question without a cached vector is not asked. */
const embedder: EmbeddingProvider = {
  model,
  dimensions,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = vectors.get(keyOf(t));
      if (!v) throw new Error('no cached vector for this text');
      return v;
    });
  },
} as EmbeddingProvider;

interface Task {
  id: string;
  suite: string;
  type: string;
  question: string;
  evidence?: { doc: string }[];
}
const tasks = new Map<string, Task>();
for (const file of fs.readdirSync(path.join(PACK, 'tasks'))) {
  for (const line of lines(path.join(PACK, 'tasks', file))) {
    const t = JSON.parse(line) as Task;
    tasks.set(t.id, t);
  }
}
const asked = new Set<string>();
for (const line of lines(path.join(RUN, 'answers.jsonl'))) {
  const a = JSON.parse(line) as { system: string; taskId: string };
  if (a.system === system) asked.add(a.taskId.replace(/~r\d+$/, ''));
}
const usable = [...asked]
  .map((id) => tasks.get(id))
  .filter((t): t is Task => !!t && (t.evidence?.length ?? 0) > 0 && vectors.has(keyOf(t.question)));

interface Tally {
  n: number;
  hit5: number;
  hit8: number;
  hitK: number;
  sourceShare: number;
  noSource: number;
}
const tally = (): Tally => ({ n: 0, hit5: 0, hit8: 0, hitK: 0, sourceShare: 0, noSource: 0 });
const shown = (t: Tally) => ({
  questions: t.n,
  hit5: t.hit5,
  hit8: t.hit8,
  ...(k > 8 ? { [`hit${k}`]: t.hitK } : {}),
  sourceShareTopK: t.n ? Number((t.sourceShare / t.n).toFixed(3)) : 0,
  noSourceInTopK: t.noSource,
});

const store = await Store.open(WS, dimensions, database);
await store.indexing;
const [index] = await store.query<{ chunks: number; source: number; wiki: number }>(
  `SELECT count(*)::int AS chunks, count(*) FILTER (WHERE d.root <> 'wiki')::int AS source, count(*) FILTER (WHERE d.root = 'wiki')::int AS wiki
   FROM chunks c JOIN documents d ON d.id = c.document_id`,
);
console.log(JSON.stringify({ index, backend: database?.kind ?? 'pglite', system, asked: asked.size, withGoldAndVector: usable.length, k, model }));

const heat = defaultConfig().heat;
const sag = defaultConfig().retrieval.sag;
for (const mode of modes) {
  for (const [name, extra] of Object.entries(variants)) {
    const all = tally();
    const usage = tally();
    const bySuite = new Map<string, Tally>();
    let ms = 0;
    for (const t of usable) {
      const gold = new Set(t.evidence!.map((e) => `raw/docs/${e.doc}`));
      const question = has('strip-prefix') ? t.question.replace(/^（[^）]*）/, '') : t.question;
      const started = Date.now();
      const { results } = await searchExplained(store, embedder, question, {
        k, mode, track: false, current: false, heat, sag, queryVector: vectors.get(keyOf(t.question)), ...extra,
      });
      ms += Date.now() - started;
      const hit = (n: number) => results.slice(0, n).some((r) => gold.has(r.path));
      const sources = results.filter((r) => r.path.startsWith('raw/')).length;
      const suite = bySuite.get(`${t.suite}/${t.type}`) ?? bySuite.set(`${t.suite}/${t.type}`, tally()).get(`${t.suite}/${t.type}`)!;
      for (const into of [all, suite, ...(t.suite === 'usage' ? [usage] : [])]) {
        into.n++;
        if (hit(5)) into.hit5++;
        if (hit(8)) into.hit8++;
        if (hit(k)) into.hitK++;
        into.sourceShare += results.length ? sources / results.length : 0;
        if (sources === 0) into.noSource++;
      }
    }
    console.log(JSON.stringify({ mode, variant: name, all: shown(all), usage: shown(usage), msPerQuestion: Math.round(ms / Math.max(1, all.n)) }));
    if (has('suites')) console.log(JSON.stringify(Object.fromEntries([...bySuite].map(([s, t]) => [s, { n: t.n, hit5: t.hit5, hit8: t.hit8 }]))));
  }
}
await store.close();
