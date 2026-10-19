# QIU Bridge · Continue your desktop AI work from Feishu

**Mention your bot in a Feishu group, receive the final text answer, and continue in the same real Codex project conversation when you return to your computer.**

For an individual who already uses Codex: draft reports while away, organize meeting notes, and follow separate workstreams without repeatedly explaining the background. Work runs on your own Windows computer, which must stay on and connected.

[中文介绍](README.zh.md) · [Download v0.9.5](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.9.5) · [Installation](README.desktop.md) · [Office examples](docs/office-workflows.en.md) · [Operations](docs/desktop-p4-deployment.md)

## Ways to use it

| Situation | Sample request |
|---|---|
| Weekly report | “Draft completed work, risks and next steps from this week's project notes. Mark missing information.” |
| Meeting actions | “Turn the notes pasted below into tasks, owners and due dates. Mark anything unstated as unconfirmed.” |
| Customer briefing | “Use the project files to summarize confirmed needs, missing information and five questions for the meeting.” |
| Data summary | “If you can read sales.csv, total sales by region, check missing values and explain the calculation. Preserve the source file.” |
| Separate workstreams | With full mode enabled, send `/topic new main Weekly report` in the entry group to create a conversation and its private Feishu group. |

These examples need materials accessible on the bridge computer. Data analysis needs a suitable tool. Feishu documents, calendars, tasks and Base operations require separately configured Codex tools and authorization; the bridge does not grant those capabilities. See [complete prompts and workflows](docs/office-workflows.en.md).

## Daily controls

Mention the bot in a bound group and state the material, goal and constraints. Follow up there, then review source materials and finish delivery in the desktop app. The bridge primarily returns final text results and supported approval notifications.

| Command | Purpose |
|---|---|
| `/status` | Inspect running, queued, uncertain and approval states |
| `/steer Additional instructions` | Append instructions to an eligible active turn |
| `/stop` | Request a stop; already launched external commands may continue |
| `/result [messageId]` | Retrieve a saved answer without rerunning the task |
| `/reconcile` | Check the original uncertain request |

Topic creation is available only in its enabled entry group. Replace `main` with your configured project key. A topic is a Codex conversation and its group, not a Feishu reply thread. Check status before repeating a delayed request.

## Get started

1. Prepare Windows x64, Node.js 22 LTS, a signed-in Codex desktop app and your own Feishu bot.
2. [Download the bundle](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.9.5) and follow the [installation guide](README.desktop.md), currently in Chinese. Configure your project and real conversation, then verify one group. Initial setup requires some command-line experience.
3. Install the login entry. Enable and verify full mode through [operations](docs/desktop-p4-deployment.md) if you need more topics or projects.

Start through `QIU New Bridge` and wait for readiness checks. Normally quitting the managed desktop also closes its messaging channel. This desktop version is distributed through GitHub Releases; installing the upstream `lark-channel-bridge` npm package does not install it.

## Release and boundaries

**v0.9.5** fixes Windows PowerShell module-path compatibility at login, permits fresh admission after a fully restored health failure, and adds redacted startup diagnostics with a failure notice. See [patch notes](docs/releases/v0.9.5.md).

Desktop support covers Windows x64, one configured owner and text interaction in registered groups. Images, attachments, full desktop-message mirroring, multi-user hosting and guaranteed unattended operation are outside this release's scope. Codex tools and permissions still apply. A local Windows sandbox `setup refresh had errors` issue remains unresolved; approved execution was verified. Each installation and Codex update needs its own checks. See [compatibility and limits](docs/compatibility.md).

Personal configuration, ledgers and credentials are excluded from source and release bundles. Requests and results still pass through Feishu and your configured Codex services; check that the tools, platforms and authorization are appropriate for the business data involved.

## Development and attribution

[Design and acceptance summary](docs/development.md) · [Independent CLI backend](docs/cli-backend.en.md) · [Security](SECURITY.md) · [Issues](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/issues)

For a source build, check out `v0.9.5`, run `npx --yes pnpm@10.33.0 install --frozen-lockfile` and `npx --yes pnpm@10.33.0 build`. Development checks: `pnpm test`, `pnpm typecheck`, `pnpm build`.

Based on [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge), under the [MIT license](LICENSE). Independent community integration, not an OpenAI or Feishu product. Remove credentials and private conversation content from issue reports.
