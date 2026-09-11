# Stock-analysis demo — the "logical database" MVP

One scenario that exercises every layer: static research reports + breaking
news (markdown), live trading data (MySQL + TimescaleDB + parquet-via-DuckDB),
a knowledge graph linking entities across all of them, agent-native query
tools, context packs, and the playbook learning loop.

## Run it

```bash
# 1. live databases (MySQL on 3307, TimescaleDB on 5433)
docker compose -f demo/stock/docker-compose.yml up -d

# 2. seed everything into a data directory
knode-os --data ./stock-data demo seed-stock
#    no docker? point at local servers instead:
#    knode-os --data ./stock-data demo seed-stock --mysql-port 3306 --tsdb-port 5432

# 3. sync schemas into the graph + index the documents
knode-os --data ./stock-data ingest

# 4. build a context pack
knode-os --data ./stock-data pack "宁德时代最近表现怎么样"
```

What the pack returns for that utterance:

- **matchedEntities** — 宁德时代 (organization, aliases 300750/CATL)
- **evidence.docs** — research-report + news chunks that mention it
- **evidence.claims** — incl. a *conflicting pair* (Q2 profit 120 亿 vs the
  8-12 correction to 110 亿, flagged `CONFLICT`) and, for 贵州茅台 queries, an
  *expired* pricing-window claim flagged `STALE`
- **evidence.datasets** — the 4 live tables the company appears in
- **liveData** — playbook probes executed right now (latest daily bars,
  company profile, minute bars), each with an `asOf` timestamp
- **suggestions** — concrete next steps: ready-to-run SQL for unprobed tables,
  conflict adjudication hints, freshness warnings

## Explore further

```bash
knode-os --data ./stock-data datasource list
knode-os --data ./stock-data datasource query hist-parquet \
  "SELECT symbol, round(avg(close),2) avg_close FROM daily_bars GROUP BY symbol"
knode-os --data ./stock-data graph "宁德时代"     # docs AND tables, one graph
knode-os --data ./stock-data pack-optimize --apply # learning loop
knode-os --data ./stock-data connect claude        # use the MCP tools from Claude Code
```

Seeded layout inside the data directory:

```
raw/docs/reports/   3 research reports (frontmatter-declared entities+claims)
raw/docs/news/      4 news flashes (incl. the conflict pair + a stale claim)
datasets/hdfs/      daily_bars.parquet — 2y history, the "HDFS table"
packs/organization.md   the playbook driving live probes
wiki/datasets/      generated schema pages, wired into the graph
```

Tear down: `docker compose -f demo/stock/docker-compose.yml down -v`.
