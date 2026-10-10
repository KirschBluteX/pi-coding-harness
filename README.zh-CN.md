# Pi Coding Harness

[![CI](https://github.com/KirschBluteX/pi-coding-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/KirschBluteX/pi-coding-harness/actions/workflows/ci.yml)
[English](README.md) · [使用指南](docs/USER-GUIDE.md) · [架构](docs/ARCHITECTURE.md) · [验证记录](docs/VALIDATION.md)

PCH 1.3 是带独立 CLI 的 **Single 单 Agent 编码执行系统**，Pi Coding Agent 适配器可选。它约束修改范围，
以本地证据验收结果，并在中断后恢复准确的任务状态。

## 能解决什么

- 一个 Agent 直接读、改、测真实工作区；小任务只使用一个 WorkCell。
- 修改前检查范围、租约和文件原内容，修改后核对结果；成功交付必须有仍然有效的验收证据。
- SQLite/CAS 保存需求、决策、路线、已完成证据和结果未知的操作，恢复时避免盲目重做。
- 仅提供三个管理工具，复用当前证据，确定性检查在本地执行，统计写入在后台排队。
- 未进入 `/coding` 时，不启动 Host、不打开数据库、不注入提示、不增加模型请求。

独立 CLI 使用用户明确指定的 OpenAI-compatible 网关、模型和上下文窗口；Pi 适配器继续沿用当前 Pi 的
provider、model 和 thinking。两种入口都不额外启动规划、审查或 Worker 会话。
1.3 已移除 Multi 执行，保留历史记录的完整性和兼容读取。

PCH 适合需要明确验收、范围控制或中断恢复的任务。这些保障本身有开销；目前不声称所有小任务都会比原生 Pi 更省 token 或更快。

## 环境与安装

本次实测环境为 Windows、PowerShell 7（`pwsh`）、npm 11 和 Node.js 24.19.0；Pi 适配器另外在 Pi 0.82.1
上测试，声明兼容 `>=0.81.0 <=0.82.1`。Node.js 需要 `>=22.22.3 <23` 或 `>=24.15.0`，且包含 SQLite WAL
修复；`pch doctor` 不打开数据库就能检查内置 SQLite 版本。
Pi 执行本地命令还需要 Bash。若 Git 安装在自定义磁盘，请在 Pi 的 `settings.json` 中设置 `shellPath`，
例如 `"X:/Git/bin/bash.exe"`。

### 独立 CLI

将仓库克隆到非系统盘，运行 `npm ci` 和 `npm run build:runtime`，之后可从任意工作目录启动 CLI。
Windows 安装前也应将 `TEMP`、`TMP`、`NPM_CONFIG_CACHE` 指向非系统盘。所选数据根目录存放权威状态、
会话记录、CLI 临时文件和 npm 缓存。

```powershell
$cli = (Resolve-Path ./dist/cli/index.js).Path
$env:PCH_API_KEY = '<你的网关密钥>'
node $cli doctor --workspace X:/my-project --data-root X:/PCH-data
node $cli plan '检查项目' --workspace X:/my-project --data-root X:/PCH-data --base-url https://gateway.example/v1 --model your-model --context-window 64000
node $cli status --workspace X:/my-project --data-root X:/PCH-data
```

`run` 开始 Build 任务，`plan` 在路线冻结后等待用户选择 Build／Keep／Revise。中断后使用 `resume GOAL-ID`
并传入相同工作区、数据根目录和网关选项。CLI 不能代替用户批准任务合同，也不会重放结果未知的操作。
可用 `--api-key-env NAME` 选择其他密钥环境变量。X 盘性能与长任务体验仍待验收，独立 CLI 尚未宣称正式发布。

### Pi 适配器安装

先进入你希望存放工作区的磁盘目录，再执行：

```powershell
git clone https://github.com/KirschBluteX/pi-coding-harness.git
cd pi-coding-harness
npm ci
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1 -WhatIf
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/doctor.ps1
```

运行数据默认在 `~/.pi/agent/coding-harness`。如需放到 X 盘，安装前将 `config/default.json` 的 `data.root`
设为绝对路径，例如 `X:/PCH-data`。生命周期脚本的 `-DataRoot` 参数只覆盖该次调用。重新构建会清除旧的生成文件，避免遗留已移除的执行器。

## Pi 适配器使用

```text
/coding build 修复 CSV 解析器并运行测试
/coding plan 评估模块重构路线
/coding
/coding recover <goal-id>
/coding status
/coding pause
/coding resume
/coding replan 当前库版本不支持原方案中的 API
/coding exit
```

Build 先给出最小任务合同，由用户确认一次，再冻结路线并执行。Plan 完成路线后提供 Build、Keep、Revise 选择。
日常进度由 Widget 展示。原有的 `/coding single build ...` 仍可使用，但无需再选择拓扑。
无界面场景的合同确认、澄清和取消命令见[使用指南](docs/USER-GUIDE.md)。

## 从 1.2 升级

原有 Single 任务继续使用其权威状态与恢复记录。旧 Worker 配置字段读取后被丢弃。SQL 迁移、不可变事件和历史产物均保留。

尚未结束、曾请求 Multi 的任务会在获取新控制租约前返回 `LEGACY_MULTI_UNAVAILABLE`，包括仍等待 Multi 准入的任务。
请先用 PCH 1.2.1 核对并取消该任务，再升级同一工作区；也可在另一工作区开始 Single 任务。
不要删除数据库来绕过结果未知的操作。详见[升级说明](docs/USER-GUIDE.md#upgrading-from-12)。

## 验证与边界

```powershell
npm run verify
```

验证覆盖类型、lint、测试、SQL/JSON/Markdown、安装升级卸载、任意 cwd 导入、性能与源码闭包。
实际结果以[验证记录](docs/VALIDATION.md)和[项目状态](PROJECT-STATUS.md)为准；真实模型验收使用隔离工作区及明确停止条件。

Single 功能检查已通过。本机 X 盘上的持久化写入及 Cache C1 统计延迟超过现有预算，性能验收仍未通过；
本次交付更新代码，暂不创建 Release。

不匹配已验证 provider 合同的 Cache 自动回到 C0。缺失用量和未知网关价格不会被估算成确定数字。
生产长度下的自然 Compaction、广泛成本优势和长任务可靠性，不能由一个小型实测推导。
旧 Multi／四方对比实验不属于本版交付范围。

Pi 适配器的 API key 放在 Pi 凭据配置中；不要将密钥、运行数据库或依赖目录提交到仓库。
安全问题见 [SECURITY.md](SECURITY.md)，许可证为 [Apache-2.0](LICENSE)。
