# Signing in, and reaching knode-os from other machines

`knode-os serve` asks everyone to sign in: in the browser, in the macOS app, from a script, on the same Mac or
from across the internet. Accounts live on the server. An administrator creates them, and each one says what its
holder may do and what they may use from another machine. The service listens on loopback. Other machines reach it
through a domain (Cloudflare Tunnel), through an SSH tunnel, or, when you turn it on, through an HTTPS listener on
an IP address. A **gateway** can also publish selected APIs of other services on the same machine under `/gw/<id>`,
behind the same sign-in.

The code is in `src/auth/`: accounts, sessions, API groups, gateways, the HTTP side, and the CLI.

## Accounts

| role | may |
| --- | --- |
| **admin** | every Team, every API group, settings, users and gateways |
| **member** | their own personal workspaces, the Teams listed for them, every API group except `settings`. From other machines, only the groups in their `remoteApis`. |

Each user's personal workspaces are under `users/<name>/workspaces/`. **Name the first administrator after the folder
that holds your existing workspaces** (the old mock sign-in used `admin`), so they stay yours.

**The first account** is made on the machine the service runs on, never from another one. Either:

```bash
knode-os user add admin --admin            # asks for the password twice (or --password-stdin)
```

or open the web UI or the app on that machine. With no accounts yet, they show **Create the administrator**. Another
machine is only told that the server has no accounts yet.

Then:

```bash
knode-os user list
knode-os user add alice --name "Alice" --team research-lab           # a member
knode-os user set alice --remote-apis files,search,ask               # what she may use from other machines
knode-os user set alice --gateway homebook                           # a local service she may reach
knode-os user set alice --disable | --enable
knode-os user passwd alice                                           # her sessions end
knode-os user signout alice                                          # every session ends
knode-os user remove alice                                           # users/alice stays on disk
knode-os user sessions [alice] [--revoke <id>]
```

Administrators can do the same in the web UI and the app under **Settings → Access**. Everyone can change their own
password and end their own sessions there.

An operator can share an existing personal workspace through a Team alias, without moving or copying its data:

```bash
mkdir -p ~/.knode-os/teams
ln -s ../users/admin/workspaces/finance ~/.knode-os/teams/finance
knode-os user set alice --team finance
```

The alias must point to an existing `users/<owner>/workspaces/<id>` within the same data root. Team membership is
checked before opening it. The Team and the owner's personal view share the same files, index, processing and
updates; members have their usual read/write permissions. Remove the alias or the member's Team grant to stop
sharing. Clearing through an alias is refused; an intentional clear must use the owner's personal workspace.

Accounts are kept in `.knode/accounts.json` and sessions in `.knode/sessions.json`, both mode 0600 and under the data
root. Passwords are hashed with scrypt (N=2¹⁵), and a session token is stored only as its SHA-256. A running `serve`
re-reads both files when they change, so CLI changes take effect without a restart.

**Sessions.** A browser gets an HttpOnly cookie, `knode_session_<port>`, with `SameSite=Lax` (and `Secure` over
HTTPS). The app and scripts get a bearer token, `knu_…`. The app keeps its token in `~/Library/Application Support/KnodeOS/sessions.json` (mode 0600). It does not use the Keychain: the app is ad-hoc signed, so every rebuild would ask for the login password before the Keychain handed the token back. A session
lasts `server.auth.sessionDays` (30) after its last use; "Keep me signed in" off means half a day. A password change,
"sign out everywhere", disabling or removing the account ends that account's sessions. A browser's state-changing
request must carry `X-Knode-CSRF: 1`, and a page on another site cannot send that header.

**Throttling.** Ten failed sign-ins from one address in 10 minutes block that address for 15 minutes. Twenty failed
sign-ins for one username block that name for 10 minutes. Password checks run a few at a time.

## Ways in

| from | web | macOS app |
| --- | --- | --- |
| the same machine | `http://127.0.0.1:<port>` | **This Mac** |
| a domain | `https://knode.example.com` | **Domain or address (HTTPS)** |
| an IP address, over SSH | `ssh -N -L 12000:127.0.0.1:12000 you@<ip>`, then `http://127.0.0.1:12000` | **SSH tunnel** (the app runs the tunnel) |
| an IP address, over HTTPS | `https://<ip>:<tls port>` | **Domain or address (HTTPS)**, then trust the certificate |

