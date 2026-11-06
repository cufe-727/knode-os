# Embedding model pools

Settings → Providers & Agents contains the embedding key inventory and the model pool. Add one row per key, refresh its model catalog, and enable automatic routing for a model and vector dimension. The Index stage then uses the pool for both ingestion and query embeddings.

Each key has an enable switch, priority (lower first), RPM, TPM, daily request/token caps, concurrency and an IANA reset timezone. Zero request/token caps block calls. Equal priorities rotate by least recent use. OpenRouter can pin an upstream; a pin disables its upstream fallbacks. The original single-provider configuration remains available by switching off the pool.

Only the exact BGE-M3 aliases `BAAI/bge-m3`, `baai/bge-m3`, and `@cf/baai/bge-m3` share the built-in `bge-m3` identity, at 1024 dimensions. Other models require the same selected model ID and dimension on each participating key. Model discovery lists embedding catalogs on SiliconFlow, Cloudflare and OpenRouter; a listed model is not a guarantee of available credits or capacity. All pooled vectors are checked for count, order, dimension and finite nonzero values, then L2-normalized. Cross-provider numerics may still differ; validate retrieval quality on representative documents before depending on exact rankings.

The pool has its own vector identity. Changing its model or dimensions rebuilds embeddings, while rotating keys, changing priorities, or editing caps leaves the vector space unchanged. A pool never falls back to hashing or to another model.

Usage is stored in `~/.knode-os/embedding-usage.json`, permission 0600. It contains credential hashes and counters, not keys. A process lock and atomic file replacement protect quota reservations across processes and workspaces. The same Cloudflare account is identified from its API URL; other providers can share an explicit account quota group. Use the same group and reset timezone for all keys belonging to one account. Within a group the stricter configured limits apply. The app conservatively counts all model requests in that group together, even where the provider has a separate allowance for each model.

Every upstream attempt reserves its budget before sending, including retries on another key. Token reservation uses an estimate of the model's own tokens (see [Token counts](#token-counts-reported-and-estimated)), then settles to the provider's reported usage when available. Failed attempts retain the estimate. Daily accounting follows the configured timezone, including requests finishing after midnight. Rolling minute counters, active request leases and cooldowns survive restarts. Corrupt usage files fail closed. HTTP 429 respects `Retry-After`; transient errors cool down, and authentication/balance failures receive a longer cooldown. If every candidate is unavailable, the request waits briefly for a rate slot or returns an explicit error.

These are **application caps**, not a live view of the provider's billing balance. Calls outside KnodeOS are not counted. Provider limits and paid/free quotas remain authoritative. Cloudflare Neurons and tokens are different units: any token cap estimated from the BGE-M3 neuron rate is specific to that model and does not cover other AI models on the account.

The configuration API redacts keys as `***`, preserving the stored secret when the UI saves the placeholder. Key values stay in user configuration files outside the repository. `GET /api/config/embedding-usage` returns counters (requests, tokens, and how many of the tokens are estimates) and cooldowns; `POST /api/config/embedding-test` tests a draft pool or one named key without running the LLM stages.

## Deferred embedding and endpoints of your own

`ingest.embedding` says when a document's vectors are made ([design 12](design/12-remote-processing.md) §3.3):

- `"inline"`, the default: the CLI embeds while it applies a document; `serve` applies without them and its
  background embedder fills them in right after (`src/ingest/embed-backfill.ts`).
- `"deferred"`: no sync embeds. A document is keyword-searchable once synced and vector-searchable once its batch
  lands. The chunks without a vector for the workspace's identity are a backlog, newest documents first, which
  `serve`'s embed slots (`ingest.embedSlots`, default 8, `0` for none) and remote workers drain as leased work
  (`src/work/embed.ts`). The duplicate audits' entity and claim vectors go on the same queue, ahead of the backlog.
  Changing the embedding model re-applies nothing: the backlog refills for the new identity and drains.

Vector search reads only vectors of the query's own identity (`WHERE e.model = …`), so while a new model's vectors
are coming in, recall comes from those already there.

