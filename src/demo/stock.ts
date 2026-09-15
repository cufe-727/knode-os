import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { DuckDBInstance } from '@duckdb/node-api';
import { DataSourceConfig, loadConfig, saveConfig } from '../config.js';
import { PACKS_DIR } from '../fs/layout.js';

/**
 * Stock-analysis demo seed — the minimal end-to-end scenario for the
 * "logical database" MVP:
 *
 *   static knowledge   research reports + breaking news (markdown → raw/docs;
 *                      news carries frontmatter claims incl. one stale and one
 *                      conflicting pair, so expiry/conflict handling is
 *                      demonstrable without an LLM)
 *   live data          MySQL (companies + daily_quotes), TimescaleDB
 *                      (minute_bars hypertable), parquet-via-DuckDB
 *                      (daily_bars history — the stand-in for an HDFS table)
 *   wiring             datasources config block + an organization playbook
 *                      with live probes
 *
 * Prereq for the DB part: `docker compose -f demo/stock/docker-compose.yml up -d`.
 */

export interface SeedStockOptions {
  skipDb?: boolean;
  onProgress?: (msg: string) => void;
  /** Connection overrides for tests. */
  mysqlPort?: number;
  timescalePort?: number;
}

export interface SeedStockResult {
  files: string[];
  mysqlRows: number;
  timescaleRows: number;
  parquetRows: number;
  playbook: string;
  configUpdated: boolean;
  errors: string[];
}

interface Company {
  symbol: string;
  name: string;
  industry: string;
  exchange: string;
  marketCapBillion: number;
  listedDate: string;
  basePrice: number;
  aliases: string[];
}

const COMPANIES: Company[] = [
  { symbol: '300750', name: '宁德时代', industry: '动力电池', exchange: '深交所创业板', marketCapBillion: 1120.5, listedDate: '2018-06-11', basePrice: 245, aliases: ['300750', 'CATL'] },
  { symbol: '600519', name: '贵州茅台', industry: '白酒', exchange: '上交所主板', marketCapBillion: 1890.2, listedDate: '2001-08-27', basePrice: 1520, aliases: ['600519', '茅台'] },
  { symbol: '688981', name: '中芯国际', industry: '半导体代工', exchange: '上交所科创板', marketCapBillion: 640.8, listedDate: '2020-07-16', basePrice: 88, aliases: ['688981', 'SMIC'] },
];

export async function seedStockDemo(dataDir: string, opts: SeedStockOptions = {}): Promise<SeedStockResult> {
  const progress = opts.onProgress ?? (() => {});
  const result: SeedStockResult = { files: [], mysqlRows: 0, timescaleRows: 0, parquetRows: 0, playbook: '', configUpdated: false, errors: [] };

  /* ── static knowledge: reports + news ── */
  for (const [rel, content] of Object.entries(demoDocuments())) {
    const abs = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    result.files.push(rel);
  }
  progress(`wrote ${result.files.length} markdown documents to raw/docs`);

  /* ── parquet history (the "HDFS table") ── */
  const parquetDir = path.join(dataDir, 'datasets', 'hdfs');
  fs.mkdirSync(parquetDir, { recursive: true });
  result.parquetRows = await writeParquetHistory(path.join(parquetDir, 'daily_bars.parquet'));
  progress(`parquet: ${result.parquetRows} rows → datasets/hdfs/daily_bars.parquet`);

  /* ── live databases ── */
  if (!opts.skipDb) {
    try {
      result.mysqlRows = await seedMysql(opts.mysqlPort ?? 3307);
      progress(`mysql: ${result.mysqlRows} rows in market.companies + market.daily_quotes`);
    } catch (err) {
      result.errors.push(`mysql seed failed (is docker compose up?): ${err instanceof Error ? err.message : err}`);
    }
    try {
      result.timescaleRows = await seedTimescale(opts.timescalePort ?? 5433);
      progress(`timescaledb: ${result.timescaleRows} rows in minute_bars hypertable`);
    } catch (err) {
      result.errors.push(`timescaledb seed failed (is docker compose up?): ${err instanceof Error ? err.message : err}`);
    }
  }

  /* ── datasource config + playbook ── */
  const config = loadConfig(dataDir);
  config.datasources = demoDatasources(opts);
  saveConfig(dataDir, config);
  result.configUpdated = true;
  progress('knode.config.json: datasources block written');

  const playbookRel = `${PACKS_DIR}/organization.md`;
  const playbookAbs = path.join(dataDir, playbookRel);
  fs.mkdirSync(path.dirname(playbookAbs), { recursive: true });
  fs.writeFileSync(playbookAbs, ORGANIZATION_PLAYBOOK);
  result.playbook = playbookRel;
  progress(`playbook: ${playbookRel}`);

  return result;
}

