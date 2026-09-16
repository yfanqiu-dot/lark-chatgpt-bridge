# lark-chatgpt-bridge · P1

让飞书群成为 **Codex 桌面应用** 同一条对话的入口。项目名称保留 `chatgpt`，当前实现目标是 Codex 桌面，不是另一个 ChatGPT 消费端应用。

本阶段提供一个群、一个所有者、一个已存在项目对话的固定绑定。新建群/对话、项目记录导出属于 P2。

**状态：P1 本机实现与自动化测试已交付；真实飞书三轮对话及桌面接续验收尚未执行。** 不能把测试通过解释为已部署。具体证据见 [P1 验证记录](docs/desktop-p1-validation.md)。

## 已实现的行为

- 仅接收登记群内所有者的文字消息，默认必须 `@机器人`；普通消息逐条排队，按 `messageId` 去重。
- 核对真实 `projectId`、项目路径和 `threadId`，连接桌面正在使用的同一个 App Server。没有旧 CLI 回退。
- 桌面正在运行时先等候；只在目标轮次结束后，从分页历史读取最终回复并回到原消息位置。
- `/status`、`/stop`、`/steer`、`/result`、`/reconcile` 和审批卡片。
- 命令/文件审批核对请求和所有者；同意仅限显示了具体操作的请求。详情过长或缺失时要求到桌面确认。特殊权限、MCP 表单及模型追问提示回桌面处理。
- 执行前落盘，结果落盘后才发送。未知提交不重跑；已尝试但回执丢失的回复不盲目补发，可用 `/result` 查询。
- Windows 共享启动器固定二进制 SHA-256 和桌面安装版本；发现真实工具管道并保留安装版审批规则。临时连接证明有效期 60 秒，配置刷新/断线立即撤销。

## 安装与配置

需要 Windows、Node.js **22 或更高**、已登录的兼容 Codex 桌面。P0/P1 本机基线为 `26.908.9136.0`；升级后需重新验证，不只检查 CLI 版本字符串。

```powershell
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 build
```

复制 [host.example.json](examples/desktop/host.example.json) 和 [bridge.example.json](examples/desktop/bridge.example.json) 到本机专用目录并填写绝对路径。不要提交真实配置、会话账本、工具管道或密钥。仓库的 `.p1-local/` 和 `*.local.json` 已忽略。

`host.json` 中：

- `codexBinary` 与 `codexSha256` 指向经过验证的桌面配套二进制。
- `desktopExe`、`desktopVersion` 指向对应 WindowsApps 安装包。
- `endpoint` 是桌面和 bridge 共用地址；`backendEndpoint` 是启动器内部后台地址，两者必须不同且仅监听回环地址。
- `connectionFile` 是启动器维护的临时证明，禁止手工填写旧 PID/管道。

`bridge.json` 中填写实际 `chatId`、本人 `ownerOpenId`、原生 App Server `projectId`、`projectRoot` 和已有 `threadId`。原生项目 ID 与桌面工具返回的旧项目 ID 不能混用。`connectionFile`/`endpoint` 要与 host 相同；`stateFile` 必须独立保存，运行后不可换群继续沿用同一账本。`model` 可省略以沿用对话配置。

`appSecretEnv` 只记录密钥环境变量名，例如 `LARK_APP_SECRET`。从本机安全存储注入值，不把值写入示例、脚本或 Git。`--check` 不需要飞书密钥。

## 启动和回退

关闭桌面之前，先独立验证后台启动参数和实际就绪状态：

```powershell
node bin/lark-chatgpt-host.mjs C:/bridge/host.json --check-server
```

此检查会短暂启动本机测试后台，读取 `/readyz` 后停止该子进程，不接管桌面、不执行模型轮次或连接飞书。通过后才安排完整切换。WebSocket 客户端地址可带末尾 `/`，启动器传给 CLI 的 `--listen` 会使用不带路径的 `ws://IP:PORT`。

先结束桌面中的运行，再关闭普通 Codex 桌面。在独立 PowerShell 中操作；不要从将被关闭的桌面对话中直接启动生命周期切换。

