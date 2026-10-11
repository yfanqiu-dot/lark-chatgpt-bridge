# P4 部署开发与灰度运行手册

更新：2026-10-11。P3 已在本人确认的范围内关闭；P4 已实现部署基础、监督状态机和 Windows 只读预备入口，尚未切换常驻消费者。

## 首批实现

| 能力 | 行为 |
| --- | --- |
| 单群灰度 | `enabledChatIds` 限定监听控制器、消息、审批及项目记录同步范围；初始部署仅允许一个已有群 |
| 禁止新资源 | 灰度配置必须显式 `allowTopicCreation=false`；拒绝创建、接续创建和灰度配置下的绑定修复 |
| 启动预检 | 未找到选中群的活动绑定、项目归属改变或重复绑定时，在连接飞书之前拒绝启动 |
| 部署快照 | `prepare` 保存白名单配置、旧启动引用、文件 SHA 和账本状态计数，不复制任意配置字段或消息正文 |
| 变更检测 | `verify` 核对版本、配置、构建和原绑定；账本允许追加真实进展，不要求回到旧 SHA |
| 只读诊断 | `diagnose --native` 核对项目、任务身份、已完成历史、等待审批及分页队列；不提交模型输入 |
| 回退检查 | `rollback-check` 检查新 host/监听锁是否已释放；禁止用旧快照覆盖当前账本 |

未填写 `enabledChatIds` 的既有配置保持原多群行为。`allowTopicCreation` 默认保留现有创建能力；灰度配置不能沿用该默认值。名单外群不会启动控制器、恢复任务、处理卡片或同步项目记录，已有记录继续保留。

## 准备单群候选

Node.js 22 及以上。以下命令只准备文件或读取状态，不启动、停止服务，不调用飞书 API。

```powershell
node bin/lark-chatgpt-deploy.mjs prepare D:\bridge-local\deployment.json D:\bridge-local\stage-001
node bin/lark-chatgpt-deploy.mjs verify D:\bridge-local\stage-001
node bin/lark-chatgpt-deploy.mjs diagnose D:\bridge-local\stage-001
node bin/lark-chatgpt-deploy.mjs diagnose D:\bridge-local\stage-001 --native
node bin/lark-chatgpt-deploy.mjs rollback-check D:\bridge-local\stage-001
node bin/lark-chatgpt-deploy.mjs supervisor-prepare D:\bridge-local\stage-001 D:\bridge-local\supervisor-001
```

`prepare` 的目标目录必须不存在，父目录预先建立。失败后保留部分目录用于检查，不覆盖或自动删除。命令退出码：成功 `0`，检查失败 `1`，`rollback-check` 发现新运行锁未释放 `2`。回退检查的退出码0仅表示锁检查通过，仍需实际进程身份和唯一消费者核对。

`deployment.json` 结构：

```json
{
  "hostConfigFile": "D:\\bridge-local\\host.json",
  "topicConfigFile": "D:\\bridge-local\\topics-gray.json",
  "codeRevision": "0000000000000000000000000000000000000000",
  "artifactFiles": [
    "D:\\bridge\\dist\\desktop-host.js",
    "D:\\bridge\\dist\\desktop-topics.js",
    "D:\\bridge\\dist\\desktop-deploy.js",
    "D:\\bridge\\dist\\desktop-supervisor.js",
    "D:\\bridge\\dist\\desktop-supervisor-windows.js",
    "D:\\bridge\\bin\\desktop-runtime-control.ps1",
    "D:\\bridge\\bin\\desktop-package-broker.ps1",
    "D:\\bridge\\bin\\desktop-package-broker-task.ps1"
  ],
  "expectedToolNames": ["list_projects"],
  "legacy": {
    "scheduledTaskName": "LarkChannelBridge.Bot.codex",
    "executable": "D:\\nodejs\\node.exe",
    "entryPoint": "D:\\legacy\\bin\\lark-channel-bridge.mjs",
    "profile": "codex",
    "configFiles": ["D:\\legacy-local\\config.json", "D:\\legacy-local\\launcher.cmd", "D:\\legacy-local\\launcher-hidden.vbs"]
  }
}
```

