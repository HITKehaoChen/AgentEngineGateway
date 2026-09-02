# 多 Agent 引擎可替换网关 SPEC

> 文档类型：Software Design and Development Specification（SDD Spec）  
> 状态：Draft v0.2
> 目标分支：`person_chenkehao`  
> 适用阶段：初赛实现、联调、Windows 验证与交付验收

## 1. 文档目的

本文定义一个面向白领 Agent 产品的可替换 Harness 网关。它既是实现约束，也是测试和验收依据。

本文使用以下规范词：

- **MUST**：不满足即视为实现不符合本 SPEC；
- **SHOULD**：原则上需要满足，偏离时必须记录原因；
- **MAY**：可选能力，不影响初赛基础验收。

赛题规定的北向 HTTP/SSE 协议以 [Agent 网关接口规范](./Agent网关接口规范.md) 为最高优先级。本文负责定义该协议下方的系统边界、内部模型、Harness 契约、运行机制和验证方式，不重复替代原始接口规范。

## 2. 问题与目标

### 2.1 产品背景

目标产品形态是类似企业白领 Agent 的应用：上层产品持续演进用户入口、身份权限、业务会话、助手、Skill 和企业知识；下层 Harness 持续演进规划、推理、工具调用、上下文管理和失败恢复能力。

两者之间需要一个稳定边界，使上层产品不因 OpenCode、Pi 或未来 Harness 的替换而重写会话、事件、权限和交互协议。

### 2.2 一句话目标

> 在 Windows 评测环境中，以统一的 Agent 执行生命周期承载至少两种真实 Harness，使评测程序能够通过完全一致的网关接口驱动任务，并通过引擎能力互补提高每个用例的最高得分。

### 2.3 成功标准

系统成功必须同时满足：

1. 裁判能够按规范启动网关并完成全部基础接口调用；
2. OpenCode 与 Pi 均可通过启动配置被选中并独立完成评测；
3. 上层协议、Gateway Session ID 和错误格式不泄漏引擎私有结构；
4. 文本、工具、反问、权限、中止和完成状态可被统一观察；
5. Windows 路径、中文文件名、长时任务和子进程退出得到可靠处理；
6. 同一套黑盒契约测试可用于所有 Adapter；
7. 最终提交满足 `solution.zip/INSTRUCTION.md/code` 交付要求。

## 3. 范围

### 3.1 本期范围

- 赛题规定的全部 HTTP API；
- 全局 SSE 事件流和 15 秒心跳；
- Gateway Session 管理；
- 单 Session 单活跃 Run；
- 消息和工具执行过程的统一投影；
- Question 与 Permission 的查询和回复；
- Abort/Stop；
- OpenCode Adapter；
- Pi Adapter；
- 启动时引擎选择；
- GLM-5.2 模型配置；
- 进程健康检查、错误翻译和资源清理；
- Windows CI、黑盒契约测试和真实 Windows E2E；
- 比赛用例回归和多引擎成绩对比。

### 3.2 明确不在本期范围

- 请求级智能引擎路由；
- 同一 Gateway 进程同时服务多个引擎；
- 跨引擎 Session 迁移或上下文同步；
- 数据库和分布式持久化；
- 多 Agent 编排；
- 前端、SSO、IAM、组织和租户中心；
- Skill/Plugin 市场；
- 通用 Office、浏览器或桌面自动化工具的重新实现；
- 为未知 Harness 预先设计全部能力；
- 分布式部署和消息队列。

### 3.3 Harness 责任边界

Gateway MUST NOT 理解或执行具体业务任务。例如“润色 docx 并另存”为 Harness 和其运行环境的责任。Gateway 只负责：

- 忠实传递 Prompt、模型配置和工作目录；
- 管理执行生命周期；
- 转换和广播事件；
- 处理人机交互；
- 在 Harness 完成、失败或中止时形成规范结果。

## 4. 事实、决定与待验证项

### 4.1 已确认事实

- 必须支持 Windows；
- 必须接入至少两个不同 Harness；
- 引擎在启动时选择，不要求运行时动态切换；
- 每个引擎分别执行评测；
- 每个用例取各引擎得分最高值；
- 模型要求为 GLM-5.2；
- 会话可仅保存在内存；
- 跨引擎会话同步和多 Agent 机制可不实现；
- 北向协议包含 Session、Message、SSE、Question、Permission 和 Abort；
- 提供的 Office 用例包含 Windows 绝对路径、中文文件名和产物写入。

### 4.2 当前设计决定

| ID | 决定 |
| --- | --- |
| D-001 | Gateway 采用 TypeScript/Node.js `24.19.0` 实现；交付包必须安装或携带兼容该版本的运行时。 |
| D-002 | 进程启动时只实例化一个 Adapter；Session 创建后引擎不可变。 |
| D-003 | Gateway 拥有规范 Session、Run、Message、Interaction 和 Event 投影；引擎私有对象仅存在于 Adapter。 |
| D-004 | 按赛题文字与时序图，`prompt_async` 默认阻塞到本轮稳定结束；内部执行仍为异步事件驱动。 |
| D-005 | Session 对外仅暴露 `idle/busy`；Run 内部使用更细状态。 |
| D-006 | OpenCode 通过无头 HTTP Server/SDK 接入。 |
| D-007 | Pi 首选通过 RPC JSONL 接入；“每 Gateway Session 一个 Pi 进程”作为首个验证方案，而非不可变约束。 |
| D-008 | Gateway 维护规范消息投影，不直接把引擎原始消息作为北向响应。 |
| D-009 | 第一版使用内存状态；不建设 Repository/数据库抽象。 |
| D-010 | 引擎版本必须锁定，启动时必须记录并校验版本。 |
| D-011 | 工具链基线锁定为 Node.js `24.19.0`、npm `11.17.0`、OpenCode `1.18.26`、Pi `0.84.4`；当前已在 Windows ARM64 验证安装，交付时按评测主机架构安装对应官方构建。升级任一组件必须重新执行 Adapter 黄金事件测试和 Windows E2E。 |
| D-012 | `prompt_async` 按权威接口规范阻塞到本轮终态；客户端断开不隐式 Abort。U-001 关闭。 |

