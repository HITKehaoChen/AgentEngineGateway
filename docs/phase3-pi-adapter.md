# Phase 3：Pi Adapter

状态：**实现整改完成，待真实模型 E2E 与复审**（2026-09-02）。本阶段不先标记为 Complete / PASS。

## 交付内容

- `PiAdapter`：每个 Gateway Session 启动一个 `pi --mode rpc` 子进程，并以 Session `directory` 作为工作目录；
- 启动时执行 `pi --version`，校验默认基线 `0.84.4`；
- JSONL stdout 按行解析，支持 `\n` 与尾部 `\r`；stderr 仅作为诊断流；
- 带 ID 的 RPC command/response 关联、控制请求超时、非法 JSONL 与异常退出翻译；
- `agent_start`、文本增量、工具调用、Step、`agent_settled` 到规范 `EngineEvent` 的归一化；`agent_end` 不作为完成信号；
- Pi Extension UI Bridge：生产 Bridge 通过显式 `--extension` 加载；Question 使用 `select`/`input`/`editor`，Permission 使用 `Once`/`Always`/`Reject`，并通过结构化标题保留 `patterns`；`Always` 授权按 Pi Session 缓存，后续相同 permission/pattern 直接放行；回复通过 `extension_ui_response` 返回；
- Abort 发起时立即把当前 mapping 标记为 aborted，即使 `agent_settled` 先于 Abort response 到达也不会误报 completed；随后隔离迟到事件；
- Windows 下优先以 `process.execPath` 直接执行锁定依赖中的 Pi CLI JS，避免 `.cmd` 经 shell 解释；Session 删除和 Gateway 停止时使用 `taskkill /T /F` 清理进程树；
- `PI_COMMAND`、`PI_VERSION`、`PI_CONTROL_TIMEOUT_MS` 和 `GATEWAY_ABORT_GRACE_MS` 配置入口。

## 验证

```powershell
npm run check
npm test
npm run build
```

当前全量测试共 31 项，其中 11 项覆盖 Pi：生产 Bridge 工具注册、Permission `patterns`/三态选择/Session 级永久授权缓存、真实 Bridge 路径加载、RPC 分块/CRLF、Question/Permission 回复、Prompt 超时、非法 JSONL、异常退出、Abort 幂等及 `agent_settled` 先到的迟到 settlement 隔离、无 shell 启动、`.cmd/.bat` 配置拒绝、子进程删除，以及 Phase 0 Fixture 映射。

本机真实 RPC 烟测已验证 Pi `0.84.4` 在 Windows 下完成 `new_session`、中文工作目录传递和 Session 删除；进程树清理由同一 Supervisor 路径负责。真实 GLM-5.2 Prompt、工具、Question/Permission 和 Abort E2E 需在具备比赛模型凭据的环境执行。

额外的 4 Session 并发启动/删除 Soak 烟测通过，4 个进程均完成 RPC 建会话并由 `stop()` 清理。该烟测与自动化测试均不能替代带真实 GLM-5.2 凭据的完整任务回归。

## 启动

```powershell
$env:AGENT_ENGINE = "pi"
$env:PI_COMMAND = "pi"
$env:PI_VERSION = "0.84.4"
$env:MODEL_PROVIDER_ID = "<glm-provider>"
$env:MODEL_ID = "<glm-5.2-model>"
$env:MODEL_BASE_URL = "https://<glm-endpoint>/v1"
$env:MODEL_API_KEY = "<secret>"
npm start
```

Windows 下默认的 `PI_COMMAND=pi` 直接执行项目锁定依赖中的 CLI JS，不依赖 PowerShell 的 `pi.ps1` 或 npm 的 `pi.cmd` shim。自定义 `PI_COMMAND` 只接受原生可执行文件（如 `.exe`）或 JavaScript 文件（如 `.js`）；`.cmd/.bat` 会明确拒绝。Pi 的 provider/model 通过 RPC 子进程启动参数传入；`MODEL_API_KEY` 继续只存在于子进程环境中，不写入仓库文件或日志。

## 已知边界

- Pi 的自定义 Provider 对 `MODEL_BASE_URL` 的具体环境变量命名由比赛模型资源配置决定；适配器会提供 `PI_MODEL_BASE_URL`，若资源要求其他变量，应在评测环境中映射该变量；
- 真实模型凭据、Office 产物验收、最大 Session Soak 和全新 Windows 主机演练归入 Phase 4；
- Pi 交互 Bridge 只负责协议映射，不实现 Office 或其他业务逻辑。
