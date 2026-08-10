// VERIFIER: what does the operator actually SEE after a NaN row is persisted?
import { chromium } from 'playwright-core'
const exe = process.env.LOCALAPPDATA + '/ms-playwright/chromium-1228/chrome-win64/chrome.exe'
const b = await chromium.launch({ executablePath: exe })
const p = await (await b.newContext()).newPage()
const errs=[]; p.on('pageerror',e=>errs.push(e.message))
await p.goto('http://localhost:4212/'); await p.waitForTimeout(2000)
// inject a row with null coords straight into storage (what K2 wrote)
await p.evaluate(()=>{const d=JSON.parse(localStorage.getItem('pumpcycle-demo-v4'))
  d.customers.push({name:'Bad Row',address:'x',phone:'',email:'',tankSizeGal:1000,lastPumped:'2026-08-10',cycleMonths:36,notes:'',lat:null,lng:null,id:'c-bad'})
  localStorage.setItem('pumpcycle-demo-v4',JSON.stringify(d))})
await p.reload(); await p.waitForTimeout(3000)
console.log('visible text after reload:',JSON.stringify((await p.locator('body').innerText()).slice(0,200)))
console.log('root children:',await p.evaluate(()=>document.getElementById('root').childElementCount))
console.log('pageerrors:',errs)
// can the operator recover by switching tabs? (app is unmounted, so no)
console.log('any button on screen:',await p.locator('button').count())
await b.close()
