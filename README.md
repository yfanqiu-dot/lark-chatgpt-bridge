# QIU Bridge · Feishu ↔ Codex Desktop

Continue a **real Codex desktop project conversation from a Feishu group**. Work from your phone, then return to the same conversation on your computer, with the same project and context.

[中文介绍](README.zh.md) · [Windows installation](README.desktop.md) · [Operations](docs/desktop-p4-deployment.md) · [Compatibility](docs/compatibility.md) · [Releases](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases)

## What you can do

- Send text from a configured Feishu group to its existing desktop conversation and receive the final answer in Feishu.
- Continue in the desktop app; inspect status, append instructions, stop a turn, and handle supported approval cards.
- Keep project, thread, message and receipt identities in local durable records. Ambiguous submissions pause for reconciliation instead of being blindly replayed.
- Launch through one Windows login entry. The managed channel stops when you normally quit its desktop; failures preserve evidence and attempt to restore the ordinary desktop.

The bridge runs on **your Windows computer**, using your signed-in Codex app and your own Feishu application. Your computer must remain on and connected. This is an independent community integration, not an OpenAI or Feishu product.

## Start here

1. Download `qiu-bridge-v0.8.2-windows-x64.zip` from [Releases](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/releases). It includes built JavaScript and production dependencies; Node.js 22 LTS is required separately.
2. Follow the [installation guide](README.desktop.md). Create your own bot, identify your native project/conversation, and generate a fresh configuration with the setup tool. First-time installation currently requires command-line experience; the detailed guide is in Chinese.
3. Verify one group end to end before installing the login entry. See [operations](docs/desktop-p4-deployment.md) for daily startup, shutdown and recovery.

Source build:

```powershell
git clone https://github.com/yfanqiu-dot/lark-chatgpt-bridge.git
cd lark-chatgpt-bridge
git checkout v0.8.2
npx --yes pnpm@10.33.0 install --frozen-lockfile
npx --yes pnpm@10.33.0 build
node bin/lark-chatgpt-setup.mjs --help
```

**Installing the upstream `lark-channel-bridge` npm package does not install this desktop release.** This fork is distributed through GitHub Releases and source builds. The package name is retained for compatibility; npm publishing is disabled.

## Release scope

Version 0.8.2 recognizes the pinned native queue rejection for unrelated, idle ephemeral desktop threads. Bound and durable threads still require full queue checks; active tasks, approvals, unknown errors and changed identities still stop admission. See [release notes](docs/releases/v0.8.2.md). Opening the desktop window is followed by admission checks; keep the desktop idle until readiness is verified.

Version 0.8.1 adds bounded Feishu reconnection and supports discovery of the newer app-tools pipe. During a temporary outage, new model submissions wait for a stable connection; the same listener has up to three minutes to recover. An unrecovered or invalid connection still pauses the service. See [release notes](docs/releases/v0.8.1.md).

The 0.8.0 runtime baseline passed Windows login, startup, normal quit, five minutes remaining closed, manual re-entry, delayed quit receipts, and cleanup checks. Deployed acceptance covered one existing group and one owner. Version 0.8.1 has automated regression and read-only compatibility checks; these do not replace a new field acceptance after upgrading. Tests and builds also run on macOS/Linux; the desktop runtime is **Windows x64 only**.

Topic creation and multi-project routing exist in the code, but managed deployment disables new topics and admits one group initially. Additional groups need individual reconciliation and validation. Images/attachments, all-desktop-message mirroring, multi-user hosting, and guaranteed unattended operation are outside the desktop support scope. Bounded acceptance does not establish long-duration reliability. See [compatibility and limits](docs/compatibility.md).

```text
Feishu group → local listener → shared App Server ← managed Codex desktop
                     ↓
              local ledger + receipts
```

The integration pins the desktop version, executable hashes and complete tool catalog. Changed installations are rejected until verified again. Keep local configuration, ledgers and credentials private.

## Development and attribution

```powershell
npx --yes pnpm@10.33.0 test
npx --yes pnpm@10.33.0 typecheck
npx --yes pnpm@10.33.0 build
```

Based on [zarazhangrui/lark-coding-agent-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge). The original independent CLI backend is retained: [English guide](docs/cli-backend.en.md), [Chinese guide](docs/cli-backend.zh.md). Its daemon commands do not start the shared desktop backend.

MIT license: [LICENSE](LICENSE). Report reproducible problems through [Issues](https://github.com/yfanqiu-dot/lark-chatgpt-bridge/issues), removing credentials and private conversation content first.
