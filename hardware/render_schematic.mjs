import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const root=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1220},deviceScaleFactor:1});
  const svg=await fs.readFile(path.join(root,'eda/module-interconnect.svg'),'utf8');
  await page.setContent('<html><head><meta charset="utf-8"><style>body{margin:0}</style></head><body>'+svg+'</body></html>');
  await page.screenshot({path:path.join(root,'eda/module-interconnect.png'),fullPage:true});
  await page.setContent('<html><head><meta charset="utf-8"><style>@page{size:A3 landscape;margin:10mm}body{margin:0}svg{width:100%;height:auto;max-height:275mm}</style></head><body>'+svg+'</body></html>');
  await page.pdf({path:path.join(root,'eda/module-interconnect.pdf'),printBackground:true,preferCSSPageSize:true});
  console.log('PNG and A3 PDF rendered from module-interconnect.svg; not EDA import/ERC evidence.');
} finally {await browser.close();}
