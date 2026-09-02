# Phase 4 交付记录

更新时间：2026-09-02

## 已落地

- `INSTRUCTION.md`：Windows 安装、启动、引擎切换、评测调用顺序、交互回复、停止清理和打包说明。
- `npm run package:solution`：按源码顶层白名单生成并校验 `solution/INSTRUCTION.md` + `solution/code/` 目录结构；排除构建产物、本地文件，并对常见凭据文件名和密钥扩展名做硬拦截。
- `npm run phase4:score`：读取 `docs/phase4-score-matrix.json`，按“每个用例取各引擎最高分”输出矩阵和当前总分。
- `scripts/phase4/office-011-e2e.ps1`：在已启动网关的评测机执行一次隔离的 `office_011` Gateway 回归；拒绝复用已有目标文件，并检查 SSE 生命周期、源文件哈希、可打开的 docx 结构、Assistant/工具消息和最终 Session 状态。
- 故障注入回归：引擎不可用、异常退出、超时、非法规范事件、OpenCode SSE 断流、Pi RPC 非法 JSON/进程退出，以及失败 Session 与健康 Session 隔离。
- 比赛模型通过 `MODEL_PROVIDER_ID` / `MODEL_ID` 显式配置为 `glm` / `glm-5.2`；默认开发配置保持 `fake-provider` / `fake-model`，真实密钥仍只从 `MODEL_API_KEY` 读取。

## 当前验证结果

```text
npm run check       PASS
npm test            PASS (32 tests)
npm run build       PASS
npm run phase4:score PASS (office_011 pending)
npm run package:solution PASS
```

## 待外部资源完成

`office_011` 的真实 GLM-5.2 Prompt/工具/Permission/Abort E2E，以及最终 docx 内容评分，需要比赛模型地址、凭据和 `D:\test_data` 输入文件。得到这些资源后，应对 OpenCode、Pi 分别使用独立输入副本执行，并把每个引擎的 Judge 分数写入 `docs/phase4-score-matrix.json` 后重新运行 `npm run phase4:score`。

真实 Windows x64 全新主机演练仍需在对应主机执行；当前仓库已提供锁定版本、非交互安装命令和进程清理步骤。
