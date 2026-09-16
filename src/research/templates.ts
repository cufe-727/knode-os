import fs from 'node:fs';
import path from 'node:path';
import { RESEARCH_DIR } from '../fs/layout.js';
import { parseFrontmatter } from '../markdown.js';
import { slugify } from '../graph/store.js';

/**
 * Research templates — what an external agent is told when knode-os asks it
 * to write a wiki page. "Thin harness, fat skills": the runner only prepares
 * a workspace, launches the CLI and validates the result; everything about
 * *how* to research and *what* a good page looks like lives in these Markdown
 * files under playbooks/research/, which the user edits like any playbook.
 *
 * `AGENTS.md` holds the protocol every kind shares; `<kind>.md` adds the
 * page-specific instructions and the output contract (path pattern, required
 * frontmatter keys and sections) the validator enforces.
 */

export type ResearchKind = 'entity' | 'concept' | 'comparison' | 'timeline' | 'question' | 'refresh' | 'verify';

export const RESEARCH_KINDS: ResearchKind[] = ['entity', 'concept', 'comparison', 'timeline', 'question', 'refresh', 'verify'];

export interface ResearchTemplate {
  /** File stem under playbooks/research/. */
  name: string;
  kind: ResearchKind;
  /** Output path pattern; `{slug}` `{date}` `{kind}` are substituted. Empty = the job's target path (refresh). */
  output: string;
  maxTurns: number | null;
  requires: { frontmatter: string[]; sections: string[] };
  /** The instructions the agent reads, with `{target}` `{query}` `{output}` `{actor}` `{research}` placeholders. */
  body: string;
  path: string;
}

export const PROTOCOL_FILE = 'AGENTS.md';

const PROTOCOL = `# knode-os 研究协议（所有研究任务共用）

你在为一个本地知识库（knode-os）撰写或刷新一页 wiki。知识库通过名为 \`knode-os\` 的 MCP 服务器暴露给你；文件系统里以**只读**方式挂载了 \`raw/docs\`（原始文档）、\`wiki\`（现有页面）和 \`.sidecar\`（PDF / 图片转出的 Markdown，在 \`.sidecar/<原路径>/content.md\`）。

## 工作流程

1. 先读 \`brief.md\`：目标、输出路径、必需的 frontmatter 键与章节、可用的关系谓词、已有页面（如有）、上一次被退回的原因（如有）。
2. 起步：调用 \`knode_resolve\`（query 用 brief 的目标，带上 brief 给的 \`workset\`），拿到匹配实体、已知事实（facts）、相关文档、缺口（unknowns）和 receiptId；必要时再 \`knode_context_pack\`。
3. 深挖，直到每个章节都有依据：
   - \`knode_search\`（mode=sag 做多跳检索）找相关段落；
   - \`knode_graph_search\` 看实体的关系网（可带 valid_at / valid_range 看某个时点的关系）；
   - \`knode_claims\`（order=timeline 看时间线，include_superseded=true 看被替换的旧事实，subject 传实体名或别名）；
   - \`knode_read\` 读原文（\`raw/docs/...\`；PDF 读 \`.sidecar/<路径>/content.md\`；\`/entities/<id>.md\` 是实体的机器视图）；\`knode_grep\` 查精确字符串、代码、代号；
   - \`knode_disputes\` 看已记录的矛盾，\`knode_absences\` 看已知"查过但没有"的空档。
   所有读取都带 brief 给的 \`workset\`，这样整个任务看到的是同一时刻的知识库。
4. 写页：**只**用 \`knode_write\` 写到 brief 指定的输出路径。不要用文件工具写，不要写到别的路径，不要修改 raw/docs 或其他 wiki 页。
5. 收尾：\`knode_feedback\`（receipt_id 来自 knode_resolve；used_ids 填你真正用到的 id；outcome 写 answered / partial）→ \`knode_commit\`（workset，content 写一段 3–5 句的研究日志：看了什么、结论、没找到什么）。

## 写作规范

- 每条事实给出来源：正文里写 \`（来源：raw/docs/…）\`，引用其他 wiki 页用 \`[[实体名]]\`。找不到证据的判断写成"疑似 / 据称"，并在 frontmatter 的 claims 里标 \`status: suspected\`。
- frontmatter 必须包含 brief 列出的键。其中：
  - \`aliases\`：别名、简称、英文名、股票代码等；
  - \`relations\`：只写有证据的关系，谓词用 brief 列出的本体 id（如 subsidiary_of / supplies_to / competes_with），方向读作"本页实体 <谓词> 目标"，可带 \`from\` / \`to\`；映射写法：\`supplies_to: ["[[特斯拉]]", { target: 蔚来, from: "2020-01-01" }]\`；
  - \`claims\`：可核查的断言列表：\`{ statement, type, status, eventDate, startDate, endDate }\`，subject 缺省为本页实体；
  - \`sources\`：引用过的路径列表（相对数据目录），至少一条。
- 日期一律 ISO（YYYY-MM-DD / YYYY-MM / YYYY-Qn）；相对时间（去年、本季度）按来源文档的日期折算，折算不了就写清楚"截至文档日期"。
- 若输出路径上已有页面（brief 会附上全文），人写的段落（不在 \`<!-- knode:begin … -->\` 区域内的正文）必须原样保留，只能补充或纠正机器可核查的部分。
- 语言与知识库资料一致（brief 中资料是中文就写中文）；术语、公司名保留原文。

## 联网核实（仅当 brief 写明"联网核实：允许"）

- 优先官方来源：公司公告、监管披露、官网、权威数据库；新闻只作旁证。
- 每条外部事实在 \`sources\` 里写完整 URL，正文标注核实日期（"截至 2026-09-15 核实"）。
- 只有单一外部来源支持的事实，claims 用 \`status: suspected\`；两个独立来源一致才写 \`fact\`。
- 不整段粘贴外部文本，只转述与引用要点。
- 核实身份时把结论写进 frontmatter：\`sameAs: [已知实体名]\`（确认同一实体）、\`notSameAs: [已知实体名]\`（确认不是），名字用知识库里的规范名。

## 禁止

- 不编造来源、数字和日期；不确定的进"争议与缺口"。
- 不运行 shell 命令；不访问互联网，除非 brief 写明允许。
- 不在输出契约之外新建文件。
`;