export function demoDatasources(opts: SeedStockOptions = {}): DataSourceConfig[] {
  return [
    {
      id: 'market-mysql',
      kind: 'mysql',
      description: '交易日频数据库：公司基本面 + 日线行情（在线业务库）',
      host: '127.0.0.1',
      port: opts.mysqlPort ?? 3307,
      user: 'knode',
      password: 'knode',
      database: 'market',
      tables: [
        {
          name: 'companies',
          description: '上市公司基本信息（名称、代码、行业、市值）',
          entityColumns: [{ column: 'name', entityType: 'organization', aliasColumns: ['symbol'] }],
        },
        {
          name: 'daily_quotes',
          description: '日线行情（开高低收、成交量），每交易日更新',
          entityColumns: [{ column: 'symbol', entityType: 'organization' }],
        },
      ],
    },
    {
      id: 'ticks-tsdb',
      kind: 'timescale',
      description: '时序数据库：分钟级行情（盘中实时写入）',
      host: '127.0.0.1',
      port: opts.timescalePort ?? 5433,
      user: 'knode',
      password: 'knode',
      database: 'market',
      tables: [
        {
          name: 'minute_bars',
          description: '分钟线（时间戳、价格、成交量），TimescaleDB hypertable',
          entityColumns: [{ column: 'symbol', entityType: 'organization' }],
        },
      ],
    },
    {
      id: 'hist-parquet',
      kind: 'duckdb',
      description: '历史数据湖（模拟 HDFS）：两年日线宽表，parquet 格式',
      path: 'datasets/hdfs',
      tables: [
        {
          name: 'daily_bars',
          description: '两年日线历史（回测/长周期分析用）',
          entityColumns: [{ column: 'symbol', entityType: 'organization' }],
        },
      ],
    },
  ];
}

/* ------------------------------- price series ------------------------------ */

/** Deterministic PRNG so reruns produce identical data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tradingDays(count: number, until = new Date()): string[] {
  const days: string[] = [];
  const d = new Date(until);
  while (days.length < count) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() - 1);
  }
  return days.reverse();
}

interface Bar { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }

function dailySeries(company: Company, days: string[]): Bar[] {
  const rand = mulberry32(Number(company.symbol));
  let price = company.basePrice * 0.9;
  const bars: Bar[] = [];
  for (const date of days) {
    const drift = (rand() - 0.48) * 0.04;
    const open = price;
    const close = Math.max(1, open * (1 + drift));
    const high = Math.max(open, close) * (1 + rand() * 0.015);
    const low = Math.min(open, close) * (1 - rand() * 0.015);
    const volume = Math.floor(2_000_000 + rand() * 30_000_000);
    bars.push({ symbol: company.symbol, date, open: r2(open), high: r2(high), low: r2(low), close: r2(close), volume });
    price = close;
  }
  return bars;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* --------------------------------- MySQL ---------------------------------- */

