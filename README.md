# QIU Bridge · Continue your desktop AI work from Feishu

**Mention your bot in a Feishu group to work with Codex on your computer. Get the final text answer in Feishu, then continue in the same project conversation when you return to your desk.**

For example, ask for a weekly report draft while commuting, refine its priorities from your phone, and review the source material and finish the draft on your computer. The group stays connected to the original desktop conversation.

[中文介绍与完整办公示例](README.zh.md) · [Download v0.9.4](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases/tag/v0.9.4) · [Installation](README.desktop.md) · [Daily operations](docs/desktop-p4-deployment.md) · [Compatibility](docs/compatibility.md)

## Where it helps

| Situation | How to use the bridge |
|---|---|
| You leave your desk and remember unfinished work | Send a text request to your computer's project conversation |
| A draft needs several rounds of changes | Refine it in the same group, then continue in the desktop app |
| You follow several projects or workstreams | Use separate registered topic groups, each connected to its own conversation |
| Priorities change during a task | Append instructions with `/steer`, or request a stop with `/stop` |
| You missed an answer | Check `/status` and retrieve the saved result with `/result` |

Designed for an individual who already uses Codex on Windows. Each installation is controlled by its configured owner; joining a group does not grant others control of that computer.

## Office examples you can adapt

These are **sample requests**, not bundled business integrations. File access, command execution and business-system access depend on the tools and permissions available to your Codex installation. A path must be accessible on the computer running the bridge, not just on your phone. Mention the bot when sending each example.

### Draft a weekly report from existing notes

With work records already in the project folder:

```text
Draft a weekly report from this week's work records in the project.
Use four sections: completed work, unfinished work, risks, and next week's plan.
Cite source files, mark missing information, and keep it as a draft without sending it externally.
```

Follow up with “Keep it under 500 words and put the decisions I need to make first.” Review the original materials and finish the document when you return to your computer.

### Turn meeting notes into an action list

Paste meeting text you already have into a group message:

```text
Extract decisions, action items and open questions from these notes.
For each action, list the task, owner and due date. Mark anything unstated as unconfirmed.
Only draft the list; do not create tasks or send notifications.

Notes:
[paste the meeting text here]
```

You receive a text list to review in Feishu. Recording meetings, retrieving transcripts and creating Feishu tasks require separately configured tools and authorization.

### Prepare for a customer meeting

When background and proposal files are available in the project:

```text
Prepare a ten-minute briefing from the customer background and proposal files.
Cover confirmed needs, the current proposal, missing information, and five questions to ask.
Cite source files and distinguish documented facts from your suggestions.
```

After the meeting, add new information in the same group and ask for an updated proposal draft.

### Get a short summary from existing data

If Codex has a working data-reading or analysis tool:

```text
First check whether you can read sales.csv in this project.
If so, total sales by region, show the top three, and check for missing or duplicate records.
Explain the calculation and any uncertainties, then draft a paragraph for a weekly report.
Keep the source file unchanged. If you cannot read it, explain why.
```

The bridge returns text. View generated spreadsheets or charts on your computer, or deliver them through a separately configured file tool; desktop attachment transfer is outside this release's support scope.

### Give different workstreams their own context

With full mode enabled, mention the bot in the **entry group**:

```text
/topic new main Weekly report
```

Replace `main` with your configured project key; the installation wizard uses `main` by default. The bridge creates a real Codex project conversation and its corresponding private Feishu group. Use that group for the report and another topic group for a customer proposal. Here, a “topic” means a conversation and its group, not a reply thread inside Feishu.