### 4.3 待验证项

| ID | 待验证问题 | 区分证据 |
| --- | --- | --- |
| U-003 | Pi RPC 是否能完整承载权限与反问语义？ | 最小 Bridge/Extension Spike。 |
| U-004 | Pi 每 Session 一进程在 Windows 下的启动成本和稳定性是否可接受？ | 并发与连续会话测试。 |
| U-005 | Office 类任务按最终文件验收，还是要求真实桌面轨迹？ | 赛题组评分说明和 Rollout 采集方式。 |

任一待验证项被事实推翻时，优先调整 Controller 或 Adapter，不改变 Gateway Kernel 的规范模型。

## 5. 系统上下文

```text
┌───────────────────────────────────────────┐
│ 评测程序 / 未来白领 Agent 产品              │
└────────────────────┬──────────────────────┘
                     │ 固定 HTTP + SSE
┌────────────────────▼──────────────────────┐
│ Competition API                           │
│ 参数校验、HTTP 生命周期、错误映射、SSE       │
└────────────────────┬──────────────────────┘
                     │ Application Commands
┌────────────────────▼──────────────────────┐
│ Agent Gateway Kernel                      │
│ Session / Run / Message / Interaction     │
│ Event Projection / Engine Supervision     │
└────────────────────┬──────────────────────┘
                     │ Harness Port
          ┌──────────┴──────────┐
          ▼                     ▼
┌──────────────────┐  ┌────────────────────┐
│ OpenCode Adapter │  │ Pi Adapter         │
│ HTTP + SSE       │  │ RPC JSONL          │
└─────────┬────────┘  └──────────┬─────────┘
          ▼                      ▼
      OpenCode                  Pi
          └──────────┬───────────┘
                     ▼
            GLM-5.2 + Windows 工具环境
```

## 6. 核心领域模型

### 6.1 Gateway Session

```typescript
type SessionStatus = "idle" | "busy";

interface GatewaySession {
  id: string;
  title: string;
  createdAt: string;
  status: SessionStatus;
  directory?: string;
  engine: string;
  engineSession: EngineSessionRef;
  activeRunId?: string;
  messages: GatewayMessage[];
  pendingInteractionIds: string[];
}
```

约束：

- `id` MUST 由 Gateway 生成并保持稳定；
- `engineSession` MUST NOT 出现在北向响应或日志的默认字段中；
- 同一 Session 最多一个 `activeRunId`；
- `busy` MUST 表示存在尚未结束的 Run，包括等待 Question/Permission；
- 删除 Session MUST 终止活跃 Run、清理交互并释放引擎资源。

### 6.2 Run

```typescript
interface GatewayError {
  code: string;
  message: string;
}

type RunState =
  | "accepted"
  | "running"
  | "waiting_question"
  | "waiting_permission"
  | "completed"
  | "failed"
  | "aborted";

interface GatewayRun {
  id: string;
  sessionId: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  error?: GatewayError;
}
```

Run 是一次 Prompt 引发的完整任务，不等同于一次 LLM Step 或一次工具调用。

### 6.3 Message

```typescript
interface GatewayToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

type GatewayMessagePart =
  | { type: "text"; content: string }
  | { type: "tool"; callId: string; tool: string; state: { status: "running" | "completed"; title?: string } }
  | { type: "step-finish" };

interface GatewayMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  toolCalls?: GatewayToolCall[];
  toolCallId?: string;
  toolName?: string;
  info?: {
    role: "assistant";
    finish: "stop" | "tool-calls";
  };
  parts?: GatewayMessagePart[];
}
```

规则：

- 接受 Prompt 后 MUST 立即写入 User Message；
- Assistant Message 可在首个文本或工具事件到达时创建；
- 增量文本 MUST 由 Message Projector 组装为稳定的消息快照；
- 北向 `message.part.updated` 的文本 `content` MUST 输出当前累计快照，不得直接泄漏仅由部分引擎使用的 delta 语义；
- 中间工具 Step 的 `finish` 可为 `tool-calls`；
- 只有 Run 稳定完成后，最终 Assistant Message 才能标记 `finish=stop`；
- 失败和中止通过 Run 状态及错误/状态事件表达，不得向北向消息写入规范外的 `finish` 值；
- `step-finish` 单独出现 MUST NOT 触发 Run 完成。

### 6.4 Interaction

```typescript
interface GatewayInteraction {
  id: string;
  sessionId: string;
  runId: string;
  kind: "question" | "permission";
  engineRef: EngineInteractionRef;
  state: "pending" | "answered" | "rejected" | "expired";
  payload: unknown;
  createdAt: string;
}
```

规则：

- Gateway Interaction ID 与引擎请求 ID MUST 解耦；
- 回复操作 MUST 具备幂等保护；
- 不存在或已结束的 Interaction MUST 返回 `404 NOT_FOUND` 或明确的冲突错误；
- 等待 Interaction 时 Session MUST 保持 `busy`；
- Abort MUST 使所有 Pending Interaction 结束。

## 7. 状态机

### 7.1 Run 状态机

```text
accepted
   │
   ▼
running ───────────────┬───────────────┬───────────────┐
   │                   │               │               │
   ▼                   ▼               ▼               ▼
waiting_question  waiting_permission completed       failed
   │                   │
   └──── reply ────────┴──── reply ──────→ running

accepted/running/waiting_* ── abort ──→ aborted
```

### 7.2 外部状态投影

| Run 状态 | Session 状态 | 必须发送的关键事件 |
| --- | --- | --- |
| accepted | busy | `session.status(busy)` |
| running | busy | 文本/工具事件 |
| waiting_question | busy | `question.asked` |
| waiting_permission | busy | `permission.asked` |
| completed | idle | `session.status(idle)` 和/或 `session.idle` |
| failed | idle | `session.error`，随后状态恢复 |
| aborted | idle | 状态恢复；不得再接收旧 Run 事件 |

