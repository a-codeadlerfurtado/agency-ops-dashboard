import { chromium } from 'playwright';
import fs from 'node:fs';
const [port,path] = fs.readFileSync('C:/Users/Adler/AppData/Local/Google/Chrome/User Data/DevToolsActivePort','utf8').trim().split(/\r?\n/);
const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${path}`);
for (const [ci,ctx] of browser.contexts().entries()) {
  for (const [pi,p] of ctx.pages().entries()) {
    console.log(`${ci}:${pi} ${await p.title().catch(()=> '')} ${p.url()}`);
  }
}
await browser.close();
