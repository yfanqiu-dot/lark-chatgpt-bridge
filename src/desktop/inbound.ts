import type { InboundMessage } from './controller';

interface ChannelMessage {
  messageId: string; chatId: string; senderId: string; content: string;
  rawContentType: string; resources: readonly unknown[]; mentionedBot: boolean; senderIsBot?: boolean;
  mentions: ReadonlyArray<{key: string; name?: string; isBot?: boolean; openId?: string}>;
  threadId?: string; chatMode?: string;
}

/** Feishu sends ordinary formatted text as `post`; the channel already normalizes
 * its text and resource list. Accept both text envelopes without enabling media.
 */
export function desktopInbound(msg: ChannelMessage, botOpenId?: string): InboundMessage | undefined {
  if(msg.resources.length || !['text','post'].includes(msg.rawContentType))return;
  let content=msg.content;
  for(const mention of msg.mentions.filter(m=>m.isBot || (botOpenId && m.openId===botOpenId))){
    content=content.replace(mention.key,'');
    if(mention.name)content=content.replace(`@${mention.name}`,'');
  }
  return {messageId:msg.messageId,chatId:msg.chatId,senderId:msg.senderId,content,
    mentionedBot:msg.mentionedBot,isBot:Boolean(msg.senderIsBot || (botOpenId && msg.senderId===botOpenId)),
    replyInThread:Boolean(msg.threadId || msg.chatMode==='topic')};
}