### 7.3 非法转换

- `busy` Session 再次提交 Prompt：返回 `409 SESSION_BUSY`；
- 已结束 Run 再次结束：忽略重复底层事件并记录调试日志；
- 已 Abort Run 的迟到事件：不得更新消息完成状态；
- Idle Session 执行 Abort：返回 `{ "ok": true }`，保持幂等。

### 7.4 终态裁决与 HTTP 结果

- 每个 Run 只能从非终态原子地进入一次 `completed`、`failed` 或 `aborted`；第一个成功提交的终态获胜；
- `step.finished(stop)` 只更新消息投影，不单独结束 Run；只有 `run.settled` 可把 Run 置为 `completed`；
- `run.failed` 和 `run.aborted` 分别把 Run 置为 `failed` 和 `aborted`；
- Adapter `run()` Promise 必须在规范终态事件提交后才 resolve/reject；若 Promise 提前 resolve 且未发终态事件，Coordinator MUST 转换为 `INTERNAL_ERROR`；
- 终态后的所有引擎事件视为迟到事件，MUST 忽略且不得修改消息、Interaction 或 Session 状态；
- 任一终态处理路径都 MUST 在 `finally` 中释放 `activeRunId` 并使未删除 Session 恢复 `idle`；
- `prompt_async` 的 HTTP 结果如下：

| Run 结果 | HTTP | Code/Body |
| --- | ---: | --- |
| completed | 204 | 无响应体 |
| failed：请求或事件校验失败 | 400 | `VALIDATION_ERROR` |
| failed：引擎调用失败 | 502 | `BAD_GATEWAY` |
| failed：引擎未启动、退出或不可用 | 503 | `SERVICE_UNAVAILABLE` |
| failed：Run 超时 | 504 | `RUN_TIMEOUT` |
| failed：Gateway 内部错误 | 500 | `INTERNAL_ERROR` |
| aborted | 204 | 无响应体；Abort 的调用方通过 Abort API 的 `{ "ok": true }` 获得确认 |

HTTP 客户端断开 MUST NOT 改变上述状态机；Coordinator 继续持有 Run，直到终态、显式 Abort、超时或 Gateway 退出。

## 8. 内部组件

### 8.1 Competition API

职责：

- 实现赛题 HTTP/SSE 接口；
- 请求体和路径参数校验；
- 把协议 DTO 转为 Application Command；
- 把领域错误转为规范 HTTP 错误；
- `prompt_async` HTTP 生命周期管理；
- 不包含引擎分支判断。

### 8.2 Session Registry

- 内存保存所有 Gateway Session；
- 负责 Session ID 唯一性；
- 提供原子状态修改；
- 按 ID 查询和删除；
- 不提供数据库接口。

### 8.3 Run Coordinator

- 对 Session 加单 Run 互斥；
- 创建 `AbortController`；
- 调用 Harness Adapter；
- 接收规范 Engine Event；
- 驱动 Run 状态机；
- 管理完成 Promise，供 `prompt_async` Controller 等待；
- 处理超时、失败、Abort 和迟到事件。

### 8.4 Message Projector

- 把规范 Engine Event 投影为消息历史；
- 组装文本增量；
- 关联 Tool Call 与 Tool Result；
- 产生 `message.part.updated`；
- 只在稳定完成时形成最终 `finish=stop`。

投影算法：

- 每个 Run 创建一个 User Message；首次收到 `text.delta`、`tool.started` 或 `step.finished` 时创建本 Run 的 Assistant Message；
- `messageRef` 映射为稳定 Gateway Message ID；同一 `messageRef` 的 delta 必须追加到同一文本 Part；缺失 `messageRef` 时使用当前 Run 的默认 Assistant Message；
- `callRef` 映射为稳定 Gateway Tool Call ID；不同 `callRef` 即使工具名相同也必须分离；
- `tool.started` 创建 Tool Part 和 `toolCalls` 条目；`tool.updated` 只更新对应 Part 的快照；`tool.completed` 更新 Part 并创建或更新唯一的 `role=tool` 结果消息；
- 若 `tool.updated/tool.completed` 先于 `tool.started` 到达，Projector MUST 为该 `callRef` 合成初始 Tool Part，再应用事件；
- 相同 `callRef`、事件类型和规范化内容的重复事件必须幂等；已完成 Tool Call 的冲突更新应忽略并记录警告；
- `message.part.updated` 的 text `content` 和 tool `state` 均输出当前累计快照，不输出引擎私有 delta；
- `step.finished(tool-calls)` 将 Assistant Message 的 `info.finish` 置为 `tool-calls` 并添加一次 `step-finish` Part，但 Run 保持活跃；
- `run.settled` 时，最终 Assistant Message MUST 含 `step-finish` 且 `info.finish=stop`；若引擎未提供最终 `step.finished(stop)`，Projector 在结算时合成该规范结束标记；
- `failed` 或 `aborted` 保留已经投影的部分文本和工具状态，但不得设置 `finish=stop`，也不得向北向 Tool Part 引入规范外状态；失败和中止只通过 Run、Session 事件与 HTTP 结果表达；
- 投影顺序以 Coordinator 接收规范事件的单调序号为准，而非引擎时间戳；Message 数组按首次创建序号稳定排序。

### 8.5 Interaction Broker

- 创建 Gateway Interaction ID；
- 保存 Engine Interaction 引用；
- 为 `/question` 和 `/permission` 提供查询；
- 将回复送回正确 Adapter/Session/Run；
- 在 Run 结束时清理 Pending Interaction。

### 8.6 Event Hub

- 支持多个 SSE Subscriber；
- 连接后立即发送 `server.connected`；
- 每 15 秒发送 `server.heartbeat`；
- 按赛题格式输出 `data: <json>\n\n`；
- 单个 Subscriber 断开 MUST NOT 影响 Run；
- 慢 Subscriber MUST NOT 阻塞 Harness 事件消费；
- v1 不要求事件重放，断线恢复通过状态和消息查询完成。

