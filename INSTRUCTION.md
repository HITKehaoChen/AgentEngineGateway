# Agent Engine Gateway 评测说明

本作品在 Windows 10/11 上运行，Node.js 版本固定为 `24.19.0`，npm 版本固定为 `11.17.0`。网关默认监听 `http://127.0.0.1:6217`，通过 `AGENT_ENGINE` 或 `--engine` 选择 Harness：`opencode` 或 `pi`。

## 1. 环境准备

在 PowerShell 中进入 `code` 目录（即本文件所在目录的 `code` 子目录）：

```powershell
node --version       # v24.19.0
npm --version        # 11.17.0
npm ci
npm run check
npm test
npm run build
```

评测环境必须提供 GLM-5.2 的访问配置。密钥只放在进程环境变量中，不写入文件、请求消息或日志：

```powershell
$env:MODEL_PROVIDER_ID = "glm"
$env:MODEL_ID = "glm-5.2"
$env:MODEL_BASE_URL = "<评测环境提供的模型地址>"
$env:MODEL_API_KEY = "<评测环境提供的密钥>"
```

如评测环境使用不同的 Provider 别名，只需修改 `MODEL_PROVIDER_ID`；模型仍应配置为 `glm-5.2`。

## 2. 启动网关

启动前为每个引擎准备独立的测试目录。目录必须已存在，并使用 Windows 绝对路径：

```powershell
$env:GATEWAY_DEFAULT_DIRECTORY = "D:\test_data\opencode"
$env:AGENT_ENGINE = "opencode" # 或 "pi"
npm start -- --engine $env:AGENT_ENGINE
```

也可以不用环境变量切换引擎：

```powershell
npm start -- --engine pi
```

命令行参数优先于同名环境变量。启动日志只用于确认监听地址；若启动失败，检查对应的 `OPENCODE_COMMAND` 或 `PI_COMMAND` 以及锁定版本（OpenCode `1.18.26`、Pi `0.84.4`）。Pi 使用项目依赖中的 CLI，不要把 `.cmd`/`.bat` shell shim 作为 `PI_COMMAND`。

## 3. 评测调用顺序

裁判按接口规范调用以下流程：

1. `POST /session?directory=<URL 编码的绝对路径>`，请求体至少包含 `{"title":"..."}`；
2. 连接 `GET /event` 接收 SSE；
3. `POST /session/{id}/prompt_async`，请求体传入 `parts: [{"type":"text","text":"..."}]` 和模型别名；该请求会等待本轮 Run 完成；
4. 如 SSE 出现 `question.asked` 或 `permission.asked`，分别查询 `/question`、`/permission`，再调用对应的 `/reply` 接口；
5. 完成后查询 `GET /session/{id}/message`，检查最终消息和工具结果；
6. 结束时调用 `DELETE /session/{id}`。

`prompt_async` 的成功响应是 HTTP `204`。引擎异常、超时和不可用会返回规范化的 5xx 错误；`/session/status` 应在 Run 结束或中止后显示 `idle`。同一 Session 不要并发提交两个 Prompt；另一个 Session 可以并行执行。

## 4. `office_011` 回归

OpenCode 和 Pi 必须分别使用源文件的独立副本执行 `office_011`，避免一个引擎的输出污染另一个引擎。用例要求保留原始 docx，并在同目录生成：

`OpenClaw学术洞察报告_执行摘要润色版.docx`

每次回归前必须确保目标文件不存在；驱动会检查目标文件为可打开的 docx、源文件未修改、工具结果和 SSE 生命周期事件，再由评测 Judge 判断文本内容和事实保留情况。

已启动网关时，也可以用仓库内的驱动完成 Gateway 层回归（参数使用 Windows 绝对路径）：

```powershell
./scripts/phase4/office-011-e2e.ps1 `
  -GatewayUrl http://127.0.0.1:6217 `
  -Directory D:\test_data\opencode `
  -SourceDocument D:\test_data\opencode\OpenClaw学术洞察报告.docx `
  -Engine opencode
```

将 `-Engine` 改为 `pi`，并使用另一份输入目录副本重复执行。驱动会自动回复 Question 和 Permission；如任务策略不同，可通过 `-QuestionAnswer` 和 `-PermissionReply` 覆盖默认值。

## 5. 停止与清理

正常停止网关请在其 PowerShell 窗口按 `Ctrl+C`；网关会先关闭 HTTP 服务，再清理引擎子进程。也可对单个 Session 先调用 `POST /session/{id}/abort`，随后调用 `DELETE /session/{id}`。确认没有残留 `node.exe`、`opencode.exe` 或 Pi CLI 进程后再删除临时测试目录。

## 6. 本地交付前检查

```powershell
npm run check
npm test
npm run build
npm run package:solution
```

最后一条命令生成仓库根目录的 `solution.zip`。压缩包内部结构为 `solution/INSTRUCTION.md` 和 `solution/code/`，不包含 `node_modules`、`dist`、`.git`、模型密钥或本地测试产物。