Each way asks you to sign in. A session belongs to the service it was made for, so in the app, switching to another
connection means signing in there.

**A domain (Cloudflare Tunnel).** Point a public hostname of the machine's tunnel at `http://localhost:<port>`. Turn
on *Always Use HTTPS*. Leave Cloudflare Access off for this hostname, because the server's sign-in is the
authentication. Requests through the tunnel count as coming from another machine. The service accepts them only if
the edge reports HTTPS, and each account may use only its `remoteApis` groups.

**An SSH tunnel.** The app's **SSH tunnel** mode takes:
- a destination: `user@host`, or a Host alias selected from the Mac's `~/.ssh/config` (including `Include` files)
- an optional SSH port override; leave it empty to use the host's config, or SSH's default of 22
- the knode-os port on that machine (12000)
- optionally, an identity file override; leave it empty to use the host's config or ssh-agent

The host menu reloads when the connection dialog opens, and its refresh button rereads the files. It lists literal
aliases, omitting wildcard and negated patterns. Selecting an alias clears the optional overrides so OpenSSH can
use that host's `User`, `HostName`, `Port`, `IdentityFile`, `ProxyJump` and other settings. The app only reads config
text to discover names; it does not run `Match exec` commands or open private key files during discovery.

The app keeps `ssh -N -L 127.0.0.1:<free port>:127.0.0.1:<port>` running for you. It runs ssh in batch mode, so it
never asks for a password. It disables connection multiplexing and backgrounding for its own tunnel, even if
`ControlMaster`, `ControlPersist` or `ForkAfterAuthentication` are enabled in your config. This keeps the process
and forward owned by the app; other SSH sessions are unaffected. Use the port the remote service actually listens
on — it can differ from the bundled local service's 9100. Use a key that ssh-agent or the Keychain holds. Connect once in Terminal first, so the
host key is known. To the server, a tunnelled request comes from its own machine. It still needs an account, and is
not limited to `remoteApis`: whoever can SSH into the machine is trusted with it already.

**An HTTPS listener.** This is for reaching the service by IP without a tunnel. Make a certificate for the names and
addresses clients use, then turn on a second listener:

```bash
knode-os tls init --host 192.168.1.20 --host mac-mini.local    # prints the SHA-256 fingerprint
```

```json
"server": { "port": 12000, "host": "127.0.0.1",
            "tls": { "port": 12443, "host": "0.0.0.0", "cert": ".knode/tls/cert.pem", "key": ".knode/tls/key.pem" } }
```

The main listener stays plain HTTP on loopback. The MCP endpoint, the LaunchAgent's health check and tunnels use it.
The HTTPS one serves other machines. Browsers warn about a self-signed certificate. When the app connects for the
first time, it shows the fingerprint and remembers it once you trust it. A certificate from a CA the client trusts,
such as one made with mkcert or Tailscale, needs no trusting.

`serve` refuses to listen where other machines would reach it over plain HTTP. If `server.host` is not loopback, it
fails to start unless `server.auth.allowInsecureRemote` is true. Set that only on a network that encrypts by itself,
such as a VPN, because passwords would otherwise cross it in the clear. A remote request that arrives over plain HTTP
is answered `403`.

## What an account may use from other machines

Every `/api` route belongs to an API group (`src/auth/apis.ts`). A route that is not listed falls into `settings`, so
a new route stays locked down until someone decides who it is for.

| group | covers |
| --- | --- |
| `files` | browse, read, edit, upload and move files; linked folders |
| `search` | search, graph, entities, documents, claims, stats, lineage, history |
| `ask` | Ask, chat, context packs |
| `knowledge` | wiki, research, dream, suggestions, merges, reviews |
| `ingest` | sync, ingest, forget, purge, rebuild, labeling status |
| `traces` | agent traces |
| `datasources` | configured live datasources and their read-only queries |
| `settings` | models, connections, agents, profiles, clearing a workspace, users, gateways (admins only) |
| `gateway` | `/gw/<id>` |

