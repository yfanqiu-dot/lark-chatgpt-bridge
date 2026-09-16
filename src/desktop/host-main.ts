import { desktopHostMain } from './host';
void desktopHostMain().catch(e=>{console.error(String(e));process.exitCode=1;});
