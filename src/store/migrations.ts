/**
 * Schema migrations. `meta.schema_version` records the applied version; each
 * migration runs in its own transaction (Postgres DDL is transactional and
 * PGlite honours it), so a crash mid-migration leaves the previous version
 * intact and the next open retries.
 *
 *   v1  baseline   — the pre-lineage schema (documents/chunks/entities/…)
 *   v2  lineage    — scopes / effects / evidence / deps / pages + bitemporal
 *                    columns. Rebuilds the graph layer from sources on the
 *                    first sync (old rows carry no per-source evidence).
 *   v3  temporal   — drops the legacy TEXT date columns superseded by the
 *                    `valid_from` / `valid_to` timestamps, indexes the world
 *                    time window, and publishes the read-only `v_*` catalog
 *                    views agents query through knode_query(source='catalog').
 */

export interface Queryable {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Multi-statement execution (DDL scripts). Optional on plain query handles. */
  exec?(sql: string): Promise<void>;
}

export interface MigrationContext {
  /** Schema version the database had before this migration run started. */
  from: number;
}

export interface Migration {
  version: number;
  name: string;
  up(q: Queryable, ctx: MigrationContext): Promise<void>;
}

const V1_BASELINE = `
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  root       TEXT NOT NULL,
  title      TEXT,
  sha256     TEXT NOT NULL,
  mime       TEXT,
  bytes      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending',
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunks (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 0,
  metadata    JSONB NOT NULL DEFAULT '{}',
  tsv         tsvector,
  UNIQUE (document_id, seq)
);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS chunks_doc_idx ON chunks (document_id);

CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'concept',
  description   TEXT NOT NULL DEFAULT '',
  aliases       JSONB NOT NULL DEFAULT '[]',
  wiki_path     TEXT,
  mention_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relations (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'related_to',
  description TEXT NOT NULL DEFAULT '',
  weight      REAL NOT NULL DEFAULT 1.0,
  document_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS relations_source_idx ON relations (source_id);
CREATE INDEX IF NOT EXISTS relations_target_idx ON relations (target_id);

CREATE TABLE IF NOT EXISTS claims (
  id           TEXT PRIMARY KEY,
  subject_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  object_id    TEXT REFERENCES entities(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'fact',
  statement    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'fact',
  start_date   TEXT,
  end_date     TEXT,
  document_id  TEXT,
  chunk_id     TEXT REFERENCES chunks(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS claims_subject_idx ON claims (subject_id);
CREATE INDEX IF NOT EXISTS claims_document_idx ON claims (document_id);

CREATE TABLE IF NOT EXISTS entity_mentions (
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  chunk_id    TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  PRIMARY KEY (entity_id, chunk_id)
);
CREATE INDEX IF NOT EXISTS mentions_chunk_idx ON entity_mentions (chunk_id);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  session_id  TEXT,
  path        TEXT NOT NULL UNIQUE,
  project     TEXT,
  started_at  TIMESTAMPTZ,
  bytes       INTEGER NOT NULL DEFAULT 0,
  sha256      TEXT NOT NULL DEFAULT '',
  analyzed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  evidence    JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'pending',
  report_path TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chunk_stats (
  chunk_id    TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  hit_count   INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS doc_stats (
  document_id  TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  hit_count    INTEGER NOT NULL DEFAULT 0,
  last_hit_at  TIMESTAMPTZ,
  heat         REAL NOT NULL DEFAULT 0,
  heat_updated TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS extraction_queue (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tier        INTEGER NOT NULL DEFAULT 1,
  priority    REAL NOT NULL DEFAULT 0,
  enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS extraction_queue_priority_idx ON extraction_queue (priority DESC);

CREATE TABLE IF NOT EXISTS datasets (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  columns      JSONB NOT NULL DEFAULT '[]',
  row_count    BIGINT,
  schema_sha   TEXT NOT NULL DEFAULT '',
  description  TEXT NOT NULL DEFAULT '',
  entity_count INTEGER NOT NULL DEFAULT 0,
  refreshed_at TIMESTAMPTZ,
  UNIQUE (source_id, table_name)
);

CREATE TABLE IF NOT EXISTS pack_events (
  id             TEXT PRIMARY KEY,
  utterance      TEXT NOT NULL,
  entities       JSONB NOT NULL DEFAULT '[]',
  playbooks      JSONB NOT NULL DEFAULT '[]',
  datasets       JSONB NOT NULL DEFAULT '[]',
  probes         JSONB NOT NULL DEFAULT '[]',
  gaps           JSONB NOT NULL DEFAULT '[]',
  doc_count      INTEGER NOT NULL DEFAULT 0,
  claim_count    INTEGER NOT NULL DEFAULT 0,
  stale_count    INTEGER NOT NULL DEFAULT 0,
  conflict_count INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pack_events_created_idx ON pack_events (created_at DESC);
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS payload JSONB;
`;

