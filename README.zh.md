# QIU Bridge：在飞书里，继续电脑上的 AI 工作

**在飞书群里 @ 机器人，把工作交给电脑上的 Codex；收到文字结果，回到电脑后继续同一个项目、同一条真实对话。**

适合已使用 Codex 的个人用户：出门后整理草稿、会后梳理待办、分事项持续跟进，减少重复交代材料和背景。工作由自己的 Windows 电脑处理，需保持开机联网。

[下载 v0.9.5](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.9.5) · [安装配置](README.desktop.md) · [办公案例与提问模板](docs/office-workflows.zh.md) · [日常操作](docs/desktop-p4-deployment.md) · [English](README.md)

## 可以怎样用

| 场景 | 示例请求 |
|---|---|
| 周报草稿 | “根据项目里本周的记录，整理完成事项、风险和下周计划，缺少的信息标为待补充。” |
| 会议行动项 | “把下面粘贴的会议文字整理成事项、负责人、截止时间；未明确的内容写待确认。” |
| 客户会前准备 | “根据项目内已有的客户资料，列出已知需求、缺失信息和会上应确认的五个问题。” |
| 数据小结 | “如果能读取项目里的 sales.csv，按地区汇总销售额，检查空值，说明统计口径，保留原文件。” |
| 不同事项分别跟进 | 启用完整模式后，在入口群发送 `/topic new main 周报整理`，创建独立对话及对应私有群。 |

这些是提问示例，所用材料须能被运行 Bridge 的电脑访问。数据分析需要相应工具。飞书云文档、日历、任务和多维表格操作还需要 Codex 另行配置工具并授权，安装 Bridge 不会自动获得这些能力。[查看完整示例与使用流程](docs/office-workflows.zh.md)。

## 日常操作

在绑定群内 @ 机器人发送文字，说明材料、目标和限制；收到结果后可继续追问，回到桌面核对材料和产物。主要回传最终文字结果及支持的审批通知。

| 命令 | 用途 |
|---|---|
| `/status` | 查看运行、排队、待核对和审批情况 |
| `/steer 补充要求` | 给当前活动轮次补充指令 |
| `/stop` | 请求停止本群任务；已启动的外部命令可能继续运行 |
| `/result [消息编号]` | 取回已保存结果，不重新执行任务 |
| `/reconcile` | 按原请求核对不确定状态 |

新建话题需在已启用该功能的入口群使用；`main` 是项目标识，应按自己的配置替换。“话题”对应独立 Codex 对话和飞书群，不是群内消息串。延迟或未回复时先查状态，不要连续重复发送同一项工作。

## 如何开始

1. 准备 Windows x64、Node.js 22 LTS、已登录的 Codex 桌面及自己的飞书机器人。
2. [下载安装包](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.9.5)，按[安装指南](README.desktop.md)配置项目和真实桌面对话，先验证一个群。首次配置需要一定命令行经验。
3. 再设置登录入口；需要更多话题或项目时，按[运维说明](docs/desktop-p4-deployment.md)启用并验证完整模式。

从 `QIU New Bridge` 入口启动，等待检查就绪后使用。正常退出受管 Codex 时，消息渠道也关闭。桌面版通过 GitHub Releases 分发；npm 上的 `lark-channel-bridge` 不是本桌面版安装入口。

## 版本与边界

当前为 **v0.9.5**，修复登录入口的 PowerShell 模块路径兼容问题，并支持已完整恢复的健康故障经重新核对后进入新一轮启动。启动失败会记录脱敏诊断并提示，见[版本说明](docs/releases/v0.9.5.md)。

支持范围是 Windows x64、单个配置所有者、已登记群的文字交互。图片附件、桌面全部消息镜像、多用户托管和长期无人值守保证不在本版支持范围。各项工作仍受 Codex 工具及权限约束；本机验收遇到的 Windows 沙盒 `setup refresh had errors` 问题尚未修复，审批后执行已验证成功。新安装及 Codex 升级均需重新核对，详见[兼容性与限制](docs/compatibility.md)。

个人配置、消息账本和凭据不随源码或发布包分发。请求和结果仍会经过飞书及所配置的 Codex 服务，处理业务资料前请确认工具、平台及授权范围适用。

## 开发与来源

[开发设计与验收摘要](docs/development.md) · [原独立 CLI 后端说明](docs/cli-backend.zh.md) · [安全说明](SECURITY.md) · [问题反馈](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/issues)

源码构建：检出 `v0.9.5`，运行 `npx --yes pnpm@10.33.0 install --frozen-lockfile` 和 `npx --yes pnpm@10.33.0 build`；开发检查使用 `pnpm test`、`pnpm typecheck`、`pnpm build`。

基于 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 开发，采用 [MIT 许可证](LICENSE)。社区第三方集成，非 OpenAI 或飞书官方产品。问题反馈请移除密钥、私人对话和业务账本。
