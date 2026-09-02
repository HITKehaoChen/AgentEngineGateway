# Phase 2：OpenCode Adapter

状态：**Complete / PASS（协议黑盒、真实 Fixture 回放与 Windows 启动基线）**（2026-09-02）。

## 交付内容

- `OpenCodeAdapter`：以 `opencode serve --pure` 启动并监督一个 OpenCode Server；
- 启动时通过 `opencode --version` 与 `/global/health` 校验 `1.18.26`，健康检查使用独立超时；
- OpenCode Session 与 Gateway Session 使用独立 ID，`directory` 通过查询参数传入真实引擎；
- Prompt、Abort、Delete、Question Reply、Permission Reply 的 HTTP 映射；
- OpenCode SSE 的串行消费、按 Session ID 分流和终态等待；
- `session.status(busy)`、文本 Part、Tool Part、Step Finish、Question、Permission、Idle 和 Error 到规范 `EngineEvent` 的归一化；
- Windows `.cmd` shim 兼容与子进程树清理；
- `MODEL_BASE_URL` 与 `MODEL_API_KEY` 通过运行时生成的临时 `OPENCODE_CONFIG` 接入 OpenCode；已有 `OPENCODE_CONFIG` 时保留用户配置，不落盘写入密钥值；
- 断流时先向上游发送 Abort，并将 Session 隔离到收到 Idle 确认后再允许新 Run；
- Session/Prompt/Abort/Delete/Question Reply/Permission Reply 均使用有界控制请求超时；Abort 超时仍会终结当前 Run、保持 quarantine 并继续 SSE 重连；
- Interaction Reply 仅在上游成功后提交状态，Gateway 监听失败时清理 Adapter 与子进程；
- `opencode-ai@1.18.26` 已写入 `package.json` 与 `package-lock.json`。

## 验证

```powershell
npm install
npm run check
npm test
npm run build
npm start -- --engine opencode
```

当前测试共 20 项：7 项 OpenCode Adapter/映射与故障回归测试，13 项 Phase 1 Gateway 契约测试。真实本机烟测已验证：

- Windows 下从本地 npm 安装的 `opencode.exe` 启动 Server；
- `/global/health` 返回 `1.18.26`；
- Gateway 在 OpenCode Adapter 健康后监听 HTTP 端口；
- Session 创建、状态查询和删除成功。

回归覆盖真实 Phase 0 OpenCode Server Fixture（reasoning 不进入最终文本、pending→running 工具参数保留）、含跨 chunk CRLF 与多行 data 的 SSE 帧、SSE 断流后的上游 Abort/Session 隔离（包括 Abort HTTP 永不返回），以及上游 Reply 失败后的重试语义。

真实模型 Prompt、Question、Permission、Tool 和 Abort 的完整 E2E 仍需在具备比赛模型凭据的环境执行；固定协议映射和 Gateway 行为已由 Mock HTTP/SSE 及 Phase 0 原始 Fixture 约束。

## 配置

```powershell
$env:AGENT_ENGINE = "opencode"
$env:MODEL_PROVIDER_ID = "<glm-provider>"
$env:MODEL_ID = "<glm-5.2-model>"
$env:MODEL_BASE_URL = "https://<glm-endpoint>/v1"
$env:MODEL_API_KEY = "<secret>"
npm start
```

本地子进程启动时 Adapter 会生成临时 `OPENCODE_CONFIG`，把 `MODEL_BASE_URL` 写入 provider 的 `baseURL`，把 `MODEL_API_KEY` 作为环境变量引用传给 OpenCode；密钥本身不会写入配置文件。

可选环境变量：`OPENCODE_COMMAND`、`OPENCODE_HOST`、`OPENCODE_PORT`、`OPENCODE_BASE_URL`、`OPENCODE_VERSION`。设置 `OPENCODE_BASE_URL` 时连接已有 OpenCode Server，不再启动本地子进程；否则 Adapter 会启动锁定版本的本地 Server。

## 已知边界

- Adapter 按 Gateway Session 的 `directory` 建立 OpenCode SSE 订阅，并在断流后自动重连；不同项目目录的长时并行 E2E 仍归入后续稳定性回归；
- Gateway 的显式逐订阅者 SSE 计数队列仍是 Phase 1 记录的后续韧性项；
- Pi Adapter 已在 Phase 3 接入，`AGENT_ENGINE=pi` 会选择 Pi Supervisor；其实现状态与未完成的真实模型 E2E 见 `docs/phase3-pi-adapter.md`。