const V2_LINEAGE = `
-- one row per apply of a source (document, datasource, page, dream …); the
-- unit of temporal composability: dispose reverts everything it produced
CREATE TABLE IF NOT EXISTS scopes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  sha         TEXT NOT NULL,
  parent_id   TEXT REFERENCES scopes(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'applying',
  actor       TEXT NOT NULL DEFAULT 'system',
  applied_at  TIMESTAMPTZ NOT NULL,
  disposed_at TIMESTAMPTZ,
  meta        JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS scopes_live_key_idx ON scopes (kind, key) WHERE status <> 'disposed';
CREATE INDEX IF NOT EXISTS scopes_key_idx ON scopes (kind, key);
CREATE INDEX IF NOT EXISTS scopes_parent_idx ON scopes (parent_id);

-- explicit effects with a recorded inverse (files, queue entries, rows …)
CREATE TABLE IF NOT EXISTS effects (
  seq         BIGSERIAL PRIMARY KEY,
  scope_id    TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  inverse     JSONB NOT NULL,
  reverted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS effects_scope_idx ON effects (scope_id, seq);

-- per-source contribution to a shared entity / relation / claim row
CREATE TABLE IF NOT EXISTS evidence (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  scope_id    TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  segment_id  TEXT,
  weight      REAL NOT NULL DEFAULT 1.0,
  extractor   TEXT NOT NULL,
  attrs       JSONB NOT NULL DEFAULT '{}',
  tx_from     TIMESTAMPTZ NOT NULL,
  tx_to       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS evidence_live_target_idx ON evidence (kind, target_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS evidence_target_hist_idx ON evidence (kind, target_id, tx_from);
CREATE INDEX IF NOT EXISTS evidence_scope_idx ON evidence (scope_id);

-- spatial composability: artifact <- input
CREATE TABLE IF NOT EXISTS deps (
  artifact_kind TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  input_kind    TEXT NOT NULL,
  input_id      TEXT NOT NULL,
  required      BOOLEAN NOT NULL DEFAULT false,
  input_sha     TEXT,
  PRIMARY KEY (artifact_kind, artifact_id, input_kind, input_id)
);
CREATE INDEX IF NOT EXISTS deps_input_idx ON deps (input_kind, input_id);

-- materialized wiki views
CREATE TABLE IF NOT EXISTS pages (
  path         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  scope_id     TEXT REFERENCES scopes(id) ON DELETE SET NULL,
  generator    TEXT NOT NULL,
  inputs_sha   TEXT NOT NULL,
  file_sha     TEXT,
  regions      JSONB NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'active',
  dirty_reason JSONB,
  tx_from      TIMESTAMPTZ NOT NULL,
  tx_to        TIMESTAMPTZ
);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS scope_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'source';

ALTER TABLE entities ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE entities ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS fold_sha TEXT NOT NULL DEFAULT '';

ALTER TABLE relations ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE relations ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS fold_sha TEXT NOT NULL DEFAULT '';

ALTER TABLE claims ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE claims ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS evidence_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS fold_sha TEXT NOT NULL DEFAULT '';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS primary_scope_id TEXT;

ALTER TABLE entity_mentions ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE entity_mentions DROP CONSTRAINT IF EXISTS entity_mentions_pkey;
ALTER TABLE entity_mentions ADD PRIMARY KEY (entity_id, chunk_id, scope_id);
CREATE INDEX IF NOT EXISTS mentions_scope_idx ON entity_mentions (scope_id);

ALTER TABLE datasets ADD COLUMN IF NOT EXISTS scope_id TEXT;
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS tx_from TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS tx_to TIMESTAMPTZ;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS scope_id TEXT;

CREATE INDEX IF NOT EXISTS entities_live_mentions_idx ON entities (mention_count DESC) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS relations_live_source_idx ON relations (source_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS relations_live_target_idx ON relations (target_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS claims_live_subject_idx ON claims (subject_id) WHERE tx_to IS NULL;

-- pre-lineage graph rows carry no per-source evidence and inflated weights:
-- rebuild the graph layer from sources on the next sync. Chunks/embeddings
-- are kept (chunk ids are content-derived, so they are reused as-is).
DELETE FROM entities;
DELETE FROM extraction_queue;
UPDATE documents SET status = 'pending' WHERE status = 'indexed';
`;

