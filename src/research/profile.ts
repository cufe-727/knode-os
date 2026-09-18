import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseYaml } from '../compiler/intents.js';
import { KnodeConfig } from '../config.js';
import { RESEARCH_DIR } from '../fs/layout.js';
import { agentWebCapable, ResearchAgent } from './agent.js';
import { PHASES, PhaseName, ResearchTemplate } from './templates.js';

/**
 * Research profiles — the harness-independent description of *how* a deep
 * research job runs, stored as `playbooks/research/profiles/<name>.yaml` and
 * selected by `research.profile`:
 *
 *   reasoning.effort      how hard the model thinks (claude --effort, codex
 *                         model_reasoning_effort, cursor model[effort=…])
 *   search                whether web tools are on, how fresh (codex
 *                         web_search = live | cached) and how many rounds
 *   verification / stop / output
 *                         the bar a page must clear, written into every brief
 *                         and, where it is checkable, enforced by the validator
 *   roles                 the sub-agents: one per pipeline phase (or several),
 *                         each with its own CLI, model, effort, tool scope and
 *                         prompt file. Disabling a role skips its phase.
 *
 * Adapters in `launch.ts` translate a role's settings into each CLI's flags;
 * `pipeline.ts` runs the roles. The profile never widens what `review.external`
 * allows — that block remains the master switch for web access.
 */

export const PROFILES_DIR = `${RESEARCH_DIR}/profiles`;
/** Where prompts of roles created in the UI are written (relative to playbooks/research/). */
export const ROLE_PROMPTS_DIR = 'roles';

export const EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const ROLE_PHASES = ['plan', 'research', 'synthesize', 'review', 'revise'] as const;
export type RolePhase = (typeof ROLE_PHASES)[number];
export const WEB_ACCESS = ['inherit', 'on', 'off'] as const;
export type WebAccess = (typeof WEB_ACCESS)[number];
export const PIPELINE_MODES = ['single', 'team', 'native'] as const;
export type PipelineMode = (typeof PIPELINE_MODES)[number];
export const CONFLICT_POLICIES = ['flag', 'prefer_primary', 'prefer_recent'] as const;
export type ConflictPolicy = (typeof CONFLICT_POLICIES)[number];
export const FRESHNESS = ['live', 'cached'] as const;
export type Freshness = (typeof FRESHNESS)[number];

export interface RoleTools {
  /** knode_write / knode_commit / knode_checkout — the role writes pages. */
  write: boolean;
  /** Read / Grep / Glob over the read-only add-dirs (claude enforces it; sandboxed CLIs always read). */
  files: boolean;
  /** Web tools: inherit = the profile's `search.web`, itself gated by review.external. */
  web: WebAccess;
}

export interface ResearchRole {
  id: string;
  title: string;
  phase: RolePhase;
  enabled: boolean;
  /** Which CLI runs this role: a connection id or provider name; '' = research.agent. */
  agent: string;
  /** Model override ('' = the agent's model). */
  model: string;
  /** 'default' = the profile's reasoning.effort. */
  effort: Effort;
  tools: RoleTools;
  /** research phase: parallel sessions (0 = research.researchers). */
  parallel: number;
  /** review / revise phases: critique → revise rounds (0 = research.reviewRounds). */
  rounds: number;
  /** Turn cap for one session (0 = derived from the template / research.maxTurns). */
  maxTurns: number;
  /** Prompt file relative to playbooks/research/ ('' = phases/<phase>.md). */
  prompt: string;
  /** Exposed to the orchestrator as a native sub-agent in pipeline = native. */
  native: boolean;
  /** One line shown to the orchestrator when it picks a sub-agent, and in the UI. */
  description: string;
}

export interface ResearchProfile {
  name: string;
  title: string;
  description: string;
  /** '' = research.pipeline. */
  pipeline: PipelineMode | '';
  reasoning: { effort: Effort };
  search: { web: WebAccess; freshness: Freshness; maxRounds: number };
  verification: { minSourcesPerClaim: number; preferPrimarySources: boolean; resolveConflicts: ConflictPolicy };
  stop: { maxSections: number; marginalGain: boolean };
  output: { citations: boolean; uncertainty: boolean; evidenceTable: boolean };
  roles: ResearchRole[];
  /** File relative to the data dir; '' for the built-in fallback. */
  path: string;
}

