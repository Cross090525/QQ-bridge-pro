# 本机 Haitang 记忆

已采用 [haitang1/dsh-memory](https://github.com/haitang1/dsh-memory) v0.5.0，固定源代码修订 `15de1c791bbcb5be2c9b0c2096eddedcaa61cc17`。其独立 MCP 本身只使用 Node 内置依赖；本次复用相同的 `lib/store.js` 存储与检索模块，通过 `integrations/haitang-memory.mjs` 提供 QQ-bridge 记忆协议 MCP 接口。不安装 DSH 宿主注入钩子，不读取个人全局记忆，不需要新增模型密钥。

## 本机配置

- 上游代码：`C:/DSH/external-memory/haitang-dsh-memory`
- 独立数据：`C:/DSH/external-memory/haitang-data/<不透明会话命名空间>/raw_memories.md`
- 固定版本与文件校验记录：`C:/DSH/external-memory/haitang-installation.json`
- 提供者 ID：`haitang`，已设为默认。
- 用户选择：`approvalMode: "automatic"`，查询、写入、更新、删除、清空及选定记录导入均自动执行，无逐次确认。显式 deny/ask 规则、群白名单、会话隔离、暂停、额度及审计仍然有效。普通媒体/MCP 服务不受此项授权影响。

stdio 服务按需启动，不需要单独常驻或开启端口；桥接关闭后释放锁。配置生效需重启桥接，DSH 不需要为这个记忆服务重启或加装插件。

## 接入与操作

```powershell
# 上游仓库准备好后，注册本机提供者（保留其他提供者与扩展规则）
npm run setup:memory:haitang

# 回归真实存储、MCP 与自动授权
npm run test:memory:haitang
```

安装脚本支持 `--upstream=<目录>`、`--data=<独立数据目录>`；每次执行记录实际 Git 修订和源码 SHA256。不要把数据目录设为已有个人 DSH 全局记忆目录，也不要同时让宿主插件修改适配器的分库。

既有 `qq_memory`、`qq_memory_providers`、旧记忆工具别名与 API v1 继续可用。模型需要时查询；内容不会每轮自动打包注入。写入是否发生由 Agent/调用方决定，“自动授权”不等于自动保存每一条群聊。

接口 `memory("ingest", {messageSeqs:[...]})` 仍只导入当前会话明确选择的 1–10 条近期消息，不会导出全部历史或其他群。无需逐次确认，但仍有这一数据范围。批量清空限当前提供者下的当前会话；无法通过传入 namespace 操作其他群。

## 功能与边界

数据通过上游原子文件替换写入，并使用上游 Markdown 格式和 BM25/CJK 模糊检索。适配器补齐不透明命名空间、条目 ID/类别/对象/元数据/到期时间、批量操作与桥接协议。原文封装为单行 JSON，避免用户记忆文本中的 Markdown 标题被解析成额外记录。数据损坏时拒绝覆盖；活进程的锁不会因超过 60 秒而被抢占，异常退出留下的本机死进程锁可恢复。

未启用宿主自动摘要、自动全量历史采集、远程 embedding 或语义大模型抽取。当前查询采用上游本地词法/模糊检索，非远程向量检索；有关键词的排序结果最多 50 条，再按请求分页，空查询可浏览当前会话条目。每次返回仍受框架 limit/maxChars 预算约束。每会话上限 10000 条或约 16 MiB，单进程最多打开 64 个会话分库。

存储中的 JSON 字段属于适配器格式，普通上游宿主插件的整理/合并工具不应直接改写这些文件。升级上游前先运行其 store/MCP 测试和本仓库适配测试，再重新记录版本；不会自动拉取最新代码。