const V3_TEMPORAL = `
-- claims carried both a TIMESTAMPTZ window (valid_from/valid_to, the one the
-- fold maintains) and its TEXT projection (start_date/end_date) from the
-- pre-lineage schema. Two columns for one fact drift; the projection is
-- computed on read now (toDateString), so the TEXT pair goes.
ALTER TABLE claims DROP COLUMN IF EXISTS start_date;
ALTER TABLE claims DROP COLUMN IF EXISTS end_date;

CREATE INDEX IF NOT EXISTS claims_valid_window_idx ON claims (valid_from, valid_to) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS documents_root_kind_idx ON documents (root, kind);
CREATE INDEX IF NOT EXISTS documents_path_idx ON documents (path text_pattern_ops);
CREATE INDEX IF NOT EXISTS scopes_live_kind_idx ON scopes (kind) WHERE disposed_at IS NULL;

-- Read-only catalog: the shape agents are allowed to see of the projection
-- database itself. Views hide the fold bookkeeping (fold_sha, dirty_reason)
-- and default to currently-believed rows, so a plain SELECT cannot silently
-- read tombstoned knowledge. History stays reachable through v_evidence.
CREATE OR REPLACE VIEW v_documents AS
  SELECT d.id, d.path, d.root, d.kind, d.title, d.sha256, d.mime, d.bytes, d.status,
         d.scope_id, d.created_at, d.updated_at
  FROM documents d;

CREATE OR REPLACE VIEW v_entities AS
  SELECT e.id, e.name, e.type, e.description, e.aliases, e.wiki_path,
         e.mention_count, e.evidence_count, e.tx_from
  FROM entities e WHERE e.tx_to IS NULL;

CREATE OR REPLACE VIEW v_relations AS
  SELECT r.id, r.source_id, r.target_id, r.type, r.description, r.weight,
         r.evidence_count, r.tx_from
  FROM relations r WHERE r.tx_to IS NULL;

CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  WHERE cl.tx_to IS NULL;

CREATE OR REPLACE VIEW v_scopes AS
  SELECT s.id, s.kind, s.key, s.sha, s.parent_id, s.status, s.actor,
         s.applied_at, s.disposed_at
  FROM scopes s;

CREATE OR REPLACE VIEW v_evidence AS
  SELECT ev.id, ev.kind, ev.target_id, ev.scope_id, s.key AS source_path,
         ev.segment_id, ev.weight, ev.extractor, ev.tx_from, ev.tx_to
  FROM evidence ev
  JOIN scopes s ON s.id = ev.scope_id;

CREATE OR REPLACE VIEW v_pages AS
  SELECT p.path, p.kind, p.generator, p.inputs_sha, p.status, p.tx_from
  FROM pages p WHERE p.tx_to IS NULL;

CREATE OR REPLACE VIEW v_datasets AS
  SELECT d.id, d.source_id, d.table_name, d.kind, d.columns, d.row_count,
         d.description, d.entity_count, d.refreshed_at, d.tx_from
  FROM datasets d WHERE d.tx_to IS NULL;

CREATE OR REPLACE VIEW v_mentions AS
  SELECT m.entity_id, m.chunk_id, m.document_id, d.path AS document_path
  FROM entity_mentions m JOIN documents d ON d.id = m.document_id;
`;