const ENTITY = `---
type: research-template
kind: entity
output: wiki/entities/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, aliases, sources, actor, research]
  sections: ["## 概要", "## 关键事实", "## 关系", "## 时间线", "## 争议与缺口", "## 来源"]
---
# 实体研究页：{target}

为实体 **{target}** 写一页档案，目标是"读这一页就知道知识库里关于它的一切、以及哪些还不知道"。

## 步骤

1. **身份**：规范名、别名（含英文名 / 简称 / 代码）、类型（用本体里的实体类型）、一句话定义。用 \`knode_graph_search\` 和 \`/entities/<id>.md\` 确认知识库已知的别名与邻居。
2. **关键事实**：从 \`knode_claims\`（order=timeline）和检索到的段落里挑出对理解该实体最重要的 5–15 条事实，每条带日期与来源；被新事实替代的旧事实放进时间线而不是这里。
3. **关系**：上下游（supplies_to / customer_of）、股权与从属（subsidiary_of / owns / invested_in）、竞争与合作（competes_with / partner_of）、人事（works_at / founded）等，只写有证据的，并写进 frontmatter 的 relations。
4. **时间线**：按 eventDate 升序列出关键事件（成立、融资、并购、业绩、人事、重大合同）。
5. **争议与缺口**：\`knode_disputes\` 里的矛盾、来源互相不一致之处、过期或未核实的说法、明显缺失的信息（例如"没有 2026 年之后的财务数据"）。
6. **来源**：列出引用过的每个路径。

## 页面骨架

\`\`\`markdown
---
type: organization            # 或 person / product / project / technology / event / location …
title: {target}
aliases: []
description: 一句话定义
relations:
  supplies_to: []
  subsidiary_of: []
claims:
  - { statement: "…", type: revenue, status: fact, eventDate: "2026-04-01" }
sources: []
actor: {actor}
research: {research}
---
# {target}

## 概要
## 关键事实
## 关系
## 时间线
## 争议与缺口
## 来源
\`\`\`
`;

