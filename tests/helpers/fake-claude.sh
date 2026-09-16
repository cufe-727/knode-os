#!/bin/sh
# claude-cli stand-in: ignore claude's flags, run the fake agent with the brief on stdin
exec node "$(dirname "$0")/fake-agent.mjs" "$@"
