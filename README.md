# Agent Engine Gateway

面向 Windows 的多 Agent 引擎可替换网关。项目通过统一 HTTP/SSE 接口屏蔽不同 Harness 的协议差异，目前接入 OpenCode 与 Pi，并提供 Session、Prompt、消息投影、Question、Permission、Abort 和事件流能力。

## 当前状态

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| Phase 1 | Gateway Kernel、Fake Adapter、北向接口与契约测试 | Complete / PASS |
| Phase 2 | OpenCode `1.18.26` Adapter | Complete / PASS（协议、Fixture 与 Windows 启动基线） |
| Phase 3 | Pi `0.84.4` Adapter | 实现与整改完成；待真实 GLM-5.2 E2E 复审 |
| Phase 4 | Windows 交付、故障注入、`office_011` 驱动、评分与打包 | 已实现；真实双引擎评分待外部模型环境 |

当前自动化测试共 32 项。尚未完成的真实模型验收不会在文档中标记为 PASS，详见 [`docs/phase3-pi-adapter.md`](docs/phase3-pi-adapter.md) 和 [`docs/phase4-delivery.md`](docs/phase4-delivery.md)。

## 运行环境

- Windows 10/11
- Node.js `24.19.0`
- npm `11.17.0`
- 模型：GLM-5.2（真实运行需要内网提供服务地址和凭据）

## 快速开始

```powershell
npm ci
npm run check
npm test
npm run build
```

配置模型和默认工作目录：

```powershell
$env:MODEL_PROVIDER_ID = "glm"
$env:MODEL_ID = "glm-5.2"
$env:MODEL_BASE_URL = "<内网模型服务地址>"
$env:MODEL_API_KEY = "<运行时密钥>"
$env:GATEWAY_DEFAULT_DIRECTORY = "D:\test_data\opencode"
```

启动 OpenCode：

```powershell
$env:AGENT_ENGINE = "opencode"
npm start
```

启动 Pi：

```powershell
$env:AGENT_ENGINE = "pi"
npm start
```

默认监听 `http://127.0.0.1:6217`。也可以使用 `npm start -- --engine opencode` 或 `npm start -- --engine pi`，命令行参数优先于环境变量。

## 核心接口

- `POST /session?directory=<绝对路径>`：创建 Session
- `POST /session/{id}/prompt_async`：提交 Prompt，并等待本轮稳定结束
- `GET /session/{id}/message`：查询投影后的消息与工具结果
- `GET /session/status`：查询 Session 状态
- `GET /event`：订阅 SSE 事件
- `GET /question`、`POST /question/{id}/reply`：处理 Question
- `GET /permission`、`POST /permission/{id}/reply`：处理 Permission
- `POST /session/{id}/abort`：中止当前 Run
- `DELETE /session/{id}`：删除 Session 并清理引擎资源

完整调用顺序和 `office_011` 回归命令见 [`INSTRUCTION.md`](INSTRUCTION.md)。接口字段定义见 [`docs/Agent网关接口规范.md`](docs/Agent网关接口规范.md)。

## 项目结构

```text
src/api/             HTTP 与 SSE 接口
src/gateway/         Session、Run、Interaction 和消息投影
src/harness/opencode OpenCode Adapter
src/harness/pi/      Pi RPC Adapter 与交互 Bridge
tests/               契约、Adapter 和故障回归测试
scripts/phase4/      office_011、评分与交付打包脚本
docs/                需求、SPEC 和各阶段交付记录
```

## 交付打包

```powershell
npm run phase4:score
npm run package:solution
```

打包结果为仓库根目录的 `solution.zip`，内部包含 `solution/INSTRUCTION.md` 和 `solution/code/`。打包脚本使用源码白名单，并拒绝 `.env`、`.npmrc`、私钥和证书等敏感文件。

## 安全说明

- `MODEL_API_KEY` 仅通过进程环境变量传递，不应写入仓库、请求消息或日志。
- 不要提交真实模型凭据、内部服务地址、测试数据或生成的 Office 文档。
- 每个引擎执行真实用例时应使用独立的测试目录副本，避免输出互相污染。
- 将项目导入内网后，请按内网密钥管理、依赖镜像和审计要求调整部署方式。

## 进一步阅读

- [`INSTRUCTION.md`](INSTRUCTION.md)：评测与运行说明
- [`docs/多Agent引擎可替换网关-SPEC.md`](docs/多Agent引擎可替换网关-SPEC.md)：架构设计与决策记录
- [`docs/phase2-opencode-adapter.md`](docs/phase2-opencode-adapter.md)：OpenCode Adapter 状态
- [`docs/phase3-pi-adapter.md`](docs/phase3-pi-adapter.md)：Pi Adapter 状态
- [`docs/phase4-delivery.md`](docs/phase4-delivery.md)：Phase 4 交付和待办
