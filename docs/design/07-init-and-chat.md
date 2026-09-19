# 07 — Initializing a knowledge base, and talking to it: overview + AGENTS.md guide / chat / runner improvements

> Status: **implemented** (2026‑09‑18). This follows [06 — Wiki research agents](06-wiki-research-agent.md):
> the runner could already write one page; here it first reads the **whole base** and writes the manual
> every later agent gets, and people get a natural-language way in.
> Chinese version: [07-init-and-chat.zh-CN.md](07-init-and-chat.zh-CN.md).

## 0. Goals and decisions

A new workspace (or one that just received a pile of documents) is a black box to an agent:
`wiki/overview.md` is still the template `initDataDir` wrote, `purpose.md` / `schema.md` are placeholders,
and the agent has to search from scratch. It is a black box to people too: there is a search box and a
"queue research" button, but nowhere to ask "what is actually in here", and nowhere to hand it something you know.

Three confirmed decisions:

| Decision | Outcome |
| --- | --- |
| D1 What one run produces | Two files: `wiki/overview.md` (the hub page) and `AGENTS.md` at the data root (`CLAUDE.md` is a copy). The topics the planner picks are queued as **ordinary research jobs** (6 by default), each going through the existing validation |
| D2 Knowledge taught in chat | Quarantined first: the agent writes `raw/docs/notes/<date>-<slug>.md` (`actor: agent/<cli>`), syncs it so it is searchable at once, but it cannot overwrite a trusted fact — a contradiction opens a dispute. The chat UI has an "adopt" button |
| D3 Session resume | **No CLI resume**: `syncTraces` mirrors every `.jsonl` under `~/.claude/projects` into `raw/traces/`, so persisted chat sessions would be ingested as traces. Every turn is a fresh process that replays recent history (`--no-session-persistence`) |

The guide lives at the data root rather than in `wiki/`: a root file is not collected as a source by
`enumerateDeclared` (which only adds `purpose.md` / `schema.md`), is not watched, and is not OKF-validated —
while `cd`-ing into the data directory and starting Claude Code picks up `CLAUDE.md` automatically, which is
exactly the codebase `/init` analogy. `knode_write` gained a root-file allowlist for `AGENTS.md` / `CLAUDE.md`
(`src/fs/files.ts`); `knode_forget` and `/api/forget` refuse them (they are not sources).

## 1. Initialization (research kind `init`)

It reuses the `research_jobs` queue, the service loop, profiles, cancel and retry — it only adds pre-flight
steps and a second output file.

```
POST /api/research/init ─▶ research_jobs(kind=init) ─kick─▶ claimed by the loop
 runResearchJob
   ├─ prepareInit (src/research/init.ts)                      payload.steps persisted step by step
   │    sync → drainTier1 (configurable, time-capped) → ensureEntityStubs / HotTopics / SourcesIndex
   │    → surveyKnowledgeBase (an empty base fails fast: "add documents first")
   ├─ prepareRunWorkspace: brief = the survey + the previous guide verbatim + both output contracts
   ├─ team pipeline, with the prompts the template declares (init-plan / init-research / init-synthesize)
   │    plan → {sections, topics}; research covers areas in parallel; synthesize writes both files
   │    review / revise see both files
   ├─ validateResearchPage(overview) + validateCompanions(AGENTS.md)
   └─ finalizeInit: sync only the overview → carry over `## 人工备注` → stamp → copy to CLAUDE.md → queue topics
```

**Template-level phase prompts.** `ResearchTemplate` gained `companions` (a second output file with its own
required sections) and `phases` (which prompts this kind runs, relative to `playbooks/research/`). Resolution
order: the template's `phases[phase]` > the role's own `prompt` > `phases/<phase>.md` > the built-in constant
(`rolePromptText(dataDir, role, override)`). So `init` needs no profile of its own: whichever profile is active,
its roles get the init prompts for an init job.

**Why the overview's section is "资料概况" and not "资料来源"**: `outlineFrom` treats a heading matching
`来源|sources|证据表|evidence` as the synthesizer's own and sends no researcher to it (`src/research/pipeline.ts`).

**`selfEntity: false`.** Every non-reserved page in the wiki bundle otherwise gets a "page self entity"
(`planWireFromMarkdown`). The overview is about the whole base, so its skeleton carries `selfEntity: false`
and `classify` (`src/ingest/apply.ts`) honours it — otherwise the graph grows an entity named after the page.

**Human notes.** The guide's last section, `## 人工备注`, belongs to a person: the existing guide is backed up
to `.runs/<id>/existing-AGENTS.md`, and once validation passes the runner copies that section's body into the
new guide verbatim (`carryOverHumanNotes`); the agent only keeps the heading. Line 1 carries
`<!-- knode-init: {"job","at","agent"} -->`, which `knode_survey` reads back.