const CONCEPT = `---
type: research-template
kind: concept
output: wiki/concepts/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, aliases, sources, actor, research]
  sections: ["## 概要", "## 核心观点", "## 相关实体", "## 演变", "## 争议与缺口", "## 来源"]
---
# 概念研究页：{target}

为概念 / 主题 **{target}** 写一页综述：它是什么、知识库里的资料怎么说、涉及哪些实体、观点如何随时间变化。

## 步骤

1. 用 \`knode_search\`（mode=sag）和 \`knode_graph_search\` 找到讨论该概念的段落与实体簇；用 \`knode_read\` 读最重要的 3–8 篇原文。
2. **核心观点**：归纳 3–7 个要点，每个要点后面给出支持它的来源；不同来源的分歧单列。
3. **相关实体**：以 \`[[实体名]]\` 链接，并在 frontmatter 的 relations 里用 related_to / uses / depends_on / part_of 等谓词记录（本页实体是概念本身）。
4. **演变**：按时间列出该概念在资料中的出现与变化（首次提出、关键节点、最新进展）。
5. **争议与缺口**：矛盾、过期、缺证据的地方。

frontmatter：\`type: concept\`，其余同实体页。
`;

const COMPARISON = `---
type: research-template
kind: comparison
output: wiki/comparisons/{slug}.md
maxTurns: 40
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 概要", "## 对比维度", "## 逐项对比", "## 结论", "## 来源"]
---
# 对比页：{target}

对 **{target}** 中列出的对象（用 " vs " 或 "、" 分隔）做结构化对比。

## 步骤

1. 对每个对象分别 \`knode_resolve\` / \`knode_claims\`，确认它们在知识库里的规范名与可比事实。
2. **对比维度**：选 4–8 个资料真正支持的维度（规模、业务、财务、技术路线、时间线、风险 …）。
3. **逐项对比**：用表格，每格给出数值 / 描述与来源；缺数据的格子明确写"无资料"。
4. **结论**：基于对比得出的判断，并说明不确定性。

frontmatter：\`type: comparison\`；relations 里可用 competes_with / partner_of 记录对象之间的关系；claims 记录对比中用到的关键数字。
`;

const TIMELINE = `---
type: research-template
kind: timeline
output: wiki/timelines/{slug}.md
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 概要", "## 时间线", "## 来源"]
---
# 时间线页：{target}

把知识库里关于 **{target}** 的事件按时间整理成一条可核查的时间线。

## 步骤

1. \`knode_claims\`（subject={target}，order=timeline，include_superseded=true）拿到所有带日期的断言；\`knode_search\` 补充没有进入 claims 的事件。
2. **时间线**：每行 \`- YYYY-MM-DD · 事件 · （来源：…）\`，同一天多个事件分行；日期精度按资料（年 / 月 / 季 / 日）。
3. 被后来事实替代的条目保留并标注 "（后被 … 替代）"。
4. 把每个事件写进 frontmatter 的 claims（eventDate 必填）。

frontmatter：\`type: timeline\`。
`;

const QUESTION = `---
type: research-template
kind: question
output: wiki/questions/{slug}.md
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 问题", "## 结论", "## 论据", "## 缺口", "## 来源"]
---
# 问答归档页：{query}

回答问题 **{query}**，并把答案归档成一页，供以后直接查阅（知识复利：同样的问题不必再查一遍）。

## 步骤

1. \`knode_resolve\`（query 原样）→ 看 slots / facts / unknowns，弄清答案需要哪些信息、本地已有哪些。
2. 逐项取证：\`knode_claims\`、\`knode_search\`、\`knode_read\`；每个论据带来源与日期。
3. **结论**：直接回答，先说结论再说条件与不确定性；用 "截至 <最新资料日期>" 限定时效。
4. **缺口**：回答不了或只能部分回答的部分，以及下一步该找什么资料。
5. frontmatter：\`type: question\`，\`question\` 键写原问题；relations 可空；claims 写结论依赖的关键断言。
`;

