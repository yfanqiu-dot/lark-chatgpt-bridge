# QIU Bridge user guide

For **v0.10.0, Windows desktop**. Continue real Codex project conversations from Feishu: plan in an owner DM, work in separate groups, then review and deliver from your computer.

[Overview](../README.md) · [中文完整手册](user-guide.zh.md) · [Installation, Chinese](../README.desktop.md) · [Office prompts](office-workflows.en.md) · [Operations, Chinese](desktop-p4-deployment.md)

## Install and start

Use your own Windows x64 computer, Node.js 22 LTS, a signed-in compatible Codex desktop app and a Feishu bot with published permissions. Initial setup requires command-line experience. Follow the installation guide, verify one existing project conversation and group first, then enable registered topics and optional DM control. DM control is disabled by default.

The computer must remain awake, connected and logged into Windows. Business tools such as document access, calendars, tasks, GitHub and data analysis need separate configuration and authorization in Codex.

After installing the login shortcut, Windows **user login** attempts startup automatically; you do not need to click `QIU New Bridge` each day. Checks may wait for desktop work to finish. Avoid opening ordinary Codex first or clicking repeatedly. If ordinary Codex is already open, save work and quit normally so startup can continue; the wait has a ten-minute limit. Normally quitting the managed desktop closes the channel. Use the same shortcut to start again when needed.

After installation, a reboot or an upgrade, check `/status` and send a fresh simple request to verify receipt. An open window alone does not prove readiness. See the installation guide for service status. Production does not rely on a short test window; finite health observations do not establish weeks of unattended reliability.

## Choose the right conversation

| Entry | How to send | Purpose |
|---|---|---|
| Explicitly configured owner DM | Text without a mention | Independent work, topic creation and discovery |
| Configured entry group | Mention the bot for every message, including commands | Original work and topic creation/discovery |
| Registered topic group | Mention the bot for every message, including commands | Work and controls for that topic |

Only the configured owner controls execution. Group membership does not grant access to the computer. Unknown groups and unbound DMs are ignored.

Each entry has its own real Codex conversation and ledger. The DM is **not a global task controller**: its `/stop` does not stop another group, and its `/result` does not fetch that group's answer. Visit the relevant group. Mentioning another group's name in plain text does not change routing or create resources.

A topic is a Codex conversation, a private ordinary Feishu group and a local binding; it is not a Feishu reply thread or native topic-group feature. Separate conversations in the same project can still modify the same files. Avoid concurrent edits to one file.

## Your first workflow

1. Send `/help` in the enabled DM to find project keys. Replace the example `main` below with a configured key.
2. Send `/topic new main Weekly report 2026-W42` once.
3. Follow the returned group link and mention the bot: “Draft completed work, unfinished work, risks and next steps from this week's project notes. Cite sources, mark missing information, preserve source files and keep it as a draft.”
4. Refine the answer in the same group. While an eligible turn is active, use `/steer Keep the final answer under 500 words`. After completion, send a normal follow-up instead.
5. Use `/status` for progress and `/result` to retrieve a saved answer. Return to the DM and use `/topic list` to find the group later. Review sources and files in the original desktop conversation.

Do not repeat topic creation because it is slow. Identical titles in different incoming messages can create different topics. Continue an existing group for ongoing work.

## Complete command reference

Use lowercase commands. Mention the bot in groups; the enabled DM needs no mention. Replace angle-bracket values; square brackets mean optional arguments. Do not send the brackets themselves.

| Command | Scope | Meaning |
|---|---|---|
| `/help` | DM control / entry group | Show usage and configured project keys |
| `/topic list` | DM control / entry group | List registered topics and group links, not all running tasks |
| `/topic new <projectKey> <title>` | Enabled DM control / entry group | Create a real conversation and private group; title: 1–60 visible characters |
| `/topic resume <messageId>` | DM control / entry group | Continue the saved original incomplete creation request; does not restore deleted resources |
| `/status` | Current conversation | Inspect activity, queued/uncertain records, delivery and approvals |
| `/steer <text>` | Current conversation | Append to an eligible active turn, not the next queued request |
| `/stop` | Current conversation | Request a stop of its active Feishu-originated task. Other groups and independent desktop work are unaffected. **Queued requests remain and may start next.** Launched external commands may continue |
| `/result` | Current conversation | Retrieve the most recent non-command request with a saved result; this can be older than the latest unfinished request |
| `/result <messageId>` | Current conversation | Retrieve a saved result by original incoming message ID, not group/thread/turn ID; no model rerun |
| `/reconcile` | Current conversation | No arguments. Check the oldest uncertain record; refuses while busy. Missing native identifiers require desktop review, not automatic resubmission |
| `/approve <token> accept` | Conversation receiving approval | Submit an approval using its valid token |
| `/approve <token> decline` | Same | Decline the approval |
| `/approve <token> cancel` | Same | Submit a cancel decision; submission is not proof of successful execution |