### 8.7 Engine Supervisor

- 启动、连接、健康检查和停止 Harness；
- 记录引擎名称与版本；
- 负责子进程 stdout/stderr 捕获和脱敏；
- Gateway 退出时清理子进程；
- 引擎异常退出时，使受影响 Run 进入 `failed` 并发送 `session.error`。

## 9. Harness Port

### 9.1 Adapter 接口

```typescript
interface EngineConfig {
  command: string;
  version: string;
  model: ResolvedModel;
  startupTimeoutMs: number;
  healthTimeoutMs: number;
}

interface EngineHealth {
  ok: boolean;
  version: string;
  message?: string;
}

interface EngineSessionRef {
  readonly opaqueId: string;
}

interface EngineInteractionRef {
  readonly opaqueId: string;
}

interface SessionContext {
  gatewaySessionId: string;
  title: string;
  directory: string;
}

interface RunInput {
  gatewayRunId: string;
  text: string;
  model: ResolvedModel;
}

interface Question {
  question: string;
  options: Array<{ label: string; description?: string }>;
}

type PermissionDecision =
  | { reply: "once" | "always"; message?: string }
  | { reply: "reject"; message?: string };

interface EngineError {
  code: "INVALID_REQUEST" | "UNAVAILABLE" | "UPSTREAM_ERROR" | "TIMEOUT" | "INTERNAL";
  message: string;
  retryable: boolean;
  cause?: unknown;
}

type RunResult =
  | { state: "completed" }
  | { state: "failed"; error: EngineError }
  | { state: "aborted" };

type EngineEventSink = (event: EngineEvent) => void | Promise<void>;

interface HarnessAdapter {
  readonly name: string;

  start(config: EngineConfig): Promise<void>;
  health(): Promise<EngineHealth>;

  createSession(context: SessionContext): Promise<EngineSessionRef>;

  run(
    session: EngineSessionRef,
    input: RunInput,
    sink: EngineEventSink,
    signal: AbortSignal
  ): Promise<RunResult>;

  replyQuestion(
    session: EngineSessionRef,
    interaction: EngineInteractionRef,
    answers: string[][]
  ): Promise<void>;

  replyPermission(
    session: EngineSessionRef,
    interaction: EngineInteractionRef,
    decision: PermissionDecision
  ): Promise<void>;

  abort(session: EngineSessionRef): Promise<void>;
  deleteSession(session: EngineSessionRef): Promise<void>;
  stop(): Promise<void>;
}
```

生命周期约束：

- `start()`、`abort()`、`deleteSession()` 和 `stop()` MUST 幂等；
- `start()` 仅在版本校验和健康检查通过后 resolve；失败后允许再次调用；
- `run()` MUST 串行 await `EngineEventSink`，不得并发投递同一 Run 的事件；Sink reject 时 Run 进入 `failed(INTERNAL)` 并尝试 Abort 引擎；
- `run()` 返回的 `RunResult` 必须与最后一个规范终态事件一致，否则按 `INTERNAL_ERROR` 处理；
- `abort()` 在底层执行已停止或已发出等价取消命令后 resolve；超过 Abort 宽限期由 Supervisor 强制终止相关进程；
- `deleteSession()` 可对不存在或已删除的引擎 Session 调用并成功返回；
- `stop()` 拒绝新 Session/Run，终止现有资源后返回；单个资源清理失败不得跳过其他资源；
- `opaqueId` 和 `cause` 不得进入北向响应、SSE 或普通日志。

### 9.2 规范 Engine Event

```typescript
type EngineEvent =
  | { type: "run.started" }
  | { type: "text.delta"; messageRef: string; delta: string }
  | { type: "tool.started"; callRef: string; name: string; title?: string; args?: unknown }
  | { type: "tool.updated"; callRef: string; title?: string; output?: unknown }
  | { type: "tool.completed"; callRef: string; title?: string; output?: unknown; isError: boolean }
  | { type: "step.finished"; finish: "tool-calls" | "stop" }
  | { type: "question.requested"; interactionRef: EngineInteractionRef; questions: Question[] }
  | { type: "permission.requested"; interactionRef: EngineInteractionRef; permission: string; patterns: string[] }
  | { type: "run.settled" }
  | { type: "run.failed"; error: EngineError }
  | { type: "run.aborted" };
```

### 9.3 Adapter 约束

- MUST 将引擎原始事件转换为规范 Engine Event；
- MUST 只在引擎不会继续自动执行时发出 `run.settled`；
- MUST 支持 Abort 或提供等价的进程终止语义；
- MUST 隔离 SDK/RPC 类型，Gateway Kernel 不得引用引擎类型；
- MUST 将 `directory` 作为真实执行上下文传给 Harness；
- MUST 保留中文 Prompt、中文路径和反斜杠；
- MUST 将引擎异常翻译为 `EngineError`；
- SHOULD 把 Question/Permission 通过原生能力或轻量桥接转换；
- MAY 在引擎缺失非核心能力时进行 Adapter 内模拟，但不得把模拟泄漏到北向协议。

## 10. OpenCode Adapter 设计

### 10.1 接入形态

- 通过 `opencode serve` 或官方 SDK 启动/连接无头 Server；
- 一个 OpenCode Server MAY 承载多个 Gateway Session；
- Gateway Session ID 与 OpenCode Session ID 分离；
- 使用 OpenCode SSE 订阅原始事件并按 Session ID 分流。

### 10.2 事件映射

| OpenCode 语义 | Engine Event |
| --- | --- |
| Session 开始执行/状态 busy | `run.started` |
| 文本 Part 更新 | `text.delta` 或 Adapter 计算后的增量 |
| Tool Part running | `tool.started`/`tool.updated` |
| Tool Part completed | `tool.completed` |
| Step finish | `step.finished` |
| Question | `question.requested` |
| Permission asked | `permission.requested` |
| Session idle | `run.settled` |
| Session error | `run.failed` |

### 10.3 完成规则