First-time setup defaults to one group. Enable topic creation and registered-project routing through the [full-mode operations guide](docs/desktop-p4-deployment.md#完整功能部署-v090).

## Add Feishu documents, calendars and tasks when needed

**Reading cloud documents, checking calendars, creating tasks or updating Base records requires additional connectors, skills or CLI tools in Codex, with the necessary authorization.** Sending a document URL does not grant access to it.

Once those capabilities are configured, you can ask it to summarize an accessible document, draft proposed tasks from the meeting notes, or list materials to prepare for tomorrow's meetings. Review the targets and proposed changes before authorizing writes. The bridge provides messaging and conversation continuity; actual business capabilities and access remain governed by your tools and permissions.

## A daily workflow

1. Keep your Windows computer on, connected and signed into Codex. Wait for the bridge's startup checks to finish.
2. Mention the bot in a bound group. State the material to use, the output you want, and any constraints. The final text answer normally replies to your request.
3. Follow up in the same group. While a turn is active, use `/steer` to append instructions.
4. Review supported approval cards before deciding. Some special permissions and requests for information still need attention in the desktop app.
5. Return to the original desktop conversation to review source materials and finish delivery. Desktop activity is not fully mirrored to Feishu.

| Goal | Mention the bot and send | Note |
|---|---|---|
| Inspect status | `/status` | Shows running, queued and uncertain work |
| Add an instruction | `/steer Put decisions first` | Requires an eligible active turn |
| Stop this group's task | `/stop` | Already launched external commands may continue |
| Retrieve a saved answer | `/result` | Does not rerun the task; `/result <messageId>` selects a request |
| Reconcile uncertain work | `/reconcile` | Checks the original request rather than submitting it again |
| Create a workstream | `/topic new main Customer proposal` | Entry group only, with creation enabled |

If an answer is delayed, check status and saved results before repeating the request. Sleep, connectivity, Codex updates and permission issues can affect execution. See [operations](docs/desktop-p4-deployment.md) for recovery.

The bridge runs on **your Windows computer**, using your signed-in Codex app and your own Feishu application. Your computer must remain on and connected. This is an independent community integration, not an OpenAI or Feishu product.

## Start here

1. Download `qiu-bridge-v0.9.4-windows-x64.zip` from [Releases](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases). It includes built JavaScript and production dependencies; Node.js 22 LTS is required separately.
2. Follow the [installation guide](README.desktop.md). Create your own bot, identify your native project/conversation, and generate a fresh configuration with the setup tool. First-time installation currently requires command-line experience; the detailed guide is in Chinese.
3. Verify one group end to end before installing the login entry. See [operations](docs/desktop-p4-deployment.md) for daily startup, shutdown and recovery.

Source build:

```powershell
git clone https://github.com/yfanqiu-dot/lark-chatgpt-bridge.git
cd lark-chatgpt-bridge
git checkout v0.9.4
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 build
node bin/lark-chatgpt-setup.mjs --help
```

**Installing the upstream `lark-channel-bridge` npm package does not install this desktop release.** This fork is distributed through GitHub Releases and source builds. The package name is retained for compatibility; npm publishing is disabled.

## Release scope

Version 0.9.4 resumes an already accepted queue head when an interrupted native conversation remains idle with automatic dispatch paused. It verifies the original request and current health before starting that exact queue item, preserves queue order and never resubmits the input. It includes the process scan and topic initialization fixes from 0.9.1–0.9.3. See [patch notes](docs/releases/v0.9.4.md).

Local field checks covered multiple groups, topic creation/resume, project routing, stop, automatic recovery after stop, result retrieval, steering, approved command execution and bounded health observation. Each new installation still needs its own acceptance checks.

- Desktop runtime support is **Windows x64, one configured owner, text interaction**. Only registered groups are connected. macOS/Linux CI does not establish desktop support there.
- Images, attachments, all-desktop-message mirroring, multi-user hosting and guaranteed unattended operation are outside this desktop release's support scope.
- Work runs on your computer. Sleep, shutdown or quitting the managed Codex app interrupts availability.
- Codex tools and permissions still apply. A local Windows sandbox `setup refresh had errors` issue remains unresolved; command execution after approval was verified. Diagnose the local sandbox if this error occurs.
- Codex updates require compatibility checks against the executable hashes and full tool catalog. See [compatibility and limits](docs/compatibility.md).

Personal configuration, ledgers and credentials stay out of the public repository. Requests and results still pass through Feishu and your configured Codex services; check that your platform, tool and authorization choices are appropriate for the business data involved.

## Development and attribution

```powershell
npx --yes pnpm@10.33.0 test
npx --yes pnpm@10.33.0 typecheck
npx --yes pnpm@10.33.0 build
```

Based on [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). The original independent CLI backend is retained: [English guide](docs/cli-backend.en.md), [Chinese guide](docs/cli-backend.zh.md). Its daemon commands do not start the shared desktop backend.

MIT license: [LICENSE](LICENSE). Report reproducible problems through [Issues](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/issues), removing credentials and private conversation content first.