const V4_CAPABILITY = `
-- What can be asked of a source. A dataset scope registers its table; a
-- datasource scope registers its endpoints/metrics; built-in tools register
-- themselves. Rows are owned by exactly one scope and closed by scope id on
-- dispose (the "implicit evidence" half of the ledger), so removing a source
-- from the config retires its capabilities without an explicit inverse.
CREATE TABLE IF NOT EXISTS capabilities (
  seq               BIGSERIAL PRIMARY KEY,
  id                TEXT NOT NULL,
  scope_id          TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL,
  source_id         TEXT NOT NULL,
  name              TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  dialect           TEXT NOT NULL DEFAULT 'sql',
  entity_id         TEXT,
  schema            JSONB NOT NULL DEFAULT '{}',
  semantics         TEXT NOT NULL DEFAULT '',
  sample_queries    JSONB NOT NULL DEFAULT '[]',
  freshness_seconds INTEGER,
  cost              REAL NOT NULL DEFAULT 1,
  acl               JSONB NOT NULL DEFAULT '[]',
  placement         TEXT NOT NULL DEFAULT 'federate',
  tx_from           TIMESTAMPTZ NOT NULL,
  tx_to             TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS capabilities_live_id_idx ON capabilities (id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS capabilities_scope_idx ON capabilities (scope_id);
CREATE INDEX IF NOT EXISTS capabilities_source_idx ON capabilities (source_id) WHERE tx_to IS NULL;

-- The semantic layer: metric definitions, join paths, known pitfalls. Written
-- by people or agents under capabilities/*.md, which is itself a Source — so a
-- note is a separate row per contributing scope rather than a field two scopes
-- would fight over.
CREATE TABLE IF NOT EXISTS capability_notes (
  seq               BIGSERIAL PRIMARY KEY,
  capability_id     TEXT NOT NULL,
  scope_id          TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  source_path       TEXT NOT NULL,
  semantics         TEXT NOT NULL DEFAULT '',
  sample_queries    JSONB NOT NULL DEFAULT '[]',
  pitfalls          JSONB NOT NULL DEFAULT '[]',
  joins             JSONB NOT NULL DEFAULT '[]',
  cost              REAL,
  freshness_seconds INTEGER,
  tx_from           TIMESTAMPTZ NOT NULL,
  tx_to             TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS capability_notes_live_idx ON capability_notes (capability_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS capability_notes_scope_idx ON capability_notes (scope_id);

-- How to reach one entity through one capability: the parameter to bind and
-- the value to bind it to. This is what turns "宁德时代" into
-- "symbol = '300750' on market-mysql.daily_quotes".
CREATE TABLE IF NOT EXISTS locators (
  seq           BIGSERIAL PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  param         TEXT NOT NULL,
  value         TEXT NOT NULL,
  scope_id      TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
  tx_from       TIMESTAMPTZ NOT NULL,
  tx_to         TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS locators_live_idx ON locators (entity_id, capability_id, param, value) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS locators_entity_idx ON locators (entity_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS locators_capability_idx ON locators (capability_id) WHERE tx_to IS NULL;
CREATE INDEX IF NOT EXISTS locators_scope_idx ON locators (scope_id);

CREATE OR REPLACE VIEW v_capabilities AS
  SELECT c.id, c.kind, c.source_id, c.name, c.title, c.dialect, c.entity_id, c.schema,
         c.semantics, c.sample_queries, c.freshness_seconds, c.cost, c.placement, c.tx_from
  FROM capabilities c WHERE c.tx_to IS NULL;

CREATE OR REPLACE VIEW v_locators AS
  SELECT l.entity_id, l.capability_id, l.param, l.value, l.tx_from
  FROM locators l WHERE l.tx_to IS NULL;

CREATE OR REPLACE VIEW v_capability_notes AS
  SELECT n.capability_id, n.source_path, n.semantics, n.sample_queries, n.pitfalls,
         n.joins, n.cost, n.freshness_seconds, n.tx_from
  FROM capability_notes n WHERE n.tx_to IS NULL;
`;

