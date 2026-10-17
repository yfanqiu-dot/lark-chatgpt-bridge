# Windows 桌面版安装配置

适用于 QIU Bridge v0.9.4。首次配置面向具备命令行经验的用户，需要确认本机版本、飞书权限和原生对话归属。不要复制他人的配置、凭据或账本。

## 1. 准备环境

安装过程会重新打开受管 Codex。自动打开后还需要完成后台检查，先保持桌面空闲，不要立即在 Codex 或飞书发任务；检查通过才开始使用。详见[启动与退出](docs/desktop-p4-deployment.md#启动与退出)。

- Windows x64、Windows PowerShell 5.1、Node.js 22 LTS。
- 已安装并登录的 Codex 桌面，包含 `codex-app-tools` 插件及 `Invoke-CommandInDesktopPackage` 能力。已验收版本见[兼容表](docs/compatibility.md)。
- 自己的飞书应用机器人，启用长连接事件订阅，订阅 `im.message.receive_v1`、交互卡片回调 `card.action.trigger`，具备读取群内 @ 消息、以机器人发送消息和卡片的权限。将机器人加入测试群，并完成应用权限发布。首版现场验证仅覆盖飞书国内租户。
- 一条已存在的桌面项目对话，以及群 `chat_id`、本人在此应用下的 `open_id`。
- 电脑开机联网，无其他消费者同时接收同一飞书应用消息。旧 CLI 后端应先停止并停用，保留配置和记录。

下载 [Windows 运行包](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases)，解压到固定目录，如 `D:\QIUBridge\v0.9.4`。以下命令在此目录执行。包内包含构建产物和生产依赖，不包含 Node.js、Codex、机器人或个人数据。也可按[首页](README.zh.md)从源码构建。

## 2. 保存机器人凭据

```powershell
node bin/lark-channel-bridge.mjs secrets set --app-id cli_YOURAPPID --profile codex-desktop
```

按提示输入 App Secret。凭据使用项目的加密凭据库，受当前 Windows 用户边界保护。不要将密钥放进配置、命令参数、截图或仓库。这里仅使用 CLI 的凭据功能，不启动旧消息监听器。`deployment.json` 的 `legacy` 是历史字段名，新安装工具将凭据入口指向本运行包，无需另一份旧包。

## 3. 读取桌面工具基线

保持普通 Codex 打开，在 PowerShell 中读取主进程：

```powershell
$desktop = @(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe'" |
  Where-Object { $_.ExecutablePath -like '*OpenAI.Codex_*' -and $_.CommandLine -notmatch '--type=' })
if ($desktop.Count -ne 1) { throw 'Expected one Codex desktop main process' }
node bin/lark-chatgpt-setup.mjs probe $desktop[0].ProcessId $desktop[0].ExecutablePath D:\QIUBridge\catalog.json
```

只读取已证明归属的本机工具管道，保存完整工具名、桌面路径和版本，不启动消息服务或调用业务工具。输出文件须不存在。失败时核对插件、版本和权限，不复制别人的工具清单，也不固定工具数量。

Codex 自带程序通常位于 `$env:LOCALAPPDATA\OpenAI\Codex\bin\<build>\codex.exe`。选用与当前桌面对应的实际程序，不使用 PATH 上另一份 Codex CLI。准备工具将计算并锁定其 SHA-256。

## 4. 确认项目与对话标识

`projectId` 是原生 App Server 项目 ID，`threadId` 是已有桌面对话 ID。不能用旧桌面项目 ID、群 ID、标题或目录名代替。

在自己的 Codex 开发环境中，通过原生 `project/list`、`thread/read` 读取并核对项目根目录、对话归属和工作目录。若需直接检查，先正常退出全部 Codex 窗口，再用桌面自带程序开启仅本机监听的临时诊断后台：

```powershell
& 'C:\Users\YOUR_USER\AppData\Local\OpenAI\Codex\bin\VERIFIED_BUILD\codex.exe' app-server --listen ws://127.0.0.1:19440
```

在另一终端列出原生项目：

```powershell
node tools/query-native.mjs ws://127.0.0.1:19440 project/list '{}'
```

查询器也支持 `thread/list`、`thread/read`。已有对话 ID 可从原生 `thread/list` 的结果获取，再以 `thread/read` 和参数 `{"threadId":"YOUR_THREAD_ID","includeTurns":false}` 核对。不要新建一条对话冒充原对话。查询结束后在临时后台按 `Ctrl+C`，再打开普通 Codex。

这个后台仅供读取归属，不能替代正式启动时的实时空闲证明。查询器不执行模型、修改项目或批准操作。若协议不匹配，停止配置，参阅 [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)。

## 5. 生成全新配置

复制 `examples/desktop/setup.example.json` 到仓库外，填入自己的九个字段。使用绝对路径，`desktopVersion` 与探测结果一致，不填 App Secret。

```powershell
node bin/lark-chatgpt-setup.mjs init D:\QIUBridge\setup.json D:\QIUBridge\catalog.json D:\QIUBridge\state
node bin/lark-chatgpt-deploy.mjs prepare D:\QIUBridge\state\deployment.json D:\QIUBridge\stage
node bin/lark-chatgpt-deploy.mjs verify D:\QIUBridge\stage
node bin/lark-chatgpt-runtime-supervisor.mjs --service-prepare D:\QIUBridge\stage D:\QIUBridge\service
```

`state`、`stage`、`service` 均须尚不存在。工具生成单群配置、空的新账本及程序清单，只适用于**从未由该 Bridge 处理消息的新绑定**。已有用户必须复用原账本和绑定，禁止建空账本绕过 `uncertain` 或失败记录。

保存最后一步输出的 `manifestFile` 和 `manifestSha256`；下文 `MANIFEST_SHA256` 表示实际输出。之后不要移动或修改安装程序，否则校验会拒绝启动。

## 6. 首次启动与验收

```powershell
node bin/lark-chatgpt-runtime-supervisor.mjs --service-launch D:\QIUBridge\service\service.json MANIFEST_SHA256
```

若普通 Codex 仍在，程序等待你保存工作后**正常退出**，不会强关窗口；等待上限十分钟。确认任务空闲、队列和审批为空后，才自动打开受管桌面。不要同时手动打开 Codex或重复点击入口。

通过 `service\active-run.json` 的运行信息检查状态：

```powershell
$run = Get-Content -Raw -Encoding UTF8 D:\QIUBridge\service\active-run.json | ConvertFrom-Json
node bin/lark-chatgpt-runtime-supervisor.mjs --status $run.planFile $run.planSha256
```

监督状态进入 `running` 后，在群里 @ 机器人发一条全新简单请求，核对唯一回执、项目和对话归属，并在桌面接续。再验证正常退出保持关闭和同入口重入。别人的验收不能替代自己的安装验证。

## 7. 登录入口

首次验收通过后再设置登录启动。工具默认同时创建 Startup 和桌面快捷方式：

```powershell
node bin/lark-chatgpt-runtime-supervisor.mjs --service-shortcuts-check D:\QIUBridge\service\service.json MANIFEST_SHA256
node bin/lark-chatgpt-runtime-supervisor.mjs --service-install-startup D:\QIUBridge\service\service.json MANIFEST_SHA256
```

只需 Startup 时可删除新生成的桌面快捷方式。`Win+R` → `shell:startup`，确认只有一个 `QIU New Bridge`，没有恢复软件制造的 `(1)` 副本。关闭 Codex 自己的登录启动，让 Bridge 负责启动顺序。不要为此关闭安全软件或绕过单位策略。

日常操作、升级与异常恢复见[运维指南](docs/desktop-p4-deployment.md)。更多群和自动建话题单独验收。
