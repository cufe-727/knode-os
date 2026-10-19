import net from 'node:net';
import type { PGlite } from '@electric-sql/pglite';

/**
 * PGlite behind a PostgreSQL wire-protocol socket, so the real `pg` driver —
 * and a connector built from host/port config — talks to a real PostgreSQL
 * (17, in WASM) without one installed. What the server accepts or refuses
 * (one statement per Parse, writes in a READ ONLY transaction) is
 * PostgreSQL's own behaviour, not a script's.
 *
 * The socket answers the startup handshake itself (no password, no TLS) and
 * hands every later message to PGlite. PGlite is a single session that every
 * connection shares, so a test should run its queries one at a time.
 */
export interface PgliteWire {
  port: number;
  close: () => Promise<void>;
}

const SSL_REQUEST = 80877103;

function message(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
};
const cstring = (s: string) => Buffer.from(`${s}\0`, 'utf8');
const parameter = (name: string, value: string) => message('S', cstring(name), cstring(value));

const STARTUP_REPLY = Buffer.concat([
  message('R', int32(0)), // AuthenticationOk
  parameter('server_version', '17.0'),
  parameter('server_encoding', 'UTF8'),
  parameter('client_encoding', 'UTF8'),
  parameter('standard_conforming_strings', 'on'),
  parameter('DateStyle', 'ISO, MDY'),
  parameter('integer_datetimes', 'on'),
  message('K', int32(1), int32(1)), // BackendKeyData
  message('Z', Buffer.from('I')), // ReadyForQuery, idle
]);

export async function startPgliteWire(db: PGlite): Promise<PgliteWire> {
  let queue = Promise.resolve();
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffered = Buffer.alloc(0);
    let started = false;
    let pipeline: Buffer[] = [];

    socket.on('data', (data) => {
      buffered = Buffer.concat([buffered, data]);
      for (;;) {
        if (!started) {
          // StartupMessage / SSLRequest: Int32 length, Int32 code, …
          if (buffered.length < 8 || buffered.length < buffered.readInt32BE(0)) return;
          const length = buffered.readInt32BE(0);
          const code = buffered.readInt32BE(4);
          buffered = buffered.subarray(length);
          if (code === SSL_REQUEST) {
            socket.write('N');
            continue;
          }
          started = true;
          socket.write(STARTUP_REPLY);
          continue;
        }
        if (buffered.length < 5 || buffered.length < 1 + buffered.readInt32BE(1)) return;
        const frame = buffered.subarray(0, 1 + buffered.readInt32BE(1));
        buffered = buffered.subarray(frame.length);
        const type = String.fromCharCode(frame[0]);
        if (type === 'X') {
          socket.end();
          return;
        }
        // the backend answers an extended-protocol pipeline at Sync (or Flush); a simple Query stands alone
        pipeline.push(frame);
        if (type !== 'S' && type !== 'H' && type !== 'Q') continue;
        const batch = Buffer.concat(pipeline);
        pipeline = [];
        queue = queue.then(async () => {
          const reply = await db.execProtocolRaw(new Uint8Array(batch));
          if (reply.length && !socket.destroyed) socket.write(Buffer.from(reply));
        });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue;
    },
  };
}
