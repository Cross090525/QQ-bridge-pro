# 视频分镜与语音服务

视频理解由 [SAOS-3624/dsh-video-storyboard](https://github.com/SAOS-3624/dsh-video-storyboard) `0.5.4` 提供。通过现有 `framework.services`、`qq_content_services` / `qq_process_content` 和 API v1 接入；图片继续由支持图像输入的宿主模型理解。无需单独调用云端视觉模型。

| 服务 ID | 输入 | 返回 |
| --- | --- | --- |
| `bilibili.storyboard` | 当前会话的B站链接或b23短链 | 元信息、编号分镜图、时间码、网站字幕或本地SenseVoice转写 |
| `media.storyboard` | 当前会话收到的视频、GIF、WebP、图片字节 | 编号分镜图、时间码和可用音轨台词；静态图片明确标注 |
| `media.transcript` | QQ语音或独立音频文件 | 本机SenseVoice转写与片段时间范围 |

旧 `bilibili.frames`、`bilibili.transcript`、`media.frames` 入口已移除；不再加载 `dsh-bilibili/lib/extractor.js`，原颜色直方图选帧实现也已移除。保留的 `LocalMediaEngine` 只负责本机字节、探测和语音转写，为QQ语音及新分镜提供音频输入。

## 安装与迁移

```sh
npm ci
node scripts/setup-media-services.mjs --ffmpeg=/path/to/ffmpeg --ffprobe=/path/to/ffprobe --asr-module=/path/to/sherpa-onnx.js --asr-model=/path/to/sensevoice-model
npm run test:media
```

安装脚本检查 `scale`、`crop`、`ebur128`、`silencedetect` 和PNG编码器；精简FFmpeg构建可能不满足要求。Windows可使用锁定的可选FFmpeg包，Linux使用部署方提供的兼容二进制；生产环境可通过显式路径更新解码器。二进制与模型按各自许可证分发，不纳入Git。

迁移会备份私有配置到忽略的 `state/media-config-before-storyboard-*.json`，移除旧服务与旧权限规则，为新服务合并准确会话授权，保留无关服务、新服务已有权限及账号环境变量映射。旧B站两个服务任一个为deny/ask时，新B站服务保留更严格决定；额度取旧值和默认值的较小值。白名单为空不会自动授权。重跑脚本是幂等的。

重启桥接应用服务注册；预设补丁重新生成后重启DSH加载新的视频工具说明。既有对话可能保留旧上下文，应重新发现服务，以返回的服务列表为准。

## 调用

```js
await client.contentServices(sourceId);
const first = await client.processContent('bilibili.storyboard', {
  sourceId, input: { startSeconds: 0, durationSeconds: 120, need: 'scene' }
});
const evidence = JSON.parse(first.content[0].text);
if (evidence.nextInput) {
  await client.processContent('bilibili.storyboard', { sourceId, input: evidence.nextInput });
}
await client.processContent('bilibili.storyboard', {
  sourceId, input: { mode: 'zoom', startSeconds: 48, durationSeconds: 8, cells: 4, need: 'text' }
});
await client.processContent('media.storyboard', {
  sourceId, input: { durationSeconds: 30, cells: 6, detail: 'high' }
});
```

- 默认处理前120秒，普通分镜最多180秒，zoom最多30秒。`cells` 1–9；自动格数由上游根据内容和清晰度预算决定。默认每张图120万像素。
- `need=shot/scene/text` 控制自动布局的清晰度目标，`detail=low/med/high` 控制每格最多60/120/400个台词字符；`asr=false` 关闭本地语音转写，已有网站字幕仍可使用。
- `sheets[].cells` 中 `i` 为烧进图片的格号，`t_start/t_end` 为覆盖区间，普通格的 `t_frame` 为取帧时刻，`sub` 表示格内子图数的边长。结合sheet编号定位图片。zoom用明确时间段重新取帧，不依赖跨会话共享格号缓存。
- `coverage.sampledOnly=true` 表示仍为抽样证据；切点检测和时间覆盖不保证每个镜头都看见。`nextInput` 只表示可继续区间，不证明此前已经完整理解。台词过长会标注截断；缩短区间复查。
- 网站字幕优先；无字幕时复用本机SenseVoice。ASR时间戳是约30秒片段边界，不是逐句或逐字对齐。失败或partial会明确标记且禁用结果缓存，不能当成静音。硬字幕OCR未开启，`detail=high` 不会声称已做OCR。
- 视频音频条带仅显示响度/静音变化，不识别声源类别。B站DASH视频与音频下载后在本机合流，供同一时间轴的分析使用。

## 边界与数据

来源必须是当前会话的 `sourceId`，不能指定任意文件路径、URL、命令、模型端点或凭据。权限在读取媒体字节前检查；图片返回原生MCP image块，经原框架转成会话媒体ID，跨会话不能复用。新模块不注册到DSH全局工具面，不扩展QQ群本地工具权限。

B站网络仍走原有HTTPS、DNS全量校验与公网IP固定连接、每跳重定向复核及CDN白名单。Cookie只发给api.bilibili.com；不读取浏览器Cookie。可通过管理员配置的stdio `transport.envFrom` 传入 `BILIBILI_SESSDATA`。优先选720p以内且满足体积预算的H.264轨；视频总长最多30分钟，视频96MiB、独立音轨16MiB，字幕2MiB；仍只处理第一P。继续取证可能重新下载，超限不会回退到FFmpeg直接联网。

QQ媒体沿用8MiB、缓存根目录及会话检查。FFmpeg/ffprobe只接收私有临时文件，分镜子进程为解码命令加上file/pipe协议白名单。每个任务有独立的上游缓存、格号映射和观看历史目录，结束后统一清理，不共享台词、下载凭据或跨会话记忆。输出图片沿用框架容量与过期机制。

`npm run test:media` 包含真实FFmpeg分镜、GIF、字幕时间对齐、PNG、zoom、SenseVoice，以及真实框架API/stdio图片句柄和跨会话隔离。网络桩测试仅验证下载与字幕适配边界，不等于在线B站成功，也不证明真实模型的视频理解质量。