示例中的路径、全零提交及最小工具名单均为占位；使用实际代码提交、全部运行文件及完整已验收工具目录。准备命令校验文件存在及 SHA，不查询 Git 服务证明提交归属，因此操作者须从已交付提交构建。Host 使用 P3 已验收的版本与二进制 SHA。Topics 使用同一 endpoint、connectionFile 和 registry，并指向原账本；增加一个选中群和禁止创建设置即可，不重建对话。

快照目录包含 `host.json`、`topics.json`、`legacy-launch.json` 和 `manifest.json`。前两项只保存明确配置字段，旧启动记录只保存计划任务名、路径和 profile，旧配置原文及认证数据仅计算 SHA，继续留在原位置。快照不是完整灾备包，也不是签名发布物；需要限制本机访问权限。仓库 `.p4-local` 被忽略，不上传本机身份与证据。

## 诊断结论的含义

| finding | 说明 |
| --- | --- |
| `desktop_lease_unavailable` | 共享桌面证明不存在、过期或无法验证；普通桌面模式下属于预期 |
| `tool_catalog_or_version_mismatch` | 工具目录、桌面版本或 CLI SHA 与部署基线不一致 |
| `project_unbound_or_unavailable` | 原生项目或对应根目录无法验证 |
| `native_binding_mismatch` | 原任务 ID、项目或根目录不匹配 |
| `history_incompatible` | 未找到持久化的已完成历史；不自动新建任务 |
| `permission_denied` | 原生 RPC 返回权限拒绝；不扩大权限或代为批准 |
| `protocol_unsupported` | 原生服务不支持所需读取方法 |
| `waiting_approval` | 实际原生状态含 `waitingOnApproval`，需要本人处理 |
| `native_turn_active` / `native_queue_pending` | 原生轮次活动或队列未清空，不能据此执行空闲切换 |
| `native_state_unavailable` | 原生连接或读取失败，状态不明 |
| `queue_busy` / `uncertain_paused` | 选中群账本有排队、运行、提交中或待核对记录 |
| `approval_card_pending` | 选中群持久卡片未关闭；不能代替原生待审批状态证明 |
| `saved_result_pending` | 已保存结果尚未尝试回传 |
| `original_delivery_receipt_unconfirmed` | 原发送已尝试但无回执；显式带ID的 `/result` 取回回执按 `savedResultsRetrieved` 计数，不伪填原发送回执；无ID取回不自动归到某一原消息 |

报告只输出状态计数和配置引用，不输出提示词、结果、原始错误、认证数据或 MCP 配置。`--native` 仅在新鲜租约且完整版本/工具基线一致时读取原生服务，使用 `project/list`、`thread/read`、`thread/turns/list`、`thread/queue/list`。原生身份及历史通过不意味着任务空闲；需同时核对 findings。

## 正式切换顺序（后续实现及现场验收）

### 已实现的监督基础

`supervisor-prepare` 要求新证据目录，核对当前唯一旧消费者、唯一普通桌面以及无新 host/监听/broker。它复核 PID、父 PID、创建时间、可执行文件和命令行 SHA，导出已校验的旧计划任务定义及原启用状态；不会启停服务或改变计划任务。任务动作必须是已记录的 `System32\wscript.exe` 和单一已验证 VBS 路径，不导出任意动作参数。启动脚本与认证配置仍留在原位置并以 SHA 核对；任务 XML 备份不代表完整凭据灾备。

监督状态机在每个变更前保存意图和进程身份，准入要求不超过5秒的原生空闲证明、原绑定对应、队列空、审批关闭及工具目录一致。旧消费者停止后还需再次核对桌面空闲。失败按监听、host、普通桌面、旧消费者、broker的顺序回退；普通桌面版本和工具证明未通过时不恢复旧消费者。发现陌生进程或 PID 复用时停止自动处理，避免误杀或双消费者。

监督器异常退出后，新实例等待写锁自然过期，从同一运行记录只执行回退；不继续前向切换、不删除活锁、不重放原请求。Windows 控制模块默认只允许清点、身份自检和任务备份，服务变更尚未接入可运行的生产监督器。

入口返回 `productionReady=false`。仍须实现普通桌面的真实原生空闲/队列探测、独立生产启动器和持续包内 broker 生命周期，再做现场切换及回退。独立 App Server 的持久历史或测试标志不能替代普通桌面的实时空闲证明。