const V5_RECEIPTS = `
-- One row per resolve/pack. The receipt is what makes the loop learnable: the
-- plan that was handed out, the calls the agent actually made, and which
-- returned ids it ended up using. Everything the ranker needs later is here,
-- so no separate telemetry path can drift from it.
CREATE TABLE IF NOT EXISTS receipts (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL DEFAULT 'resolve',
  query        TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'agent',
  intent       TEXT,
  recipe_path  TEXT,
  recipe_sha   TEXT,
  program_sha  TEXT,
  entities     JSONB NOT NULL DEFAULT '[]',
  playbooks    JSONB NOT NULL DEFAULT '[]',
  datasets     JSONB NOT NULL DEFAULT '[]',
  probes       JSONB NOT NULL DEFAULT '[]',
  gaps         JSONB NOT NULL DEFAULT '[]',
  plan         JSONB,
  calls        JSONB NOT NULL DEFAULT '[]',
  used_ids     JSONB NOT NULL DEFAULT '[]',
  ignored_ids  JSONB NOT NULL DEFAULT '[]',
  budget       JSONB NOT NULL DEFAULT '{}',
  summary      JSONB NOT NULL DEFAULT '{}',
  outcome      TEXT,
  as_of        TIMESTAMPTZ,
  valid_at     TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  feedback_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS receipts_created_idx ON receipts (created_at DESC);
CREATE INDEX IF NOT EXISTS receipts_intent_idx ON receipts (intent, created_at DESC);

-- Carry the existing pack history over, then replace the table with a view of
-- the same shape: the learning loop keeps its query, the data gets one home.
INSERT INTO receipts (id, kind, query, entities, playbooks, datasets, probes, gaps, summary, created_at)
SELECT id, 'pack', utterance, entities, playbooks, datasets, probes, gaps,
       jsonb_build_object('docCount', doc_count, 'claimCount', claim_count,
                          'staleCount', stale_count, 'conflictCount', conflict_count),
       created_at
FROM pack_events
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS pack_events;

CREATE OR REPLACE VIEW pack_events AS
  SELECT r.id, r.query AS utterance, r.entities, r.playbooks, r.datasets, r.probes, r.gaps,
         COALESCE((r.summary ->> 'docCount')::int, 0)      AS doc_count,
         COALESCE((r.summary ->> 'claimCount')::int, 0)    AS claim_count,
         COALESCE((r.summary ->> 'staleCount')::int, 0)    AS stale_count,
         COALESCE((r.summary ->> 'conflictCount')::int, 0) AS conflict_count,
         r.created_at
  FROM receipts r;

CREATE OR REPLACE VIEW v_receipts AS
  SELECT r.id, r.kind, r.query, r.actor, r.intent, r.recipe_path, r.outcome,
         r.entities, r.gaps, r.calls, r.used_ids, r.summary, r.created_at, r.feedback_at
  FROM receipts r;
`;

const V6_AGENT_DB = `
-- Trust and access travel with the scope that produced a fact, because that is
-- the only place that knows where it came from. An agent's own writes land
-- quarantined: readable, attributable, and excluded from trusted answers until
-- somebody promotes them.
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS trust TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE scopes ADD COLUMN IF NOT EXISTS acl JSONB NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS scopes_trust_idx ON scopes (trust) WHERE disposed_at IS NULL;

-- Evidence carries the tier it was written at, so a read can filter without
-- joining scopes on every row.
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS trust TEXT NOT NULL DEFAULT 'trusted';
CREATE INDEX IF NOT EXISTS evidence_trust_idx ON evidence (trust) WHERE tx_to IS NULL;

-- A contradiction is a fact about the knowledge base, not a merge conflict to
-- resolve silently. Quarantined evidence that disagrees with a trusted claim
-- opens one of these instead of overwriting it.
CREATE TABLE IF NOT EXISTS disputes (
  id            TEXT PRIMARY KEY,
  claim_id      TEXT NOT NULL,
  against_id    TEXT,
  scope_id      TEXT REFERENCES scopes(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL DEFAULT '',
  detail        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT
);
CREATE INDEX IF NOT EXISTS disputes_claim_idx ON disputes (claim_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS disputes_scope_idx ON disputes (scope_id);

-- A pinned view for a long task. Everything read through a workset answers at
-- the same system time, so a plan that runs for an hour does not see the world
-- change under it half way through.
CREATE TABLE IF NOT EXISTS worksets (
  id          TEXT PRIMARY KEY,
  actor       TEXT NOT NULL DEFAULT 'agent',
  as_of       TIMESTAMPTZ NOT NULL,
  valid_at    TIMESTAMPTZ,
  note        TEXT NOT NULL DEFAULT '',
  entities    JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  commit_path TEXT
);
CREATE INDEX IF NOT EXISTS worksets_open_idx ON worksets (actor) WHERE closed_at IS NULL;

-- "Tell me when this changes." Polled rather than pushed: the cursor is a
-- system time, so a subscriber that was offline still sees everything since.
CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target       TEXT NOT NULL,
  actor        TEXT NOT NULL DEFAULT 'agent',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_target_idx ON subscriptions (actor, kind, target);

-- v_scopes predates the trust columns; append them (CREATE OR REPLACE can add
-- columns at the end, which is why they go last rather than beside status)
CREATE OR REPLACE VIEW v_scopes AS
  SELECT s.id, s.kind, s.key, s.sha, s.parent_id, s.status, s.actor,
         s.applied_at, s.disposed_at, s.trust, s.acl
  FROM scopes s;

CREATE OR REPLACE VIEW v_disputes AS
  SELECT d.id, d.claim_id, d.against_id, d.reason, d.status, d.created_at, d.resolved_at
  FROM disputes d;

CREATE OR REPLACE VIEW v_worksets AS
  SELECT w.id, w.actor, w.as_of, w.valid_at, w.note, w.created_at, w.closed_at, w.commit_path
  FROM worksets w;

-- Per-(intent, slot, capability) outcomes, the ranker's input. A view rather
-- than a table so it can never drift from the receipts it summarizes.
CREATE OR REPLACE VIEW v_capability_stats AS
  SELECT r.intent,
         call ->> 'slot'       AS slot,
         call ->> 'capability' AS capability,
         count(*)::int                                                             AS attempts,
         count(*) FILTER (WHERE COALESCE((call ->> 'ok')::boolean, true))::int      AS ok,
         count(*) FILTER (WHERE r.used_ids ? (call ->> 'nodeId'))::int              AS used,
         COALESCE(avg(NULLIF((call ->> 'elapsedMs')::float, 0)), 0)::float          AS avg_latency_ms,
         max(r.created_at)                                                          AS last_seen
  FROM receipts r
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.calls, '[]'::jsonb)) AS call
  WHERE r.feedback_at IS NOT NULL
    AND call ->> 'slot' IS NOT NULL
    AND call ->> 'capability' IS NOT NULL
  GROUP BY r.intent, call ->> 'slot', call ->> 'capability';
`;

