# B站、视频与动图内容服务

接入原有 `framework.services`、`qq_content_services` / `qq_process_content`、API v1 和 `QQBridgeClient.processContent()`，没有另一套群消息或授权系统。

| 服务 ID | 输入 | 实际证据 |
| --- | --- | --- |
| `bilibili.transcript` | 当前会话的B站链接 | 元信息、可用字幕/必剪或本机转写、有限时间索引，不含画面 |
| `bilibili.frames` | 同一链接及可选时间点 | 元信息与有时间顺序的 PNG 抽样帧，不含音轨理解 |
| `media.frames` | 收到的视频、GIF/WebP或图片字节 | 多帧图像与时间信息，静态图片明确标为静态 |
| `media.transcript` | 收到的视频或可解码音频字节 | 本机 SenseVoice 转写及本次覆盖的起止时间 |

Agent 决定是否调用：B站先读文字，按需看图；音轨独立转写；动图不能只看首帧。返回标准 MCP text/image 内容块，原框架将图片绑定为会话媒体 ID，并送给支持图片输入的模型。没有额外调用云端视觉模型。

QQ 分享卡片中的 `b23.tv` 短链同样使用消息内的 sourceId。群唤醒发现待处理B站分享时提醒 Agent 发现内容服务；普通 `web_fetch` 对B站视频页返回服务调用指引，不把网页 HTML 当作视频，也不代替授权服务。提取器按上游 `metadata` 字段读取标题、作者和时长；默认抽帧分布在时间轴内部，避免容器片尾时长存在但解码不到画面的空帧。普通网页抓取支持有界 gzip/deflate/br 解压，解压后的文字仍受长度和时间限制。

## 本机安装

