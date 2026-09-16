import type { Approval } from './backend';

// Card 2.0: concrete operation, owner-only context, callback buttons.
// Plain text prevents commands/diffs from creating misleading Markdown or links.
export function approvalCard(a: Approval) {
  return {
    schema: '2.0', config: { update_multi: true, width_mode: 'default' },
    header: { title: { tag: 'plain_text', content: 'Codex 操作等待审批' }, template: 'orange' },
    body: { direction: 'vertical', vertical_spacing: '12px', elements: [
      { tag: 'column_set', flex_mode: 'none', background_style: 'grey-50', columns: [
        { tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'div', text: { tag: 'plain_text', content: a.description } }] },
      ] },
      { tag: 'div', text: { tag: 'plain_text', content: `审批编号：${a.token}\n仅任务所有者可处理，以服务端结果为准。`, text_size: 'notation', text_color: 'grey' } },
      ...(a.decisions.length ? [{ tag: 'column_set', flex_mode: 'none', columns: a.decisions.map((decision, i) => ({
        tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button', width: 'fill',
          type: i === 0 ? 'primary_filled' : 'default',
          text: { tag: 'plain_text', content: ({ accept: '同意本次', decline: '拒绝', cancel: '取消任务' } as Record<string, string>)[decision] },
          behaviors: [{ type: 'callback', value: { desktopApproval: a.token, decision } }],
        }],
      })) }] : []),
    ] },
  };
}
export function resolvedCard() {
  return { schema: '2.0', config: { update_multi: true, width_mode: 'default' },
    header: { title: { tag: 'plain_text', content: '审批入口已关闭' }, template: 'grey' },
    body: { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '此审批已结束或原连接失效。如仍需审批，请以最新卡片为准。' } }] } };
}