```powershell
node bin/lark-chatgpt-host.mjs C:/bridge/host.json --check
node bin/lark-chatgpt-host.mjs C:/bridge/host.json --start
```

启动器拒绝在已有普通桌面运行时接管。收到 `Shared desktop and tool catalog ready.` 后，在另一个终端运行：

```powershell
node bin/lark-chatgpt-bridge.mjs C:/bridge/bridge.json --check
node bin/lark-chatgpt-bridge.mjs C:/bridge/bridge.json --run
```

`--check` 只读核对项目/对话及临时连接证明，不连接飞书、不执行模型轮次。`--run` 才开始消费飞书事件。**同一机器人只能有一个消息消费者**；开始测试前先确认旧 bridge 已停止消费，并让新旧实例使用相同 `LARK_CHANNEL_HOME`。程序复用上游应用锁，但无法阻止其他电脑、旧版无锁消费者或另一个配置目录的实例。

停止时先在 bridge 终端按 Ctrl+C，等待它停止自己发起的轮次并断开飞书，再执行：

```powershell
node bin/lark-chatgpt-host.mjs C:/bridge/host.json --stop
```

外部协调程序也可先调用 `node bin/lark-chatgpt-bridge.mjs C:/bridge/bridge.json --stop` 请求 bridge 正常退出，再停止 host；该停止入口不要求桌面仍在线。

启动器结束自己创建的桌面与后台进程，确认退出后请求普通桌面启动；不删除历史。看到请求恢复日志后还需确认普通桌面实际打开。强制结束启动器或电脑断电不保证自动恢复，属于后续故障演练范围。

仅核对已有桌面工具目录、不启动共享服务：

```powershell
node bin/lark-chatgpt-host.mjs C:/bridge/host.json --check-tools <当前桌面主进程PID>
```

## 群内命令

默认都需要 `@机器人`。

| 输入 | 行为 |
|---|---|
| 普通文字 | 排队继续绑定对话，不把多条消息合成一轮 |
| `/status` | 当前状态、排队数量、待核对数量、审批编号 |
| `/stop` | 只停止本 bridge 的当前轮次；排队请求保留；不停止桌面独立发起的轮次 |
| `/steer 补充内容` | 向当前飞书轮次追加要求，校验当前 turnId |
| 审批卡片按钮 | 同意本次、拒绝或取消；过期/重复/非所有者点击会被拒绝 |
| `/approve 编号 accept\|decline\|cancel` | 卡片的文字命令入口，遵守相同权限和可选决定范围 |
| `/result [messageId]` | 读取已保存结果，不再请求模型执行 |
| `/reconcile` | 重新核对已知 turnId 的待核对任务，不重新提交 |

若 `turn/start` 已发送却没拿到 turnId，程序暂停新请求，提示在桌面核对。P1 不提供“假定没执行并重发”按钮。此时需由维护者核对历史、备份账本并明确原消息结果后处理；不得直接删除账本解除暂停。

## 实现位置与阶段取舍

新增入口位于 `src/desktop/`，复用上游 `@larksuite/channel`、原子写入和应用锁。P1 未把桌面后端塞入原有 CLI 的“进程退出即任务完成”执行器，也未注册到旧 profile/web console；通过独立 bin 明确选择桌面方式。原入口仍可用，两者不能同时消费同一机器人。

消息账本暂用原子写入 JSON，配合单进程锁与串行调度。每轮的提交/运行/结果/回执分开保存。这满足固定单群的 P1，不宣称分布式事务或 exactly-once；SQLite、跨资源新建恢复和多群调度留给后续阶段。

测试命令：`pnpm test:desktop`、`pnpm typecheck`、`pnpm build`。P0 的 `node:test` 原型使用 `pnpm test:p0` 单独运行。真实飞书联调使用 [验收步骤](docs/desktop-p1-acceptance.md)，不会随单元测试自动连接机器人。

当前边界：仅文字输入和最终回复；不支持图片附件、自动建群、自动导出、桌面消息全量镜像和无人值守开机服务。回环端口依赖本机可信用户边界，不代表完成多用户鉴权或生产加固。电脑/后台崩溃和全部客户端失联的可靠恢复在 P3 验证。