async function seedMysql(port: number): Promise<number> {
  const conn = await mysql.createConnection({ host: '127.0.0.1', port, user: 'knode', password: 'knode', database: 'market', connectTimeout: 5000 });
  let rows = 0;
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS companies (
      symbol VARCHAR(16) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      industry VARCHAR(64),
      exchange VARCHAR(64),
      market_cap_billion DECIMAL(10,1),
      listed_date DATE
    )`);
    await conn.query(`CREATE TABLE IF NOT EXISTS daily_quotes (
      symbol VARCHAR(16) NOT NULL,
      trade_date DATE NOT NULL,
      open DECIMAL(10,2), high DECIMAL(10,2), low DECIMAL(10,2), close DECIMAL(10,2),
      volume BIGINT,
      PRIMARY KEY (symbol, trade_date)
    )`);
    for (const c of COMPANIES) {
      await conn.query(
        `REPLACE INTO companies (symbol, name, industry, exchange, market_cap_billion, listed_date) VALUES (?, ?, ?, ?, ?, ?)`,
        [c.symbol, c.name, c.industry, c.exchange, c.marketCapBillion, c.listedDate],
      );
      rows++;
    }
    const days = tradingDays(60);
    for (const c of COMPANIES) {
      const bars = dailySeries(c, days);
      const values = bars.map((b) => [b.symbol, b.date, b.open, b.high, b.low, b.close, b.volume]);
      await conn.query(`REPLACE INTO daily_quotes (symbol, trade_date, open, high, low, close, volume) VALUES ?`, [values]);
      rows += bars.length;
    }
  } finally {
    await conn.end();
  }
  return rows;
}

/* ------------------------------- TimescaleDB ------------------------------- */

async function seedTimescale(port: number): Promise<number> {
  const client = new pg.Client({ host: '127.0.0.1', port, user: 'knode', password: 'knode', database: 'market', connectionTimeoutMillis: 5000 });
  await client.connect();
  let rows = 0;
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS minute_bars (
      ts TIMESTAMPTZ NOT NULL,
      symbol TEXT NOT NULL,
      price DOUBLE PRECISION,
      volume BIGINT
    )`);
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);
      await client.query(`SELECT create_hypertable('minute_bars', 'ts', if_not_exists => TRUE)`);
    } catch {
      /* plain Postgres without the timescaledb extension — a regular table
         behaves identically for the demo's query patterns */
    }
    await client.query(`CREATE INDEX IF NOT EXISTS minute_bars_symbol_ts ON minute_bars (symbol, ts DESC)`);
    await client.query(`TRUNCATE minute_bars`);

    // last two weekdays × 4h of minute bars per company
    const days = tradingDays(2);
    for (const c of COMPANIES) {
      const rand = mulberry32(Number(c.symbol) + 7);
      let price = c.basePrice;
      const values: string[] = [];
      for (const day of days) {
        for (let m = 0; m < 240; m++) {
          const ts = new Date(`${day}T09:30:00+08:00`);
          ts.setMinutes(ts.getMinutes() + m + (m >= 120 ? 90 : 0)); // lunch break
          price = Math.max(1, price * (1 + (rand() - 0.5) * 0.004));
          values.push(`('${ts.toISOString()}', '${c.symbol}', ${r2(price)}, ${Math.floor(10_000 + rand() * 400_000)})`);
        }
      }
      await client.query(`INSERT INTO minute_bars (ts, symbol, price, volume) VALUES ${values.join(',')}`);
      rows += values.length;
    }
  } finally {
    await client.end();
  }
  return rows;
}

/* ------------------------------ parquet history ---------------------------- */

async function writeParquetHistory(file: string): Promise<number> {
  const days = tradingDays(500);
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    await conn.run(`CREATE TABLE daily_bars (symbol VARCHAR, trade_date DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT)`);
    for (const c of COMPANIES) {
      const bars = dailySeries(c, days);
      const values = bars.map((b) => `('${b.symbol}', DATE '${b.date}', ${b.open}, ${b.high}, ${b.low}, ${b.close}, ${b.volume})`);
      await conn.run(`INSERT INTO daily_bars VALUES ${values.join(',')}`);
    }
    await conn.run(`COPY daily_bars TO '${file.replace(/'/g, "''")}' (FORMAT PARQUET)`);
    return days.length * COMPANIES.length;
  } finally {
    conn.disconnectSync();
  }
}

/* ------------------------------ demo documents ----------------------------- */

