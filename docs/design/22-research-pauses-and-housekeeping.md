# 22 — Research that waits out a usage limit, resumes where it stopped, and is put away

> **Record status (2026-11-17): Built.** This is a decision record, not the description of the system. What the code does now is in [ARCHITECTURE.md](../ARCHITECTURE.md) §5.4. Stale here: the quota floor at claim time (per session since 27).

> Status: **implemented** (2026‑11‑04). Source: src/research/failure.ts (classifying a failed session, reading
> the reset time, the backoff), src/research/runner.ts (`failRun`, `pauseAgentQueue`, `markInterrupted`),
> src/research/jobs.ts (`NOT_PAUSED`, `resumeJob`, `archiveJobs`, `deleteJobs`, `requeueStale`),
> src/research/launch.ts (`JobInterruptedError`, `codexFailure`), src/research/study.ts (collect resumes from its
> notes; `studyPause`, `resumeStudy`, `archiveStudy`, `removeStudy`). Server: src/server/app.ts, src/server/tasks.ts.
> CLI: `research study retry|resume|archive|unarchive|remove`, `research study list --archived`, `research resume`.
> Web: Research → Studies, Research → jobs, Tasks → Queue. Mac app: Research → Studies, Tasks.

## 0. What was there

A research job had two attempts. Whatever ended a run without its page spent one: a page the validator refused,
and equally a Claude Code session that answered "You've hit your 5-hour limit · resets 1:30am" in two seconds.
On the night of 2026‑11‑03 two xhigh Opus studies spent the shared 5‑hour limit; every job queued after that
point was claimed, refused within seconds, retried, refused again and failed — 0 of 6 pages for one study, the
other's collect "passing" on four seed captures. In the morning each had to be retried by hand, and a retry at
the report stage wrote the report before the pages it was missing (the queue takes the oldest job first, and a
study is older than its pages).

Three other ways a run was lost:

- A restart (a deploy, `launchctl kickstart`) killed the running agents; the runner saw their exits as failures
  and spent an attempt — or failed the job on its second.
- Codex's error was the first 300 characters of its stderr: the banner and the echoed prompt. Its own reason, the
  last line, never reached the job.
- A study's collect ran all its collectors again on a retry, and the notes of the ones that had succeeded were
  thrown away with the run directory.

Finished and failed studies stayed in the list for good; only a draft could be deleted.

## 1. Decisions

