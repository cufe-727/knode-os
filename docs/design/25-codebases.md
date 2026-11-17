# 25 — Code repositories as a source (`raw/codebase`)

> **Record status (2026-11-17): Built; current.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §5.1, §10. The branch named in the status line is merged.

Status: implemented (branch `claude/agent-knowledge-base-c273d7`, 2026-11-09).

## Problem

A knowledge base about agents has to learn from their code. The harnesses that matter (Codex, OpenCode, Pi, Deep Agents, DeepSeek Harness…) are documented mostly in their source. Until now knode-os could not hold a repository:

- folder import carries only text, PDF, EPUB and images, and leaves code behind;
- every document under `raw/docs` gets tier-1 extraction and a summary page. A repository has thousands of files, so that pipeline would cost thousands of model calls per repository and make a wiki page per file.

## What the field does (survey, 2026-11)

| Approach | Who | Lesson for us |
| --- | --- | --- |
| No index: grep/glob/read on the live tree | Claude Code, Codex CLI, OpenCode, Cline, Amp | Agents read code well by searching it. A KB must expose grep and read over the files themselves. |
| Syntax-aware chunks + embeddings + lexical search | Cursor (Merkle sync, own embedding model, regex index), Copilot, LlamaIndex/LangChain/Haystack splitters | Cut on definition boundaries (cAST: +4.3 Recall@5). Keep exact search beside vectors. Key updates by content hash. |
| Repo map: definitions ranked by references | Aider (tree-sitter + PageRank), Repomix `--compress`, LocAgent | Gives the most value per token, needs no model, and is deterministic. |
| Repo → wiki | DeepWiki (≤30 pages), Google Code Wiki, GitNexus | Use hierarchical pages, cap their number, and treat the README and docs as prose. |
| NL descriptions instead of raw code | Greptile, Anthropic Contextual Retrieval | Context added to each chunk (path, enclosing definition) helps retrieval a lot. |

Read-only repository Q&A favors an index (SWE-QA, 2026: vector index 65% vs 46% for agentic search alone), and no single retrieval family wins everywhere (Agent Retrieval Bench, 2026). So knode-os does both: an index and agentic file access.

Every tool skips the same things: dependencies, build output, lockfiles, minified and generated files, binaries. Every tool also caps file size.

## Design

```
raw/codebase/<name>/              the repository's readable files at one commit (owned by the entry)
raw/docs/codebase/<name>.md       the repository card — an ordinary document
raw/docs/codebase/<name>/…        its documentation (README, AGENTS.md, docs/**) — ordinary documents
.knode/codebases/<name>/          shallow working clone (git), outside every indexed tree
ingest.codebases[]                the entry: url, ref, include/exclude globs, follow, docs, commit
```

**D1 — One commit, shallow.** `git fetch --depth 1 origin <ref>` into a working clone, then `checkout --force --detach FETCH_HEAD`. A branch, a tag, a commit or the default branch all work the same way. git rewrites only the files that changed, so the mirror into `raw/codebase/<name>` (the same mirror as folder import, `mirrorPlan`) copies only those. Sync then re-indexes only what changed, because content hashes decide (`unchanged` costs nothing).

**D2 — What travels** (`src/ingest/codebase/files.ts`):
- Kept: source code in ~60 languages, configuration (JSON/YAML/TOML…), prose (md/mdx/rst…), and known names (Dockerfile, Makefile, LICENSE).
- Left behind:
  - dot-entries;
  - dependency and build folders (`node_modules`, `vendor`, `third_party`, `dist`, `build`, `target`, venvs…);
  - lockfiles;
  - minified, bundled and generated files (`*.min.js`, `*.map`, `*.pb.go`, `*_pb2.py`…);
  - binaries (NUL byte);
  - files whose average line exceeds 400 characters;
  - files over 512 KB.
- Optional `--include` / `--exclude` globs, gitignore-flavoured.
- A repository carrying more than 25,000 files or 300 MB is refused with a hint to narrow it.

**D3 — The `codebase` root.** Repository files are documents with `root = 'codebase'`:
- cut along their language's top-level definitions (recursive splitter, per-language separators, 400–1600 chars);
- each chunk headed `File: <repo>/<path> (<Language>) — in <enclosing definition>`;
- embedded and keyword-indexed;
- titled `<repo>/<path>`;
- never parsed for frontmatter or `[[links]]`;
- never extracted, summarized or translated.

That is cheap (no model call per file) and it is what the evidence supports: syntax-aware chunks with context for search, agents reading the files for depth.

**D4 — Code answers when asked.** Plain search leaves the `codebase` root out, so thousands of code chunks never outnumber prose. It is included with kind `code` (`kinds: ["code"]`) or a source prefix under `raw/codebase`. `knode_grep` searches `raw/codebase` last (`path="raw/codebase/<repo>"` to target one). Research agents get `raw/codebase` as a read-only directory wherever `raw/docs` is one.

