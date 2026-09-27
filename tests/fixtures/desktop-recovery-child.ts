import { readFile } from 'node:fs/promises';
import { DesktopBackend } from '../../src/desktop/backend';
import { DesktopController } from '../../src/desktop/controller';
import { DesktopLedger } from '../../src/desktop/ledger';
import type { DesktopConfig } from '../../src/desktop/config';

async function main() {
  const c:DesktopConfig = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
  const ledger = new DesktopLedger(c.stateFile, {appId:c.appId,chatId:c.chatId,ownerOpenId:c.ownerOpenId,projectId:c.projectId,projectRoot:c.projectRoot,threadId:c.threadId});
  const backend = new DesktopBackend(c, {toolConfig:async()=>({}),pollMs:20,reconnectDelayMs:20});
  const controller = new DesktopController(c,ledger,backend,{
    async send(chat,text){process.stdout.write(`REPLY ${JSON.stringify({chat,text})}\n`);return 'receipt';},async approval(){},async resolved(){},
  });
  await controller.start();
  if(process.argv[3] === 'initial') {
    await controller.receive({messageId:'original',chatId:c.chatId,senderId:c.ownerOpenId,content:'original prompt',mentionedBot:true,replyInThread:false});
    // Parent kills only after the running record has reached the real filesystem.
    const timer = setInterval(() => {void readFile(c.stateFile,'utf8').then(text=>{
      if(JSON.parse(text).messages.some((r:any)=>r.state==='running')){clearInterval(timer);process.stdout.write('RUNNING\n');}
    }).catch(()=>{});},10);
    timer.unref();
  }
  await controller.idle();
  await controller.shutdown();
  process.stdout.write(`DONE ${JSON.stringify(ledger.all())}\n`);
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
