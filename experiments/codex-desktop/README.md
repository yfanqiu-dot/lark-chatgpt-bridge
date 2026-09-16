# Codex Desktop 接入原型（P0）

上游基线：`589868119ce9a0a860aaf4936b5f9bac14e72681`，package version `0.7.1`。本目录尚未接入生产 profile 或启动飞书消息消费。

## 已验证的技术方向

- 桌面与 bridge 连接同一个 App Server，使用真实 projectId / threadId。
- 桌面重启后，本地工具管道地址会变化。不能从旧任务继承地址。
- 按 Windows 管道服务端 PID 匹配已核验的桌面主进程，再通过已安装 MCP 插件的 tools/list 确认唯一桌面工具目录；不枚举或调用其他应用的服务。
- 每次接续任务时使用新验证的地址构建完整 `mcp_servers.codex_app` 临时定义。实测可调用 list_projects；只设置 plugin-scoped env 字段未生效。
- 保留安装版工具的审批配置，让运行时生成真实任务元数据；不伪造 thread/turn 身份，不写桌面私有数据库。

`connection.mjs` 提供启动环境清理、短时有效的工具地址绑定、临时工具配置和本机连接检查。接收的 PID、目录和插件定义必须由本机发现层验证后提供，不能直接采用群消息中的值。

验证：`node --test experiments/codex-desktop/connection.test.mjs`。当前真实模型验证记录在主项目的 `tmp/p0-desktop-native/tools-result.json` 和 `tools-config-full-result.json`。

## 接入上游的位置

| 源码模块 | 二次开发内容 |
|---|---|
| `src/agent/types.ts` | 新 adapter 实现 AgentRun；waitForExit 在共享模式等待目标轮次收尾，不能等待或结束共享进程 |
| `src/agent/codex/adapter.ts` | 保留原CLI实现；旁边新增 codex-desktop adapter，通过JSON-RPC收发 |
| `src/runtime/agent-runtime.ts` | 根据显式配置构造新adapter，失败不能静默回退旧CLI |
| `src/runtime/run-executor.ts` | 对接turn完成、断线待核对和目标停止；保持现有队列机制 |
| `src/bot/group.ts` | 复用机器人建群邀请用户流程，加入桌面项目与任务绑定事务 |
| `src/config/profile-schema.ts` | 新后端、共享地址、项目绑定；不把瞬时管道地址当永久配置 |

2026-09-14共享桌面联合实测已通过双向接续、list_projects实际调用、active状态、steer、目标停止、外部WebSocket重连及审批拒绝。证据位于主项目tmp/p0-shared-desktop/acceptance-*.json，详见主项目output/feishu-codex-p0-result-20260914.md。组合control文件整体ok:false：其中steer成功，后续停止遇到no active turn；acceptance-active-stop.json另行验证了明确active后的定向停止，不能掩盖原失败。

2026-09-15 P0收尾已通过：补齐FEISHU侧栏/消息画面、普通恢复后真实list_projects；升级版桌面26.908.9136.0共享工具实测成功。真实审批accept产生固定命令输出和退出码0，cancel中断轮次，双方收到resolved；发起连接断开再连获得原请求，存活observer取消后双方同步。证据位于主项目tmp/p0-closeout及tmp/p0-closeout-shared，后者closeout-summary.json由p0-closeout-verify.mjs核对实际工具项与事件生成。每轮恢复读到的原审批配置，无持久允许。

完整适配器、飞书单群闭环及审批交互属于P1，自动建群与项目记录导出属于P2。服务崩溃、全部客户端断线、同时审批、电脑重启恢复及完整插件兼容性属于P3；直接键盘提交未通过，不冒充人工输入成功。不能把本原型当作已完成部署。停止遇到终态竞态应重新读取指定轮次；不得终止共享进程。结果读取须支持full items分页，不能只依赖桌面空摘要。
