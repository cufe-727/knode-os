import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { GUIDE_FILE } from '../src/fs/datadir.js';
import { mcpInstructions } from '../src/mcp/instructions.js';

/**
 * The MCP server's instructions (src/mcp/instructions.ts) send an agent to the
 * knowledge base's guide only when there is one: a base nobody has
 * initialised has none, and an agent told to read it first spent a call on
 * nothing.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-mcp-instructions-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('mcpInstructions', () => {
  it('names no guide to read when the base has none', () => {
    const dir = path.join(tmp, 'bare');
    fs.mkdirSync(dir, { recursive: true });
    const text = mcpInstructions(dir);
    expect(text).toContain('start with knode_resolve');
    expect(text).toContain('knode_survey says what this base holds');
    expect(text).not.toMatch(/knode_read/);
    expect(text).not.toContain('Read the base');
  });

  it('gives the guide itself when there is one, and says so instead of sending the agent to read it', () => {
    const dir = path.join(tmp, 'guided');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, GUIDE_FILE), '# Guide\n\nTickers are aliases of their companies.\n');
    const text = mcpInstructions(dir);
    expect(text).toContain("The base's own guide");
    expect(text).toContain('follows; knode_survey has the current numbers');
    expect(text).toContain('Tickers are aliases of their companies.');
    expect(text).not.toMatch(/knode_read/);
  });

  it('says a long guide is cut short and how to read the rest', () => {
    const dir = path.join(tmp, 'long');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, GUIDE_FILE), `# Guide\n\n${'A line of the guide.\n'.repeat(600)}`);
    const text = mcpInstructions(dir);
    expect(text).toContain('follows, cut short;');
    expect(text).toContain(`knode_read ${GUIDE_FILE}`);
  });

  it('notices a guide written after the first call', () => {
    const dir = path.join(tmp, 'later');
    fs.mkdirSync(dir, { recursive: true });
    expect(mcpInstructions(dir)).not.toContain('follows');
    fs.writeFileSync(path.join(dir, GUIDE_FILE), '# Guide\n\nNew.\n');
    expect(mcpInstructions(dir)).toContain('New.');
  });
});