const V7_WIKI_RESEARCH = `
-- Relations gain a world-time window like claims already have: "A supplies B"
-- is true of a period, not forever. Folded from evidence attrs (MIN valid_from,
-- MAX valid_to unless any supporter leaves it open).
ALTER TABLE relations ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE relations ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS relations_valid_window_idx ON relations (valid_from, valid_to) WHERE tx_to IS NULL;

-- Claims separate the time an event happened (event_at) from the window the
-- statement holds for (valid_from / valid_to) and the date of the document
-- that reported it (observed_at). superseded_by is system-maintained by the
-- claim audit: an older fact replaced by a newer one is kept, not deleted.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS event_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS observed_at TIMESTAMPTZ;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS superseded_by TEXT;

-- The reference date of a source (frontmatter date, or a date in its path).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_date TIMESTAMPTZ;

-- Entity resolution: name_key / entity_alias_keys are the normalized lookup
-- keys the writer resolves new mentions against; canonical_id points a merged
-- entity at the one it was folded into (reversible through entity_links).
ALTER TABLE entities ADD COLUMN IF NOT EXISTS canonical_id TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS name_key TEXT;
CREATE INDEX IF NOT EXISTS entities_name_key_idx ON entities (name_key) WHERE tx_to IS NULL;
CREATE TABLE IF NOT EXISTS entity_alias_keys (
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  alias_key TEXT NOT NULL,
  PRIMARY KEY (entity_id, alias_key)
);
CREATE INDEX IF NOT EXISTS entity_alias_keys_key_idx ON entity_alias_keys (alias_key);
CREATE TABLE IF NOT EXISTS entity_links (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'same_as',
  scope_id     TEXT,
  actor        TEXT,
  reason       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_to        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS entity_links_entity_idx ON entity_links (entity_id) WHERE tx_to IS NULL;

-- Deep-research jobs: one row per page an external agent is asked to write.
CREATE TABLE IF NOT EXISTS research_jobs (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  target       TEXT,
  query        TEXT,
  template     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  agent        TEXT,
  model        TEXT,
  workset_id   TEXT,
  output_path  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  turns        INTEGER,
  cost_usd     REAL,
  payload      JSONB NOT NULL DEFAULT '{}',
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS research_jobs_status_idx ON research_jobs (status, created_at);

-- Catalog views: CREATE OR REPLACE may only append columns, so the new ones go last.
CREATE OR REPLACE VIEW v_documents AS
  SELECT d.id, d.path, d.root, d.kind, d.title, d.sha256, d.mime, d.bytes, d.status,
         d.scope_id, d.created_at, d.updated_at, d.doc_date
  FROM documents d;

CREATE OR REPLACE VIEW v_entities AS
  SELECT e.id, e.name, e.type, e.description, e.aliases, e.wiki_path,
         e.mention_count, e.evidence_count, e.tx_from, e.canonical_id
  FROM entities e WHERE e.tx_to IS NULL;

CREATE OR REPLACE VIEW v_relations AS
  SELECT r.id, r.source_id, r.target_id, r.type, r.description, r.weight,
         r.evidence_count, r.tx_from, r.valid_from, r.valid_to
  FROM relations r WHERE r.tx_to IS NULL;

CREATE OR REPLACE VIEW v_claims AS
  SELECT cl.id, cl.subject_id, cl.object_id, cl.type, cl.statement, cl.status,
         cl.valid_from, cl.valid_to, cl.evidence_count, cl.tx_from,
         s.key AS source_path, cl.event_at, cl.observed_at, cl.superseded_by
  FROM claims cl
  LEFT JOIN scopes s ON s.id = cl.primary_scope_id
  WHERE cl.tx_to IS NULL;

CREATE OR REPLACE VIEW v_entity_links AS
  SELECT l.id, l.entity_id, l.canonical_id, l.kind, l.actor, l.reason, l.created_at
  FROM entity_links l WHERE l.tx_to IS NULL;

CREATE OR REPLACE VIEW v_research_jobs AS
  SELECT j.id, j.kind, j.target, j.query, j.template, j.status, j.agent, j.model,
         j.output_path, j.error, j.attempts, j.turns, j.cost_usd, j.requested_by,
         j.created_at, j.started_at, j.finished_at
  FROM research_jobs j;
`;

