import { readFile } from 'node:fs/promises';
import { DesktopBackend } from '../../src/desktop/backend';
import { DesktopController } from '../../src/desktop/controller';
import { DesktopLedger, type MessageRecord } from '../../src/desktop/ledger';
import type { DesktopConfig } from '../../src/desktop/config';

async function main() {
  const c:DesktopConfig = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
  class CheckpointLedger extends DesktopLedger {
    override async update(id:string,patch:Partial<Omit<MessageRecord,'messageId'>>):Promise<void> {
      await super.update(id,patch);
      // Atomic persistence has completed and all handles are closed. Polling the
      // same file can interfere with replacement on Windows; signal the fence directly.
      if(process.argv[3]==='initial' && patch.state==='running')process.stdout.write('RUNNING\n');
    }
  }
  const ledger = new CheckpointLedger(c.stateFile, {appId:c.appId,chatId:c.chatId,ownerOpenId:c.ownerOpenId,projectId:c.projectId,projectRoot:c.projectRoot,threadId:c.threadId});
  const backend = new DesktopBackend(c, {toolConfig:async()=>({}),pollMs:20,reconnectDelayMs:20});
  const controller = new DesktopController(c,ledger,backend,{
    async send(chat,text){process.stdout.write(`REPLY ${JSON.stringify({chat,text})}\n`);return 'receipt';},async approval(){},async resolved(){},
  });
  await controller.start();
  if(process.argv[3] === 'initial') {
    await controller.receive({messageId:'original',chatId:c.chatId,senderId:c.ownerOpenId,content:'original prompt',mentionedBot:true,replyInThread:false});
  }
  await controller.idle();
  await controller.shutdown();
  process.stdout.write(`DONE ${JSON.stringify(ledger.all())}\n`);
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
