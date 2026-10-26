# 仓库目录地图（FOLDER_MAP）

> 说明仓库目录职责与脚本命名约定。本文**只描述本仓库现状**，不列出工作区外的个人工具、启动器或运行目录。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-10-26。新增或移除公开目录、脚本和文档时请同步检查本图；不要在这里固定容易过期的文件数量。

---

## 一、顶层布局

此图仅覆盖 `qq-bridge` 仓库。旁边可能存在的独立工具、用户配置、音频与运行缓存不随克隆提供，也不列入公开仓库结构。

| 目录 | 作用 | 能不能删/动 |
| --- | --- | --- |
| `src/` | **桥接内核**：入口 `bridge.js`、DSH 客户端、MCP server、双模式与内容/记忆/权限框架 | 主程序和模块同时使用 `.js` 与 `.mjs`；不要把 `.bak` 备份放进源码目录。共享实现优先维护在对应的 `core/`、`framework/` 模块中 |
| `scripts/` | 测试、安装、验证、探针和运维脚本（见第二节） | 运行前看具体脚本的网络依赖与副作用；不要只按文件名前缀判断是否安全可运行 |
| `dsh/` | 要装进 DSH 的东西：`agent-presets/qq-chat`、`agent-presets/qq-chat-v2`（preset 的**权威源**，含工具白名单 `qq-tool-restrict.mjs` 的 re-export 壳）。DSH 0.1.7 起 preset 以 bundle patch 形式安装，patch 由 `scripts/build-agent-preset-patches.mjs` 从这里的源生成到 `plugins/qq-agent-presets/presets/` | 改 preset 会影响所有人设行为；改完必须重新生成 patch |
| `plugins/` | DSH 插件：`qq-mode-console`（暴露 `qq-mode` 设置命名空间；**只有 host 半**，浏览器 UI 卡片未实现）、`qq-agent-presets`（生成两个 preset 行 + 携带唯一的 `qq-tool-restrict` 权威实现） | 改了要重装/重启 DSH |
| `public/` | 浏览器静态资源：`console.html` 控制台与 `debate.html` 争论辅助界面 | 新增静态入口时同步更新相应路由、权限说明和控制台文档 |
| `roles/` | 人格卡（`小鲸鱼.md` / `傲娇助手.md` / `README.md`）：控制台「人格与角色」页可编辑，保存即生效 | 用户内容，别乱动 |
| `assets/` | 仓库用图片等资源（`deepseek娘.png`；`project-intro.mp4` 已改为 Release 附件、不入库） | 别加体积大的二进制 |
| `audio/` | 本机语音素材目录，不随公开克隆提供 | 用户数据；核对路径和权限后再维护 |
| `state/` | 运行时会话、模式、日志、锁与令牌。`.gitignore` 排除 | 用户数据；不要作为清理临时文件处理，详见安全基线 |
| `docs/` | 文档索引、双模式摘要、目录地图、许可证来源说明与专题指南（见第三节） | 新增公开文档时登记到索引 |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存 | 忽略 |
| `config.json` | 运行配置（真实配置**不入库**）；模板是 `config.example.json` | 值属于用户，别改 |

---

## 二、`scripts/` 命名约定

按命名和用途区分脚本。文件数量会变化，`git ls-files scripts` 与当前目录内容才是清单来源。命名只说明用途倾向，不保证离线或无副作用：

