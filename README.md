# QIU Bridge · Continue your desktop AI work from Feishu

**Use an owner-only Feishu DM to plan work and launch topics, then mention the bot in each topic group to execute. Continue the same real Codex project conversations on your computer.**

For an individual who already uses Codex: draft reports while away, organize meeting notes, and follow separate workstreams without repeatedly explaining the background. Work runs on your own Windows computer, which must stay on and connected.

[中文介绍](README.zh.md) · [Download v0.10.0](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.10.0) · **[Complete user guide and tips](docs/user-guide.en.md)** · [Installation](README.desktop.md) · [Office examples](docs/office-workflows.en.md)

## Ways to use it

| Situation | Sample request |
|---|---|
| Weekly report | “Draft completed work, risks and next steps from this week's project notes. Mark missing information.” |
| Meeting actions | “Turn the notes pasted below into tasks, owners and due dates. Mark anything unstated as unconfirmed.” |
| Customer briefing | “Use the project files to summarize confirmed needs, missing information and five questions for the meeting.” |
| Data summary | “If you can read sales.csv, total sales by region, check missing values and explain the calculation. Preserve the source file.” |
| Separate workstreams | With full mode enabled, send `/topic new main Weekly report` in DM control or the entry group to create a conversation and its private Feishu group. |

These examples need materials accessible on the bridge computer. Data analysis needs a suitable tool. Feishu documents, calendars, tasks and Base operations require separately configured Codex tools and authorization; the bridge does not grant those capabilities. See [complete prompts and workflows](docs/office-workflows.en.md).

## Daily controls

With the optional [DM control channel](README.topics.md#单聊主控) configured, send text without a mention. Use `/topic new main Customer proposal` to create a separate Codex conversation and private group, then follow the returned group link. `/topic list` finds existing topics and `/help` shows configured project keys. The DM, entry group and topic groups keep separate conversation histories.

Mention the bot in a bound group and state the material, goal and constraints. Follow up there, then review source materials and finish delivery in the desktop app. The bridge primarily returns final text results and supported approval notifications.

| Command | Purpose |
|---|---|
| `/status` | Inspect running, queued, uncertain and approval states |
| `/steer Additional instructions` | Append instructions to an eligible active turn |
| `/stop` | Stop the current conversation's active task; queued requests remain and external commands may continue |
| `/result [messageId]` | Retrieve a saved answer without rerunning the task |
| `/reconcile` | Check the original uncertain request |

Topic creation is available in its enabled entry group or explicit owner DM. Replace `main` with your configured project key. A topic is a Codex conversation and its group, not a Feishu reply thread. Check status before repeating a delayed request.

## Get started

1. Prepare Windows x64, Node.js 22 LTS, a signed-in Codex desktop app and your own Feishu bot.
2. [Download the bundle](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.10.0) and follow the [installation guide](README.desktop.md), currently in Chinese. Configure your project and real conversation, then verify one group. Initial setup requires some command-line experience.
3. Install the login entry. Enable and verify full mode through [operations](docs/desktop-p4-deployment.md) if you need more topics or projects.

Once the login entry is installed, Windows user login attempts startup automatically; no daily shortcut click is needed. For manual re-entry, use `QIU New Bridge` and wait for readiness checks. Normally quitting the managed desktop also closes its messaging channel. This desktop version is distributed through GitHub Releases; installing the upstream `lark-channel-bridge` npm package does not install it.

See the [user guide](docs/user-guide.en.md) for all commands, approvals, queues, interruptions, files and troubleshooting. Unified topic rename/archive/disable/unbind/delete commands are not implemented. Deleting a bound conversation may block later startup for the entire Bridge; read [topic management](docs/user-guide.en.md#rename-archive-and-delete) first.

## Release and boundaries

**v0.10.0** adds an explicit owner-only DM control channel for direct conversation, topic creation and topic discovery. It preserves login startup and existing task controls. See [release notes](docs/releases/v0.10.0.md).

Desktop support covers Windows x64, one configured owner and text interaction in registered groups and an explicitly bound DM. DMs remain disabled unless configured, and other users cannot access the control channel. Images, attachments, full desktop-message mirroring, multi-user hosting and guaranteed unattended operation are outside this release's scope. Codex tools and permissions still apply. A local Windows sandbox `setup refresh had errors` issue remains unresolved; approved execution was verified. Each installation and Codex update needs its own checks. See [compatibility and limits](docs/compatibility.md).

Personal configuration, ledgers and credentials are excluded from source and release bundles. Requests and results still pass through Feishu and your configured Codex services; check that the tools, platforms and authorization are appropriate for the business data involved.

## Development and attribution

[Design and acceptance summary](docs/development.md) · [Independent CLI backend](docs/cli-backend.en.md) · [Security](SECURITY.md) · [Issues](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/issues)

For a source build, check out `v0.10.0`, run `npx --yes pnpm@10.33.0 install --frozen-lockfile` and `npx --yes pnpm@10.33.0 build`. Development checks: `pnpm test`, `pnpm typecheck`, `pnpm build`.

Based on [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge), under the [MIT license](LICENSE). Independent community integration, not an OpenAI or Feishu product. Remove credentials and private conversation content from issue reports.