| # | Decision | Why |
| --- | --- | --- |
| D1 Four kinds of failure | `classifyFailure` reads a session's own error. **quota**: the plan's usage is spent — Claude's 5‑hour / weekly limit, Codex's "usage limit", Cursor's "out of usage", `insufficient_quota`, "credit balance is too low". **transient**: a rate limit, 429 / 529 / 5xx, overloaded, the network. **setup**: the CLI is missing, the login expired, the key is wrong. **other**: everything else — the turns ran out, the page was refused | Only "other" says anything about the job. The first three say the agent could not serve it; spending an attempt on them fails a job that never ran |
| D2 Only the agent's words are read | The runner classifies the sessions' errors (a team's phases each, else the one session's), a launch error, and a collector refusal; never a validator's message or a team's review summary | Those quote paths and critics ("no page at wiki/research/rate-limits.md", "the claim about the rate limit has no source"): read as limits, they would pause a job for good reason |
| D3 Pause, don't fail | A run that failed for D1's first three kinds goes back to `queued` with `payload.pause` = `{ kind, reason, since, until, count, agent, resetKnown }`; the attempt its claim charged is handed back, and nothing is added to the brief's rejections. `claimNextJob` passes over a job whose `pause.until` is in the future (`NOT_PAUSED`). The loop's 30 s tick picks it up after | The job resumes on its own, from the stage it was at, as if the limit had never been there — and a usage limit is no reason to change the page |
| D4 Until the reset the agent named | `resetTimeFrom` reads `resets 1:30am (Asia/Shanghai)`, `resets Nov 7, 9am (America/Los_Angeles)`, Claude's older `limit reached\|<epoch>`, Codex's `try again in 2 days 3 hours` and `try again at 3:04 PM` (this machine's zone), `retry after 30 seconds`, `Retry-After: 30`. The pause ends two minutes after the named reset | The provider lifts the limit on its own clock. Without a named time: a backoff — quota 30 min doubling to 6 h, setup 30 min to 6 h, transient 1 min to 15 min |
| D5 A spent quota pauses the whole account | When a job pauses for quota or setup, every other queued job whose agent has the same `agentKey` (the CLI and its path; the base URL of a built-in agent — not the model) gets the same pause, unless it already waits longer | Claimed now, each would only fail the same way in seconds, one after another, as on 2026‑11‑03. A transient refusal is momentary and pauses only its job |
| D6 Not for ever | A job pauses at most 12 times in a row for quota, 8 for setup, 6 for transient; the next refusal is an ordinary failure | A message read as a limit that is none (a CLI quoting the model) must not keep a job waiting indefinitely |
| D7 A restart interrupts, it does not fail | `stop()` marks every job the loop is running interrupted and kills their sessions; a session that ends then throws `JobInterruptedError`, and the runner queues the job again with its attempt handed back. A crash leaves jobs `running`: `requeueStale` queues them on the next start with the attempt handed back, three times (`payload.interruptions`), then charging it | A deploy between two pages should cost nothing. A job that brings serve down every time must still run out of attempts |
| D8 Collect resumes from its notes | A page whose note (`notes/NN-<page>.md`) an earlier run wrote is collected; only the others run again, beside the earlier transcripts, and the seeds are not fetched again. A collector the agent refused is not one that found nothing: when any is refused, collect saves the notes it has, marks its step `paused`, and the study pauses (D3) | A study that ran out of usage after four of six collectors keeps those four |
| D9 Resume now | `POST /api/research/jobs/:id/resume` and `/studies/:id/resume` clear the pause (and its error) of the job, or of the study and its queued pages | The person knows when the limit was lifted — a plan upgraded, another account signed in |
| D10 Archive what is finished | `archiveJobs` sets `payload.archivedAt` on a done, failed or cancelled job; a study is archived with its pages' jobs. Lists leave archived jobs out (`archived=1` lists only them; Tasks' recent jobs too); everything stays — report, pages, sources, jobs — and unarchive brings it back. Retrying a job takes it out of the archive | A list of fifty finished studies hides the three under way. No migration: a payload field, like everything else a study carries |
| D11 Remove what failed | `DELETE /api/research/studies/:id` removes a draft, or a failed or cancelled study: its job, its pages' jobs (any still live cancelled first) and their run directories. What it put into the knowledge base stays — pages it wrote, captures, notes, the register — and the reply names it (`kept`). A plain job that failed or was cancelled is removed the same way; a study's page only with its study | Those files are documents like any other now, quarantined until a person promotes them, and may be cited by other pages; deleting them is Library's job, one file at a time |

## 2. A night like 2026‑11‑03, again

```
23:20  page 3 of study A: claude → "You've hit your 5-hour limit · resets 1:30am (Asia/Shanghai)"
       → page 3 queued, attempts 1 → 0, pause { quota, until 01:32 }
       → page 4, study A's report-to-be, study B (collect, queued) on claude-cli: the same pause
23:20–01:32  the loop claims nothing on claude-cli; a codex-cli job still runs
01:32  page 3 is claimed again, then page 4 … study A's report, study B's collect
```

## 3. API

- `GET /api/research/studies[?archived=1]` — each row adds `pause` (the study's own while it collects or writes
  its report, else the first of its pages to run again when every queued page waits) and `archivedAt`.
- `GET /api/research/studies/:id` — the view adds `pause`, `archivedAt`, and `pause` per page.
- `POST /api/research/studies/:id/{resume,archive,unarchive}`; `DELETE /api/research/studies/:id` →
  `{ removed: [ids], kept: [paths] }`.
- `GET /api/research/jobs[?archived=1]` — each job adds `pause`; `POST /api/research/jobs/:id/{resume,archive,unarchive}`,
  `DELETE /api/research/jobs/:id`.
- `GET /api/tasks` — a job adds `pausedUntil` and `pauseReason`; archived jobs leave its recent list.

## 4. Open items

1. The reset patterns follow the messages seen from Claude Code (2026‑11), Codex (0.5x) and Cursor; a new
   wording falls back to the backoff, which still resumes the job, only later than it could.
2. A pause is per account as far as `agentKey` can tell: two Claude logins behind one `claude` executable
   (`CLAUDE_CONFIG_DIR`) share a key and so a pause.
3. A run that a restart interrupts starts its page again from the beginning; the session itself is not resumed
   (`--no-session-persistence`).