1. 完整备份旧启动定义、非敏感配置及受保护凭据恢复方式；保留原账本、审批回执和历史失败，不替换为旧快照。
2. 准备独立生产监督器和包内启动器，脱离当前桌面会话生命周期；登录启动、正常停止和异常回退均保存实际身份、创建时间及工具证明。
3. 所有相关桌面任务空闲、原生队列空、审批关闭后停止旧消费者；复核旧消费者为零，再启动唯一新消费者。现有应用锁不能代替跨安装目录的实际进程检查。
4. 首先只启用原 C 群，话题创建关闭。旧消费者按同一机器人全局停止后，名单外群暂不由任何消费者处理；正式灰度窗口前明确此影响，再由本人发送全新标记验证普通文本闭环及桌面飞书工具。
5. 做一次同一窗口的受控回退：先停止新监听，再停止 host，确认普通桌面恢复；新进程/运行锁均清理后才恢复唯一旧消费者。自动回退不得重放模型输入或发送未知回执结果。
6. 扩群前逐群核对项目、历史可恢复性及待核对记录。A/B历史 `uncertain` 不因部署而清除；不能直接视为可迁移成功。完成单群灰度与回退后，才制定逐群扩展顺序。
7. 最后安排升级回归、CLI 依赖清理与旧启动项退役。飞书 CLI 仍供桌面工具使用，不能因旧消费者退役而一并删除。

当前命令不会自动执行以上服务切换。`rollback-check` 不终止进程、不恢复配置、不删除活锁、不启动旧服务，不作为故障回退已验收的证据。

## 验证与保留边界

首批新增13项 P4 专项测试，本轮新增18项监督状态机测试、1项独立进程恢复测试及2项 Windows 任务XML回归。Windows 本机全仓120个测试文件、817项通过，TypeScript、构建及 PowerShell 语法检查通过。Windows XML测试在其他平台跳过。独立进程测试实际终止临时监督进程，等待锁自然过期，再核对同一运行只回退；角色进程是隔离的测试进程，不连接飞书、不操作真实桌面或计划任务，不算真实桌面故障恢复验收。

首次真实任务备份预检发现 Windows 导出 XML 会省略默认 `Enabled=true` 字段，原错误已保留。读取改为核对实际 Task Scheduler 启用状态，并只排除该可切换字段计算定义 SHA；其他设置变化或 XML/实际状态矛盾仍拒绝处理。

上一批提交 `e8841b9` 的 Windows、Linux、macOS CI 已全部通过；本轮新增监督代码的 CI 需按其实际提交另行核对。

修复后的候选 `8ccbd7a` 已在真实 Windows 环境完成 `supervisor-prepare`：旧消费者1、普通桌面1，新host/监听/broker均0；实际计划任务XML和启用状态已备份。前后原进程身份、任务状态、全部原账本、registry及审批journal字节均未变。错误创建时间的身份自检实际被拒绝。证据保存在本机忽略目录 `.p4-local/supervisor-8ccbd7a/verification.json`；首次失败保留于 `.p4-local/supervisor-bab0889/failure.json`，未执行服务变更。

原C群本机候选 `6f2f1ad` 已通过实际 `prepare / verify / diagnose / rollback-check`：原绑定保留、C账本17条completed及3条failed，无queued/running/submitting/uncertain；A/B各一条历史uncertain不变，新运行锁未持有。原三次故障回传的无回执事实仍保留，其中C10/C12有带ID取回回执，C7有无ID `/result` 回执与既有现场对应证据。候选不把无ID取回自动归因，也不重发任何旧结果。普通桌面模式没有共享租约，诊断的 `desktop_lease_unavailable` 属预期；未运行共享原生诊断或真实飞书灰度。

P3 已接受的反向输入归属保护限制保持：群任务运行时桌面追加可能进入同一轮次，Bridge 对混合来源保持 `uncertain` 并暂停本群，不能承诺双向独立轮次。长时观察不作为P3关闭考核，本轮未执行。P4 的常驻上线、真实灰度、生产监督器接入、现场回退及扩群验收仍待完成。