**An endpoint of your own.** Every vector the pool makes counts against its daily caps. A bge-m3 on your own
hardware has none. Settings → Providers & Agents → *Embedding on this machine* walks through running one on the
service's machine (Ollama, Text Embeddings Inference, or a small transformers server: the CLS token's vector,
L2-normalized, 1024 dimensions), then takes its URL and model (`ingest.embedEndpoint`). **Check endpoint** embeds the
16 probe texts there and compares each with the pool's vectors for them; every cosine must reach
`server.remote.embedProbeCosine` (0.98), and the model must have the pool's canonical name. Saving checks it again
and turns on deferred mode. The embed slots then embed on it, with one batch in 100 spot-checked; when it is
refused, parked by a missed spot check or unreachable, they embed on the pool. Another machine's model works the
same way through the remote worker (`--backends embed:N --embed-base-url … --embed-model …`, a token with the `embed`
scope: [remote workers](remote-labeling.md#embedding-on-a-workers-own-endpoint)).

The reference vectors come from the pool once per identity (16 texts) and stay in `<workspace>/.knode/embedding-probe.json`.
A different model, however small, makes vectors in another space and cannot join a bge-m3 pool; to use one, make it
the pool model, which re-embeds the workspace.

**Lending keys to workers** (design 12 §4.2) is not built. It would only move calls: a lent key's call counts against
the same daily cap wherever it runs. The `lendToWorkers` key field and the `embed-keys` token scope are reserved for it.

## Token counts: reported and estimated

The token caps count the provider's own number where a response has one and an estimate where it does not. Whether a response has one depends on the provider (checked 2026-10-18 with one request to one key of each):

| Provider | `usage` in the embeddings response? | What the ledger holds |
| --- | --- | --- |
| SiliconFlow `BAAI/bge-m3` | Yes: `prompt_tokens`, `completion_tokens`, `total_tokens` | The provider's count |
| OpenRouter `baai/bge-m3` | Yes: `prompt_tokens`, `total_tokens`, plus cost | The provider's count |
| Cloudflare Workers AI `@cf/baai/bge-m3` (`/ai/v1/embeddings`) | No: the body has `object`, `data` and `model` only | An estimate for every call |

Any other OpenAI-compatible key is counted from `usage.prompt_tokens` (or `usage.total_tokens`) when its response has it and estimated when it does not. A request that fails keeps its estimate. Reported counts include the `<s>` and `</s>` the model adds to every input, and the estimate aims at the same number: the two test sentences in `tests/embedding-router.test.ts` are 29 and 27, and SiliconFlow and OpenRouter reported 56 for them together.

**Where estimates show.** Each day in `embedding-usage.json` keeps `estimated` next to `requests` and `tokens`: the part of `tokens` no provider reported. `GET /api/config/embedding-usage` returns it as `estimatedTokensToday` (a request still in flight counts as an estimate), and Settings → *Usage today* tags each key `reported`, `estimated` or `NN% estimated`. A day recorded before the field existed has no split, so it has no tag and no `estimatedTokensToday`. The ledger stays `version: 1` and older readers ignore the field. Figures reserved before the estimator changed are in bytes, so the day the change ships mixes units; the next daily reset starts clean.

**The estimate** (`src/ingest/embedding-tokens.ts`) is

```
tokens ≈ 1.1 × (0.7·Han + 0.7·digits + 0.3·Latin + 0.15·whitespace + 0.9·other) + 4,   at least bytes / 4
```

per UTF-16 code unit. Han is U+3400–4DBF and U+4E00–9FFF, Latin the ASCII letters, whitespace the ASCII spaces, no-break and ideographic space; "other" is everything else, punctuation included, and costs about a token each. A space usually merges into the next piece, so whitespace costs little. It replaces UTF-8 bytes plus 32 per input, which counted every Han character as 3 tokens and ran 3.5–4.5 times above the real count. It is for BGE-M3 only: `estimateTokens()` in `src/llm/tokens.ts` is tuned for LLM tokenizers and comes out at 0.7–0.8 of BGE-M3.

**Calibration.** Real counts come from the model's own `tokenizer.json` (`BAAI/bge-m3` on Hugging Face, 17,098,108 bytes, SHA-256 `21106b6d7dab2952c1d496fb21d5dc9db75c28ed361a05f5020bbba27810dd08`), run through its sentencepiece normalizer, `Metaspace` split and Unigram segmentation, plus `<s>` and `</s>`. That gives the 56 above. The weights are a least-squares fit of those counts on the five classes over the chunks, claims and entities of a Chinese/English finance workspace (2026-10-18), rounded up, with a 10 % margin. The unrounded fit is 0.66 Han, 0.53 digits, 0.27 Latin, 0.14 whitespace, 0.90 other, +4; digits are weighted above it so number tables stay over.

| Input | Inputs | Avg chars | Avg real tokens | Bytes + 32 (before) | Estimate (after) | Batches of 16 under real |
| --- | --- | --- | --- | --- | --- | --- |
| Chunks | 44,683 | 750 | 434.5 | 3.47× | 1.19× | 0.04 % |
| Claims | 206,532 | 47 | 34.4 | 4.49× | 1.17× | 0 % |
| Entities | 48,645 | 43 | 27.2 | 4.47× | 1.18× | 0.03 % |

Ratios are the sum of estimates over the sum of real tokens. Chunks with more than 40 % digits went from 2.23× to 1.31×, none under real. On 900-character windows of English prose, code, type declarations, JSON/YAML and Chinese/English markdown the sum is 1.1–1.2×.

**Limits.** Random-looking strings (hashes, base64) tokenize at about 0.65 tokens per character, and single letters separated by spaces at one token per letter; both are under-counted by up to 2×. In the windows above that was 4 % of code and 15 % of markdown windows, 3 % and 4 % of batches of 16. Scripts without a class of their own are over-counted: Cyrillic, Arabic, Hindi, Thai, Greek and Hebrew by 2.5–4×, Japanese and Korean by 1.4–1.7×. That is safe but spends a cap early. Re-fit when the model changes or a workspace's content differs a lot: tokenize a sample of real inputs with the model's tokenizer, count the five classes per input, fit by least squares, round up, and check that batches of 16 rarely come out under the real count.

**Caps.** On a key that reports no usage, a token cap now means estimated real tokens rather than bytes, so the same number lets roughly three to four times more real work through. That applies to the per-minute cap as well. Calls outside KnodeOS are still not counted and the provider's own limits still apply. Existing caps are unchanged; revisit them with the new unit in mind.