/** What a native sub-agent definition needs (claude --agents JSON, codex agents.<id> layer). */
export interface NativeAgentSpec {
  id: string;
  title: string;
  description: string;
  prompt: string;
  write: boolean;
  files: boolean;
  web: boolean;
  model: string;
  effort: Effort;
}

export const EVIDENCE_TABLE_SECTION = '## 证据表';

/* ------------------------------------------------------------------ defaults */

function role(patch: Partial<ResearchRole> & Pick<ResearchRole, 'id' | 'phase'>): ResearchRole {
  return {
    title: patch.id,
    enabled: true,
    agent: '',
    model: '',
    effort: 'default',
    tools: { write: false, files: true, web: 'inherit' },
    parallel: 0,
    rounds: 0,
    maxTurns: 0,
    prompt: '',
    native: false,
    description: '',
    ...patch,
  };
}

export function defaultRoles(): ResearchRole[] {
  return [
    role({ id: 'planner', phase: 'plan', title: '规划者', maxTurns: 12, description: '读简报、摸底索引，把页面拆成可并行调查的章节（JSON 提纲）' }),
    role({ id: 'researcher', phase: 'research', title: '研究员', native: true, description: '只负责一个章节：用 knode 检索与只读资料取证，返回发现与候选 claims / relations' }),
    role({ id: 'synthesizer', phase: 'synthesize', title: '主笔', tools: { write: true, files: true, web: 'inherit' }, description: '把发现综合成页面并用 knode_write 写入' }),
    role({ id: 'critic', phase: 'review', title: '评审', maxTurns: 12, native: true, description: '对照契约评审页面，抽查来源，返回 JSON 判定' }),
    role({ id: 'reviser', phase: 'revise', title: '修订者', tools: { write: true, files: true, web: 'inherit' }, description: '按评审与校验意见修正页面' }),
  ];
}

function baseProfile(name: string, patch: Partial<Omit<ResearchProfile, 'name' | 'path' | 'roles'>> & { roles?: (r: ResearchRole[]) => ResearchRole[] }): ResearchProfile {
  const { roles, ...rest } = patch;
  const p: ResearchProfile = {
    name,
    title: name,
    description: '',
    pipeline: '',
    reasoning: { effort: 'default' },
    search: { web: 'inherit', freshness: 'live', maxRounds: 3 },
    verification: { minSourcesPerClaim: 1, preferPrimarySources: true, resolveConflicts: 'flag' },
    stop: { maxSections: 8, marginalGain: true },
    output: { citations: true, uncertainty: true, evidenceTable: false },
    roles: roles ? roles(defaultRoles()) : defaultRoles(),
    path: '',
    ...rest,
  };
  return p;
}

/** The four built-in profiles, seeded once and re-seeded when deleted (delete = reset). */
export const BUILTIN_PROFILES: Record<string, ResearchProfile> = {
  default: baseProfile('default', {
    title: '默认 · 团队流水线',
    description: '规划 → 并行调查 → 综合 → 评审 → 修订；推理强度与联网跟随 CLI 与 review.external 的默认值。',
  }),
  quick: baseProfile('quick', {
    title: '快速 · 单会话',
    description: '一个会话独立完成，适合刷新已有页面或小问题；章节少、检索轮次少。',
    pipeline: 'single',
    reasoning: { effort: 'medium' },
    search: { web: 'inherit', freshness: 'cached', maxRounds: 2 },
    stop: { maxSections: 4, marginalGain: true },
  }),
  thorough: baseProfile('thorough', {
    title: '深度 · 高强度核实',
    description: '最高推理强度、更多研究员与评审轮次、每条事实至少两个来源、附证据表；成本最高。',
    pipeline: 'team',
    reasoning: { effort: 'max' },
    search: { web: 'inherit', freshness: 'live', maxRounds: 6 },
    verification: { minSourcesPerClaim: 2, preferPrimarySources: true, resolveConflicts: 'prefer_primary' },
    stop: { maxSections: 8, marginalGain: true },
    output: { citations: true, uncertainty: true, evidenceTable: true },
    roles: (rs) => rs.map((r) => (r.id === 'researcher' ? { ...r, parallel: 5 } : r.id === 'critic' || r.id === 'reviser' ? { ...r, rounds: 2 } : r)),
  }),
  native: baseProfile('native', {
    title: '原生子代理',
    description: '一个主管会话，研究员与评审作为 CLI 原生子代理（claude --agents / codex agents.enabled）；cursor 退回单会话。',
    pipeline: 'native',
    reasoning: { effort: 'high' },
  }),
};