const REFRESH = `---
type: research-template
kind: refresh
output: ""
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: []
---
# 刷新页面：{target}

页面 **{target}** 依据的事实已经变化（brief 里列出了变化）。重新核对并更新它，而不是重写。

## 步骤

1. 读 brief 附上的现有页面全文与"变化清单"（新增 / 过期 / 被替代的事实、新的矛盾）。
2. 用 \`knode_claims\`（include_superseded=true）和 \`knode_search\` 核对每一节；改正过时的数字与说法，补充新事实，更新时间线。
3. 人写的段落原样保留；只改机器可核查的内容；在 "## 争议与缺口" 记录本次仍未解决的问题。
4. 更新 frontmatter 的 claims / relations / sources；\`research\` 键用 brief 给的新值。
`;

const VERIFY = `---
type: research-template
kind: verify
output: wiki/reviews/{slug}.md
maxTurns: 30
requires:
  frontmatter: [type, title, sources, actor, research]
  sections: ["## 核实对象", "## 别名与代码", "## 结构关系", "## 核实结论", "## 来源"]
---
# 核实：{target}

核实知识库里关于 **{target}** 的身份信息：它是谁、有哪些别名与代码、和哪些实体是同一个 / 不是同一个、母子公司与关键人物是否属实。brief 会说明是否允许联网；允许时按协议的"联网核实"一节做。

## 步骤

1. \`knode_graph_search\` 与 \`/entities/<id>.md\` 看知识库当前对它的认识（别名、关系、断言）；\`knode_suggestions\` 看是否有待审的合并建议涉及它。
2. **别名与代码**：逐条核实规范名、英文名、简称、股票代码 / 统一社会信用代码等，标注来源。
3. **结构关系**：母公司、子公司、控股股东、上下游关键对手方、董事长 / CEO；只写有来源的，写进 frontmatter 的 relations。
4. **核实结论**：明确列出 \`sameAs\`（与知识库里哪些实体是同一个）和 \`notSameAs\`（容易混淆但不是同一个的实体），并写进 frontmatter。
5. claims 里记录核实过的关键事实（含 eventDate / startDate），外部单一来源用 suspected。

frontmatter：\`type: review\`，\`title: 核实：{target}\`，另有 \`sameAs\`、\`notSameAs\`、\`relations\`、\`claims\`、\`sources\`。
`;

const BUILTIN: Record<ResearchKind, string> = { entity: ENTITY, concept: CONCEPT, comparison: COMPARISON, timeline: TIMELINE, question: QUESTION, refresh: REFRESH, verify: VERIFY };

export type PhaseName = 'plan' | 'research' | 'synthesize' | 'review' | 'revise' | 'orchestrate';

/**
 * The team pipeline's phase prompts (research.pipeline = "team"). Each is a
 * plain Markdown file under playbooks/research/phases/ with `{placeholders}`;
 * the first line names the phase so a harness (or a test double) can tell
 * them apart. Edit them like any playbook.
 */