function demoDocuments(): Record<string, string> {
  return {
    'raw/docs/reports/宁德时代-2026H1-研报.md': `---
title: 宁德时代 2026 半年度研报：储能第二曲线成型
date: "2026-08-05"
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750", "CATL"] }
  - { name: 贵州茅台, type: organization }
claims:
  - subject: 宁德时代
    type: market-share
    statement: 2026H1 全球动力电池装机份额约 36%，连续九年全球第一
    status: fact
    startDate: "2026-08-05"
---

# 宁德时代（300750）2026 半年度研报

## 核心观点

宁德时代 2026 上半年动力电池出货保持全球第一，储能业务收入占比提升至 28%，
成为名副其实的第二增长曲线。神行超充电池在 800V 平台车型渗透率快速上升。

## 业务拆分

- **动力电池**：上半年装机约 210 GWh，全球份额约 36%。麒麟电池、神行电池合计占出货 55%。
- **储能系统**：收入同比增长 45%，海外大储订单饱满，毛利率高于动力电池约 3 个百分点。
- **换电与回收**：EVOGO 换电站超 1200 座；锂回收产能利用率仍偏低。

## 风险提示

碳酸锂价格反弹会侵蚀毛利；美国 IRA 政策变动影响北美出货；
行业价格战若延续，单 Wh 盈利可能承压。

## 估值

参考同业与自由现金流折现，给予目标价区间 280-310 元。消费板块（如贵州茅台）
资金回流可能对高估值成长股形成阶段性压制。
`,

    'raw/docs/reports/贵州茅台-2026中期-研报.md': `---
title: 贵州茅台 2026 中期研报：直销占比继续提升
date: "2026-07-28"
entities:
  - { name: 贵州茅台, type: organization, aliases: ["600519", "茅台"] }
claims:
  - subject: 贵州茅台
    type: earnings
    statement: 2026H1 营业收入约 920 亿元，同比增长 14%
    status: fact
    startDate: "2026-07-28"
---

# 贵州茅台（600519）2026 中期研报

## 核心观点

贵州茅台 2026H1 营收约 920 亿元，同比增长 14%；直销（含 i 茅台）收入占比提升至 47%，
渠道利润再分配持续利好上市公司。批价企稳回升，库存健康。

## 关注点

- 飞天批价站稳 2600 元以上；
- 非标与文化酒投放节奏加快，吨价持续上行；
- 国际化：免税与东南亚渠道试点扩容。

## 风险

消费复苏不及预期；政策对高端消费的边际影响。
`,

    'raw/docs/reports/中芯国际-2026Q2-研报.md': `---
title: 中芯国际 2026Q2 研报：成熟制程满载，先进封装放量
date: "2026-08-15"
entities:
  - { name: 中芯国际, type: organization, aliases: ["688981", "SMIC"] }
  - { name: 宁德时代, type: organization }
claims:
  - subject: 中芯国际
    type: capacity
    statement: 2026Q2 产能利用率回升至 92%，12 英寸月产能约 95 万片
    status: fact
    startDate: "2026-08-15"
---

# 中芯国际（688981）2026Q2 研报

## 核心观点

中芯国际 Q2 产能利用率回升至 92%，车规 MCU 与电源管理芯片需求旺盛——
新能源产业链（宁德时代等电池厂扩产）带动功率半导体订单外溢。
先进封装（2.5D/3D）产线开始贡献收入。

## 数据

- Q2 收入 22.4 亿美元，环比 +6%；
- 毛利率 21.3%，好于指引上限；
- 12 英寸月产能约 95 万片，仍在爬坡。

## 风险

设备交付周期不确定；成熟制程价格竞争；地缘政策变化。
`,

    'raw/docs/news/2026-08-10-宁德时代盈利快报.md': `---
title: 快讯：宁德时代发布 2026Q2 盈利快报
date: "2026-08-10"
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - subject: 宁德时代
    type: earnings
    statement: 2026Q2 净利润 120 亿元，同比增长 20%
    status: fact
    startDate: "2026-08-10"
---

# 快讯：宁德时代 2026Q2 盈利快报

8 月 10 日盘后，宁德时代发布盈利快报：2026 年第二季度净利润 120 亿元，
同比增长 20%，超出市场一致预期约 5%。储能业务毛利率环比改善是主要贡献。
`,

    'raw/docs/news/2026-08-12-宁德时代业绩修正.md': `---
title: 快讯：宁德时代修正 2026Q2 业绩数据
date: "2026-08-12"
entities:
  - { name: 宁德时代, type: organization, aliases: ["300750"] }
claims:
  - subject: 宁德时代
    type: earnings
    statement: 2026Q2 净利润修正为 110 亿元，同比增长 10%
    status: disputed
    startDate: "2026-08-12"
---

# 快讯：宁德时代修正 2026Q2 业绩数据

8 月 12 日，宁德时代公告对 8 月 10 日盈利快报进行更正：因一笔海外储能项目
收入确认时点调整，2026Q2 净利润由 120 亿元修正为 110 亿元，同比增长 10%。
公司称正式财报以审计结果为准，数据仍可能变动。
`,

    'raw/docs/news/2026-06-01-贵州茅台提价窗口.md': `---
title: 贵州茅台非标产品提价窗口期公告
date: "2026-06-01"
entities:
  - { name: 贵州茅台, type: organization, aliases: ["600519"] }
claims:
  - subject: 贵州茅台
    type: pricing
    statement: 非标产品出厂价上调 10% 的执行窗口期为 6 月 1 日至 7 月 31 日
    status: fact
    startDate: "2026-06-01"
    endDate: "2026-07-31"
---

# 贵州茅台非标产品提价窗口期

6 月 1 日，渠道调研显示贵州茅台部分非标产品出厂价上调约 10%，
执行窗口期为 2026 年 6 月 1 日至 7 月 31 日，此后恢复常规价格政策。
`,

    'raw/docs/news/2026-08-25-中芯国际扩产.md': `---
title: 快讯：中芯国际宣布新一期 12 英寸产线扩产
date: "2026-08-25"
entities:
  - { name: 中芯国际, type: organization, aliases: ["688981"] }
claims:
  - subject: 中芯国际
    type: capacity
    statement: 计划 2027 年前新增 12 英寸月产能 10 万片，聚焦车规与工业芯片
    status: fact
    startDate: "2026-08-25"
---

# 快讯：中芯国际宣布新一期扩产

8 月 25 日，中芯国际宣布启动新一期 12 英寸产线扩产，计划 2027 年前
新增月产能 10 万片，聚焦车规与工业芯片。资本开支指引相应上调 15%。
`,
  };
}