/* ------------------------------------------------------------------ files */

export function isValidProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name);
}

function profileFile(dataDir: string, name: string): string {
  return path.join(dataDir, PROFILES_DIR, `${name}.yaml`);
}

/** YAML body of a profile (the file never carries its own path). */
export function profileYaml(profile: ResearchProfile): string {
  const { path: _path, ...data } = profile;
  return matter.stringify('', data).replace(/^---\n/, '').replace(/---\n*$/, '');
}

/** Seed the built-in profiles once (never overwrites user edits). */
export function ensureDefaultProfiles(dataDir: string): string[] {
  const created: string[] = [];
  for (const [name, profile] of Object.entries(BUILTIN_PROFILES)) {
    const file = profileFile(dataDir, name);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, profileYaml(profile));
    created.push(`${PROFILES_DIR}/${name}.yaml`);
  }
  return created;
}

export function loadProfiles(dataDir: string): Map<string, ResearchProfile> {
  ensureDefaultProfiles(dataDir);
  const out = new Map<string, ResearchProfile>();
  const dir = path.join(dataDir, PROFILES_DIR);
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(entry)) continue;
    const name = entry.replace(/\.ya?ml$/i, '');
    if (!isValidProfileName(name)) continue;
    const raw = parseYaml(fs.readFileSync(path.join(dir, entry), 'utf8'));
    out.set(name, normalizeProfile(raw, name, `${PROFILES_DIR}/${entry}`));
  }
  return out;
}

export function loadProfile(dataDir: string, name: string): ResearchProfile | null {
  if (!isValidProfileName(name)) return null;
  const file = profileFile(dataDir, name);
  if (!fs.existsSync(file)) {
    ensureDefaultProfiles(dataDir);
    if (!fs.existsSync(file)) return null;
  }
  return normalizeProfile(parseYaml(fs.readFileSync(file, 'utf8')), name, `${PROFILES_DIR}/${name}.yaml`);
}

/** The profile `research.profile` names, else the built-in default (a missing file never blocks a job). */
export function activeProfile(dataDir: string, config: KnodeConfig): ResearchProfile {
  const name = config.research?.profile?.trim() || 'default';
  return loadProfile(dataDir, name) ?? loadProfile(dataDir, 'default') ?? BUILTIN_PROFILES.default;
}

export function saveProfile(dataDir: string, input: Partial<ResearchProfile> & { name: string }): ResearchProfile {
  if (!isValidProfileName(input.name)) throw new Error(`invalid profile name "${input.name}" (letters, digits, - and _ only)`);
  const profile = normalizeProfile(input as unknown as Record<string, unknown>, input.name, `${PROFILES_DIR}/${input.name}.yaml`);
  const file = profileFile(dataDir, input.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, profileYaml(profile));
  return profile;
}

/** Remove a profile file. Built-in names come back as their defaults on the next load. */
export function deleteProfile(dataDir: string, name: string): boolean {
  if (!isValidProfileName(name)) return false;
  const file = profileFile(dataDir, name);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/* ------------------------------------------------------------------ normalization */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'yes' || v === 1) return true;
  if (v === 'false' || v === 'no' || v === 0) return false;
  return fallback;
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

export function roleIdOf(v: unknown, fallback: string): string {
  const s = str(v).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || fallback;
}

/** A prompt path stays inside playbooks/research/ (posix, no `..`, no absolute paths); anything else means "default". */
export function normalizePromptPath(v: unknown): string {
  const s = str(v).replace(/\\/g, '/');
  if (!s) return '';
  const norm = path.posix.normalize(s);
  if (norm.startsWith('/') || norm.startsWith('..') || norm === '.' || /(^|\/)\.\.(\/|$)/.test(norm)) return '';
  return norm;
}