Prefer the approval card after reviewing the actual command, paths or changes. Tokens are owner- and conversation-scoped. Some special permissions and information requests require the desktop app. Do not publish tokens or ledgers.

## Useful habits

- Check status before repeating a delayed task. The desktop may be busy, a task may be queued, approval may be pending, or delivery may be uncertain.
- Deduplication uses the incoming message ID. Sending the same text again creates a new request and can repeat side effects.
- Keep one ongoing matter in one group. Specify separate output filenames when several topics use the same project.
- Use `/steer` during eligible active work; use an ordinary follow-up to revise a completed answer.
- `/stop` does not clear the queue. There is no queue-clear command. If all subsequent work must be stopped, review it on the desktop with the maintainer rather than adding more requests.
- Preserve the original request and status when something is uncertain. Use `/result` or `/reconcile` in that conversation; never replace a ledger with an empty one to bypass checks.

State **the source, desired output, acceptance criteria and permitted actions**. For example: “Read this project's sales.csv. Explain missing/duplicate records, total sales by region, show the top three and draft a report paragraph. Preserve the original file. Ask if a field is ambiguous.”

For Feishu office work: prepare customer questions from accessible files; paste meeting notes to draft actions; review proposed owners/dates before authorizing task creation; or summarize an accessible cloud document with source references. These require the relevant separately authorized tools. A document link does not grant access. More templates are in [office workflows](office-workflows.en.md).

Text input and final text answers are supported. Phone images/files are not automatically model inputs. Local paths must exist on the bridge computer. Generated spreadsheets, charts and reports remain on the computer; ask for an absolute path or separately authorize an available upload tool. Full desktop activity is not mirrored to Feishu.

## Rename, archive and delete

This release supports creation, listing and incomplete-creation recovery. It has **no unified rename, archive, disable, unbind or delete commands**. `/topic rename`, `/topic archive` and `/topic delete` are not implemented.

| External change | Current behavior |
|---|---|
| Rename a Feishu group | Its ID stays the same, so routing normally continues. Codex and saved list titles do not synchronize |
| Rename a Codex conversation | Its ID stays the same; group and saved titles do not synchronize |
| Archive a Codex conversation | Does not disable the Bridge binding |
| Disband a Feishu group | Removes the messaging entry. The binding and Codex conversation remain; disbanding alone does not cancel active work |
| Delete a bound Codex conversation | Later work can fail. A subsequent original-binding/startup check may block the entire Bridge, including other groups and the DM. Broken topics are not automatically isolated |
| Recreate the same name | A new ID does not replace the original binding; `/topic resume` is not deletion recovery |

Removing a conversation from your own Feishu list is different from disbanding its group. For now, retain existing resources and stop adding work to old matters. Before permanent removal, have the maintainer reconcile active/queued tasks, results, bindings and deployment together. Do not delete registry rows or erase ledgers to bypass checks. Any enabled local conversation-text projection is a partial reading copy, not a complete backup or a disable feature.

## Troubleshooting

| Symptom | First check |
|---|---|
| No group response | Mention, registered group, configured owner, awake/networked computer and service state |
| No DM response | Explicit DM binding; installation does not enable arbitrary private chats |
| Queued task | Allow current work to finish; independent desktop work can also delay admission |
| Pending approval | Review its card; special requests may need desktop attention |
| `/result` shows an older answer | The newest request may not have a saved result; check status or its original message ID |
| Uncertain execution/delivery | Preserve records and use reconciliation/result retrieval; do not replay business actions |
| Topic creation stalls | Do not repeat creation; retain the original message ID and follow recovery guidance |
| Login startup fails | Check the unique Startup entry, ordinary Codex interference and service failure/status information |
| Codex upgrade blocks startup | Revalidate version, binary SHA and tool catalog and prepare a deployment; never bypass integrity checks |
| Windows sandbox initialization fails | Preserve the actual error and inspect on desktop; a verified approved-execution path does not fix every sandbox environment |

Report versions, timestamps, entry type, command, expected/actual behavior and redacted status. Remove secrets, personal paths, chat/user IDs, approval tokens, private conversations and ledgers. See [compatibility](compatibility.md) and [operations](desktop-p4-deployment.md).