- 上游 [CZX2244/dsh-bilibili](https://github.com/CZX2244/dsh-bilibili) v0.8.0，修订 `c53af9dee30cf04ee759ac6857d5803196fb2a95`，目录 `C:/DSH/external-media/dsh-bilibili`。只复用 MIT 许可的独立提取模块，不挂载其宿主注入或登录工具。
- FFmpeg 9.0.2：固定包 `@clayzo/ffmpeg-win32-x64@1.2.1`；ffprobe：`@ffprobe-installer/win32-x64@5.1.0`，目录 `C:/DSH/media-runtime-fast`。FFmpeg 构建禁用网络与设备，仅处理本机文件。各包保留许可证及对应源码说明，二进制不纳入本仓库。
- 复用已安装 DSH 的 sherpa-onnx-node，SenseVoice int8 模型及词表按 DSH 官方固定资产清单校验 SHA256，位于 `C:/DSH/external-media/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17`。模型沿用上游许可证，不需要新 API 密钥。
- 来源、版本与哈希记录在 `C:/DSH/external-media/media-installation.json`。

```powershell
npm run setup:media
npm run test:media
```

安装脚本合并四个服务，保留其他配置与已有 deny/ask；只为 `config.allow` 中已配置的准确会话补充缺失的 read 授权，不使用通配符。白名单为空时不会凭空授权任何群；添加群后可重跑安装脚本，或在控制台按能力授权。媒体读取还须配置实际网关缓存的 `framework.mediaRoots`，或提供可安全下载的公网 URL。

重启桥接加载服务注册，DSH 重启加载更新后的 QQ 预设说明；服务通过 stdio 按需启动，不需要作为 DSH 全局插件挂载。自定义部署用 `setup-media-services.mjs --upstream=... --ffmpeg=... --ffprobe=... --asr-module=... --asr-model=...`。非 Windows 系统需提供对应可运行二进制。先准备源码、Node 依赖和经过校验的模型；调用时不会自动安装软件。

## 调用示例

```js
await client.contentServices(sourceId);
await client.processContent('bilibili.transcript', { sourceId, input: { asr: false } });
await client.processContent('bilibili.frames', { sourceId, input: { timestamps: '12.5,35', maxFrames: 2 } });
await client.processContent('media.frames', { sourceId, input: { maxFrames: 4 } });
await client.processContent('media.transcript', { sourceId, input: { startSeconds: 0, durationSeconds: 120 } });
```

sourceId 必须来自当前会话；输入不能指定任意路径、URL、FFmpeg 参数、目录或凭据。B站服务按 source-reference 授权，媒体字节服务按 source-bytes 授权，传参时还需 input。普通服务默认拒绝；allow 的 read 服务直接执行，ask 按原审批流程处理，记忆 automatic 授权不传播到这里。

## 网络、数据及限制

如果 QQ 消息已入站但 DSH 没有新回合，先检查唤醒限频；它发生在内容服务调用之前。默认自动唤醒每分钟1次、每小时12次，随机唤醒和积压补发也会消耗额度。管理员可向管理端 `POST /api/socialV2/wake` 提交 `{"key":"group:群号","reason":"admin","bypassRateLimit":true}` 单次忽略限频；须使用控制台认证，Agent 无权调用。忙碌会话返回409，暂停、模式和白名单检查不被绕过，自动限额保持不变，不能把HTTP接受请求等同于模型已完成分析。

- B站只允许 HTTPS 白名单主机，逐次检查所有 DNS 地址并固定连接公网 IP，每跳重定向复核。SESSDATA 仅发送给 api.bilibili.com，不发送给 CDN。主流 PCDN 不在允许域名时选择官方备用 CDN，不允许任意域名。
- 部分字幕需要登录。可由管理员在 stdio `transport.envFrom` 配置 `{"BILIBILI_SESSDATA":"BILIBILI_SESSDATA"}` 并设置桥接进程环境变量。默认匿名，不读取浏览器 Cookie。默认 asr=true 可尝试B站必剪转写，仍无文字时下载不超过16 MiB的官方音轨，用本机 SenseVoice 转写前120秒并声明覆盖范围；均失败时只返回元信息，不编造内容。asr=false 禁用这两种音轨转写。
- B站抽帧限第一P、30分钟。32 MiB内的单段低清混合视频直接处理；超过该体积或混合源分段时，改选最低码率 H.264 DASH 纯视频轨，纯视频下载上限96 MiB，不下载无关音轨。预计超限或响应 Content-Length 超限时提前拒绝，未知大小仍按实际接收字节强制限制；下载检查后才交给 FFmpeg 本机文件，不回退到解码器直接访问网络。候选 CDN 仅允许 HTTPS 标准端口，跳过8082/4483等 PCDN 地址。
- 处理错误使用固定的 `qq-bridge.media-error/v1` 错误码，框架区分 `MEDIA_DOWNLOAD_LIMIT`、`MEDIA_DURATION_LIMIT`、`MEDIA_NO_VIDEO_TRACK`、`MEDIA_FRAME_DECODE` 和一般处理失败。只显示固定文案与有界大小信息，不透传任意上游异常、签名URL或凭据；单个视频超限不能推断整个抽帧服务不可用。
- QQ 原始媒体沿用框架 8 MiB 上限、缓存根目录与会话检查。单次1–6帧，最大640像素边长，最多30分钟。按实际帧率避开不存在的尾帧，靠近片尾的时间点使用最后可用编码帧；抽样时间可能有一帧偏差。
- 固定 FFmpeg 构建主要支持 H.264、VP9、ProRes、GIF、WebP和常用音频；HEVC/AV1等需另配支持的完整 FFmpeg。QQ语音有安全缓存标识时，桥接调用 `get_record(out_format=wav)`，优先读取网关返回的 `base64`，即使原消息带 SILK 下载 URL 也先转码。返回字节须为有效 base64、WAV 且不超过8 MiB；检查权限后才调用网关。SnowLuma v1.14.20 的该返回方式可直接跨 Docker 传输，无需共享QQ账号目录或重建容器。仅返回容器文件路径的旧网关仍需共享缓存或升级；不接受任意路径作为转码参数。
- 本机转写默认120秒、单次最多180秒，可分段请求；结果说明覆盖范围，语音识别可能出错。有声音文字不等于看过画面。
- 临时视频、帧及音轨在结束后清理；输出图片沿用原媒体存储的会话归属、容量及过期机制。不会自动写入长期记忆，也不会例行识别全部消息。

测试包含真实 FFmpeg 的变色视频/GIF、多帧差异、默认与片尾采样、真实 SenseVoice、真实 stdio，经实际桥接处理器返回原生图片/媒体ID，以及默认拒绝、审批前不读字节、跨群拒绝、伪造域名、重定向和Cookie隔离。在线 B站探测单独记录，不把 mock 算成在线成功；不向 QQ 发测试消息，不声明已验证真实模型的视频理解质量。