**A seed template is nobody's prose.** `humanParagraphsOf` protects paragraphs of 40+ characters on an existing
page, and the `wiki/overview.md` `initDataDir` writes is long enough to qualify — so `isSeedTemplate`
(`src/fs/datadir.ts`) checks whether the file still equals its template and, if so, protects nothing.

**Rollback.** When validation fails the page moves to `.runs/<id>/rejected.md` and the guide to
`rejected-AGENTS.md`, both are restored from their backups, and the job is requeued for one more attempt.

## 2. Three channels that put the guide in front of an agent

1. **The run workspace**: `CLAUDE.md` / `AGENTS.md` of every research and chat session = protocol + template +
   `# 知识库自述` (the guide, purpose.md, schema.md).
2. **MCP `instructions`**: `src/mcp/instructions.ts` returns a three-line preamble plus the guide (capped at
   6 000 characters) to any agent that connects, over both stdio and HTTP, cached by the file's mtime — the
   HTTP endpoint builds a server per request.
3. **`knode_read "AGENTS.md"`**: step 0 of the research protocol says to read the guide, then `knode_survey`,
   when the base is unfamiliar.

## 3. `knode_survey` / `GET /api/survey`

`src/research/survey.ts` — deterministic, no LLM, about ten queries: documents by folder and date range,
entities by type with the top ones, relation predicates (including `unknownPredicates`), claims by status and
event range, wiki pages (generated / written / researched), ontology packs, live datasources, the extraction
backlog and budget, the state of the guide and the overview, and whether `purpose.md` / `schema.md` are still
templates. `renderSurvey` turns it into the brief's `## 知识库概况`; the initialization card uses the numbers.

## 4. The chat entry (`src/chat/`)

| Table | What it holds |
| --- | --- |
| `chat_conversations` | id / title / agent / model / status (`idle`\|`running`) / created_by / payload |
| `chat_messages` | conversation_id + seq unique; role, content, events (jsonb), payload (jsonb, v10), turns, cost_usd, error |

One turn is one agent session — a headless CLI, or the built-in agent in the `serve` process — whose cwd is `.runs/chat/<conversation>/` (the schema files are rewritten
every turn, so protocol and guide edits apply at once). The prompt comes from `playbooks/chat/turn.md`: the
last `chat.historyTurns` messages (assistant messages truncated to 2 000 characters, 40 000 overall), the new
message, and the writing conventions. The reply's `events` are the tool calls parsed out of the transcript
(`parseActivity` reads claude / cursor stream-json `tool_use` + `tool_result`; codex has no event stream), plus
the files the reply marked with `<!-- knode:wrote <path> -->`.

- **Status**: the route answers 202 and the client polls `GET …/status` every 1.5 s, which parses the live transcript.
- **Cancel**: `killAgentsFor('chat:<id>')`; the assistant message records `error: cancelled` and the conversation goes idle.
- **Teaching**: the protocol asks the agent to confirm its understanding, then `knode_write` the note and
  `knode_sync only:[path]`, and to say that it is quarantined.
- **Web**: `chatWebAllowed` only narrows or widens *within* what `review.external` allows, never past it.

### 4.1 Merged with Ask, then down to one cost (2026-09-19)

Ask (`POST /api/ask` — one retrieval pass and one LLM call, stateless) and Chat used to be two top-level
entries, but to a person they are the same intent. They were merged into one **Ask** with a mode switch
beside the composer — quick or agent — and the switch was then removed: **every question is one agent
session**.

Why the switch went: the two modes differed by roughly two orders of magnitude in latency and cost, and a
segmented control beside a text box is the worst possible place to put that choice. It defaulted to quick, so
the cheap answer was the one people got without deciding; it started a fresh conversation on every quick ask
and on every mode change, so the thread list read as two interleaved histories; and "dig deeper with the
agent" existed precisely because the default was usually not what the question needed. One mode that always
works beats two the reader has to arbitrate between.

