#!/bin/sh
# opencode stand-in: `opencode run …` with the prompt on stdin; the fake agent sees `run` and speaks OpenCode
exec node "$(dirname "$0")/fake-agent.mjs" "$@"
