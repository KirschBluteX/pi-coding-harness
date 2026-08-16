# Implementation instructions

本文件约束后续所有 Pi Coding Harness 开发工作。

## 开始与恢复

1. 从项目根运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/show-resume-context.ps1`。
2. 只读取输出指向的当前切片、相关源码/测试及唯一权威蓝图的对应章节。
3. 不因线程恢复或压缩而重新通读未变化蓝图；hash 不匹配、路线被证伪或用户明确要求时才扩大读取。
4. 先运行最小失败性测试，再改代码；阶段退出时才运行聚合验证。
5. 缺陷修复按关联问题簇推进：每次只运行能证伪当前修复的测试、受影响 lint/compile 和必要的邻接集成测试。
   不得在每个小修复后重复 full verify、manifest/hash 再生、安装刷新或模型 benchmark。
6. 仅在修复簇稳定且进入阶段/发布候选退出门时统一运行一次完整发布验证；模型 benchmark 发现首个可行动的
   Harness 缺陷时立即停止、保留证据并先修复，不用已知缺陷继续消耗整轮请求。

## 权威与范围

- 唯一架构权威是 `docs/PI-CODING-HARNESS-BLUEPRINT.md`。
- SQLite WAL、不可变 event/receipt、lease、fencing token 和 CAS 是产品权威。Pi JSONL、聊天、
  Widget、状态 Markdown 和 Worker 文本均不可授权副作用。
- `/coding` 是唯一公开入口。不得恢复旧名称、旧命令或兼容别名。
- 未显式进入时不得启动 Host、读取配置、打开 SQLite、注入 prompt、发送 RPC 或增加模型请求。
- provider、model、thinking level 和 context window 只来自当前 Pi 配置。禁止调用 `setModel`、
  `setThinkingLevel` 或写死具体模型、thinking level、窗口与 provider。

## Single 与 Multi

- Single 和 Multi 都必须支持 Plan、Build、澄清、路线纠错、恢复、Memory、Input Context、
  Compaction、Output、Cache telemetry 和性能门。
- Single 由 Supervisor 在真实工作区执行；所有 mutation 经过 operation prepare/observe/commit/reconcile。
- Multi 仅在用户进入时选择。Worker 按 `PLANNER/EXPLORER/IMPLEMENTER/VERIFIER/INTEGRATOR`
  隔离，使用短生命周期 in-memory session 和 scoped mirror。
- Worker 输出是不可信提案；只有 hash-bound TaskPacket、lease、PatchSet、fresh oracle 与 IntegrationReceipt
  能推动 authority。并行写范围必须互斥，集成必须串行。
- Worker 模型配置只能继承 Supervisor 或读取用户在 Pi 配置中明确提供的 role profile；不可隐式降级。

## 低开销硬门

- 不为规划、审查、Memory、Output、状态或重规划增加独立模型请求。利用当前 Agent turn，本地代码
  完成确定性检查、状态更新和 telemetry。
- Build 采用最小合同；小任务保持 DirectCell。Plan 只展开当前与近期 WorkCell，远期用 typed deferred outcome。
- 读取先搜索再取精确范围；复用仍在输入闭包中的 receipt；不要重复不影响决策的检查。
- provider accounting 在后台有序记录，不阻塞用户请求；非关键索引和 telemetry 批处理或去抖。
- Output 默认工具期静默、Widget 优先、只报告问题、阻塞和最终证据；禁止额外 rewrite 请求。
- Cache 没有真实 integration 时保持 C0；不得用 warmup、填充、延迟请求或选择性分母改善指标。
- 性能收益不能抵消正确性、安全、隐私、验收、状态完整性或未知副作用。

## 修改与验证

- 手工编辑使用 `apply_patch`。保持改动紧贴目标 Module 和 Interface，不做无关格式化。
- 按风险递增验证：受影响测试 -> compile/lint -> 集成/故障测试 -> 全量测试 -> 生命周期/性能/自包含。
- 重复失败签名必须升级为 Local Repair、Replan、Ask User 或 Reconcile，禁止无限重试。
- 新证据否定路线时，先更新 Assumption、RouteDecision 与 `manifests/PROJECT-STATE.json`，再继续。
- 不把结构扫描当作最终验证；必须从任意 cwd 验证已安装 package 的真实行为。

## 重大突破回写

以下事件后，在开始下一切片前运行 `scripts/update-project-state.ps1` 原子更新状态：核心假设确认或
否定、schema/Interface 冻结、阶段退出、首个端到端路径、重要 blocker 解除、路线实质改变、关键
验证通过或失败、发现不可重复路线，以及压缩、长暂停或环境切换前。

状态至少记录：版本、当前阶段、authoritative artifact hash、验证 receipt、最新纠正、关键决定、
失败/禁止重复路线、开放风险、阻塞与一个精确下一动作。状态文件是开发投影，不得与产品 authority
竞争，也不得在每个普通命令后刷新。

## Git

- 若项目尚不在任何 Git 工作树内，初始 scaffold 可运行并通过验证后执行 `git init`。
- `.gitignore` 必须先于 staging；禁止提交 secret、`.env`、依赖、构建、缓存、报告和运行数据库。
- 只创建一次 `chore: initialize project` 初始提交。没有 Git identity 时不虚构身份，报告跳过提交。
- 不创建 remote、不 push；后续改动除非用户明确要求，不自动提交。