On the server's own machine, an account may use every group its role allows. From another machine it may use only
the groups in `remoteApis`. A new member gets `files, search, ask, knowledge, ingest, traces`, and a new administrator
gets `*`. `GET /api/auth/me` shows what the current session may use, and so does **Settings → Access**.

**Ask and Research** run coding agents (Codex, Claude Code, Cursor) on the server's machine. Even in a read-only
sandbox, an agent can read files outside the workspace. Give these groups only to people you would trust with read
access to that machine.

## Gateways: other local services, behind the same sign-in

```bash
knode-os gateway add homebook http://127.0.0.1:12200/api --description "Homebook API"
knode-os gateway list
knode-os gateway remove homebook
```

`/gw/homebook/<path>` is forwarded to `http://127.0.0.1:12200/api/<path>`. Administrators may use every gateway.
Members need the gateway in their list (`knode-os user set <name> --gateway homebook`), and the `gateway` group as
well when they connect from another machine.

What the service sees and returns:
- **Credentials.** Knode credentials never reach the service. The session cookie is cut out of `Cookie`, and a
  `Bearer knu_…` header is dropped. The service learns who called from `X-Knode-User`, which only the gateway sets.
  It also gets `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` and `X-Forwarded-Prefix: /gw/<id>`.
- **Its own Authorization header.** If the service needs one, add the gateway with `--pass-authorization`, and send
  the knode token as `X-Knode-Token: knu_…` instead.
- **Redirects and cookies.** These stay under `/gw/<id>`.
- **Sandboxing.** Responses come with `Content-Security-Policy: sandbox`, so a page the service returns cannot script
  the knode-os origin. Use `--no-sandbox` only for a web UI you trust as much as knode-os itself.
- **Limits.** Targets must be on the same machine (`127.0.0.1`, `localhost`, `[::1]`). There is no WebSocket
  forwarding. A request may take `--timeout` seconds (300 by default).

An administrator can also manage gateways under **Settings → Access**.

## Scripts

```bash
knode-os user token alice --label nightly-export --days 90     # printed once
curl -H "Authorization: Bearer knu_…" \
     -H "X-Knode-Workspace-Kind: personal" -H "X-Knode-Workspace-ID: default" -H "X-Knode-Workspace-Name: Default" \
     https://knode.example.com/api/stats
curl -H "Authorization: Bearer knu_…" https://knode.example.com/gw/homebook/items
```

A script token acts as its account and expires on the date it was made with. `knode-os user sessions alice --revoke
<id>` ends it. Remote labeling workers keep their per-machine `knr_…` tokens on `/remote/v1`; see
[remote-labeling.md](remote-labeling.md).

## Configuration

| key | default | |
| --- | --- | --- |
| `server.auth.enabled` | `true` | Off (development only): `serve` trusts the workspace headers a client sends, must listen on loopback, and answers only `/remote/v1` from outside. |
| `server.auth.sessionDays` | `30` | Days a browser or app session lives without use. |
| `server.auth.allowInsecureRemote` | `false` | Answer other machines over plain HTTP. Use this only on a VPN. |
| `server.tls` | `null` | `{ port, host, cert, key }`: an HTTPS listener beside the main one. Relative paths are under the data root. |

## HTTP

Open, without a session:
- `GET /api/health`
- `GET /api/auth/state`: whether sign-in is on, whether the server has accounts, whether this client may create the
  first one, and the session if there is one
- `POST /api/auth/login`: `{ username, password, client: "browser" | "app", label?, remember? }`. A browser gets a
  cookie. An app gets `{ token }`.
- `POST /api/auth/setup`: the first administrator, on the server's machine only
- `POST /api/auth/logout`

With a session:
- `GET /api/auth/me`
- `POST /api/auth/password`: `{ current, password }`. Answers a new session, and every other session ends.
- `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`
- `POST /api/auth/signout-others`

Administrators:
- `GET` and `POST /api/auth/users`
- `PATCH` and `DELETE /api/auth/users/:name`
- `POST /api/auth/users/:name/signout`
- `GET` and `POST /api/auth/gateways`, `DELETE /api/auth/gateways/:id`

Every other `/api` route needs a session and the route's API group. `/mcp` answers this machine only, with its own
token. `/remote/v1` uses per-machine tokens.
