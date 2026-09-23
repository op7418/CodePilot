import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const baseURL = process.env.SITE_SMOKE_URL || 'http://localhost:3001';
const target = new URL(baseURL);
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.protocol !== 'http:') throw new Error('Use a local site server for smoke testing');
const artifactDir = process.env.SITE_SMOKE_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-site-smoke-'));
fs.mkdirSync(artifactDir, { recursive: true });

async function checkLocalizedScreenshots(page, locale) {
 const screenshots = page.locator('.screenshot-stage img');
 await expect.poll(() => screenshots.evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
 const sources = await screenshots.evaluateAll(images => images.map(image => new URL(image.currentSrc).searchParams.get('url') || new URL(image.currentSrc).pathname));
 if (sources.some(src => !src.startsWith(`/screenshots/${locale}/`))) throw Error('Screenshot locale mismatch: ' + sources.join(', '));
 for (const name of ['chat', 'plugins', 'providers']) if (!sources.includes(`/screenshots/${locale}/${name}-window.webp`)) throw Error('Missing localized screenshot: ' + name);
 const corners = await page.locator('.continuous-corners').evaluateAll(elements => elements.map(element => ({path: getComputedStyle(element).clipPath, ready: element.dataset.cornersReady})));
 if (corners.length !== 2 || corners.some(corner => corner.ready !== 'true' || !corner.path.startsWith('path(') || (corner.path.match(/C/g) || []).length !== 8)) throw Error('Continuous Bézier corners are missing');
 const frame = await page.locator('[data-screenshot-frame]').boundingBox();
 if (Math.abs(frame.width / frame.height - 64 / 43) > 0.01) throw Error('Native screenshot ratio was distorted');
 await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', new RegExp(`/screenshots/${locale}/chat-window\\.webp$`));
}

async function sampleSlideMotion(carousel) {
 return carousel.evaluate(el=>new Promise(resolve=>{
  const samples=[];
  const start=performance.now();
  function sample(now) {
   const frame=el.querySelector('[data-screenshot-frame]');
   const active=el.querySelector('figure[data-active="true"]');
   const bounds=frame.getBoundingClientRect();
   samples.push({x:new DOMMatrixReadOnly(getComputedStyle(active).transform).m41,width:bounds.width,height:bounds.height,activeCount:el.querySelectorAll('figure[aria-hidden="false"]').length});
   if(now-start<750)requestAnimationFrame(sample);else resolve(samples);
  }
  requestAnimationFrame(sample);
 }));
}

async function checkSlideMotion(carousel, direction) {
 const samples=await sampleSlideMotion(carousel);
 const moving=samples.filter(s=>s.x*direction>1 && s.x*direction<s.width-1);
 if(moving.length<2||moving[0].x===moving.at(-1).x)throw Error('Expected a smooth directional slide: '+JSON.stringify(samples));
 if(samples.some(s=>Math.abs(s.height-samples[0].height)>1||s.activeCount!==1))throw Error('Slide transition shifted layout or exposed duplicate slides');
 if(Math.abs(samples.at(-1).x)>0.5)throw Error('Slide did not settle');
 await expect(carousel.locator('figure')).toHaveCount(1);
}

async function checkMarketingCopy(page, locale, capture = false) {
 const isZh=locale==='zh';
 await expect(page).toHaveTitle(isZh ? 'CodePilot — 你的 AI 桌面工作台' : 'CodePilot — Your Desktop AI Workspace');
 await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',/Claude Code.*Codex.*CodePilot/);
 await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content',await page.locator('meta[name="description"]').getAttribute('content'));
 const faq=page.getByRole('heading',{name:isZh ? /^常见问题/ : /^Frequently asked questions/}).locator('xpath=ancestor::section');
 const questions=faq.getByRole('button');
 await expect(questions).toHaveCount(7);
 const facts=isZh ? [/BSL 1\.1.*100.*商业授权/,/订阅授权.*本地模型/,/Ollama.*并非所有组合/,/首次发送后.*固定.*新建聊天/,/CodePilot Agent 不需要额外安装 CLI/,/保存在本地.*服务商.*匿名错误.*重启/,/Linux.*AppImage.*DEB.*RPM.*手动/] : [/BSL 1\.1.*100.*commercial license/,/subscription sign-in.*local model/,/Ollama.*not every combination/,/first message.*stays.*new conversation/,/CodePilot agent works without an additional CLI/,/stored locally.*provider.*anonymous error.*restart/,/Linux.*AppImage.*DEB.*RPM.*downloading/];
 for(let i=0;i<facts.length;i++) {
  await questions.nth(i).click();
  await expect(questions.nth(i)).toHaveAttribute('aria-expanded','true');
  await expect(faq.getByRole('region')).toHaveCount(1);
  await expect(faq.getByRole('region')).toContainText(facts[i]);
  await expect.poll(()=>faq.locator('[role="region"]').evaluateAll(els=>els.every(el=>el.getAttribute('aria-hidden')==='true' ? el.clientHeight<=1 : el.clientHeight>=el.firstElementChild.scrollHeight-1))).toBe(true);
  await expect(faq.getByRole('link')).toHaveCount(i===0||i===6 ? 1 : 0);
  if(i===0)await expect(faq.getByRole('link')).toHaveAttribute('href','https://github.com/op7418/CodePilot/blob/main/LICENSE');
  if(i===6)await expect(faq.getByRole('link')).toHaveAttribute('href','https://github.com/op7418/CodePilot/releases/latest');
  if(capture&&(i===0||i===5||i===6))await faq.screenshot({path:path.join(artifactDir,`site-faq-${locale}-${i}.png`),style:'nextjs-portal {display:none;}'});
 }
 await questions.last().click();
 await expect(faq.getByRole('region')).toHaveCount(0);
 await expect(faq.getByRole('link')).toHaveCount(0);
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow)throw Error('Updated FAQ overflows viewport');
 const navLinks=await page.locator('main > nav').getByRole('link').evaluateAll(els=>els.map(el=>{
  const {x,width}=el.getBoundingClientRect();return {x,right:x+width};
 }));
 if(navLinks.some((link,index)=>index>0&&link.x<navLinks[index-1].right))throw Error('Header navigation links overlap');
}

