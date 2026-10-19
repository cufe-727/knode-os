import type { AddressInfo } from 'node:net';
import mysql from 'mysql2';

/**
 * A MySQL wire-protocol endpoint (mysql2's server side) that records what a
 * client sends, for testing what the MySQL connector asks of a server without
 * one installed. It answers the way MySQL 8 does where that matters here:
 *
 *   - text holding a second statement is a syntax error (1064) unless the
 *     client asked for CLIENT_MULTI_STATEMENTS in its handshake;
 *   - inside START TRANSACTION READ ONLY a write is refused (1792);
 *   - SET, START TRANSACTION, ROLLBACK and COM_RESET_CONNECTION answer OK.
 *
 * `answer` scripts everything else: the rows a query returns, an error, or
 * no reply at all.
 */

/** The capability a client must ask for before a server runs `a; b` as two statements. */
export const CLIENT_MULTI_STATEMENTS = 0x00010000;
const COM_RESET_CONNECTION = 0x1f;
const VAR_STRING = 253;
const UTF8_GENERAL_CI = 33;

export interface FakeMysqlSession {
  /** Capability flags the client asked for. */
  clientFlags: number;
  /** What the client sent, in order: statement texts, and RESET for COM_RESET_CONNECTION. */
  received: string[];
  /** Between START TRANSACTION READ ONLY and the ROLLBACK / COMMIT / reset that ends it. */
  readOnly: boolean;
  closed: boolean;
}

export type FakeMysqlAnswer =
  | { rows: Record<string, string | null>[] }
  | { error: { code: number; message: string } }
  | 'ok'
  | 'hang';

export interface FakeMysql {
  port: number;
  sessions: FakeMysqlSession[];
  close: () => Promise<void>;
}

type ServerConnection = {
  serverHandshake: (args: Record<string, unknown>) => void;
  clientHelloReply: { clientFlags: number };
  on: (event: string, listener: (...args: never[]) => void) => void;
  writeOk: () => void;
  writeError: (args: { code: number; message: string }) => void;
  writeColumns: (columns: Record<string, unknown>[]) => void;
  writeTextRow: (values: (string | null)[]) => void;
  writeEof: () => void;
  stream: { destroy: () => void };
};

const WRITE = /^\s*(insert|update|delete|replace|create|alter|drop|truncate|rename)\b/i;

export async function startFakeMysql(
  answer: (sql: string, session: FakeMysqlSession) => FakeMysqlAnswer | undefined = () => undefined,
): Promise<FakeMysql> {
  const sessions: FakeMysqlSession[] = [];
  const open = new Set<ServerConnection>();
  const server = mysql.createServer();

  server.on('connection', (conn: ServerConnection) => {
    open.add(conn);
    const session: FakeMysqlSession = { clientFlags: 0, received: [], readOnly: false, closed: false };
    sessions.push(session);
    conn.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.36-knode-fake',
      connectionId: sessions.length,
      statusFlags: 2,
      characterSet: UTF8_GENERAL_CI,
      capabilityFlags: 0xffffff,
    });

    const reply = (result: FakeMysqlAnswer) => {
      if (result === 'hang') return;
      if (result === 'ok') return conn.writeOk();
      if ('error' in result) return conn.writeError(result.error);
      const names = Object.keys(result.rows[0] ?? { result: null });
      conn.writeColumns(
        names.map((name) => ({
          catalog: 'def', schema: 'fake', table: 't', orgTable: 't', name, orgName: name,
          characterSet: UTF8_GENERAL_CI, columnLength: 255, columnType: VAR_STRING, flags: 0, decimals: 0,
        })),
      );
      for (const row of result.rows) conn.writeTextRow(names.map((n) => row[n] ?? null));
      conn.writeEof();
    };

    const onStatement = (sql: string) => {
      session.clientFlags = conn.clientHelloReply.clientFlags;
      session.received.push(sql);
      const scripted = answer(sql, session);
      if (scripted) return reply(scripted);
      if (sql.replace(/;\s*$/, '').includes(';') && !(session.clientFlags & CLIENT_MULTI_STATEMENTS)) {
        return reply({ error: { code: 1064, message: `You have an error in your SQL syntax near '${sql.slice(sql.indexOf(';'))}'` } });
      }
      if (/^\s*start\s+transaction\s+read\s+only\s*$/i.test(sql)) session.readOnly = true;
      else if (/^\s*(rollback|commit)\b/i.test(sql)) session.readOnly = false;
      else if (session.readOnly && WRITE.test(sql)) {
        return reply({ error: { code: 1792, message: 'Cannot execute statement in a READ ONLY transaction.' } });
      }
      if (/^\s*(set|start|rollback|commit)\b/i.test(sql)) return reply('ok');
      reply({ rows: [{ result: 'ok' }] });
    };

    // mysql2 hands a COM_QUERY that starts with SET or PREPARE to `stmt_prepare`
    conn.on('query', onStatement);
    conn.on('stmt_prepare', onStatement);
    conn.on('packet', (_packet: unknown, _known: boolean, command: number) => {
      if (command !== COM_RESET_CONNECTION) return;
      session.received.push('RESET');
      session.readOnly = false;
      conn.writeOk();
    });
    conn.on('end', () => {
      session.closed = true;
      open.delete(conn);
    });
    conn.on('error', () => {
      session.closed = true;
      open.delete(conn);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = (server as unknown as { _server: { address: () => AddressInfo } })._server.address();
  return {
    port,
    sessions,
    close: async () => {
      for (const conn of open) conn.stream.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
