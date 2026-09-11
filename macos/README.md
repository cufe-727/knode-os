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
open build/KnodeOS.app
```

The packaged app needs no separate Terminal process. Its default service URL
is `http://127.0.0.1:9100`; the connection control in the sidebar can still be
used for an externally managed local or remote service.
