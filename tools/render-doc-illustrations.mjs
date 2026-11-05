import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Original vector illustrations, explicitly labelled as diagrams rather than
// product screenshots. PNG exports are committed for offline Markdown readers.
const dir='docs/images';await mkdir(dir,{recursive:true});
const c={paper:'#f5f3ec',ink:'#173e35',muted:'#64766d',line:'#d7dfd3',lime:'#d9f4a4',white:'#ffffff',soft:'#e8eee6'};
const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const t=(x,y,s,size=22,fill=c.ink,weight=400,mono=false)=>`<text x="${x}" y="${y}" font-family="${mono?'Consolas, monospace':'Microsoft YaHei, Segoe UI, sans-serif'}" font-size="${size}" fill="${fill}" font-weight="${weight}">${esc(s)}</text>`;
const rect=(x,y,w,h,fill=c.white,r=24,stroke='none')=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const svg=(height,title,body)=>`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="${height}" viewBox="0 0 1440 ${height}" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10Z" fill="${c.ink}"/></marker></defs>${rect(0,0,1440,height,c.paper,0)}${body}</svg>`;
const arrow=(path)=>`<path d="${path}" fill="none" stroke="${c.ink}" stroke-width="3" marker-end="url(#arrow)"/>`;
const foot=(y,s='功能流程示意 · 非真实聊天截图 / Illustrative workflow')=>t(64,y,s,17,c.muted);

let body=t(64,65,'QIU BRIDGE',19,c.ink,700)+rect(1210,32,165,42,c.ink,21)+t(1235,60,'v1.0.0',21,c.lime,700);
body+=t(64,143,'在飞书，接续电脑上的 AI 工作',49,c.ink,700)+t(66,190,'Start in Feishu. Execute locally. Continue in Codex.',25,c.muted);
for(const x of [64,535,1006])body+=rect(x,248,370,330,c.white,26,c.line);
body+=rect(88,271,57,57,c.soft,17)+t(106,310,'F',31,c.ink,700)+t(164,310,'Feishu / 飞书',29,c.ink,700);
body+=t(92,355,'手机发起 · 单聊与专项群',21,c.muted)+rect(90,383,315,61,c.soft,16)+t(108,420,'“起草本项目的周报”',23,c.ink,500);
body+=rect(90,461,315,84,c.lime,16)+t(108,497,'继续追问、追加要求',21,c.ink,500)+t(108,529,'查看状态、取回结果',21,c.ink,500);
body+=rect(559,271,57,57,c.lime,17)+t(574,310,'Q',31,c.ink,700)+t(635,310,'QIU Bridge',29,c.ink,700);
body+=t(563,355,'你的 Windows 电脑',21,c.muted)+t(563,407,'消息接续 + 对话路由',26,c.ink,600)+t(563,452,'仅配置所有者可控制',22,c.ink)+t(563,491,'保留原请求与结果记录',22,c.ink)+t(563,539,'后台运行，无驻留终端窗',20,c.muted);
body+=rect(1030,271,57,57,c.soft,17)+t(1047,310,'C',31,c.ink,700)+t(1106,310,'Codex',30,c.ink,700);
body+=t(1034,355,'真实项目 · 原生对话',21,c.muted)+rect(1032,382,316,164,'#173e35',16)+t(1052,419,'project / weekly-report',17,c.lime,500,true)+t(1052,462,'读取可访问的项目材料',21,'#ffffff')+t(1052,500,'生成草稿，回桌面审阅',21,'#ffffff');
body+=arrow('M447 410H518')+arrow('M918 410H989');
body+=t(64,632,'电脑保持开机、联网、用户登录；业务工具与权限仍需另行配置。',22,c.muted)+foot(686);
await writeFile(join(dir,'overview.svg'),svg(720,'QIU Bridge：飞书发起，电脑执行，桌面接续',body),'utf8');

body=t(64,88,'一个主控，多个专项',46,c.ink,700)+t(66,134,'One control channel. Separate conversations for each workstream.',23,c.muted);
body+=rect(64,194,375,436,c.ink,28)+t(96,246,'所有者单聊',31,c.white,700)+t(96,284,'Owner DM',20,c.lime)+rect(91,315,321,82,c.lime,16)+t(109,365,'/topic new main 周报整理',17,c.ink,600,true);
body+=t(96,443,'/help 查看项目标识',20,c.white)+t(96,490,'/topic list 找回入口',20,c.white)+t(96,553,'普通文字继续主控对话',20,c.lime)+t(96,588,'不会自动切换到其他群',20,c.lime);
const cards=[{y:175,n:'1',title:'周报整理',sub:'Weekly report',text:'群内 @机器人 · 持续补充工作进展'},{y:350,n:'2',title:'客户方案',sub:'Customer proposal',text:'群内 @机器人 · 分轮完善同一份方案'},{y:525,n:'3',title:'数据小结',sub:'Data summary',text:'群内 @机器人 · 引用材料并核对口径'}];
for(const card of cards){body+=arrow(`M452 413H548V${card.y+70}H648`)+rect(667,card.y,709,140,c.white,24,c.line)+rect(689,card.y+25,80,87,c.soft,18)+t(714,card.y+83,card.n,42,c.ink,700)+t(795,card.y+43,card.title,27,c.ink,700)+t(795,card.y+75,card.sub,19,c.muted)+t(795,card.y+112,card.text,20,c.ink);}
body+=t(64,703,'在对应群控制对应任务；同一项目下的文件仍可能共享。',22,c.muted)+foot(756);
await writeFile(join(dir,'topics.svg'),svg(790,'单聊主控与独立专项群、独立 Codex 对话的关系',body),'utf8');

body=t(64,86,'安装与上手：先跑通一个群',44,c.ink,700)+t(66,132,'Four steps. Verify a single group before enabling more topics.',23,c.muted);
const steps=[{x:60,n:'01',title:'准备环境',en:'Prepare',lines:['Windows x64 + Node.js 22','登录兼容的 Codex 桌面','创建并授权飞书机器人']},{x:400,n:'02',title:'绑定与封存',en:'Bind',lines:['核对工具、项目与对话 ID','安全保存机器人凭据','生成新的配置与部署清单']},{x:740,n:'03',title:'启动与核验',en:'Verify',lines:['默认手动启动','按提示正常退出 Codex','自动重开后暂时保持空闲']},{x:1080,n:'04',title:'开始工作',en:'Work',lines:['单聊 /help 查看项目','创建话题，进入专项群','群内 @机器人持续追问']}];
for(const step of steps){body+=rect(step.x,193,300,352,c.white,25,c.line)+rect(step.x+23,217,64,50,c.lime,14)+t(step.x+35,252,step.n,25,c.ink,700)+t(step.x+24,311,step.title,29,c.ink,700)+t(step.x+24,348,step.en,19,c.muted);step.lines.forEach((line,i)=>{body+=t(step.x+24,403+i*47,line,18,c.ink);});}
for(const x of [369,709,1049])body+=arrow(`M${x} 361h24`);
body+=rect(60,580,1320,67,c.soft,18)+t(85,622,'以实际 running、连接和新鲜心跳确认就绪；不要把弹窗或窗口打开当作成功证明。',22,c.ink);
body+=foot(693,'安装流程示意 / Installation diagram · 详细命令与权限见安装指南');
await writeFile(join(dir,'installation.svg'),svg(730,'QIU Bridge 的环境准备、绑定、启动核验和日常使用流程',body),'utf8');
console.log(JSON.stringify({generated:['overview.svg','topics.svg','installation.svg'],directory:dir}));
