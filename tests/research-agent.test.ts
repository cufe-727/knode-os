import { describe, expect, it } from 'vitest';
import { KnodeConfig, defaultConfig } from '../src/config.js';
import { agentForSpec, resolveResearchAgent } from '../src/research/agent.js';
import { resolveChatAgent } from '../src/chat/runner.js';

/**
 * The agent resolver had no coverage, and its failure mode is silent: with
 * nothing resolvable the queue logs once and then stalls forever
 * (src/research/service.ts). These tests pin the resolution rules so a change
 * to them has to be deliberate.
 */

const cliConnection = {
  id: 'my-claude',
  label: 'My Claude',
  provider: 'claude-cli' as const,
  baseUrl: '',
  apiKey: '',
  model: 'opus',
  cliPath: '/opt/bin/claude',
  cliTimeoutMs: 300_000,
};

const apiConnection = {
  id: 'ark',
  label: 'Ark',
  provider: 'openai' as const,
  baseUrl: 'https://ark.example/api/v3',
  apiKey: 'sk-ark',
  model: 'doubao-pro',
  cliPath: '',
  cliTimeoutMs: 300_000,
};

function configWith(patch: (c: KnodeConfig) => void): KnodeConfig {
  const config = defaultConfig();
  patch(config);
  return config;
}

describe('agentForSpec', () => {
  it('resolves a connection id to that connection CLI and path', () => {
    const config = configWith((c) => {
      c.connections = [cliConnection];
    });
    expect(agentForSpec(config, 'my-claude')).toEqual({
      kind: 'cli',
      provider: 'claude-cli',
      cliPath: '/opt/bin/claude',
      model: 'opus',
    });
  });

  it('lets an explicit model override the connection model', () => {
    const config = configWith((c) => {
      c.connections = [cliConnection];
    });
    expect(agentForSpec(config, 'my-claude', 'sonnet').model).toBe('sonnet');
  });

  it('resolves a bare provider name, borrowing the path from a connection on the same provider', () => {
    const config = configWith((c) => {
      c.connections = [cliConnection];
    });
    expect(agentForSpec(config, 'claude-cli')).toEqual({
      kind: 'cli',
      provider: 'claude-cli',
      cliPath: '/opt/bin/claude',
      model: 'opus',
    });
  });

  it('resolves a bare provider name with nothing configured for it', () => {
    expect(agentForSpec(defaultConfig(), 'codex-cli')).toEqual({ kind: 'cli', provider: 'codex-cli', cliPath: '', model: '' });
  });

  it('returns null for an empty spec, an unknown name, and a deleted connection id', () => {
    const config = defaultConfig();
    for (const spec of ['', '   ', 'not-a-provider', 'deleted-connection']) {
      expect(agentForSpec(config, spec)).toBeNull();
    }
  });

  it('resolves an OpenAI-compatible connection to the built-in agent', () => {
    const config = configWith((c) => {
      c.connections = [apiConnection];
    });
    expect(agentForSpec(config, 'ark')).toEqual({
      kind: 'builtin',
      provider: 'deep-agents',
      baseUrl: 'https://ark.example/api/v3',
      apiKey: 'sk-ark',
      model: 'doubao-pro',
    });
  });

  it('refuses an endpoint with no model — that cannot run a session', () => {
    const config = configWith((c) => {
      c.connections = [{ ...apiConnection, model: '' }];
    });
    expect(agentForSpec(config, 'ark')).toBeNull();
  });

  it("resolves 'default' to the section-01 connection, whatever kind it is", () => {
    const cli = configWith((c) => {
      c.llm = { ...c.llm, provider: 'codex-cli', cliPath: '/opt/bin/codex' };
    });
    expect(agentForSpec(cli, 'default')).toMatchObject({ kind: 'cli', provider: 'codex-cli' });

    const api = configWith((c) => {
      c.llm = { ...c.llm, provider: 'openai', model: 'gpt-4.1-mini' };
    });
    expect(agentForSpec(api, 'default')).toMatchObject({ kind: 'builtin', model: 'gpt-4.1-mini' });
  });
});

describe('resolveResearchAgent', () => {
  it('uses research.agent when set, with research.model on top', () => {
    const config = configWith((c) => {
      c.connections = [cliConnection];
      c.research.agent = 'my-claude';
      c.research.model = 'haiku';
    });
    expect(resolveResearchAgent(config)).toEqual({
      kind: 'cli',
      provider: 'claude-cli',
      cliPath: '/opt/bin/claude',
      model: 'haiku',
    });
  });

  it('returns null when research.agent names something unresolvable', () => {
    const config = configWith((c) => {
      c.research.agent = 'gone';
    });
    expect(resolveResearchAgent(config)).toBeNull();
  });

  // There is no inherit-from-llm fallback any more: an empty spec means "not
  // configured", whatever the default provider happens to be. Someone who wants
  // the old behaviour names it explicitly with 'default'.
  it('returns null for an empty spec even when the default LLM provider is a CLI', () => {
    const config = configWith((c) => {
      c.llm = { ...c.llm, provider: 'cursor-cli', cliPath: '/opt/bin/cursor-agent', model: 'gpt-5' };
      c.research.agent = '';
    });
    expect(resolveResearchAgent(config)).toBeNull();
    expect(resolveResearchAgent(configWith((c) => { c.research.agent = 'default'; c.llm = { ...c.llm, provider: 'cursor-cli' }; }))).toMatchObject({
      kind: 'cli',
      provider: 'cursor-cli',
    });
  });

  it('returns null for an empty spec when the default LLM provider is an API endpoint', () => {
    expect(defaultConfig().llm.provider).toBe('openai');
    expect(resolveResearchAgent(defaultConfig())).toBeNull();
  });

  it('runs research on the built-in agent when research.agent names an OpenAI connection', () => {
    const config = configWith((c) => {
      c.connections = [apiConnection];
      c.research.agent = 'ark';
    });
    expect(resolveResearchAgent(config)).toMatchObject({ kind: 'builtin', provider: 'deep-agents', model: 'doubao-pro' });
  });
});

describe('resolveChatAgent', () => {
  it('uses chat.agent when set', () => {
    const config = configWith((c) => {
      c.connections = [cliConnection];
      c.chat.agent = 'my-claude';
    });
    expect(resolveChatAgent(config)).toMatchObject({ provider: 'claude-cli', cliPath: '/opt/bin/claude' });
  });

  it('falls back to the research agent, keeping chat.model as the override', () => {
    const config = configWith((c) => {
      c.connections = [cliConnection];
      c.research.agent = 'my-claude';
      c.chat.agent = '';
      c.chat.model = 'sonnet';
    });
    expect(resolveChatAgent(config)).toEqual({ kind: 'cli', provider: 'claude-cli', cliPath: '/opt/bin/claude', model: 'sonnet' });
  });

  it('returns null when neither chat nor research names an agent', () => {
    expect(resolveChatAgent(defaultConfig())).toBeNull();
  });
});