OpenCode Adapter MUST 以 Session 稳定 Idle/终止语义完成 Run，不得仅因单个 `step-finish` 完成。

### 10.4 版本隔离

- 当前基线为 `opencode-ai@1.18.26`；已在 Windows ARM64 验证 `opencode serve --hostname 127.0.0.1 --port <port> --pure` 启动且根路径返回 HTTP 200；
- npm 安装 OpenCode 时必须允许其官方 `postinstall`，以选择与主机架构匹配的可执行文件；禁止把仅“包安装成功但二进制无法运行”视为健康；
- 安装版本必须写入 lockfile；
- 启动时读取并记录版本；
- Adapter 测试使用固定原始事件 Fixture；
- 版本升级必须重跑黄金事件转换测试。

## 11. Pi Adapter 设计

### 11.1 首选接入形态

- 当前基线为 `@earendil-works/pi-coding-agent@0.84.4`；已在 Windows ARM64 以 `pi --mode rpc --no-session --offline` 验证 JSONL `get_state` 请求/响应；
- Windows PowerShell 执行策略阻止 npm `.ps1` shim 时，Supervisor MUST 解析并调用 `pi.cmd`/`opencode.cmd`，不得要求修改系统执行策略；
- 通过 `pi --mode rpc` 使用 stdin/stdout JSONL；
- 第一验证方案为每 Gateway Session 一个 Pi RPC 进程；
- 每个进程以 Session `directory` 作为工作目录；
- 如果 Windows 实测显示进程开销不可接受，MAY 改为 Pi SDK 多 Session 管理，但 Harness Port 不变。

### 11.2 JSONL 处理

- 每行一个 JSON 对象；
- 解析器 MUST 支持 `\n` 和输入尾部 `\r`；
- stdout 只作为协议流处理；
- stderr 作为诊断日志处理，不得混入 JSONL；
- Command 必须有相关 ID，以关联 Response；
- 非法 JSON、进程退出和超时必须进入 `run.failed`。

### 11.3 事件映射

| Pi RPC 事件 | Engine Event |
| --- | --- |
| `agent_start` | `run.started` |
| `message_update.text_delta` | `text.delta` |
| `tool_execution_start` | `tool.started` |
| `tool_execution_update` | `tool.updated` |
| `tool_execution_end` | `tool.completed` |
| `turn_end` | `step.finished` |
| `agent_settled` | `run.settled` |
| RPC/进程错误 | `run.failed` |

`agent_end` 不是稳定完成信号，Pi Adapter MUST 等待 `agent_settled` 或经验证的等价事件。

### 11.4 Question/Permission

- 首选使用 Pi 原生 RPC/Extension UI 交互能力；
- 如需 Bridge Extension，该扩展仅负责把 Pi Interaction 转为 Adapter 可识别事件，不得承担业务任务；
- Bridge 不得实现 Office、文件润色等具体业务能力；
- U-003 Spike 未通过时，不得宣称 Pi 已完整支持 Question/Permission。

## 12. 北向接口行为补充

### 12.1 `POST /session`

- 校验 `title`；
- 解析可选 `directory`；
- 调用当前 Adapter 创建引擎 Session；
- 只有引擎 Session 创建成功才注册 Gateway Session；
- 返回 Gateway Session ID；
- 初始状态为 `idle`。

### 12.2 `POST /session/{id}/prompt_async`

处理顺序：

1. 验证 Session 存在且为 `idle`；
2. 校验 `parts` 至少包含一个合法 Text Part；
3. 解析 GLM-5.2 模型配置；
4. 原子设置 Session 为 `busy`；
5. 创建 User Message 和 Run；
6. 广播 `session.status(busy)`；
7. 异步调用 Adapter，并在当前 HTTP 请求中等待 Run Promise；
8. 期间通过 SSE 广播消息、工具和 Interaction；
9. 完成后返回 `204`；
10. 失败时发送 `session.error`，HTTP 返回规范错误；
11. 客户端断开 HTTP 连接 SHOULD NOT 自动中止 Run，显式 Abort 才中止。

### 12.3 `GET /event`

- 连接立即返回 SSE Headers；
- 立即发送 `server.connected`；
- 每 15 秒发送心跳；
- 事件属性使用 Gateway ID；
- 不得输出引擎 Session ID、进程 ID、模型密钥或原始堆栈。

### 12.4 `GET /session/{id}/message`

- 返回 Gateway Message Projector 的规范快照；
- 读取操作不得直接依赖引擎当前可用性；
- Run 执行中 MAY 返回当前已投影的部分结果；
- 数组顺序必须按创建时间稳定。

### 12.5 Abort/Stop

- `/abort` 和 `/stop` 映射到同一 Application Command；
- 先标记 Run 正在 Abort，再调用 Adapter；
- Abort 完成后 Session 回到 `idle`；
- 清理 Pending Interaction；
- 迟到事件不得复活 Run。

## 13. Directory 与 Windows 语义

- 规范入口为 `POST /session?directory=<URL-encoded Windows absolute path>`；为兼容评测客户端，MAY 同时接受请求体 `directory`；查询参数优先于请求体；
- `directory` MUST 保持 Windows 绝对路径语义，不得转换为 POSIX 路径；
- MUST 支持盘符、反斜杠、空格和中文；
- Adapter 创建引擎 Session/进程时 MUST 使用该目录作为工作上下文；
- 若请求未提供 `directory`，使用配置项 `GATEWAY_DEFAULT_DIRECTORY`；
- Session 创建时 MUST 完成 URL 解码、绝对路径、存在性和目录类型校验；不存在、不是目录或不可访问时返回 `400 VALIDATION_ERROR`；Gateway v1 不自动创建目录；
- Session 创建成功后 `directory` 不可修改；
- Gateway MUST NOT 从 Prompt 文本解析路径来代替正式目录配置；
- 绝对路径任务 MAY 由 Harness 直接处理，Gateway 不得改写 Prompt 中的路径；
- 实际 Windows 测试 MUST 覆盖 `D:\test_data\OpenClaw学术洞察报告.docx`。

