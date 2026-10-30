#!/usr/bin/env bash
# Smoke test for the omp host: runs one Haiku turn through the bridge with a
# real tool call, then checks the Claude quota shows up in `omp usage`.
# Requires: omp with this package linked (`omp plugin link .`), jq, and Claude
# Code credentials. Spends a little real Claude quota.
set -euo pipefail

cd "$(dirname "$0")/.."

PROMPT="Use the read tool on package.json and reply with only its name field."
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "=== omp-smoke.sh ==="

omp -p --mode json --model claude-bridge/claude-haiku-5-5 "$PROMPT" > "$OUT"

jq -e -s 'any(.[]; .type == "tool_execution_end" and .toolName == "read" and (.isError // false) != true)' "$OUT" >/dev/null \
  || fail "no successful read tool_execution_end event"
echo "ok: read tool executed"

jq -e -s '[.[] | select(.type == "message_end")] | last
          | [.message.content[]? | select(.type == "text") | .text] | join("")
          | contains("pi-claude-bridge")' "$OUT" >/dev/null \
  || fail "final message_end text does not contain pi-claude-bridge"
echo "ok: final message mentions pi-claude-bridge"

jq -e -s 'any(.[]; .type == "agent_end")' "$OUT" >/dev/null \
  || fail "no agent_end event"
echo "ok: agent_end seen"

USAGE="$(omp usage --json --provider claude-bridge)"
jq -e '[.reports[0].limits[].window.id] | (index("5h") != null) and (index("7d") != null)' <<<"$USAGE" >/dev/null \
  || fail "omp usage lacks 5h and 7d windows for claude-bridge"
echo "ok: omp usage reports 5h and 7d windows"

jq -e '.reports[0].limits[] | select(.window.id == "5h")
       | (.amount.usedFraction | type) == "number" or (.amount.used | type) == "number"' <<<"$USAGE" >/dev/null \
  || { echo "claude-bridge usage notes: $(jq -c '.reports[0].notes // []' <<<"$USAGE")" >&2
       fail "claude-bridge 5h usage row has no numeric amount.usedFraction or amount.used"; }
echo "ok: claude-bridge 5h usage row has a numeric amount"

echo "PASS"