export const PHASES: Record<PhaseName, string> = {
  plan: `<!-- knode-phase: plan -->
# 阶段 1：规划

你是研究团队的负责人。先读后面附上的任务简报，用 knode_resolve / knode_graph_search / knode_search 快速摸底（不超过 {maxTurns} 轮），然后给出研究提纲：把页面拆成 3–6 个可以并行调查的子任务，每个子任务对应一个章节，写清要回答的问题、建议的检索词和涉及的实体。

只输出一个 JSON 对象，不要其他文字：
{"sections":[{"title":"## 章节标题","questions":["…"],"queries":["…"],"entities":["…"]}],"notes":"整体判断，一两句"}

章节标题必须覆盖简报里列出的必需章节（可以增加，不能遗漏）；"来源"章节由主笔汇总，不必单列。
`,
  research: `<!-- knode-phase: research -->
# 阶段 2：调查「{section}」

你是研究团队的一名研究员，只负责这一个章节。用 knode_search（mode=sag）、knode_graph_search、knode_claims（order=timeline，include_superseded=true）、knode_read、knode_grep 取证；所有读取都带 workset \`{workset}\`。**不要写任何页面**（不要调用 knode_write / knode_commit）。

要回答的问题：
{questions}

建议检索词：{queries}

输出 Markdown（不要 frontmatter），固定结构：

## 发现
- 每条一行：结论 · 日期 ·（来源：路径）

## 候选 claims
- {"statement":"…","type":"…","status":"fact|suspected","eventDate":"…","startDate":"…","endDate":"…","source":"路径"}

## 候选 relations
- {"target":"实体名","type":"本体谓词","from":"…","to":"…","source":"路径"}

## 缺口
- 没找到什么、哪里互相矛盾
`,
  synthesize: `<!-- knode-phase: synthesize -->
# 阶段 3：综合成页

你是主笔。后面附上任务简报与各研究员的发现。按简报的输出契约与模版把发现综合成最终页面，用 knode_write 写到 \`{output}\`（只写这一处）。规则：
- 发现里没有依据的事实不写；每条事实保留来源路径；矛盾与缺口写进相应章节。
- 候选 claims / relations 经你核对后写进 frontmatter（谓词用本体 id，日期 ISO）；frontmatter 必须包含简报列出的必需键。
- 简报里标注为人写的段落原样保留。
写完后 knode_feedback（receipt 见简报）并 knode_commit（workset \`{workset}\`，content 写一段研究日志）。
`,
  review: `<!-- knode-phase: review -->
# 阶段 4：评审

你是评审。对照简报的输出契约与写作规范检查页面 \`{output}\`（用 knode_read 读取；抽查 2–3 条事实的来源是否属实）。只输出一个 JSON 对象：
{"pass":true|false,"issues":[{"where":"章节或 frontmatter 键","problem":"…","fix":"…"}],"summary":"一句话"}

不通过的情形：事实无来源或与来源不符、日期或数字错误、必需章节缺失或空洞、frontmatter 缺键或谓词不在本体内、人写段落被删。小问题（措辞、排版）只写进 issues，不影响 pass。
`,
  revise: `<!-- knode-phase: revise -->
# 阶段 5：修订

评审与校验发现了下面的问题。用 knode_read 读取当前页 \`{output}\`，逐条修正后用 knode_write 重新写入**同一路径**，其余内容和人写段落保持不变。

问题清单：
{issues}
`,
  orchestrate: `<!-- knode-phase: orchestrate -->
# 主管（原生子代理模式）

你是研究团队的负责人，也是主笔。CLI 已经为你注册了下面这些子代理，按需派发任务（互不依赖的任务并行派发），最后由你自己核对发现并用 knode_write 把页面写到 \`{output}\`（只写这一处）：

{agents}

流程：先 knode_resolve 摸底（workset \`{workset}\`）→ 把页面拆成 3–6 个章节 → 每个章节派给一个研究员子代理，任务里写清要回答的问题、建议检索词、涉及实体和 workset → 汇总发现写页（每条事实带来源；候选 claims / relations 核对后进 frontmatter）→ 派评审子代理检查页面 → 按评审意见修订 → knode_feedback → knode_commit（workset \`{workset}\`，content 写一段研究日志）。

子代理没有 knode_write；只有你写页。子代理返回的内容没有来源就不要采用。
`,
};