const V8_REVIEW = `
-- Lookup keys carry their kind so the resolver can be told to merge only on an
-- identical spelling ('exact') while suffix-stripped keys ('bare') stay
-- available to the duplicate audit. Keys written before this column are
-- retagged the next time their entity folds (\`knode-os sync --verify\` does all).
ALTER TABLE entity_alias_keys ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'exact';
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline', up: async (q) => execScript(q, V1_BASELINE) },
  {
    version: 2,
    name: 'lineage',
    up: async (q, ctx) => {
      // Early pre-lineage builds are treated as v1 but did not yet include
      // datasets, pack_events, or suggestions.payload. Complete that baseline
      // inside this migration's transaction before altering those objects.
      if (ctx.from >= 1) await execScript(q, V1_BASELINE);
      await execScript(q, V2_LINEAGE);
      if (ctx.from >= 1) {
        await q.query(
          `INSERT INTO meta (key, value) VALUES ('lineage_rebuild', $1::jsonb)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [JSON.stringify({ pending: true, at: new Date().toISOString() })],
        );
      }
    },
  },
  { version: 3, name: 'temporal', up: async (q) => execScript(q, V3_TEMPORAL) },
  { version: 4, name: 'capability', up: async (q) => execScript(q, V4_CAPABILITY) },
  { version: 5, name: 'receipts', up: async (q) => execScript(q, V5_RECEIPTS) },
  { version: 6, name: 'agent-db', up: async (q) => execScript(q, V6_AGENT_DB) },
  { version: 7, name: 'wiki-research', up: async (q) => execScript(q, V7_WIKI_RESEARCH) },
  { version: 8, name: 'review', up: async (q) => execScript(q, V8_REVIEW) },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

async function execScript(q: Queryable, script: string): Promise<void> {
  if (q.exec) {
    await q.exec(script);
    return;
  }
  for (const statement of splitStatements(script)) await q.query(statement);
}

/** Split a DDL script on statement boundaries (no string literals contain ';'). */
export function splitStatements(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface MigrationResult {
  from: number;
  to: number;
}

/**
 * Bring the database to the current schema version. A database created before
 * versioning (no `schema_version` key but a `documents` table) is treated as v1.
 */
export async function migrate(
  q: Queryable,
  tx: <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>,
): Promise<MigrationResult> {
  const [row] = await q.query<{ value: { v: number } }>(`SELECT value FROM meta WHERE key = 'schema_version'`);
  let current = row?.value?.v;
  if (current === undefined) {
    const [t] = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'documents'`,
    );
    current = t?.n ? 1 : 0;
  }
  const from = current;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await tx(async (txq) => {
      await m.up(txq, { from });
      await txq.query(
        `INSERT INTO meta (key, value) VALUES ('schema_version', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [JSON.stringify({ v: m.version, name: m.name, at: new Date().toISOString() })],
      );
    });
    current = m.version;
  }
  return { from, to: current };
}
