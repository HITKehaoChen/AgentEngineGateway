# Phase 0 event mapping decisions

## OpenCode 1.18.26

| Observed OpenCode signal | Canonical event | Decision |
| --- | --- | --- |
| `session.status` busy | `run.started` | Emit once per accepted Gateway Run. |
| `message.part.delta` for text | `text.delta` | Use Part/message IDs as opaque correlation refs. |
| Tool Part enters running | `tool.started` | Deduplicate by tool call ID. |
| Tool Part updates | `tool.updated` | Emit only when the normalized snapshot changes. |
| Tool Part completed/error | `tool.completed` | Preserve output and normalized `isError`. |
| `question.asked` | `question.requested` | Store OpenCode request ID only inside Adapter interaction ref. |
| `permission.asked` | `permission.requested` | Preserve permission and patterns exactly. |
| step finish `tool-calls` | `step.finished(tool-calls)` | Never settle the Run. |
| final step finish `stop` | `step.finished(stop)` | Update message only; wait for idle. |
| `session.idle` | `run.settled` | Authoritative normal completion signal. |
| accepted abort | `run.aborted` | Authoritative even if late message/session events arrive. |
| server process exit | `run.failed(UNAVAILABLE)` | Fail every active Run owned by that server. |

OpenCode's own `/prompt_async` returns 204 immediately. The Gateway Coordinator therefore waits for the Adapter's canonical terminal event rather than forwarding OpenCode's HTTP lifetime.

## Pi 0.84.4

| Observed Pi signal | Canonical event | Decision |
| --- | --- | --- |
| `agent_start` | `run.started` | Emit once per prompt. |
| `message_update.text_delta` | `text.delta` | Preserve streamed delta; Projector builds snapshots. |
| `tool_execution_start` | `tool.started` | Use `toolCallId` as opaque correlation ref. |
| `tool_execution_update` | `tool.updated` | Preserve normalized snapshot. |
| `tool_execution_end` | `tool.completed` | Map `isError`. |
| `turn_end` with tool use | `step.finished(tool-calls)` | Run remains active. |
| final `turn_end` with stop | `step.finished(stop)` | Message is final candidate only. |
| `extension_ui_request` dialog | `question.requested` or `permission.requested` | Bridge classifies `input/editor` as Question and permission-gate `confirm/select` as Permission. |
| RPC `abort` accepted | `run.aborted` | Authoritative terminal state. |
| `agent_end` | no terminal event | Preserve message data only. |
| `agent_settled` | `run.settled` only when not aborted/failed | Ignore as completion after accepted Abort. |
| process exit | `run.failed(UNAVAILABLE)` | Fail the owning Session Run. |

## Process supervision

- OpenCode server and Pi RPC processes are launched in process trees owned by the Engine Supervisor.
- Graceful Abort is attempted first.
- After the configured grace period, Windows cleanup uses tree termination semantics equivalent to `taskkill /T /F`.
- Phase 0 verified that the Pi root and child process both disappear, and that a force-terminated OpenCode server releases its listening port.