| 前缀 / 形态 | 含义 | 归宿 |
| --- | --- | --- |
| `test-*.mjs` | 验证脚本。只有登记在 `scripts/test-audit.mjs` 的脚本属于 `npm run test:audit` 安全离线套件；其他测试可能需要服务、环境配置或普通终端 | 改动套件成员时同步更新 `test-audit.mjs`；运行其他测试前先看脚本说明 |
| `test-dsh-*.mjs` | DSH 契约相关验证，离线与需要活 DSH 的脚本都有；例如 `test-dsh-inbox-projection.mjs` 是离线解析并已加入 `test:audit` | 先看单个脚本的环境要求；改 DSH 契约时检查相关用例 |
| `test-audit-*.mjs` | test-audit 的子模块（`test-audit-bridge` / `-protocol` / `-security` / `-setup` 及其 `-helpers`/`-guards`），被上一个直接运行 | 保留 |
| `test-console-ui.mjs` + `console-ui-*.json` / `console-ui-fixture.mjs` / `fixtures/` | 控制台**离线浏览器回归**与基线（`npm run test:console-ui` / `npm run preview:console`），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 保留（基线只在后端契约真变时才重录） |
| `send-*.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具（`send-voice.mjs` 走桥接；`send-test-group.mjs` 发测试群） | 保留，但注意会真的发消息 |
| `setup-*.mjs` | **安装/初始化**：把 preset、MCP 挂载写进目标设备的 DSH（`setup-dsh.mjs`，幂等） | 保留 |
| `verify-*.mjs` | **一致性校验**：`verify-dsh-020-adaptation.mjs`（DSH 适配；`npm run verify:adaptation`）、`verify-persona-config.mjs`（人格配置） | 保留 |
| `probe-*.mjs` | 探测 DSH/SnowLuma 的实际协议与能力；鉴权统一走 `probe-auth.mjs` | 保留；多数探针需要相应服务在线，运行前检查脚本说明 |
| `probe-020-protocol.mjs` / `probe-020-settings.mjs` | 0.2.0 版探针：前者采样 `session/control` baseline、`session/projections`、`session/follow`、`$events`、`session/cancel` 的**原始帧结构**；后者列 settings 命名空间并**幂等写回**验证 `qq-mode` 可写。控制台「改模式不生效」时的第一手诊断 | 保留（`npm run probe:protocol` / `probe:settings`） |
| `scan-dsh-tool-names.mjs` + `dsh-tool-names.mjs` | **工具名对账**：从已安装的 DSH 包里抽真实工具名，与 QQ 守卫的 restrict 名单双向求差（防拼错假名静默失效 / 防新版本新增能力漏隐藏）。抽取实现只有 `dsh-tool-names.mjs` 一份，`test-preset-local-tools.mjs` 与 `scan-dsh-tool-names.mjs` 共用 | 保留（每次升级 DSH 后跑一次） |
| `probe-snowluma-heartbeat.mjs` | 只读探针：连 SnowLuma 的 OneBot WS，等一个 `meta_event/heartbeat`，打印载荷里的 `status.online` / **`status.good`**。桥接的上游健康主信号就是这个字段——它存不存在、拼写对不对只能拿**真实运行时**验证（SDK 不校验 data 载荷，取错字段不会报错）。不发消息、不建会话 | 保留（`npm run probe:heartbeat`） |
| `voice-tool-locator.mjs` | 解析可选的仓库外语音工具位置；支持 `QQ_BRIDGE_VOICE_TOOL_DIR` 覆盖 | 保留；该工具不随本仓库克隆提供 |
| `audit-bridge-harness.mjs` | 虚拟网关 + 沙箱化的桥接行为审计脚手架（被 `test-audit-bridge.mjs` 使用） | 保留 |
| `harden-state-acl.mjs` | 收紧 `state/` 目录权限（Windows 上 `mode 0o600` 是空操作，必须动 ACL）。直接试 → 失败提权重试 → 仍失败则打印可复制命令；**任何路径都以 0 退出，绝不阻断启动**。被 `start.bat` 调用 | 保留（`start.bat` 依赖） |
| `diagnose-acl.mjs` | 只读盘点：列出仓库里所有被**切断 ACL 继承**的路径，分「有意收紧（`state/`、`config.json`）」与「非预期收紧」两类，并对后者打印恢复继承的命令。背景见 [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) §2.6：DSH 沙箱的写权限只靠继承下发能力 SID，切断继承 ⇒ 沙箱里写不进去。**必须在无沙箱终端跑**（沙箱禁止以管道 stdio 拉起 icacls） | 保留（`npm run diagnose:acl`） |
| `dsh-modules.mjs` | 小工具：按路径加载 DSH 安装内的模块 | 保留 |
| `check-onebot-status.mjs` | 手工排查：查 OneBot 连通性 | 保留（运维常用） |
| `patch-*.mjs` | 安装或升级过程中的补丁；当前必须保留的 `patch-snowluma-sdk.mjs` 由 `postinstall` 调用 | 不要因脚本名像一次性补丁就删除；维护 `.gitignore` 里排除的本机脚本见第四节 |
| `cleanup-*` / `fix-*` / `diag-*` / `debug-*` | 当前没有公开跟踪的脚本使用这些前缀；本机一次性脚本由 `.gitignore` 排除 | 仅核对忽略规则，不把旧候选清单当作当前文件清理指令 |
---

## 三、`docs/` 结构

```
docs/
├── README.md     # 按任务分类的文档索引
├── DUAL_MODE.md  # 双模式路由摘要
├── FOLDER_MAP.md # 本文件
├── LICENSE_PROVENANCE.md # 许可证与上游来源核查
└── guides/       # 安装、架构、接口、运维、安全与专题指南
```

> ⚠️ `.gitignore` 把 `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/` 以及
> `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` **整体排除**了
> （原因写在那里：这批文档里扫出过多份含本机真实路径的内容）。
> 当前文档清单以 `git ls-files docs` 为准；`.gitignore` 中列出的本机目录在干净克隆里可能不存在，不能当作公开文档链接目标。
> 新增公开文档应放入 `docs/`，确认未被忽略并纳入版本控制，再登记到 `docs/README.md`。

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` 三个文档**，其余一律进 `docs/` 对应子目录，
并在 [README.md](README.md) 索引里登记一行。版本适配或验证记录应标出目标版本和日期，避免被当作当前部署状态。

