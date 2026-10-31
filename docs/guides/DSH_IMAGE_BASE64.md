# DSH MCP 大图兼容修复

部分 DSH `dsh-mcp-client` 使用重复分组正则校验 MCP 图片的 base64。较大字符串可能在校验时触发 `Maximum call stack size exceeded`，使原本正确的图片被投影成 `[image unavailable: ...]`。桥接下载成功和工具调用成功都不能证明模型已得到图像。

本项目的 `scripts/patch-dsh-image-base64.mjs` 只修复已识别的实现：使用扁平字符校验，补充字符串类型与4字符对齐检查，保留原有 Buffer 解码再编码一致性检查。不会放宽 base64 别名、空白、填充位等约束，也不改变附件存储、图片大小、模型视觉能力或权限检查。

```sh
node scripts/patch-dsh-image-base64.mjs --file /path/to/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js
```

也可通过 `DSH_INSTALL_MODULES` 指定 node_modules 根目录后省略 `--file`。脚本先备份原文件，输出备份路径；重复执行不修改已修复文件；上游实现不匹配时拒绝修改。安装完后重启 DSH，桥接重连即可。DSH 升级或重装可能覆盖修复，需要重新核对；本脚本不自动覆盖陌生的上游版本。

回滚时将脚本输出的备份文件复制回原 `index.js`，再重启 DSH。

`node --test scripts/test-dsh-image-base64.mjs` 验证大字符串、非法输入、备份及幂等性。真实 NASA PNG 对照试验在服务器 Node v24.22.1 运行时复现：1,698,509字节小图正常；6,166,086字节原图在旧校验下变为栈溢出占位文字。该大小是实验样本，不是固定故障阈值。