## 14. 模型策略

```typescript
interface ResolvedModel {
  providerId: string;
  modelId: string;
  baseUrl?: string;
  credentialRef: string;
}
```

`credentialRef` 只引用进程内凭据，不携带密钥明文；该对象不得序列化到北向接口、SSE 或普通日志。

- 比赛部署 MUST 使用 GLM-5.2；
- 模型 Endpoint、Provider ID、Model ID 和密钥通过环境变量配置；
- 北向请求 `model` 字段必须通过 Model Resolver；
- Resolver 输出统一 `ResolvedModel`，Adapter 不直接解释北向 DTO；
- Resolver MUST 支持把评测 Provider/Model Alias 映射到部署配置指定的模型，不把具体供应商语义泄漏到 Kernel；
- 密钥不得写入仓库、SSE、消息历史和普通日志；
- 两个引擎的正式对比 MUST 使用相同模型资源和等价参数。

## 15. 配置

启动优先级：

```text
命令行参数 > 环境变量 > 默认值
```

最低配置集合：

| 参数/环境变量 | 说明 |
| --- | --- |
| `--engine` / `AGENT_ENGINE` | `opencode` 或 `pi` |
| `--host` / `GATEWAY_HOST` | 默认 `localhost` |
| `--port` / `GATEWAY_PORT` | 默认 `6217` |
| `GATEWAY_DEFAULT_DIRECTORY` | 默认工作目录 |
| `GATEWAY_RUN_TIMEOUT_MS` | 单 Run 超时 |
| `MODEL_PROVIDER_ID` | GLM Provider 标识 |
| `MODEL_ID` | GLM-5.2 模型标识 |
| `MODEL_BASE_URL` | 模型服务地址 |
| `MODEL_API_KEY` | 模型鉴权 |
| `OPENCODE_COMMAND` | OpenCode 可执行命令 |
| `PI_COMMAND` | Pi 可执行命令 |
| `LOG_LEVEL` | 日志级别 |

基线版本与默认限制：

| 配置 | 默认值 |
| --- | ---: |
| Node.js | `24.19.0` |
| npm | `11.17.0` |
| OpenCode | `1.18.26` |
| Pi | `0.84.4` |
| `GATEWAY_RUN_TIMEOUT_MS` | `1800000`（30 分钟） |
| `GATEWAY_ABORT_GRACE_MS` | `10000` |
| `GATEWAY_ENGINE_STARTUP_TIMEOUT_MS` | `60000` |
| `GATEWAY_ENGINE_HEALTH_TIMEOUT_MS` | `5000` |
| `GATEWAY_SHUTDOWN_GRACE_MS` | `15000` |
| `GATEWAY_MAX_SESSIONS` | `32` |
| `GATEWAY_SSE_SUBSCRIBER_QUEUE_SIZE` | `1000` |
| `GATEWAY_MAX_REQUEST_BYTES` | `1048576`（1 MiB） |

- 数值配置必须是正整数且在启动时校验，非法值导致启动失败；
- 达到最大 Session 数时，创建 Session 返回 `503 CAPACITY_EXCEEDED`；
- 单订阅者 SSE 队列溢出时只断开该订阅者，不阻塞 Run，也不影响其他订阅者；
- CLI 参数优先于环境变量，环境变量优先于默认值；未知 CLI 参数导致启动失败；
- 正式启动必须校验 Node 与所选引擎版本完全匹配上述基线；开发模式 MAY 允许版本偏差，但必须输出显式警告。

未知引擎值 MUST 启动失败并列出支持值。

## 16. 错误与恢复

### 16.1 领域错误映射

| 场景 | HTTP | Code |
| --- | ---: | --- |
| 请求校验失败 | 400 | `VALIDATION_ERROR` |
| Session/Interaction 不存在 | 404 | `NOT_FOUND` |
| Session 正忙 | 409 | `SESSION_BUSY` |
| Adapter/引擎请求失败 | 502 | `BAD_GATEWAY` |
| 引擎未就绪或不可用 | 503 | `SERVICE_UNAVAILABLE` |
| 达到 Session 容量 | 503 | `CAPACITY_EXCEEDED` |
| Run 超时 | 504 | `RUN_TIMEOUT` |
| 未分类内部异常 | 500 | `INTERNAL_ERROR` |

### 16.2 恢复规则

- Run 超时：尝试 Abort，发送 `session.error`，Session 恢复 `idle`；
- 引擎进程退出：所有关联 Run 失败，清理 Interaction；
- SSE Subscriber 退出：只清理 Subscriber；
- Adapter `stop()` 失败：记录错误并继续网关退出；
- 删除 Busy Session：先 Abort，超时后强制释放引擎资源；
- 任何异常路径都必须最终解除 Session 的 `busy`，除非进程已整体终止。

## 17. 并发与资源管理

- 不同 Session 的 Run SHOULD 并发执行；
- 同一 Session 的 Run MUST 串行；
- Session 锁粒度不得扩大为全局锁；
- SSE 广播不得阻塞 Run Coordinator；
- Pi 每 Session 一进程时，删除 Session MUST 回收对应进程；
- Windows 退出时 MUST 清理子进程树；
- Gateway MUST 处理 `SIGINT`/等价 Windows 终止信号并进行有界优雅退出；
- 超时、最大 Session 数和最大事件队列长度 SHOULD 可配置。

### 17.1 竞态与幂等裁决