---

## 四、本机一次性脚本（由 .gitignore 排除）

以下路径来自 .gitignore 的本机一次性脚本规则，不是当前仓库中的跟踪文件；本次核对时这些文件均不在 scripts/ 工作树中。保留忽略规则可避免本机临时产物误入公开提交。该表是忽略规则清单，不是待删除文件清单。

| 忽略路径 | 本机用途 |
| --- | --- |
| scripts/cleanup-probe-sessions.mjs、cleanup-probe-workspaces.mjs、cleanup-test-sessions.mjs | 清理本机探针或测试产生的一次性 DSH 会话/工作区 |
| scripts/debug-whitelist.mjs、diag-archive.mjs、fix-probe-workspace-title.mjs | 本机调试、日志整理或单次修复 |
| scripts/patch-qq-chat-v2-collect-memory.mjs、patch-qq-chat-v2-presleep.mjs、patch-qq-chat-v2-stickers.mjs、patch-web-mcp-timeout.mjs | 针对一次运行或外部 DSH 安装的临时补丁 |

清理前先确认文件实际存在，再检查 package.json、scripts/test-audit.mjs、导入引用及 CI 配置；不要仅凭命名或旧文档推断它仍存在或可以删除。

---

## 五、文档维护时的自动核对

- 目录清单以 git ls-files 和当前工作树为准；不要维护手工文件计数。
- 文档中的相对链接应指向实际文件；npm run <name> 应存在于 package.json，否则改用真实的 node scripts/<file>.mjs 命令。
- DSH、SnowLuma 和第三方服务的运行行为应注明版本、验证时间及是否需要活服务；本机群名单、额度和运行状态不要写入公开指南。
- 发布前按 [隐私说明](guides/PRIVACY.md) 重新运行隐私扫描；扫描记录的旧结果不能替代当前检查。
