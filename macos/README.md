# knode-os macOS app

The app is a native SwiftUI client for the `knode-os` service.

The packaged `.app` includes a Node runtime and the production service. When
the configured URL is local and unavailable, the app starts that bundled
service automatically and stops the process when the app quits.

```bash
# For `swift run`, start the development service from the repository root
pnpm dev serve --data ./.dev-data

# Then run the unbundled development client
cd macos
swift run KnodeOS
```

Build an ordinary `.app` bundle in `macos/build/`:

```bash
./scripts/package-app.sh
```

For local installation and debugging, run `./scripts/install-app.sh`. It builds,
replaces `/Applications/KnodeOS.app` following the
[local installation workflow](../AGENTS.md), and launches that fixed path.
Keep any persistent rollback backup as a single ZIP archive, and clean up the
reproducible build bundle after the installed app is verified. Leaving multiple
loose `.app` bundles lets macOS list each copy as another application.

The packaged app needs no separate Terminal process. Its default service URL
is `http://127.0.0.1:9100`, where it starts its bundled service when nothing
answers. The connection control in the sidebar (or **Change…** on the sign-in
screen) points it elsewhere: another local URL, a domain or address over HTTPS
(a self-signed certificate is shown to you to trust once), or a machine reached
through an SSH tunnel the app keeps open itself. Every service asks you to sign
in; the session token is kept in `~/Library/Application Support/KnodeOS/sessions.json` (0600). See
[docs/remote-access.md](../docs/remote-access.md).