- Busy Session 的第二个 Prompt 原子检查失败并返回 `409 SESSION_BUSY`；
- Session 删除开始后立即进入内部 `deleting` 状态并从公开查询结果中移除；后续操作按不存在返回 `404 NOT_FOUND`；
- Busy Session 删除顺序为：标记 deleting、结束 Pending Interaction、请求 Abort、等待宽限期、必要时强杀进程、释放注册表记录；
- Abort 与自然完成竞争时，第一个原子提交的终态获胜；若 Abort 已被 Coordinator 接受，则后续 `run.settled` 视为迟到事件；
- Abort 被多次调用均返回 `{ "ok": true }`；
- Interaction 首次回复原子写入结果并转发 Adapter；相同内容的重复回复返回 `{ "ok": true }`；不同内容的重复回复返回 `409 INTERACTION_RESOLVED`；
- Abort 或删除被接受后，所有 Pending Interaction 转为 `expired`，之后的回复返回 `409 INTERACTION_RESOLVED`；
- Gateway 退出时先停止接受新请求，再在 `GATEWAY_SHUTDOWN_GRACE_MS` 内 Abort 活跃 Run；超时后终止全部子进程树；
- 任何锁只保护单个 Session 的短事务，不得在等待 Adapter、网络、Sink 或子进程时持有。

## 18. 可观测性

### 18.1 日志字段

所有关键日志 SHOULD 包含：

- `gateway_session_id`；
- `run_id`；
- `engine`；
- `event_type`；
- `duration_ms`；
- `error_code`；
- 脱敏后的 `directory`（必要时）。

### 18.2 指标

测试与比赛分析至少统计：

- Session 创建成功率；
- Run 完成/失败/中止数量；
- Run 总耗时；
- 首个事件延迟；
- 工具调用数量；
- Question/Permission 次数；
- 引擎异常退出次数；
- 每个用例的各引擎得分和最高分。

### 18.3 日志边界

不得记录：

- 模型 API Key；
- 完整鉴权 Header；
- 未脱敏的环境变量；
- 与问题诊断无关的用户文档全文。

## 19. 测试策略

### 19.1 Fake Harness 契约测试

首先实现可编程 Fake Adapter，覆盖：

- 文本增量；
- 多个工具 Step；
- Question；
- Permission；
- 完成；
- 失败；
- 超时；
- Abort；
- 迟到事件；
- 引擎进程异常退出模拟。

Fake Adapter 只用于测试，不参与正式评测。

### 19.2 北向 API 黑盒测试

同一测试套件 MUST 验证：

- 创建、查询、删除 Session；
- 状态查询；
- Prompt 执行与 204；
- 消息历史；
- SSE 连接、心跳和全部事件类型；
- Question/Permission 查询和回复；
- Abort/Stop；
- 404、400、409、502、503；
- 多 Session 隔离。

### 19.3 Adapter 黄金事件测试

每个 Adapter 保存固定版本的原始事件 Fixture：

```text
raw-engine-events.jsonl
        ↓ Adapter Mapper
canonical-engine-events.jsonl
        ↓ Message/Event Projector
gateway-events.jsonl
```

升级引擎时必须重新验证该转换链。

### 19.4 Windows E2E

测试必须在真实 Windows Runner/主机验证：

- 安装和启动；
- PowerShell 命令；
- 中文路径；
- 盘符和反斜杠；
- 子进程创建与回收；
- HTTP/SSE；
- 长时 Run；
- OpenCode 与 Pi 分别启动；
- GLM-5.2 真实工具调用。

### 19.5 测试隔离

每个 Harness 执行用例前 MUST 恢复独立、相同的测试数据副本，避免前一个引擎产生的文件影响后一个引擎。

## 20. 黄金 E2E：office_011

### 20.1 输入

```json
{
  "task_id": "office_011",
  "title": "文档润色改写1",
  "description": "润色OpenClaw报告执行摘要为正式汇报风格，保留关键数据，另存为新docx",
  "query": "请打开 D:\\test_data\\OpenClaw学术洞察报告.docx，把“执行摘要”中介绍 OpenClaw 影响力和行业采用情况的两段文字改写成更克制、正式、适合内部研究汇报的表述。不要改动事实信息和章节结构，保留 GitHub Stars、MIT、自托管、主流云厂商采用等关键信息，并另存为同目录下的 OpenClaw学术洞察报告_执行摘要润色版.docx。",
  "category": "文档操作与数据分析类",
  "secondary_category": "文档润色",
  "difficulty": 3,
  "difficulty_label": "中"
}
```

### 20.2 本用例验证的 Gateway 行为

- Prompt 和中文 Windows 路径原样传递；
- Session 在长时执行和工具调用期间保持 `busy`；
- Harness 工具事件正常投影和广播；
- 如发生权限请求，Run 保持存活并可继续；
- Harness 稳定结束后 Session 变为 `idle`；
- 最终消息可查询；
- OpenCode 与 Pi 使用相互隔离的初始测试目录。

### 20.3 不属于 Gateway 的验收

以下结果用于评价 Harness 任务得分，不作为 Gateway 功能实现：

- 是否正确找到执行摘要；
- 是否完成文字润色；
- 是否保留 GitHub Stars、MIT、自托管和云厂商采用信息；
- 是否保持 docx 章节结构；
- 是否正确另存文件；
- 是否通过 Word、脚本、内置工具或其他方式完成。

### 20.4 外部结果检查

E2E 测试工具 MAY 在 Harness 完成后检查：

- 目标文件存在；
- 源文件未被修改；
- 目标 docx 可打开；
- 目标路径和文件名正确；
- 内容语义由比赛 Judge 或独立 Eval 判定。

这些检查属于测试基础设施，不得进入 Gateway 运行逻辑。

## 21. 验收需求

### 21.1 功能需求

