# Phase 1：Gateway Kernel + Fake Adapter

状态：**Complete / PASS**（2026-09-02）。

## 交付内容

- Node.js/TypeScript 北向 HTTP API：Session 创建、查询、删除、状态、Prompt、Message、Abort/Stop、Question、Permission 和 SSE；
- Gateway Session、Run 与 Interaction 状态管理；
- Run Coordinator 的单 Session 互斥、超时、Abort、终态裁决和迟到事件隔离；
- Message Projector 的文本累计快照、多工具 Step、Tool Result 和最终完成投影；
- Interaction Broker 的 Question/Permission 查询、转发、幂等回复和过期处理；
- Event Hub 的多订阅者广播、即时 `server.connected` 和 15 秒默认心跳；
- 与 Kernel 类型隔离的可编程 Fake Adapter；
- FR-003～FR-010 黑盒契约测试。

## 验证

```powershell
npm install
npm run check
npm test
npm run build
npm start -- --engine fake
```

当前契约套件共 13 项，覆盖：

| 门禁 | 覆盖内容 |
| --- | --- |
| FR-003 | 全部北向接口、规范错误格式、请求校验、容量限制 |
| FR-004 | 稳定 Gateway Session ID 和 Session 生命周期 |
| FR-005 | 同 Session 单 Run 互斥及多 Session 隔离 |
| FR-006 | 文本、多个工具 Step、Tool Result、完成与失败投影 |
| FR-007 | Question 查询、回复、暂停/恢复和幂等 |
| FR-008 | Permission 查询、回复和暂停/恢复 |
| FR-009 | Abort/Stop 幂等、Busy 释放和迟到事件隔离 |
| FR-010 | SSE Headers、connected 与 heartbeat |

真实 OpenCode 和 Pi Adapter 不属于 Phase 1，分别由 Phase 2 和 Phase 3 承接。

## 完成复核与已知遗漏

2026-09-02 提交前再次按 SPEC 复核。FR-003～FR-010 的 Phase 1 门禁仍为 PASS，并补充了乱序/重复工具事件、Interaction 冲突回复、引擎不可用和非法规范事件测试。Abort/Delete 的 Kernel 清理现在即使 Adapter 清理报错也会执行。

以下事项尚未完成，必须保留在后续工作中：

1. `GATEWAY_SSE_SUBSCRIBER_QUEUE_SIZE` 尚未实现为显式、可配置的逐订阅者计数队列。当前实现依赖 Node HTTP socket 的 backpressure，在 `write()` 返回 `false` 时移除慢订阅者；这满足 Phase 1 的 Run 不被慢订阅者阻塞，但还没有精确的“累计 1000 个事件后断开”语义。
2. “HTTP 客户端断开不终止 Run”由当前控制流保证（Run 没有绑定请求的 `close` 事件），但尚缺专门的断连后继续执行黑盒回归测试。该项属于 NFR-004，不改变 FR-003～FR-010 门禁结论。
3. Fake Adapter 的引擎退出仅通过规范 `UNAVAILABLE` 故障事件模拟；真实子进程退出、强制进程树清理和版本校验需要在 Phase 2/3 的真实 Adapter 与 Supervisor 中验证。

除第 1～2 项测试/韧性增强外，未发现 Phase 1 功能门禁遗漏。上述事项不得在后续阶段被误报为已经完成。
