# QIU Bridge：让飞书成为 Codex 桌面对话的入口

在飞书群里向电脑上的 Codex 发出指令，收到处理结果；回到电脑时，继续的仍是**同一个项目、同一条真实桌面对话**。

[安装配置](README.desktop.md) · [日常使用与运维](docs/desktop-p4-deployment.md) · [兼容性与限制](docs/compatibility.md) · [下载版本](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases) · [English](README.md)

## 可以用它做什么

- 离开电脑后，通过飞书继续已有项目的工作，例如整理材料、修改代码、查询信息。
- 同群消息沿用已绑定的桌面对话，最终结果回到飞书；回到桌面可以继续处理。
- 查询状态、补充指令、停止当前轮次，以及处理支持的审批卡片。
- 在本地保存消息、任务、结果和回执的对应关系；提交结果不确定时暂停核对，避免盲目重复执行。
- 通过一个 Windows 登录入口启动；正常退出受管 Codex 后，Bridge 也保持关闭。故障时保存证据，并尝试恢复普通 Codex。

Bridge 安装在**自己的 Windows 电脑**上，使用自己登录的 Codex 和自己配置的飞书机器人。电脑需要保持开机联网。它是社区开发的第三方集成，并非 OpenAI 或飞书官方产品。

## 如何开始

1. 从 [Releases](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases) 下载 `qiu-bridge-v0.9.3-windows-x64.zip`，包含构建产物和运行依赖；电脑需另装 Node.js 22 LTS。
2. 按[安装配置指南](README.desktop.md)准备机器人、原生项目与对话标识，用安装准备工具生成自己的配置。首次配置需要一定命令行经验。
3. 先验证一个群的收发和桌面接续，再设置登录入口，按[运维说明](docs/desktop-p4-deployment.md)日常使用。

也可以从源码构建：

```powershell
git clone https://github.com/yfanqiu-dot/lark-chatgpt-bridge.git
cd lark-chatgpt-bridge
git checkout v0.9.3
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 build
node bin/lark-chatgpt-setup.mjs --help
```

本分支通过 GitHub 发布。**不要把安装 npm 上的 `lark-channel-bridge` 当成安装本桌面版**；两者入口和会话机制不同。保留的包名用于兼容，本仓库关闭了 npm 发布。

## 当前版本与支持范围

`v0.9.3` 将缺失进程信息的补查合并为批量查询，避免工具和控制台子进程集中退出时逐个查询耗尽扫描时效。原生身份、退出证明和五秒时效要求保持不变。包含 v0.9.2 的全部子进程退出证明、健康失败后提交前阻断，以及 v0.9.1 的新话题初始化与原请求接续修复。详见[补丁说明](docs/releases/v0.9.3.md)。

`v0.9.0` 增加完整功能的受管部署：入口群、全部已登记话题群、配置项目内的新建话题与接续、各群独立收发和控制、支持的审批卡片。在入口群使用 `/topic new <projectKey> <名称>`，会创建该项目的真实 Codex 对话和对应飞书私有群。首次安装仍默认单群；按[完整功能部署](docs/desktop-p4-deployment.md#完整功能部署-v090)显式启用。新增绑定可继续运行并在下次启动时复用，原绑定仍保持不变；历史不确定任务须先按原任务证据核对。详见[版本说明](docs/releases/v0.9.0.md)。

`v0.8.2` 补充新版 Codex 临时内部对话的队列兼容：只识别未绑定、空闲临时对话的精确原生拒绝；绑定和持久对话仍完整检查队列，活动任务、审批、未知错误和身份变化仍拒绝启动。详见[修复说明](docs/releases/v0.8.2.md)。自动打开后还有启动检查，先保持桌面空闲，实际就绪再使用。

`v0.8.1` 修复短暂断线导致立即暂停的问题：同一个飞书连接最多等待三分钟重连，连接稳定后才放行新的模型提交；超时或身份校验异常仍会暂停。也兼容新版 Codex 的桌面工具管道。详见[修复说明](docs/releases/v0.8.1.md)。

首版 `v0.8.0` 的运行核心已通过真实 Windows 登录、启动、正常退出、持续关闭五分钟、手动重入、延迟退出回执和清理验证。现场验收范围是一个已存在的群、一个所有者。`v0.8.1` 已有自动回归和新版只读兼容核对，升级后仍需重新完成现场验收。macOS/Linux 通过代码测试和构建，不代表桌面运行支持；目前桌面版支持 **Windows x64**。

默认安装先验证单群；完整模式开放登记群、新话题及多项目路由，仍需核对自己的项目、对话和群归属。图片附件、桌面全部消息镜像、多用户托管和长期无人值守保证不在本版桌面支持范围；短时验收也不能替代长期运行观察。详见[兼容性与限制](docs/compatibility.md)。

```text
飞书群 → 本机消息监听 → 共享 App Server ← 受管 Codex 桌面
                ↓
         本地消息记录与回执
```

程序核对桌面版本、程序 SHA-256 和完整工具目录。升级后若不匹配会拒绝启动，需要重新验证。配置、消息记录和凭据保存在个人电脑上，不上传公开仓库。

## 开发与来源

```powershell
npx --yes pnpm@10.33.0 test
npx --yes pnpm@10.33.0 typecheck
npx --yes pnpm@10.33.0 build
```

本项目基于 [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 开发，保留原项目独立 CLI 后端，参阅[原 CLI 中文说明](docs/cli-backend.zh.md)。其中的 daemon 命令属于独立 CLI 后端，不会启动共享桌面版。

MIT 许可证，见 [LICENSE](LICENSE)。问题反馈请提交到 [Issues](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/issues)，附复现步骤和脱敏诊断；不要附密钥、私人对话或完整业务账本。