**D5 — The card** (`card.ts`) is what the document pipeline learns from. It is rendered deterministically (same commit, same bytes):
- frontmatter: `type: repository`, `date` = commit date, `source`, `commit`, `languages`;
- languages table;
- packages and dependencies from `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`;
- folder layout with file counts;
- documentation index with titles;
- a **code map**: definitions (line patterns per language) of the files the rest of the code imports most. This approximates Aider's PageRank, with tests and examples weighed down and entry points up, and is capped at about 18k chars;
- the README, cleaned of badges and HTML, with its headings demoted.

Extraction names the project, its components and what it uses, and the summary becomes the repository's wiki page.

**D6 — Documentation as documents.** Prose is copied (unless `--no-docs`) into `raw/docs/codebase/<name>/`: top-level Markdown/RST (not license, changelog or templates) and anything under `docs/`, `design/`, `adr/`, `rfcs/`, `guides/`… (at most 300 files). There it gets extraction and summaries like any document. Plain search sees this copy; a `code` search sees the original.

**D7 — Ownership.** The mirror, the card and the docs copy belong to the entry (`mirrorLinks`), so writes into them are refused. `codebase remove` deletes them, disposes their documents and drops the clone; `--keep-files` keeps them as plain content.

**D8 — Following.** `--follow` entries are fetched again daily at `ingest.codebaseCheckAt` (default `05:00`; `off` disables) by `serve` (`Codebases`, one operation at a time per workspace). A failed check retries after an hour. The card's extraction waits in the ordinary queue, under the quota floor. Tasks → Schedule shows it as `codebases` in both clients — the time, the next run (at once while a check is owed), the newest `checkedAt` of a followed entry, and running while any repository operation holds the slot — with Check now, which posts `/api/codebases/update` with `followed: true, wait: false`.

**D9 — Safety.** HTTP routes take only https/ssh URLs. Adding is an administrator's call (`/api/codebases/add` → settings group); the CLI may also name a local working copy. Refs are validated (no leading `-`, no `..`). `protocol.ext.allow=never` is set, git never prompts for credentials, and every git command has a timeout.

**D10 — In the clients.** Library → Import data → Code repositories, in the web UI and the Mac app, is one dialog (sheet):
- the entries, each with its ref, commit and date, file count and size, whether it is followed, when it was last checked, and its globs;
- per entry, *Update now* (a background fetch), *Edit* (ref, globs, follow, docs — a change to what is fetched is applied by an update started right after the save), and *Remove…*, confirmed in the row, with a keep-files option;
- the add form (owner/repo or URL, name, ref, include/exclude globs, follow, docs), for administrators only;
- the `codebase` activity: the fetch running now with its progress line, else how the last one ended — a background add that failed says so here.

A fetch, update or removal is a `codebase` activity (src/activity.ts) when `serve` runs it — an HTTP route or the daily check — so Tasks → Background shows it too. In Files, the tree marks a repository's mirror, card and docs copy (`links[].kind = 'codebase'` with its `name`), and their menu offers the repository's actions instead of a linked folder's sync and unlink.

## Interfaces

```
knode-os codebase add <owner/repo | url | path> [--name n] [--ref r] [--include g…] [--exclude g…] [--follow] [--no-docs] [--no-llm]
knode-os codebase update [name] [--followed] [--reindex]
knode-os codebase list | edit <name> [--ref r] [--include g…] [--exclude g…] [--[no-]follow] [--[no-]docs] | remove <name> [--keep-files]

GET    /api/codebases                      entries, sizes, whether a fetch is running, the codebase activity (running, last 5)
POST   /api/codebases/add                  {repository, name?, ref?, include?, exclude?, follow?, docs?, wait?}  (202 unless wait)
POST   /api/codebases/update               {name?, reindex?, wait?, followed?}  (202 when wait is false: {started, repositories, queued})
PATCH  /api/codebases                      {name, ref?, include?, exclude?, follow?, docs?}
DELETE /api/codebases?name=…[&keepFiles=1]
```

MCP: `knode_search` takes kind `code`; `knode_grep` covers `raw/codebase`; `knode_read` reads its files.

## Not done (yet)

- A symbol index in the database (definitions and references as rows, a "find references" tool). The card's code map and grep cover this for now. tree-sitter would bring native or WASM dependencies.
- Per-file or per-module LLM summaries (DeepWiki-style module pages). Research studies over `raw/codebase` play that role on demand.
- Pinning citations to `path#Lstart-Lend@sha` automatically. Templates ask agents to cite path and lines, and the card records the commit.
- Secret scanning of carried files.