- **What replaced quick's safety net.** Quick mode was what made Ask usable with no coding agent installed.
  `resolveChatAgent` now ends with `agentForSpec(config, 'default')`: with nothing named, Ask runs on the
  section-01 default connection — a CLI provider as that CLI, an OpenAI-compatible one as the built-in agent.
  The shipped `chat.agent` is `'default'` for the same reason. Research deliberately keeps refusing to guess
  (`resolveResearchAgent`): it is a background spend someone opts into, while Ask is a question just typed.
- **When even that cannot resolve** — an OpenAI-compatible default with no model, which is the fresh-install
  state — `GET /api/chat/readiness` says so *before* the person types, and both clients render a screen that
  opens Settings → Providers & Agents. `POST …/messages` returns the same `reason` (`no-mcp` / `no-agent` /
  `no-builtin`) so a race lands on that screen instead of a toast.
- **`chat_messages.payload` and migration v10 stay.** Nothing writes the column; historical quick answers
  still hold their citations, and deleting the migration would lower `SCHEMA_VERSION` below what every
  existing database reports. Stored `payload.mode = 'quick'` values are inert — both clients read any
  conversation as an agent conversation. Old quick replies keep their prose and lose their citation list,
  which was the price of deleting the footer that rendered it.
- **`ask()` survives; only its UI caller went.** `src/search/ask.ts` is still called by MCP's `knode_ask`
  (`src/mcp/tools.ts`), the `knode-os ask` CLI, `bench answer`, and `POST /api/ask` — all as a *function*,
  which is what an earlier version of this section got wrong. After the deletion `POST /api/ask` has no
  in-repo caller and stays as a documented public endpoint. The agent can still reach the cheap path itself:
  `knode_ask` is in the tool set a chat session is launched with.
- **Config keys are untouched**: still `chat.*` in `knode.config.json`. `chat.keep` is 200 — one conversation
  per question filled the old 50 in about a day, and `runner.ts` now uses that same default instead of its own
  stale 50.

## 5. Runner improvements

1. **Per-job cancel**: the child-process registry in `launch.ts` became `Map<jobId, Set<ChildProcess>>`, with
   `killAgentsFor(jobId)` / `clearCancelled(jobId)` and `JobCancelledError`. A killed child resolves like a
   normal exit (`runProcess` resolves on `close`), so `launchSession` re-checks the flag afterwards and throws —
   otherwise the team pipeline would carry the error into the next phase. Between phases the pipeline also
   re-reads the job row, which covers a cancel from another process. The runner ends such a job as `cancelled`,
   with no retry and no `failed`.
2. **Tier-1 serialization**: `runTier1Pass` queues per data dir (the same promise chain `sync` uses), so an
   initialization draining the queue never takes the same batch as serve's timer.
3. **Job progress**: `GET /api/research/jobs/:id` now also returns `steps`, `phases` (read straight from
   `.runs/<id>/phases.json` while the job runs), `plan` and the available transcript labels; `?log=<label>`
   tails one phase's transcript.
4. **Claim now**: `startResearchLoop` returns `kick()`, and `serve` registers it together with the workspace's
   MCP endpoint in `createApp`'s `services`, so a queued job starts at once instead of at the next 30 s tick.
   The chat routes take the MCP endpoint from the same place.

## 6. Config and migration

```jsonc
"research": {
  "init": { "followUps": 6, "extraction": "drain", "extractionMaxMs": 900000 }
},
"chat": {
  "agent": "", "model": "", "effort": "default", "maxTurns": 30, "timeoutMs": 600000,
  "web": "inherit", "historyTurns": 12, "keep": 50
}
```

Migration **v9** adds `chat_conversations` / `chat_messages`. New seeded files: `playbooks/research/init.md`,
`playbooks/research/phases/init-*.md`, `playbooks/chat/AGENTS.md`, `playbooks/chat/turn.md` — none overwrite an edit.

## 7. Open items

1. Codex's session event stream is not parsed, so chat shows only "answering" for codex, without tool chips.
2. Avoiding CLI resume is what keeps chat sessions out of the trace sync (D3); the cost is that a long
   conversation replays history every turn. Narrowing what `raw/traces` collects would make `--resume` viable.
3. What an initialization produces depends entirely on the configured CLI. The tests cover the mechanics
   (steps, both files' validation, rollback, carried-over notes, queued follow-ups), not the writing.
4. `knode_survey` is computed live (about ten queries); a very large base may want the card's refresh cached.
5. Chat shares `research.readDirs` and `review.external` with research; there is no separate chat read scope.
