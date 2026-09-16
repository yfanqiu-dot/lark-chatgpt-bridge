import { expect, it } from 'vitest';
import { approvalCard, resolvedCard } from '../../../src/desktop/cards';

it('uses callback values tied to the exact request and treats command markup as plain text', () => {
  const card=approvalCard({token:'opaque-request',requestId:2,threadId:'t',turnId:'turn',method:'item/commandExecution/requestApproval',description:'<a href="other">do not interpret</a>',decisions:['accept','cancel']});
  expect(card.schema).toBe('2.0');
  const detail=(card.body.elements[0] as any).columns[0].elements[0].text;
  expect(detail.tag).toBe('plain_text');
  const buttons=(card.body.elements[2] as any).columns.map((c:any)=>c.elements[0]);
  expect(buttons.map((b:any)=>b.behaviors[0].value)).toEqual([{desktopApproval:'opaque-request',decision:'accept'},{desktopApproval:'opaque-request',decision:'cancel'}]);
  expect(JSON.stringify(resolvedCard())).not.toContain('callback');
});
