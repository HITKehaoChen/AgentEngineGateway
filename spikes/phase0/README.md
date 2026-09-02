# Phase 0 Harness Spike

## Verified baseline

- Windows ARM64
- Node.js 24.19.0
- npm 11.17.0
- OpenCode 1.18.26
- Pi 0.84.4
- Model: `deepseek-v4-flash-vision-exp`

The API key is never stored here. Set `DEEPSEEK_API_KEY` in the process environment before running either harness.

## Smoke task

Both harnesses receive the same task from the repository root:

> Use a file-reading tool to read the first line of `docs/多Agent引擎可替换网关-SPEC.md`, then reply with exactly that line and nothing else.

Expected result:

```text
# 多 Agent 引擎可替换网关 SPEC
```

## Observed result

| Harness | Result | Tool | Stable completion signal |
| --- | --- | --- | --- |
| OpenCode | PASS | `read` | final `step_finish` with `reason=stop` |
| Pi | PASS | `read` | `agent_settled` after `agent_end` |

OpenCode emitted a tool step ending in `reason=tool-calls`, followed by a new text step ending in `reason=stop`. Pi emitted streamed tool-call deltas, `tool_execution_start`, `tool_execution_end`, a final text turn, `agent_end`, and `agent_settled`.

Phase 0 status: **PASS**. Both harnesses completed the tool gate; OpenCode Server Question/Permission/Abort and Pi RPC interaction/Abort probes are reproducible through the scripts in `scripts/`.

## Pi interaction and abort probes

Pi RPC Extension UI was exercised with the installed `rpc-demo.ts` extension:

1. `new_session` caused `extension_ui_request(method=confirm)` with a unique interaction ID.
2. The client returned `extension_ui_response` with the same ID and `confirmed=true`.
3. The suspended command resumed and returned `success=true`, `cancelled=false`.

This proves a lightweight Pi Bridge can map `select/input/editor` to Gateway Question and `confirm/select` to Gateway Permission while keeping the Gateway Kernel unchanged.

A real streaming model request was then aborted through the RPC `abort` command. Pi preserved partial content, ended the assistant message with `stopReason=aborted`, emitted `turn_end`, `agent_end`, then `agent_settled`, and finally acknowledged the abort command with `success=true`. The Adapter must treat the accepted abort as authoritative even though settlement events follow it.

## OpenCode Server probes

The automated server probe captured 141 relevant SSE events and verified:

- Question request, `string[][]` reply, continuation, and final idle;
- Permission request containing the exact PowerShell command pattern, `once` approval, tool execution, and continuation;
- Abort while busy, acknowledged with `true`, without a false completed message;
- active-server force termination releases the listening port.

## Pi process baseline

Four Pi RPC processes were started concurrently on Windows ARM64:

- launch loop: 157ms;
- alive after startup: 4/4;
- combined working set: approximately 270.3MiB;
- remaining after process-tree cleanup: 0.

This supports one Pi process per Gateway Session for v1, bounded by the configured maximum Session count.

## Configuration

- `opencode/opencode.json` uses an OpenAI-compatible custom provider and references `{env:DEEPSEEK_API_KEY}`.
- `pi/models.json` uses an OpenAI-compatible custom provider and references `$DEEPSEEK_API_KEY`.
- OpenCode must be launched with `OPENCODE_CONFIG` pointing at the checked-in Phase 0 config when its working directory is the repository root.
- Pi must be launched with `PI_CODING_AGENT_DIR` pointing at the checked-in Phase 0 Pi directory.

The fixtures contain raw harness events and no credentials.