/** Seed the phase prompts once (never overwrites user edits). */
export function ensureDefaultPhases(dataDir: string): string[] {
  const created: string[] = [];
  const dir = path.join(dataDir, RESEARCH_DIR, 'phases');
  for (const [name, text] of Object.entries(PHASES)) {
    const file = path.join(dir, `${name}.md`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    created.push(`${RESEARCH_DIR}/phases/${name}.md`);
  }
  return created;
}

/** A phase prompt with its placeholders filled. */
export function loadPhasePrompt(dataDir: string, name: PhaseName, vars: Record<string, string>): string {
  ensureDefaultPhases(dataDir);
  const file = path.join(dataDir, RESEARCH_DIR, 'phases', `${name}.md`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : PHASES[name];
  return text.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

/** Seed the protocol and one template per kind (never overwrites user edits). */
export function ensureDefaultResearchTemplates(dataDir: string): string[] {
  const created: string[] = [];
  const dir = path.join(dataDir, RESEARCH_DIR);
  const protocol = path.join(dir, PROTOCOL_FILE);
  if (!fs.existsSync(protocol)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(protocol, PROTOCOL);
    created.push(`${RESEARCH_DIR}/${PROTOCOL_FILE}`);
  }
  for (const [kind, text] of Object.entries(BUILTIN)) {
    const file = path.join(dir, `${kind}.md`);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text);
    created.push(`${RESEARCH_DIR}/${kind}.md`);
  }
  created.push(...ensureDefaultPhases(dataDir));
  return created;
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
  if (!Array.isArray(v)) return [];
  return v.map(String).map((s) => s.trim()).filter(Boolean);
}

export function parseResearchTemplate(text: string, name: string, filePath: string): ResearchTemplate | null {
  const { frontmatter: fm, body } = parseFrontmatter(text);
  if (fm.type !== 'research-template') return null;
  const kind = typeof fm.kind === 'string' && (RESEARCH_KINDS as string[]).includes(fm.kind) ? (fm.kind as ResearchKind) : null;
  if (!kind) return null;
  const requires = (fm.requires ?? {}) as Record<string, unknown>;
  const maxTurns = Number(fm.maxTurns);
  return {
    name,
    kind,
    output: typeof fm.output === 'string' ? fm.output.trim() : '',
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : null,
    requires: { frontmatter: strings(requires.frontmatter), sections: strings(requires.sections) },
    body: body.trim(),
    path: filePath,
  };
}

/** Every template under playbooks/research (built-ins seeded if missing), keyed by file stem. */
export function loadResearchTemplates(dataDir: string): Map<string, ResearchTemplate> {
  ensureDefaultResearchTemplates(dataDir);
  const dir = path.join(dataDir, RESEARCH_DIR);
  const out = new Map<string, ResearchTemplate>();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.md') || entry === PROTOCOL_FILE) continue; // phases/ is a directory and is skipped
    const rel = `${RESEARCH_DIR}/${entry}`;
    try {
      const t = parseResearchTemplate(fs.readFileSync(path.join(dir, entry), 'utf8'), entry.replace(/\.md$/, ''), rel);
      if (t) out.set(t.name, t);
    } catch {
      // a broken template is skipped, not fatal
    }
  }
  return out;
}

export function loadResearchProtocol(dataDir: string): string {
  ensureDefaultResearchTemplates(dataDir);
  return fs.readFileSync(path.join(dataDir, RESEARCH_DIR, PROTOCOL_FILE), 'utf8');
}

/** Resolve the template a job uses: an explicit name, else the kind's default. */
export function templateFor(dataDir: string, kind: ResearchKind, name?: string | null): ResearchTemplate {
  const all = loadResearchTemplates(dataDir);
  if (name && all.has(name)) return all.get(name)!;
  const byKind = [...all.values()].find((t) => t.name === kind) ?? [...all.values()].find((t) => t.kind === kind);
  if (!byKind) throw new Error(`no research template for kind "${kind}" under ${RESEARCH_DIR}/`);
  return byKind;
}

/** A path-safe slug for a target or question (keeps CJK, trims long questions). */
export function researchSlug(text: string): string {
  const cleaned = text.trim().replace(/[?？!！。，,、；;:："'“”‘’()（）]+/g, ' ').replace(/\s+/g, ' ').trim();
  const slug = slugify(cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned);
  return slug;
}

export function renderOutputPath(template: ResearchTemplate, job: { kind: ResearchKind; target: string | null; query: string | null }): string {
  if (template.kind === 'refresh' || !template.output) {
    if (!job.target) throw new Error('a refresh job needs the page path as its target');
    return job.target.replace(/\\/g, '/').replace(/^\/+/, '');
  }
  const subject = job.kind === 'question' ? job.query ?? job.target ?? '' : job.target ?? job.query ?? '';
  const date = new Date().toISOString().slice(0, 10);
  return template.output
    .replace(/\{slug\}/g, researchSlug(subject) || 'untitled')
    .replace(/\{kind\}/g, job.kind)
    .replace(/\{date\}/g, date);
}
