# Example plugin

`example-plugin.mjs` shows one of each extension point knode-os plugins have
(see [docs/plugins.md](../../docs/plugins.md)): an LLM provider (`echo`), an
embedding provider (`char-hash`), a document converter (`.rot13`), hooks at the
tier-0 and extraction stages, and a `setup` that reads options from the config.

Try it:

```bash
mkdir -p ~/knode-data/plugins
cp demo/plugins/example-plugin.mjs ~/knode-data/plugins/
```

```jsonc
// ~/knode-data/knode.config.json
"plugins": [{ "module": "./plugins/example-plugin.mjs", "options": { "redact": ["CONFIDENTIAL"] } }]
```

```bash
node dist/cli.js plugins --data ~/knode-data
printf 'Uryyb sebz n cyhtva pbairegre' > ~/knode-data/raw/docs/hello.rot13
node dist/cli.js sync --data ~/knode-data
node dist/cli.js search "plugin converter" --data ~/knode-data
```
