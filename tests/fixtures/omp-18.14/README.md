# omp 18.14 prompt capture

Captured **2026-10-30**, using **omp/18.14.0** and
`opencode-go/deepseek-v4.1-flash`. This is a sanitized live
`before_agent_start` payload, not a reconstructed prompt. Its shape is
`{ "systemPrompt": string[] }`; all **4 elements** retain their original order.

## Reproduction

In a scratch git repository (`git init`), create:

- `AGENTS.md`: `FIXTURE-AGENTS-RULE` followed by a newline.
- `.omp/skills/fixture-skill/SKILL.md`:

  ```markdown
  ---
  name: fixture-skill
  description: FIXTURE-SKILL
  ---

  FIXTURE-SKILL
  ```

- `appender.ts`:

  ```typescript
  export default function (pi) {
    pi.on("before_agent_start", (event) => ({
      systemPrompt: [...event.systemPrompt, "FIXTURE-EXTENSION-APPEND"],
    }));
  }
  ```

With `BRIDGE` pointing to this checkout, run from the scratch repository:

```sh
OMP_CAPTURE_OUT=$PWD/system-prompt.json omp -p \
  --model opencode-go/deepseek-v4.1-flash \
  -e "$PWD/appender.ts" -e "$BRIDGE/diag/omp-capture-prompt.ts" "reply ok"
jq '.systemPrompt | length' system-prompt.json
```

The run exited 0, replied `ok`, and produced 4 elements. The project skill was
discovered directly; no fallback skill or other configuration was added under
`~/.omp`. The raw capture stays outside this checkout. Copy **only a sanitized
version** here. User configuration affects optional sections and extensions;
recapturing in another environment need not produce identical text.

## Observed markers (source of truth for parser work)

Zero-based element indices:

| Element | Observed structure |
| --- | --- |
| 0 | Starts with two RFC 2119/XML explanatory lines; **first heading is `§ Role`**, not the first line. Subsequent major headings: `§ Runtime`, `§ Tool Policy`, `§ Workflow`, `§ Delivery`, `§ Critical`. |
| 0 | `# Personality` is present, including omp's built-in personality prose and subheadings. |
| 0 | `<skills>` / `</skills>` enclose 7 entries; `fixture-skill: FIXTURE-SKILL` is the second. |
| 0 | **`<generic-rules>` and `<domain-rules>` are absent**, including their closing tags. Do not invent these optional sections when parsing this fixture. |
| 0 | `# Internal URLs` is followed by its prose/list; the **next heading is `# Tool Inventory`**, followed by `# xd:// Tool Devices`. |
| 1 | A separate extension/template element headed `# Browser Relay`. |
| 2 | Begins with `<project-context>`, containing `<workstation>` and `<repo-rules>` with two `<file path="…">` blocks; the second contains `FIXTURE-AGENTS-RULE`. |
| 2 | **After `</project-context>`**, a blank line then `<critical>` / `</critical>` wrap the three delivery/verification bullets. This block is outside project context. |
| 2 | Further headings in the **same element**, after that critical block: `# Memory`, `## Auto-Learn (experimental)`, `## User Instructions`. No separate recalled-memory block was delivered. |
| 3 | Exactly `FIXTURE-EXTENSION-APPEND`, proving the capture ran after the appender. No further elements. |

## Sanitization

This public fixture retains omp's template headings, tags, markers and prose.
Global AGENTS.md content, user-authored appended instructions, and non-fixture
skill names/descriptions are replaced with `REDACTED`. List entries and array
elements were not removed or reordered. OS and architecture values are
`REDACTED`; the capture model is retained. Absolute home prefixes become
`/home/fixture`; the identifying scratch path becomes `/tmp/omp-fixture-repo`.

No personal recalled-memory payload, hostname, rule listing, key or token was
present in this capture. The generic `# Memory` and Auto-Learn guidance is omp
shipped prose, not recalled personal content, so it is retained. Any such
personal data must be redacted on recapture. The three `FIXTURE-*` markers remain
verbatim. The capture extension itself deliberately writes **raw** data: never
commit its output without this privacy review.

## Acceptance 2026-10-30 (omp 18.14.0, `claude-bridge/claude-opus-5-5`, fork main at a124538)

Run live through herdr against fresh omp processes; each check verified from transcripts or the bridge debug log, not only the model's answer.

| # | Check | Result |
|---|---|---|
| 1 | `~/.claude/CLAUDE.md` does not reach bridged turns | PASS — no pi-workers instruction in context |
| 2 | omp AGENTS.md, APPEND_SYSTEM and skills arrive | PASS — quota-routing rule quoted; `skill://` read works |
| 3 | No Claude Code hook/plugin output | PASS after A6 (`provider.loadClaudeSettings`, default false); CC transcripts show no hook events |
| 4 | Context survives `/compact` and `/tree` summaries | PASS after B5 — snap and soft compaction plus branch summary route to the isolated path |
| 5 | `/btw` promotion keeps context | PASS |
| 6 | Esc mid-turn and steering between tool calls | PASS — abort logged; steer stopped the tool sequence (minor: the reply appeared twice) |
| 7 | Task subagent on `claude-bridge/*`, also after `/new` | PASS (subagent model set via config; omp 18.14's task tool takes no per-call model) |
| 8 | `/usage` matches the subscription | PASS — matches the Claude Code statusline cache (requires `provider.isolateAnthropicEnv` when `ANTHROPIC_API_KEY` is exported) |
