# 聊天表达、草稿判断与本地梗库

本模块适配 [MX3a48c5/dsh-fish-tone](https://github.com/MX3a48c5/dsh-fish-tone)，复用MIT许可的文本算法与静态梗库。上游主包0.3.0、附属包0.1.1，固定修订 `b22b071644379ae8abb2640c412eef9ea2de49ee`。源码和署名位于 `integrations/vendor/dsh-fish-tone/`，不挂载上游全局插件、设置路由或工具面。

## 默认行为

- QQ聊天提示增加自然回应的表达引导，沿用原有人格，避免套话、复述和堆句式。不故意写错字，不编经历、关系或事实。管理员closed-agent工作会话不注入这段引导。
- `text.judge` 分析草稿的句式与扎堆，只给建议；`text.meme` 查询1000个梗词和24个句式。没有新模型、云服务或API密钥，也不读取近期消息、角色卡正文或长期记忆。
- `text.tone` 润色默认关闭，安装时也不授予该能力。它只返回原文与建议稿，不介入发送链路。启用需要管理员打开该会话的 `rewriteEnabled`，并在原扩展授权中授予 `text.tone` 的 `input` 范围。
- 原有视频、语音、记忆和QQ发送机制继续使用各自入口。

## 安装

```sh
npm run setup:fish-tone
npm run test:fish-tone
```

安装脚本在 `framework.services` 注册三个固定stdio内容服务，保留无关服务和已有deny/ask规则；只为白名单内准确会话补充判断、查梗的read授权，不授权润色、不使用通配符。重跑保留已有禁用状态。配置备份到忽略的 `state/config-before-fish-tone-*.json`。无需准备上游外部目录或新增npm运行依赖。

重启桥接加载注册；运行 `node scripts/build-agent-preset-patches.mjs` 并重启DSH加载两代QQ预设的新说明。之后表达设置由控制台热更新，不需要重启。

## 控制台设置

打开「人格与角色 → 聊天表达与本地梗库」。可编辑默认值、指定人格或准确会话key；优先级为会话覆盖 ＞ 人格覆盖 ＞ 默认值。「恢复继承」移除该覆盖项。支持本地草稿分析、查梗和已启用会话的润色预览；预览不调用QQ发送接口。

设置保存在 `state/fish-tone.json`：

```json
{
  "version": 1,
  "defaults": { "enabled": true, "style": "neutral", "strength": "light", "rewriteEnabled": false },
  "roles": { "示例角色": { "style": "cute" } },
  "conversations": { "group:456": { "style": "abstract", "rewriteEnabled": false } }
}
```

`enabled`控制表达引导，`style`为neutral/cute/abstract，`strength`为off/light/normal/max（用于可选润色），`rewriteEnabled`控制是否开放润色。强度off时不添加语气修饰，润色调用原样返回输入。判断与查梗仍可按已有内容服务授权使用。

管理接口 `GET/POST /api/fish-tone` 和 `POST /api/fish-tone/preview` 只接受控制台管理员身份；携带会话token或agent-call标记的请求即使同时持有控制台token也会被拒绝。保存设置会使旧表达服务缓存及在途结果失效，不中断视频、语音服务。

## Agent调用

先调用 `qq_content_services` 发现能力，再通过 `qq_process_content` 调用。文本服务不传sourceId，参数放在input：

```js
await client.processContent('text.judge', { input: { text: '这是一份需要检查表达的草稿。' } });
await client.processContent('text.meme', { input: { text: '破防', limit: 3 } });
// 仅在管理员已开启并授权后使用
await client.processContent('text.tone', { input: { text: '这个功能挺有趣。', strength: 'light' } });
```

草稿最多6000字符，查梗词最多100字符，结果受原框架16000字符上限约束。发现的参数、审批、调用额度和会话隔离沿用原框架；`$context.key`由桥接绑定会话提供，模型不能通过input指定别的会话。`$input`映射只传递已经过服务schema验证的参数，不包含token、scope或配置。

## 改写与上游修正

适配器修复了strength=off后微标记仍改字的问题，直接传递shock模式；内置flavor实现补全闭合/未闭合代码围栏保护，随机抽梗使用完整候选池，查询结果仍限量。

本接入不运行语病注入、不添加也/好像/根本等语义微标记，不自动压缩句式。数字、引文、技术内容及部分明确事实行整行保护，其他文本仍可能被口语规则改变语气或含义，所以输出保留原文并标为建议稿，需要模型自行核对。规则保护不等于语义等价证明。

判断结果来自正则、文体启发和上游语料基线，不能当作AI文本鉴定；本仓库未重新采集或验证上游语料。梗库为静态数据，502个词条有释义，其余明确标注未考据，不保证时效与适用场合。

## 验证

`npm run test:fish-tone` 覆盖四项回归、默认关闭、数字/代码保护、人格与会话覆盖、原框架审批、真实stdio/API调用、管理接口隔离及配置变更撤销在途结果。`scripts/test-fish-tone-ui.mjs` 使用Playwright对隔离桥接验证控制台保存、继承、预览与默认禁用；测试不发送真实QQ消息。