| ID | MUST 行为 | 验收方式 |
| --- | --- | --- |
| FR-001 | 支持 `--engine` 和 `AGENT_ENGINE` 选择引擎。 | 启动测试。 |
| FR-002 | 至少支持 OpenCode 和 Pi。 | 两次独立 E2E。 |
| FR-003 | 实现赛题全部 HTTP API。 | 北向契约测试。 |
| FR-004 | 创建并维护稳定 Gateway Session ID。 | Session 与 Adapter 测试。 |
| FR-005 | 同 Session 只允许一个活跃 Run。 | 并发 Prompt 测试。 |
| FR-006 | 完整投影文本、工具、完成和错误事件。 | 黄金事件测试。 |
| FR-007 | 支持 Question 查询和回复。 | Fake + 真实 Adapter 测试。 |
| FR-008 | 支持 Permission 查询和回复。 | Fake + 真实 Adapter 测试。 |
| FR-009 | 支持 Abort/Stop 并恢复 Session。 | 中止测试。 |
| FR-010 | SSE 连接后发送 connected，并每 15 秒心跳。 | SSE 计时测试。 |
| FR-011 | 支持 Windows 中文绝对路径。 | `office_011`。 |
| FR-012 | Gateway 不执行具体 Office 业务逻辑。 | 代码依赖与架构评审。 |
| FR-013 | 比赛运行统一解析为 GLM-5.2。 | 配置与调用日志检查。 |
| FR-014 | 引擎异常退出时形成标准错误并解除 Busy。 | 故障注入。 |
| FR-015 | 删除 Session 时清理 Run、Interaction 和引擎资源。 | 资源清理测试。 |

### 21.2 非功能需求

| ID | 要求 | 验收方式 |
| --- | --- | --- |
| NFR-001 | 可在赛题 Windows 环境非交互安装和启动。 | Windows E2E。 |
| NFR-002 | 引擎和依赖版本可复现。 | Lockfile/版本日志。 |
| NFR-003 | 单 Session 故障不污染其他 Session。 | 多 Session 故障注入。 |
| NFR-004 | SSE 断连不终止 Run。 | 断连重连测试。 |
| NFR-005 | 日志不得泄漏模型密钥。 | 日志扫描。 |
| NFR-006 | Gateway Kernel 不依赖引擎 SDK 类型。 | 依赖检查/代码评审。 |
| NFR-007 | 同一黑盒套件可验证所有 Adapter。 | 参数化测试。 |
| NFR-008 | `INSTRUCTION.md` 可指导裁判完成安装、启动和评测。 | 全新 Windows 环境演练。 |

## 22. 推荐工程结构

```text
solution/
├── INSTRUCTION.md
└── code/
    ├── src/
    │   ├── api/
    │   ├── gateway/
    │   │   ├── session-registry.ts
    │   │   ├── run-coordinator.ts
    │   │   ├── interaction-broker.ts
    │   │   ├── message-projector.ts
    │   │   └── event-hub.ts
    │   ├── harness/
    │   │   ├── harness-adapter.ts
    │   │   ├── engine-event.ts
    │   │   ├── engine-supervisor.ts
    │   │   ├── opencode/
    │   │   └── pi/
    │   ├── model/
    │   ├── config/
    │   └── main.ts
    ├── extensions/
    │   └── pi-gateway-bridge/
    ├── tests/
    │   ├── contract/
    │   ├── adapters/
    │   ├── e2e/
    │   └── fixtures/
    ├── package.json
    └── lockfile
```

目录是推荐边界而非交付格式的额外强制项。实现 MAY 调整文件组织，但不得破坏依赖方向。

## 23. 实施阶段与门禁

### Phase 0：Harness Spike

交付：

- OpenCode + GLM-5.2 最小真实任务；
- Pi + GLM-5.2 最小真实任务；
- 两个引擎的原始事件样本；
- Pi Interaction 可行性结论；
- Windows 进程模型结论。

门禁：至少确认两个 Harness 均能产生真实工具调用，才进入完整 Adapter 实现。

### Phase 1：Gateway Kernel + Fake Adapter

交付：

- 全部北向接口；
- 状态机；
- SSE；
- Message Projector；
- Interaction Broker；
- Fake Adapter 契约测试。

门禁：Fake Adapter 下全部 FR-003～FR-010 通过。

### Phase 2：OpenCode Adapter

交付：

- 真实 Session、Prompt、Event、Abort、Question、Permission；
- Windows/近似环境黑盒基线；
- 引擎版本锁定。

### Phase 3：Pi Adapter

交付：

- RPC 进程管理；
- JSONL 关联；
- 事件归一化；
- Interaction Bridge（如需要）；
- 同一黑盒套件通过。

### Phase 4：Windows 与比赛优化

交付：

- `office_011` 等真实任务回归；
- 多引擎得分矩阵；
- 故障注入；
- `INSTRUCTION.md`；
- `solution.zip` 演练。

## 24. 竞争方案与选择理由

### 方案 A：OpenCode API 透传，Pi 模拟 OpenCode

优点：OpenCode 接入最快。  
缺点：内部仍被 OpenCode 概念绑定，Pi Adapter 复杂，难以证明真正可替换。

### 方案 B：规范生命周期 Kernel + 两个语义 Adapter（采用）

优点：只抽象比赛真实需要的 Session/Run/Event/Interaction；上层稳定；两个 Adapter 差异清晰；可测试。  
缺点：需要实现 Message/Event Projector，首期成本高于纯透传。

### 方案 C：完整通用多引擎平台

优点：远期能力丰富。  
缺点：动态路由、持久化、注册中心和跨引擎同步不会直接提高初赛得分，扩大 Windows 故障面。

选择方案 B。若 Phase 0 证明北向评测只是 OpenCode 原样透传且主观架构不重要，才允许重新评估方案 A；当前不采用方案 C。

## 25. 设计完成判据

本 SPEC 进入 `Accepted` 状态前必须确认：

1. Pi Question/Permission 的实现路线完成真实 RPC/Bridge Spike；
2. 交付包在全新 Windows 环境按 `INSTRUCTION.md` 完成安装、启动和进程清理演练；
3. `office_011` 的评分关注最终产物还是桌面轨迹；在赛题组未确认时按两者兼容实现和测试。

已关闭项：`prompt_async` 返回时机由权威接口规范确认；OpenCode、Pi、Node/npm 固定版本已安装并完成基础烟测；`directory` 已采用查询参数、请求体兼容和默认目录三级解析契约。模型通过既有可替换配置处理，不作为 Kernel 开工门禁。

在这些问题确认前，Gateway Kernel、Fake Adapter 和北向契约测试可以先行；任何依赖未知事实的实现必须保持可替换。
