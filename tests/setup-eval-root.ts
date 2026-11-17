import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

/*
 * Every evaluation run a test starts keeps its knode builds in an evaluation
 * root (docs/design/35), by default `~/knode-eval/server`: no test may write
 * there. Each test file gets a root of its own in a temporary folder, removed
 * when the file is done; a test that names a root (`evalRoot`) uses that one.
 */
if (!process.env.KNODE_EVAL_ROOT) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-eval-root-'));
  process.env.KNODE_EVAL_ROOT = path.join(dir, 'server');
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.KNODE_EVAL_ROOT;
  });
}