/* --------------------------------- playbook -------------------------------- */

const ORGANIZATION_PLAYBOOK = `---
type: playbook
appliesTo: organization
retrieval:
  k: 6
  mode: hybrid
probes:
  - id: latest-quote
    source: market-mysql
    table: daily_quotes
    description: 最近 5 个交易日日线（开高低收、成交量）
    sql: "SELECT trade_date, open, high, low, close, volume FROM daily_quotes WHERE symbol = {symbol} ORDER BY trade_date DESC LIMIT 5"
  - id: company-profile
    source: market-mysql
    table: companies
    description: 公司基本面（行业、市值、上市日期）
    sql: "SELECT symbol, name, industry, exchange, market_cap_billion, listed_date FROM companies WHERE symbol = {symbol} OR name = {name}"
  - id: intraday
    source: ticks-tsdb
    table: minute_bars
    description: 最新 10 根分钟线（盘中实时）
    sql: "SELECT ts, price, volume FROM minute_bars WHERE symbol = {symbol} ORDER BY ts DESC LIMIT 10"
suggestions:
  - "长周期回溯（两年日线）不在探针内：用 knode_query 查 hist-parquet 的 daily_bars 表。"
  - "行情数值一律以带 asOf 时间戳的实时探针为准；研报/资讯中的价格可能已过期。"
---

# 上市公司上下文 playbook

针对 organization 类实体（上市公司）的取数剧本：

1. 先看本 pack 内的研报与资讯 chunk，注意 claims 的 status / endDate —— 标记为
   STALE 或 CONFLICT 的断言必须先核实再引用。
2. 行情、市值等时效数据以 liveData 探针结果为准（带 asOf 时间戳）。
3. 需要更长历史或自定义聚合时，用 knode_query 直接写 SQL；
   日线在 market-mysql.daily_quotes，分钟线在 ticks-tsdb.minute_bars，
   两年历史在 hist-parquet.daily_bars。
`;
