# 发布前隐私检查（PRIVACY）

> 这个项目在一台**真实机器**上运行过，工作树里天然散落着真实 QQ 号、群号、本机绝对路径、
> 令牌、以及个人化的人格卡内容。任何一次「忘了就 push」都会把这些**永久写进公开仓库历史**
> ——Git 历史里的东西删提交也删不干净（还会被 fork 保留）。
>
> 所以发布前跑一遍扫描，是发布流程的**硬性一步**，不是可选建议。

---

## 一、跑扫描

```bash
node scripts/privacy-scan.mjs                # 扫"将要提交的内容"（推荐）
node scripts/privacy-scan.mjs --tracked-only # 只扫 git 已跟踪文件
node scripts/privacy-scan.mjs --json         # 机读输出（给 CI 用）
```

退出码：`0` = 干净，`1` = 有命中（**必须逐个判读**），`2` = 规则文件坏了或目录扫不动。

如果输出「匹配过多/过慢，已提前结束该规则」警告，该文件的对应规则结果不完整；即使退出码为 `0`，也不能据此确认扫描完整。应人工复核警告列出的文件，或先改进规则再重跑。

它扫描：`git ls-files` + 未被 ignore 的未跟踪文件（git 不可用时退化为目录遍历，并尽力套用 `.gitignore`；
遍历会跳过 junction/symlink，免得被指回自身的联接搞成无限递归）。

## 二、内置规则（挡住最常见的泄漏）

| 规则 | 说明 |
| --- | --- |
| 本机绝对路径 | `C:\Users\<名字>\…` 与 `D:\<工作盘>\…` 这类工作盘路径 |
| QQ 号 / 群号 | 9–10 位连续数字；文档示例使用文字占位符 |
| 高熵串 | 疑似令牌/密钥。**过滤掉**全 hex（git SHA）、全大写下划线（环境变量名）、小写文件名式串 —— 真凭据是"大小写+数字混合" |
| 凭据赋值 | `accessToken: "<12 位以上实际值>"` 形态（空值/模板不算，避免噪音） |
| 私钥头 / 带凭据的 URL | `-----BEGIN … PRIVATE KEY-----`、`https://user:pass@host` |
| 不应入库的文件 | `config.json`、`state/`、`audio/`、`*.log`、`*.bak*` |

## 三、判读命中：三种处理，别一律"忽略"

| 情况 | 处理 |
| --- | --- |
| **真实数据**（你的 QQ 号、群号、本机路径、令牌） | 换成文字占位符（例如 `QQ号占位符` / `C:\path\to\…`），或把该文件移出版本控制 |
| **该文件本来就不该入库** | 加进 `.gitignore`；若已提交过，见下面第四节 |
| **误报**（脱敏模板、测试夹具、文档示例） | 加进白名单 —— 两种方式：<br>① 文件级：`scripts/privacy-rules.json` 的 `allowPaths`；<br>② 规则级：在同一文件里加一条更精确的 `deny` 规则覆盖默认规则 |

### `scripts/privacy-rules.json`（可选的本地规则文件）

- **它含你机器上的真实标识，必须加进 `.gitignore`**（模板见 `privacy-rules.example.json`）。
- 结构：

```jsonc
{
  "comment": "本机专用；不入库",
  "deny": [
    { "name": "我的真实群号", "pattern": "1001[0-9]{6}", "flags": "" }
  ],
  "denyFiles": ["notes/", "*.private.md"],
  "allowPaths": ["docs/guides/VOICE.md", "scripts/console-ui-"]
}
```

`allowPaths` 支持前缀或 `*` 通配。**加入白名单前先确认那个文件里确实只有占位数据**——
白名单是"误报豁免"，不是"这个文件不用检查"。

## 四、已经提交进去了怎么办

| 情况 | 处理 |
| --- | --- |
| 还没 push | `git reset --soft` 回退提交、清掉敏感内容、重新提交 |
| 已 push，但**没有被 fork / 没人拉过** | `git filter-repo --replace-text` 清历史，再 `git push --force`。要提前通知协作者 |
| 已 push 且可能被 fork / 已公开一段时间 | **当作已泄露**：① 立刻**轮换**所有涉及的凭据；② 评估是否清理历史并通知协作者；③ 若无法可靠清理，使用干净历史重新发布，并处理旧仓库与 fork 的可见性 |

> 如果决定另建仓库，应从干净起点开始并先扫描提交内容；清理工作树不会自动清除旧仓库历史。

## 五、CI 里怎么用

```yaml
# .github/workflows/ci.yml 片段
- name: Privacy scan
  run: node scripts/privacy-scan.mjs --tracked-only
```

CI 上只扫**已跟踪**文件（未跟踪文件在干净 checkout 里不存在），命中即失败。

## 六、历史扫描记录（2026-09-20；不代表当前状态）

这是一次历史扫描快照，不能代替提交前重新运行扫描。旧记录中的群号已脱敏；当前状态以新的扫描结果为准：

| 文件 | 命中 | 处理建议 |
| --- | --- | --- |
| `public/console.html` | 真实群号（已脱敏）× 2 | 当时应替换为占位符；当前源文件已不含这条旧标识 |
| `src/bridge.js` | `accessToken` 键名（配置读取处，无真实值） | 误报：键名不是值；已在规则里区分"有实际值" |
| `docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md` | 真实 QQ 号/群号、`C:\Users\<名字>`、`D:\<工作盘>` | 旧项目的本机实现说明，不纳入公开仓库；这份历史清单不指定替代文档 |
| `docs/audits/*`、`docs/design/*`、`docs/research/*`、`docs/legacy/*` | 本机路径、真实 QQ 号 | 本机历史资料，不纳入公开仓库；当前公开安全说明见 [安全基线](SECURITY_BASELINE.md) |
| `scripts/test-*`、`scripts/console-ui-*`、`src/sensitive.js`、`config.example.json` | 刻意构造的假 ID / 假凭据 / 占位符 | 误报：已在 `allowPaths` 白名单里 |

当时的扫描结论仅适用于 2026-09-20 的文件快照。现在发布前请重新运行 `node scripts/privacy-scan.mjs`，不要把这份旧表当作当前的放行结论。