(async () => {
 const browser=await chromium.launch({headless:true});
 const errors=[];
 const results=[];
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1150},deviceScaleFactor:1,colorScheme:'light'});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',msg=>{if(msg.type()==='error' && /hydrat|matching|validateDOM|nesting/.test(msg.text())) errors.push(msg.text());});
  await page.goto(`${baseURL}/zh`);
  const carousel=page.getByRole('region',{name:'CodePilot 界面'});
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','全新对话界面');
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveJSProperty('complete',true);
  await expect(carousel.locator('figure[data-active="true"] img')).not.toHaveJSProperty('naturalWidth',0);
  await checkLocalizedScreenshots(page, 'zh');
  await expect(carousel.getByRole('button')).toHaveCount(3);
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','技能与扩展',{timeout:6500});
  await carousel.hover();
  await page.waitForTimeout(5500);
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','技能与扩展');
  await carousel.getByRole('button',{name:'技能与扩展',exact:true}).click();
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','技能与扩展');
  await carousel.getByRole('button',{name:'技能与扩展',exact:true}).press('ArrowRight');
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','连接 AI 服务');
  await carousel.getByRole('button',{name:'连接 AI 服务',exact:true}).press('ArrowRight');
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','全新对话界面');
  await expect(carousel.getByRole('button',{name:'全新对话界面',exact:true})).toBeFocused();
  await page.mouse.move(0,0);
  await page.waitForTimeout(5500);
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','全新对话界面');
  results.push('Carousel: 5s autoplay / hover + keyboard focus pause / three dots / click / arrows / wraparound passed');
  await carousel.getByRole('button',{name:'技能与扩展',exact:true}).click();
  await checkSlideMotion(carousel,1);
  await carousel.getByRole('button',{name:'全新对话界面',exact:true}).click();
  await checkSlideMotion(carousel,-1);
  await carousel.getByRole('button',{name:'连接 AI 服务',exact:true}).click();
  await expect(carousel.locator('figure')).toHaveCount(1);
  await carousel.getByRole('button',{name:'连接 AI 服务',exact:true}).press('ArrowRight');
  await checkSlideMotion(carousel,1);
  await carousel.getByRole('button',{name:'技能与扩展',exact:true}).click();
  await carousel.getByRole('button',{name:'连接 AI 服务',exact:true}).click();
  await carousel.getByRole('button',{name:'全新对话界面',exact:true}).click();
  await expect(carousel.locator('figure')).toHaveCount(1);
  await expect(carousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','全新对话界面');
  results.push('Motion: forward / backward / forward wrap slide across intermediate frames; fixed frame height; only active slide exposed; rapid clicks settle correctly');
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.getByRole('heading', {level:1}).click();
  await expect(page.getByRole('heading', {level:1})).toHaveText(/专注 (开发|设计|写作|调研|调试|原型)$/);
  await page.screenshot({path:path.join(artifactDir, 'site-home-desktop.png'),style:'nextjs-portal {display:none;}'});
  await carousel.screenshot({path:path.join(artifactDir, 'site-carousel.png')});
  await expect(page.getByRole('heading',{name:'多 Agent 切换',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Code · Plan · Ask',exact:true})).toHaveCount(0);
  const features=page.getByRole('heading',{name:'多 Agent 切换',exact:true}).locator('xpath=ancestor::section');
  const featureWidths=await features.locator('h3 + p').evaluateAll(els=>els.map(el=>el.getBoundingClientRect().width));
  if(featureWidths.length!==8||featureWidths.some(w=>w>288||w!==featureWidths[0]))throw Error('Feature copy widths are not consistently constrained: '+featureWidths);
  await features.screenshot({path:path.join(artifactDir,'site-features.png')});
  results.push('Feature copy: all eight descriptions share a 288px maximum width');
  await checkMarketingCopy(page,'zh',true);
  results.push('Chinese marketing: current agents / BSL terms / supported connections / bound-agent conversations / CLI setup / telemetry / Linux packages; seven FAQs and source links passed');
  const hero=carousel.locator('xpath=ancestor::section');
  await expect(hero.getByRole('img',{name:'CodePilot',exact:true})).toHaveAttribute('src',/logo\.[a-z0-9]+\.png/);
  const logoBounds=await hero.getByRole('img',{name:'CodePilot',exact:true}).boundingBox();
  if(logoBounds.width>96||logoBounds.height>96)throw Error('Hero app icon is too large');
  await expect(page.locator('img[src*="logo.png"]')).toHaveCount(0);
  const glow=await page.locator('.rainbow-glow').evaluateAll(els=>els.map(el=>{
   const style=getComputedStyle(el,'::before');
   return {background:style.backgroundImage,filter:style.filter,width:parseFloat(style.width)};
  }));
  if(glow.length!==2||glow.some(s=>!s.background.includes('linear-gradient')||s.filter==='none'||s.width===0)) throw Error('Missing rainbow download glow');
  const heroBounds=await hero.boundingBox();
  const carouselBounds=await carousel.boundingBox();
  if(heroBounds.x<40||1440-heroBounds.x-heroBounds.width<40||heroBounds.y+heroBounds.height-carouselBounds.y-carouselBounds.height<90)throw Error('Hero gray area needs more breathing room');
  results.push('Current macOS app icon / smaller logo / multi-agent copy / both rainbow CTAs / gray hero insets passed');
  const cards=page.getByRole('button',{name:/v.*阅读更新详情/});
  await expect(cards).toHaveCount(4);
  const rows=await cards.evaluateAll(els=>els.map(el=>{
   const {x,y,width,height}=el.getBoundingClientRect();
   return {x,y,width,height,radius:getComputedStyle(el).borderRadius};
  }));
  if(rows.some((r,i)=>r.height>145||r.radius!=='0px'||r.x!==rows[0].x||r.width!==rows[0].width||(i>0&&r.y<rows[i-1].y+rows[i-1].height)))throw Error('Expected four capped, square, single-column rows: '+JSON.stringify(rows));
  await cards.first().locator('xpath=ancestor::section').screenshot({path:path.join(artifactDir,'site-releases.png')});
  await cards.first().click();
  const dialog=page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading',{name:'新增功能',exact:true})).toBeVisible();
  const scroll=await dialog.locator('[data-release-body]').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight}));
  if(scroll.scroll<=scroll.height)throw Error('Expected scrollable long release');
  await expect(dialog.locator('strong').first()).toBeVisible();
  await expect(dialog.getByRole('link',{name:'在 GitHub 上查看'})).toHaveAttribute('href',/github.com\/op7418\/CodePilot\/releases\/tag\//);
  await page.screenshot({path:path.join(artifactDir, 'site-release-dialog.png'),style:'nextjs-portal {display:none;}'});
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(cards.first()).toBeFocused();
  await cards.first().click();
  await page.getByRole('button',{name:'关闭更新详情'}).click();
  await expect(dialog).toBeHidden();
  await expect(cards.first()).toBeFocused();
  results.push('Release rows: four stable releases / square single column / 144px cap / full Markdown / inner scroll / Escape + close return focus passed');
  const neutral=await page.locator('body').evaluate(el=>({background:getComputedStyle(el).backgroundColor, foreground:getComputedStyle(el).color}));
  results.push('Light palette: '+JSON.stringify(neutral));
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${baseURL}/zh`);
  await expect(page.getByRole('region',{name:'CodePilot 界面'})).toBeVisible();
  let overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw Error('Mobile page overflows horizontally');
  const mobileCarouselBounds=await carousel.boundingBox();
  if(mobileCarouselBounds.x<32||390-mobileCarouselBounds.x-mobileCarouselBounds.width<32)throw Error('Mobile gray stage needs edge spacing');
  await page.screenshot({path:path.join(artifactDir, 'site-home-mobile.png'),style:'nextjs-portal {display:none;}'});
  await checkMarketingCopy(page,'zh');
  await page.getByRole('button',{name:/v.*阅读更新详情/}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const bounds=await page.getByRole('dialog').boundingBox();
  if(bounds.x<0||bounds.x+bounds.width>390||bounds.height>844)throw Error('Mobile dialog outside viewport');
  await page.keyboard.press('Tab');
  const focusInside=await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement));
  if(!focusInside)throw Error('Dialog failed focus trap');
  await page.keyboard.press('Escape');
  results.push('390px mobile: no page overflow / dialog fits / focus stays inside passed');
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
  await page.goto(`${baseURL}/`);
  await checkMarketingCopy(page,'en',true);
  await checkLocalizedScreenshots(page, 'en');
  await expect(page).toHaveURL(`${baseURL}/`);
  const enCarousel=page.getByRole('region',{name:'Inside CodePilot'});
  await expect(enCarousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','A new conversation');
  await expect(enCarousel.getByRole('button',{name:/Pause slideshow|Play slideshow/})).toHaveCount(0);
  await page.waitForTimeout(6200);
  await expect(enCarousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','A new conversation');
  await enCarousel.getByRole('button',{name:'Skills and extensions',exact:true}).click();
  const reducedFrames=await sampleSlideMotion(enCarousel);
  if(reducedFrames.some(s=>Math.abs(s.x)>0.5))throw Error('Reduced-motion preference still slides images');
  await expect(enCarousel.locator('figure[data-active="true"] img')).toHaveAttribute('alt','Skills and extensions');
  await expect(enCarousel.locator('figure[data-active="true"] img')).toHaveJSProperty('complete',true);
  await expect(enCarousel.locator('figure[data-active="true"] img')).not.toHaveJSProperty('naturalWidth',0);
  await page.getByRole('button',{name:/v.*Read release notes/}).first().click();
  await expect(page.getByRole('button',{name:'Close release notes'})).toBeVisible();
  await page.getByRole('button',{name:'Close release notes'}).click();
  overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(overflow)throw Error('English mobile page overflows horizontally');
  await page.setViewportSize({width:1440,height:1150});
  await page.evaluate(()=>window.scrollTo(0,0));
  await expect(enCarousel.locator('figure[data-active="true"] img')).toHaveJSProperty('complete',true);
  await expect(enCarousel.locator('figure[data-active="true"] img')).not.toHaveJSProperty('naturalWidth',0);
  await page.screenshot({path:path.join(artifactDir, 'site-home-dark.png'),style:'nextjs-portal {display:none;}'});
  results.push('English + dark + reduced motion: manual controls work / no autoplay / localized dialog passed');
  results.push('English marketing + mobile Chinese: FAQ parity / localized title + sharing metadata / no hidden focusable links / no overflow passed');
  await page.goto(`${baseURL}/zh/docs`);
  const docsLogo=page.getByRole('img',{name:'CodePilot',exact:true});
  await expect(docsLogo.first()).toHaveAttribute('src',/logo\.[a-z0-9]+\.png/);
  await expect(page.locator('img[src*="logo.png"]')).toHaveCount(0);
  results.push('Docs navigation shares the current macOS app icon with a content-hashed URL');
  if(errors.length)throw Error('Browser errors: '+JSON.stringify(errors));
  results.push('No page errors or hydration warnings');
  console.log(results.join('\n'));
  console.log('Evidence: ' + artifactDir);
  fs.writeFileSync(path.join(artifactDir, 'results.txt'),results.join('\n')+'\n');
 } finally {await browser.close();}
})();
