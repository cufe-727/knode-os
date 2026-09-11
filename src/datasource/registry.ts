import { DataSourceConfig } from '../config.js';
import { DuckdbConnector } from './duckdb.js';
import { HttpJsonConnector } from './http.js';
import { ObjectConnector } from './object.js';
import { PrometheusConnector } from './prometheus.js';
import { MysqlConnector } from './mysql.js';
import { TimescaleConnector } from './timescale.js';
import { DataSourceConnector } from './types.js';

/** Lazily-connected pool of configured data sources, one per config id. */
export class DataSourceRegistry {
  private connectors = new Map<string, DataSourceConnector>();

  constructor(
    private readonly dataDir: string,
    private readonly configs: DataSourceConfig[],
  ) {}

  list(): DataSourceConfig[] {
    return this.configs;
  }

  has(id: string): boolean {
    return this.configs.some((c) => c.id === id);
  }

  get(id: string): DataSourceConnector {
    const existing = this.connectors.get(id);
    if (existing) return existing;
    const config = this.configs.find((c) => c.id === id);
    if (!config) throw new Error(`unknown datasource: ${id} (configured: ${this.configs.map((c) => c.id).join(', ') || 'none'})`);
    const connector = createConnector(config, this.dataDir);
    this.connectors.set(id, connector);
    return connector;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connectors.values()].map((c) => c.close()));
    this.connectors.clear();
  }
}

function createConnector(config: DataSourceConfig, dataDir: string): DataSourceConnector {
  switch (config.kind) {
    case 'mysql':
      return new MysqlConnector(config);
    case 'timescale':
      return new TimescaleConnector(config);
    case 'duckdb':
      return new DuckdbConnector(config, dataDir);
    case 'http-json':
      return new HttpJsonConnector(config);
    case 'prometheus':
      return new PrometheusConnector(config);
    case 'object':
      return new ObjectConnector(config, dataDir);
    default:
      throw new Error(`unsupported datasource kind: ${(config as DataSourceConfig).kind}`);
  }
}
