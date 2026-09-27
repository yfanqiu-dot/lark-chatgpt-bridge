# lark-chatgpt-bridge · 多话题开发版

P2 增加显式话题创建：在入口群 `@QIU /topic new <projectKey> <名称>`，机器人为该项目创建一条原生 Codex 桌面对话，并创建包含本人和机器人的私有普通飞书群。此后该群的文字消息进入对应对话。每群沿用 P1 的独立账本、状态、停止、追加和审批逻辑；普通追问不会创建新资源。

**状态：P2 已完成受控现场验收，P3 稳定性开发已启动，尚未正式切换。** 旧 bridge 仍是日常唯一消息消费者。只在受控测试窗口停止旧消费者、启动共享桌面与新版入口，结束后恢复。P2 证据见 [验证记录](docs/desktop-p2-validation.md)，P3 范围和待验收项见 [P3 开发与验收](docs/desktop-p3-progress.md)。

## 配置

复制 [topics.example.json](examples/desktop/topics.example.json) 和 [host-topics.example.json](examples/desktop/host-topics.example.json) 到本机私有位置，填写真实值；不要提交密钥、账本、连接证明或真实群记录。`projects` 是允许新建话题的原生桌面项目白名单；`projectId` 必须来自 App Server，`projectRoot` 必须与项目实际根目录一致。`entryChatId` 是接受建话题命令的现有群。可选 `existing` 保留 P1 原群与原任务，`stateFile` 必须指向其原账本，不能复制为新群账本。

Host 的 `topicRegistryFile` 要与 P2 的 `registryFile` 相同，`topicProjects` 列出可接续的新项目。Host 对注册表中任务的桌面恢复会再次核对任务 ID、项目 ID 和根目录；未经登记的桌面任务不会被修改。Host 的原 `toolBindings` 继续负责已有 P1 任务。`appSecretEnv` 仅是密钥环境变量名，实际值从本机安全存储注入。

项目根目录下的 `.lark-chatgpt-bridge/index.md` 和 `topics/<chatId>.md` 保存可读索引与已持久化的原生对话文字。该目录自带 `.gitignore`，避免将私人群内容意外提交。新绑定激活时同步一次，运行期间每分钟刷新；未完成轮次、工具明细和附件不会写入 Markdown，桌面原生历史仍是准据。

Codex 空任务在创建连接关闭后可能没有可恢复的对话历史。P2 因此先以 `thread_initializing` 记录新任务 ID，再在同一连接命名并完成一轮明确标记为 QIU bridge 初始化的简短对话，核对持久化历史后才建飞书群。该初始化轮次可在桌面历史中看到，但不会作为用户消息导出到项目 Markdown 记录。若初始化结果不明，需先核实该任务已有完成轮次，再用离线修复入口续办，不重建同一任务。

## 使用与恢复

在共享 host 已启动、旧 bridge 已暂停的受控窗口：

```powershell
node bin/lark-chatgpt-topics.mjs C:/bridge/topics.json --check
node bin/lark-chatgpt-topics.mjs C:/bridge/topics.json --run
```

`--check` 只核对项目和桌面临时工具连接，不连接飞书。`--run` 使用 QIU 机器人身份创建群；必须已开通 `im:chat:create`，且机器人能邀请配置中的本人。创建完成后入口群收到新群 ID 和桌面对话 ID。新群消息默认仍需 `@QIU`。机器人是群创建者并自动入群，本人作为成员明确加入；群成员核验未通过时不会激活绑定。

创建按原飞书消息 ID 去重。若资源 ID 已落盘而下一步失败，`@QIU /topic resume <原消息ID>` 从该步骤续办。若 `thread/start` 或建群的响应丢失，注册表分别停在 `thread_creating` 或 `chat_creating`；**先人工核实确切资源及其归属**，停止 P2 消费者后才可执行：

```powershell
node bin/lark-chatgpt-topics.mjs C:/bridge/topics.json --repair-thread <原消息ID> <已核实threadId>
node bin/lark-chatgpt-topics.mjs C:/bridge/topics.json --repair-chat <原消息ID> <已核实chatId>
```

修复入口会读取真实任务项目或群成员，再保存 ID；之后在入口群发送 `/topic resume <原消息ID>`。不能在结果不明时再次发送新的建话题消息来“重试”。这套状态机保证同一已登记请求不盲目重建，不声称飞书与 Codex 跨系统严格 exactly-once；任意崩溃与长时稳定性留给 P3。

关闭 P2 消费者可 Ctrl+C，或在另一终端运行 `node bin/lark-chatgpt-topics.mjs C:/bridge/topics.json --stop`。等它退出，再按 [P1 运行说明](README.desktop.md)停止共享 host 并验证普通桌面、旧 bridge 已恢复。不得让新旧两个消费者同时监听同一机器人。

## 恢复与 P3 验收

重启时，对账本内已知 `turnId` 的未完成任务自动恢复订阅并核对一次，成功后继续排队任务；不会再次调用 `turn/start` 执行原请求。若没有 `turnId` 或核对失败，仍暂停该群新请求，使用 `/reconcile` 或桌面核实。回传回执不明时不自动重发，使用 `/result` 读取已保存结果。

审批卡片回执保存在注册表旁的 `.approvals.json`，单群入口则放在账本旁。该文件不保存审批决定。进程重启后旧卡片失效，已知回执的卡片会关闭，关闭失败每 5 秒重试。发送成功与否不明且无回执的卡片无法自动关闭，也不会再次发送；旧按钮在后端会被拒绝。`/status` 显示本群回传待核对数、审批卡片待关闭数和回执不明数。上述文件均属本机私人运行状态，不提交仓库。

P3 现场仍需验证两端同时操作、真实 desktop/host 重启、审批中断线、回传网络故障和插件兼容；持续运行时长与故障窗口按 [P3 验收清单](docs/desktop-p3-progress.md) 执行。离线测试和真实子进程退出测试不能替代飞书与桌面的现场证据。
