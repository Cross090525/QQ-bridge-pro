# 许可证与上游来源核查

核对日期：2026-10-26。本文记录当前仓库与锁定依赖的工程核查结果，不构成法律意见。版本变化或发行形态改变时，应重新检查对应上游许可证。

## 当前结论

根目录 `package.json` 与 [`LICENSE`](../LICENSE) 将本项目代码声明为 MIT。已识别的上游来源各自保留原有署名和许可；本项目的 MIT 声明不会覆盖 npm 依赖、SnowLuma 本体、原生组件或仓库外动态加载的代码。目前没有因为“借鉴其他项目”就把本项目整体改成其他许可证的依据。

仓库不跟踪 `node_modules/`，但锁文件解析到 `@snowluma/sdk` 和 `@snowluma/mcp` **1.14.20**；安装后 `postinstall` 会修补本机依赖副本的 ESM 相对导入。该处理不把上游代码变成本项目代码，也不代表可以按 MIT 重新分发这些依赖。涉及 SnowLuma 的公开发布、商业使用或打包前，应先按上游许可和依赖包实际附带的许可文件核查。

## 来源与边界

| 来源 | 本仓库中的使用方式 | 许可边界 |
| --- | --- | --- |
| [`Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge/blob/main/LICENSE) | 本项目的直接基础；README 保留来源致谢 | 上游使用 MIT。保留原版权与署名；本仓库许可证见根目录 `LICENSE`。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE) | 通过 `@deepseek-ai/*` npm 包接入，没有将 Harness 本体源码复制进仓库 | 上游仓库使用 MIT；各依赖仍按其实际包许可分发。 |
| [`MX3a48c5/dsh-fish-tone`](https://github.com/MX3a48c5/dsh-fish-tone) | 固定b22b071修订的纯文本算法与静态梗库，放在integrations/vendor/dsh-fish-tone并做适配修正 | MIT，保留上游LICENSE与UPSTREAM.md；不挂载原全局插件与管理路由。 |
| [`SAOS-3624/dsh-video-storyboard`](https://github.com/SAOS-3624/dsh-video-storyboard) | npm锁定0.5.4，分镜子进程调用其pipeline；不复制上游源码 | Apache-2.0，依赖包中的LICENSE与NOTICE仍适用。 |
| [`CZX2244/dsh-bilibili`](https://github.com/CZX2244/dsh-bilibili/blob/main/LICENSE) | 历史方案，当前视频适配器已移除动态加载 | 历史引用保留MIT署名；旧源码不再是运行依赖。 |
| FFmpeg / `@ffmpeg-installer/win32-x64` 4.1.0 | Windows可选外部解码进程；Linux使用部署方配置的兼容构建 | 包声明GPLv3，二进制及源码条款由其自身LICENSE管理，不由桥接MIT覆盖。 |
| [`haitang1/dsh-memory`](https://github.com/haitang1/dsh-memory/blob/main/LICENSE) | 记忆适配器从仓库外的 `external-memory/haitang-dsh-memory/lib/store.js` 动态加载；该源码不在 Git 跟踪内容中 | 上游使用 MIT。若复制、打包或分发该组件，须一并保留对应版权和许可文本。 |
| [SnowLuma v1.14.20](https://github.com/SnowLuma/SnowLuma/tree/v1.14.20) 与 `@snowluma/*` | 桥接通过 OneBot/SDK 接口连接用户运行的 SnowLuma；锁定的 `@snowluma/sdk`、`@snowluma/mcp` 版本为 1.14.20 | 上游 [`LICENSE`](https://github.com/SnowLuma/SnowLuma/blob/v1.14.20/LICENSE) 是源码可见非商业许可，不是 OSI 开源许可；原生附加组件另属专有组件。两个 npm 包声明 `SEE LICENSE IN LICENSE`，分发前须核实包中实际许可文件及适用条件。 |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) 与其他 npm 依赖 | 通过 npm 安装和调用，没有复制其完整源码 | 以锁定版本的 `LICENSE`、`NOTICE` 和包元数据为准；本项目 MIT 不替代依赖自身许可。 |

## 发布时的处理

1. 只发布本仓库源代码时，保留根目录 `LICENSE` 和 README 中的上游致谢；不要把“本项目采用 MIT”写成“全部依赖均为 MIT”。
2. 发行包若包含 `external-media`、`external-memory`、依赖源码或原生二进制，先确认再分发的权限，并随包带上各组件对应的完整许可证与 NOTICE。
3. 发布 npm 包或包含 SnowLuma 组件的安装器前，核对 `package-lock.json` 中实际解析的版本、npm 包内实际包含的许可文件及 SnowLuma 上游条款；遇到许可缺失或不明确的依赖，先取得书面澄清或移除该依赖。
4. 每次更新依赖大版本、替换上游实现或改变打包内容时，重新运行许可证清单检查，并同步更新本文和根目录第三方边界说明。