export function normalizeRole(raw: unknown, index: number): ResearchRole | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const phase = oneOf(o.phase, ROLE_PHASES, '' as RolePhase);
  if (!phase) return null;
  const tools = (o.tools && typeof o.tools === 'object' ? o.tools : {}) as Record<string, unknown>;
  const id = roleIdOf(o.id, `${phase}-${index + 1}`);
  const defaults = defaultRoles().find((r) => r.phase === phase)!;
  return {
    id,
    title: str(o.title, id),
    phase,
    enabled: bool(o.enabled, true),
    agent: str(o.agent),
    model: str(o.model),
    effort: oneOf(o.effort, EFFORTS, 'default'),
    tools: {
      write: bool(tools.write, defaults.tools.write),
      files: bool(tools.files, true),
      web: oneOf(tools.web, WEB_ACCESS, 'inherit'),
    },
    parallel: int(o.parallel, 0, 0, 16),
    rounds: int(o.rounds, 0, 0, 6),
    maxTurns: int(o.maxTurns, 0, 0, 500),
    prompt: normalizePromptPath(o.prompt),
    native: bool(o.native, false),
    description: str(o.description),
  };
}

export function normalizeProfile(raw: Record<string, unknown>, name: string, filePath: string): ResearchProfile {
  const builtin = BUILTIN_PROFILES[name];
  const base = builtin ?? BUILTIN_PROFILES.default;
  const reasoning = (raw.reasoning && typeof raw.reasoning === 'object' ? raw.reasoning : {}) as Record<string, unknown>;
  const search = (raw.search && typeof raw.search === 'object' ? raw.search : {}) as Record<string, unknown>;
  const verification = (raw.verification && typeof raw.verification === 'object' ? raw.verification : {}) as Record<string, unknown>;
  const stop = (raw.stop && typeof raw.stop === 'object' ? raw.stop : {}) as Record<string, unknown>;
  const output = (raw.output && typeof raw.output === 'object' ? raw.output : {}) as Record<string, unknown>;
  const roles: ResearchRole[] = [];
  const seen = new Set<string>();
  const rawRoles = Array.isArray(raw.roles) ? raw.roles : null;
  for (const [i, r] of (rawRoles ?? []).entries()) {
    const role = normalizeRole(r, i);
    if (!role) continue;
    let id = role.id;
    let n = 2;
    while (seen.has(id)) id = `${role.id}-${n++}`;
    seen.add(id);
    roles.push({ ...role, id });
  }
  return {
    name,
    // a custom profile is its own thing: no borrowed title or description from the built-in default
    title: str(raw.title, builtin ? builtin.title : name),
    description: str(raw.description, builtin ? builtin.description : ''),
    pipeline: oneOf(raw.pipeline, [...PIPELINE_MODES, ''] as const, base.pipeline),
    reasoning: { effort: oneOf(reasoning.effort, EFFORTS, base.reasoning.effort) },
    search: {
      web: oneOf(search.web ?? (typeof search.enabled === 'boolean' ? (search.enabled ? 'on' : 'off') : undefined), WEB_ACCESS, base.search.web),
      freshness: oneOf(search.freshness, FRESHNESS, base.search.freshness),
      maxRounds: int(search.maxRounds ?? search.max_rounds, base.search.maxRounds, 1, 20),
    },
    verification: {
      minSourcesPerClaim: int(verification.minSourcesPerClaim ?? verification.min_sources_per_claim, base.verification.minSourcesPerClaim, 1, 5),
      preferPrimarySources: bool(verification.preferPrimarySources ?? verification.prefer_primary_source, base.verification.preferPrimarySources),
      resolveConflicts: oneOf(verification.resolveConflicts ?? verification.resolve_conflicts, CONFLICT_POLICIES, base.verification.resolveConflicts),
    },
    stop: {
      maxSections: int(stop.maxSections ?? stop.max_sections, base.stop.maxSections, 1, 12),
      marginalGain: bool(stop.marginalGain ?? stop.marginal_information_gain, base.stop.marginalGain),
    },
    output: {
      citations: bool(output.citations, base.output.citations),
      uncertainty: bool(output.uncertainty, base.output.uncertainty),
      evidenceTable: bool(output.evidenceTable ?? output.evidence_table, base.output.evidenceTable),
    },
    // a file without a roles key gets the defaults; an explicit empty list is respected (single-session profiles)
    roles: rawRoles === null ? base.roles.map((r) => ({ ...r, tools: { ...r.tools } })) : roles,
    path: filePath,
  };
}

/* ------------------------------------------------------------------ prompts */

export function rolePromptPath(role: ResearchRole): string {
  return role.prompt || `phases/${role.phase}.md`;
}

