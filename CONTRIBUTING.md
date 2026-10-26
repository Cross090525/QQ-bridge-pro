# 贡献指南 / Contributing

感谢你考虑为 QQ-bridge-pro 提交改进。项目通过 GitHub Issue 和 Pull Request 协作；请向仓库的默认分支提交 PR。维护者会先审查变更，再决定是否合并。

## 开发流程

1. 提交较大改动前，先开 Issue 说明问题、预期行为和方案；小型文档修正可以直接发 PR。
2. Fork 仓库，在默认分支的最新提交上创建独立分支，例如 `feat/<topic>`、`fix/<topic>` 或 `docs/<topic>`。
3. 安装当前受支持且已包含安全修复的 Node.js 版本，然后运行 `npm ci`。
4. 完成改动后运行 `npm run self-test`，并根据改动范围选择相关的 `npm run test:*` 命令。需要 QQ 网关、外部服务或真实账号的端到端脚本，应只在自己的测试环境中运行；不要把个人凭据放进 PR。
5. 推送到自己的 Fork，向仓库默认分支创建 PR。PR 描述请填写变更目的、主要内容和验证结果。

提交历史建议使用简洁的 Conventional Commits 风格，例如 `fix: ...`、`docs: ...` 或 `feat: ...`。

## 提交身份与隐私

- 如需隐藏个人邮箱，在 GitHub 的 Email 设置中启用隐私选项，并把 Git 的本地 `user.email` 配为该页面提供的 noreply 地址。不要把个人邮箱写进提交记录。
- 提交前检查暂存区和提交内容。不要加入 `config.json`、`.env`、运行状态目录、日志、访问令牌、QQ 账号标识、私人服务器地址、本机绝对路径或含个人信息的截图、音视频素材。
- 新增依赖、外部服务或模型前，说明用途、来源、许可证和运行时影响。
- 引用或改编其他项目时保留其版权与许可声明，并确认许可证兼容；来源记录见 [许可证来源](docs/LICENSE_PROVENANCE.md)。

## Pull Request 审查

- PR 应聚焦一个问题，说明对用户可见的行为变化和可能的兼容性影响。
- 修复问题时尽可能提供复现步骤或回归验证方式；涉及界面变化时附上不含隐私信息的截图。
- 当前仓库没有配置 GitHub Actions 检查。提交者需要在 PR 中列出已运行的本地检查；维护者审核通过后再合并。
- 如果以后添加面向 Fork PR 的 CI 工作流，应使用最小只读权限，不向外部 PR 暴露仓库密钥或部署凭据。

## English summary

Use Issues for larger changes and submit focused Pull Requests against the repository's default branch. Fork the repository, branch from its latest default-branch commit, install a supported Node.js release with current security fixes, run `npm ci`, then run `npm run self-test` and checks relevant to your change. Keep credentials and private data out of commits. Use the GitHub-provided noreply address if you want to keep your personal email private. Preserve upstream notices and check license compatibility when reusing code. The repository currently has no GitHub Actions checks, so include the local commands you ran in your PR description.
