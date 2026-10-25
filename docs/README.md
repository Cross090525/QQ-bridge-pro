# 文档索引

项目定位、上游贡献和安装入口见[中文 README](../README.md)与[English README](../README.en.md)。本索引只链接当前仓库实际包含的文档；个人开发环境中的历史审计、研究与规划文件不作为公开安装前提。

## 从这里开始

| 目标 | 文档 |
| --- | --- |
| 查看总体架构、六张分层图与实现边界 | [开放框架架构](guides/FRAMEWORK_ARCHITECTURE.md) |
| 在新设备安装预设与QQ MCP | [DSH端配置](guides/DSH_SETUP.md) |
| 了解已验证版本与DSH协议变更 | [DSH 0.2.0适配](guides/DSH_020_ADAPTATION.md) |
| 隔离群聊仿真与管理员私聊任务 | [双模式路由](DUAL_MODE.md) |
| 查目录、脚本与维护约定 | [目录说明](FOLDER_MAP.md) |

## 接入能力

| 目标 | 文档 |
| --- | --- |
| 按需上下文、会话API v1、SDK、外部MCP / skill runner | [扩展接口](guides/EXTENSION_API.md) |
| sourceId、固定内容服务、参数schema、媒体句柄与统一输出 | [内容服务框架](guides/CONTENT_FRAMEWORK.md) |
| 精确能力授权、一次性审批、管理员QQ通知和私聊指令 | [扩展授权与审批](guides/EXTENSION_PERMISSIONS.md) |
| 理解审批设计与阶段边界，实际行为以实现说明为准 | [审批设计记录](guides/EXTENSION_PERMISSIONS_DESIGN.md) |
| B站字幕、分段ASR、场景抽帧、按时间取证及安装限制 | [视频与动图服务](guides/VIDEO_SERVICES.md) |
| 替换整体记忆模块，实现HTTP / MCP记忆插件 | [开放记忆协议](guides/MEMORY_PROVIDERS.md) |
| 使用Haitang本地存储/检索与自动记忆授权 | [Haitang适配](guides/HAITANG_MEMORY.md) |
| 创建限时业务任务并运行独立分析worker | [争论辅助插件](guides/DEBATE_PLUGIN.md) |

## 运维与维护

| 目标 | 文档 |
| --- | --- |
| 管理员、群友、模型与工具的权限边界 | [权限规则](../RULES.md) |
| 修改安全相关代码前了解威胁模型与检查要求 | [安全基线](guides/SECURITY_BASELINE.md) |
| 了解运行数据与隐私边界 | [隐私说明](guides/PRIVACY.md) |
| 查看用量、计价口径与控制台统计 | [令牌与花费](guides/TOKEN_USAGE_CONSOLE.md) |
| 预览控制台并运行离线界面检查 | [控制台测试](guides/CONSOLE-UI-TESTING.md) |

## 文档范围

- 根README介绍当前能力、安装入口、限制和各上游项目贡献；架构文档连接各实现模块，专题文档描述具体协议。
- 个人部署的账号、限额调整和临时审批测试规则不是公共默认值，也不随文档发布真实配置。
- 同级 `../voice-tool/` 为部分开发环境的独立工具，不随克隆提供；当前语音识别与媒体输出以内容/视频服务文档为准。
- 历史版本可通过Git记录追溯。旧设计、旧模式说明与当前实现不一致时，以本分支代码和对应专题为准。