/**
 * The prompt text a role runs with: the template's own phase prompt when the
 * kind declares one (`override`, e.g. init), else the role's file when
 * present, else the built-in phase prompt.
 */
export function rolePromptText(dataDir: string, role: ResearchRole, override?: string): { text: string; path: string; isDefault: boolean; exists: boolean } {
  if (override) {
    const abs = path.join(dataDir, RESEARCH_DIR, override);
    if (fs.existsSync(abs)) return { text: fs.readFileSync(abs, 'utf8'), path: `${RESEARCH_DIR}/${override}`, isDefault: false, exists: true };
    const builtin = PHASES[override.replace(/^phases\//, '').replace(/\.md$/, '') as PhaseName];
    if (builtin) return { text: builtin, path: `${RESEARCH_DIR}/${override}`, isDefault: false, exists: false };
  }
  const rel = rolePromptPath(role);
  const abs = path.join(dataDir, RESEARCH_DIR, rel);
  const builtin = PHASES[role.phase];
  if (fs.existsSync(abs)) {
    const text = fs.readFileSync(abs, 'utf8');
    return { text, path: `${RESEARCH_DIR}/${rel}`, isDefault: text === builtin, exists: true };
  }
  return { text: builtin, path: `${RESEARCH_DIR}/${rel}`, isDefault: true, exists: false };
}

/** Write a role's prompt; roles without an explicit file get `roles/<id>.md`. Returns the path stored on the role. */
export function writeRolePrompt(dataDir: string, role: ResearchRole, text: string): string {
  const rel = role.prompt || `${ROLE_PROMPTS_DIR}/${role.id}.md`;
  const abs = path.join(dataDir, RESEARCH_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text.endsWith('\n') ? text : `${text}\n`);
  return rel;
}

export function fillPrompt(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

/** Every prompt starts with the phase marker a harness (or test double) reads; users need not write it. */
export function withPhaseMarker(text: string, phase: string): string {
  return /^\s*<!--\s*knode-phase:/.test(text) ? text : `<!-- knode-phase: ${phase} -->\n${text}`;
}

export function rolePrompt(dataDir: string, role: ResearchRole, vars: Record<string, string>, override?: string): string {
  return withPhaseMarker(fillPrompt(rolePromptText(dataDir, role, override).text, vars), role.phase);
}

/* ------------------------------------------------------------------ effective settings */

export function rolesFor(profile: ResearchProfile, phase: RolePhase): ResearchRole[] {
  return profile.roles.filter((r) => r.enabled && r.phase === phase);
}

export function effectiveEffort(profile: ResearchProfile, role?: ResearchRole | null): Effort {
  return role && role.effort !== 'default' ? role.effort : profile.reasoning.effort;
}

export function effectivePipeline(profile: ResearchProfile, config: KnodeConfig): PipelineMode {
  const fromConfig = config.research?.pipeline;
  return profile.pipeline || (fromConfig && (PIPELINE_MODES as readonly string[]).includes(fromConfig) ? (fromConfig as PipelineMode) : 'team');
}

/**
 * Web access for one session. `review.external` is the master switch: `off`
 * never, `research` always, `verify` only for verify jobs — unless the profile
 * or the role says `on`, which widens `verify` to every kind (never `off`).
 * A role or profile saying `off` always wins.
 *
 * The agent has the final say: only the CLIs ship a web tool, so a built-in
 * session is masked to `false` here rather than being handed a brief that
 * promises external verification it cannot perform.
 */
export function webAllowed(input: { gate: 'off' | 'verify' | 'research'; kind: string; profile: ResearchProfile; role?: ResearchRole | null; agent?: ResearchAgent | null }): boolean {
  const { gate, kind, profile, role } = input;
  if (gate === 'off') return false;
  if (input.agent !== undefined && !agentWebCapable(input.agent)) return false;
  const roleWeb = role?.tools.web ?? 'inherit';
  if (roleWeb === 'off' || (roleWeb === 'inherit' && profile.search.web === 'off')) return false;
  if (gate === 'research') return true;
  const forced = roleWeb === 'on' || (roleWeb === 'inherit' && profile.search.web === 'on');
  return kind === 'verify' || forced;
}

/** Sections the page must have: the template's plus the evidence table when the profile asks for one. */
export function requiredSections(template: ResearchTemplate, profile: ResearchProfile | null | undefined): string[] {
  const sections = [...template.requires.sections];
  if (profile?.output.evidenceTable && !sections.some((s) => /证据表|evidence/i.test(s))) sections.push(EVIDENCE_TABLE_SECTION);
  return sections;
}

const CONFLICT_TEXT: Record<ConflictPolicy, string> = {
  flag: '并列写出双方与各自来源，标注 disputed，不擅自裁决',
  prefer_primary: '以一手来源（公告、财报、原始文件）为准，其余写进「争议与缺口」',
  prefer_recent: '以最新日期的来源为准，旧说法写进时间线并标注已被更新',
};

const EFFORT_TEXT: Record<Effort, string> = {
  default: 'CLI 默认',
  low: '低（快速浏览）',
  medium: '中',
  high: '高（多轮交叉验证）',
  xhigh: '极高',
  max: '最高（不惜成本）',
};

/** The brief's "research rules" block — the profile as instructions the agent reads. */
export function profileBrief(profile: ResearchProfile, opts: { allowNetwork: boolean }): string[] {
  const v = profile.verification;
  const lines = [
    `## 研究规范（profile: ${profile.name}${profile.title && profile.title !== profile.name ? ` · ${profile.title}` : ''}）`,
    '',
    `- 推理强度：${EFFORT_TEXT[profile.reasoning.effort]}`,
    opts.allowNetwork
      ? `- 联网：允许；检索新鲜度 ${profile.search.freshness === 'live' ? 'live（实时）' : 'cached（索引缓存）'}；每个章节最多 ${profile.search.maxRounds} 轮检索`
      : '- 联网：不允许（只用知识库与只读资料）',
    `- 来源：每条 fact 至少 ${v.minSourcesPerClaim} 个来源${v.minSourcesPerClaim >= 2 ? '（frontmatter 里的 claim 用 sources: [...] 列出）' : ''}；${v.preferPrimarySources ? '优先一手来源' : '一手与二手来源均可，但要标明'}`,
    `- 冲突：${CONFLICT_TEXT[v.resolveConflicts]}`,
    `- 停止条件：最多 ${profile.stop.maxSections} 个章节${profile.stop.marginalGain ? '；当新一轮检索不再带来新事实时停止该章节' : ''}`,
    `- 输出：${[
      profile.output.citations ? '每条事实带来源引用（路径或 URL）' : null,
      profile.output.uncertainty ? '不确定的断言标 suspected 并写明不确定的原因' : null,
      profile.output.evidenceTable ? `包含「${EVIDENCE_TABLE_SECTION}」章节（表格列：断言 | 来源 | 日期 | 置信度）` : null,
    ].filter(Boolean).join('；') || '按模版'}`,
  ];
  return lines;
}

/** A one-line summary for lists (API, CLI, UI). */
export function profileSummary(p: ResearchProfile): Record<string, unknown> {
  return {
    name: p.name,
    title: p.title,
    description: p.description,
    pipeline: p.pipeline,
    effort: p.reasoning.effort,
    web: p.search.web,
    freshness: p.search.freshness,
    roles: p.roles.filter((r) => r.enabled).map((r) => r.id),
    path: p.path,
    builtin: Boolean(BUILTIN_PROFILES[p.name]),
  };
}

/* ------------------------------------------------------------------ verification helpers */

/** Sources a frontmatter claim cites itself (`source: path` or `sources: [..]`). */
export function claimSources(claim: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) out.push(x.trim());
  };
  push(claim.sources);
  push(claim.source);
  return [...new Set(out)];
}

/**
 * verification.minSourcesPerClaim, checked where it can be: a `fact` needs that
 * many sources of its own once the bar is above one (with one source the
 * page-level `sources` list is enough, as before); a `suspected` claim only warns.
 */
export function claimSourceIssues(claims: unknown, minSources: number): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (minSources < 2 || !Array.isArray(claims)) return { errors, warnings };
  for (const raw of claims) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.statement !== 'string' || !o.statement.trim()) continue;
    const n = claimSources(o).length;
    if (n >= minSources) continue;
    const msg = `claim "${o.statement.slice(0, 40)}": ${n} source(s), the profile requires ${minSources} per claim (add sources: [...])`;
    if (o.status === 'suspected' || o.status === 'disputed') warnings.push(msg);
    else errors.push(msg);
  }
  return { errors, warnings };
}
