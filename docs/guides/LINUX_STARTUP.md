# Linux 开机启动与 QQ 事件连接

开机后应分别检查 systemd 服务、DSH 就绪和 QQ 事件连接。`active (running)` 表示进程存活，QQ 事件接收还需要实际 WebSocket 连接与事件包。

## 启动等待

使用仓库中的就绪检查作为 Bridge 的 `ExecStartPre`。该脚本复用现有 OneBot 凭据发现逻辑，使用 WebSocket 凭据完成握手，然后经该连接调用 `get_status`，确认 `online=true` 与 `good=true`。HTTP 与 WebSocket 凭据分别处理，配置的固定端点规则同样生效。

在仓库目录手动检查可以执行以下命令。检查只读，输出固定状态文字。

```sh
node scripts/wait-onebot-ready.mjs
```

默认总等待时间为 120 秒，每次探测之间等待 2 秒。超时返回失败，可配合服务的 `Restart=on-failure` 和 `RestartSec=5` 重试。`TimeoutStartSec` 应留出余量，例如 150 秒。QQ 重新登录需要人工处理时，等待会明确失败并重试。

以下单元片段使用合成路径，安装时替换为实际的固定 Node 运行时和仓库路径。已有单元中的环境变量、工作目录、DSH 依赖和其他启动检查应按实际配置保留。

```ini
[Service]
ExecStartPre=/opt/node/bin/node /opt/qq-bridge/scripts/patch-snowluma-sdk.mjs --root=/opt/qq-bridge
ExecStartPre=/opt/node/bin/node /opt/qq-bridge/scripts/wait-onebot-ready.mjs --root=/opt/qq-bridge
TimeoutStartSec=150s
Restart=on-failure
RestartSec=5
```

现有配置若含只探测 TCP 端口的旧检查，应将其替换为上述就绪检查。systemd drop-in 中可以先用空的 `ExecStartPre=` 清除旧列表，再依次添加需要的检查。用户服务需启用，并通过 `loginctl show-user "$USER" -p Linger` 确认用户管理器可以随开机运行。

## 首次连接失败后的恢复

SnowLuma SDK 1.14.20 在 Node 的 WebSocket 初次握手只触发 error、没有 close 的情况下，会留下未结束的连接 Promise，后续重试也无法推进。开机时端口刚开放、OneBot 尚未就绪便可能触发该场景。

仓库的 `postinstall` 补丁会结束失败的初始连接、清理监听器，并进入 SDK 原有退避重连流程。补丁可重复执行。遇到无法识别的 SDK 实现会明确报错，升级依赖后应运行恢复测试核验。启动前再执行一次补丁，可让服务启动同时检查该依赖修复。

```sh
node scripts/patch-snowluma-sdk.mjs
npm run test:onebot-recovery
```

## 核对结果

```sh
systemctl --user is-enabled dsh.service qq-bridge.service
systemctl --user is-active dsh.service qq-bridge.service
journalctl --user -b -u qq-bridge.service --no-pager
```

控制台状态应同时显示 DSH 就绪、QQ 在线和健康，并持续收到新的网关事件。日志中的「SnowLuma 已连接」与后续心跳可核实事件连接。运维诊断应仅导出必要状态和时间，聊天正文、凭据与完整思考保留在主机。

曾经一次恢复正常只能验证当前连接。开机启动还应结合服务的自动启用配置、真实就绪检查和失败重试测试，最后在计划内的主机重启后复核。
