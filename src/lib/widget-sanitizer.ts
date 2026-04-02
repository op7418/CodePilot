/**
 * Widget HTML sanitizer + iframe srcdoc builder.
 *
 * Security model:
 *
 * 1. **Streaming updates** (pushed to iframe via postMessage):
 *    - Dangerous embedding tags stripped (iframe, object, embed, form, etc.)
 *    - ALL on* handlers stripped (preview is purely visual)
 *    - ALL script tags stripped
 *    - javascript:/data: URLs in href/src/action stripped
 *
 * 2. **Finalized rendering** (pushed to iframe via postMessage):
 *    - Only dangerous embedding tags stripped
 *    - Scripts execute inside the sandboxed iframe (safe)
 *    - Handlers execute inside the sandboxed iframe (safe)
 *
 * 3. **iframe sandbox** (set by WidgetRenderer):
 *    - `sandbox="allow-scripts"` only
 *    - No allow-same-origin, allow-top-navigation, allow-popups
 *    - CSP meta tag: script-src limited to CDN whitelist + inline;
 *      connect-src 'none' blocks fetch/XHR/WebSocket
 *    - Links intercepted, forwarded to parent via postMessage
 *    - Height synced via ResizeObserver + postMessage
 */

// ── CDN whitelist ──────────────────────────────────────────────────────────

export const CDN_WHITELIST = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
];

// ── HTML sanitization ────────────────────────────────────────────────────

const DANGEROUS_TAGS = /<(iframe|object|embed|meta|link|base|form)[\s>][\s\S]*?<\/\1>/gi;
const DANGEROUS_VOID = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi;

/**
 * Sanitize widget HTML for streaming preview (no interactivity).
 * Strips: dangerous tags, ALL on* handlers, ALL scripts, js/data URLs.
 */
export function sanitizeForStreaming(html: string): string {
  return html
    .replace(DANGEROUS_TAGS, '')
    .replace(DANGEROUS_VOID, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']*)/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(
      /\s+(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/gi,
      (match, _attr: string, dq?: string, sq?: string, uq?: string) => {
        const url = (dq ?? sq ?? uq ?? '').trim();
        if (/^\s*(javascript|data)\s*:/i.test(url)) return '';
        return match;
      },
    );
}

/**
 * Light sanitization for finalized content inside iframe.
 * Only strips tags that could nest/break out of the sandbox.
 */
export function sanitizeForIframe(html: string): string {
  return html
    .replace(DANGEROUS_TAGS, '')
    .replace(DANGEROUS_VOID, '');
}

// ── Receiver iframe srcdoc ────────────────────────────────────────────────

/**
 * Build the "receiver" iframe document.
 *
 * This iframe stays alive for the widget's entire lifetime. Content is
 * pushed into it via postMessage in two phases:
 *
 * 1. **Streaming** (`widget:update`): sanitized HTML (no scripts/handlers)
 *    is set as innerHTML. Height grows incrementally.
 *
 * 2. **Finalize** (`widget:finalize`): full HTML is set. Script elements
 *    are cloned-and-replaced to trigger execution.
 *
 * Also handles: height sync, link interception, theme updates, sendMessage.
 */
export function buildReceiverSrcdoc(
  styleBlock: string,
  isDark: boolean,
): string {
  const cspDomains = CDN_WHITELIST.map(d => 'https://' + d).join(' ');
  const csp = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cspDomains}`,
    "style-src 'unsafe-inline'",
    "img-src * data: blob:",
    "font-src * data:",
    "connect-src 'none'",
  ].join('; ');

  const receiverScript = `(function(){
var root=document.getElementById('__root');
var _t=null,_first=true;
function _h(){
if(_t)clearTimeout(_t);
_t=setTimeout(function(){
var h=document.body.scrollHeight;
if(h>0)parent.postMessage({type:'widget:resize',height:h,first:_first},'*');
_first=false;
},60);
}
var _ro=new ResizeObserver(_h);
_ro.observe(document.body);

function applyHtml(html){
root.innerHTML=html;
_h();
}

function finalizeHtml(html){
// Parse finalized HTML in a temp container to separate scripts from content
var tmp=document.createElement('div');
tmp.innerHTML=html;
var ss=tmp.querySelectorAll('script');
var scripts=[];
for(var i=0;i<ss.length;i++){
scripts.push({src:ss[i].src||'',text:ss[i].textContent||'',attrs:[]});
for(var j=0;j<ss[i].attributes.length;j++){
var a=ss[i].attributes[j];
if(a.name!=='src')scripts[scripts.length-1].attrs.push({name:a.name,value:a.value});
}
ss[i].remove();
}
// Update non-script content only if it differs (avoids repaint flash)
var visualHtml=tmp.innerHTML;
if(root.innerHTML!==visualHtml)root.innerHTML=visualHtml;
// Append and execute scripts without disturbing existing DOM.
// CDN scripts load first; inline scripts execute exactly once after ALL CDNs resolve.
// This avoids let/const redeclaration errors from re-injecting inline scripts.
var cdnScripts=scripts.filter(function(s){return !!s.src});
var inlineScripts=scripts.filter(function(s){return !s.src&&s.text});
function _appendInline(){
for(var k=0;k<inlineScripts.length;k++){
var s=document.createElement('script');
s.textContent=inlineScripts[k].text;
for(var j=0;j<inlineScripts[k].attrs.length;j++)s.setAttribute(inlineScripts[k].attrs[j].name,inlineScripts[k].attrs[j].value);
root.appendChild(s);
}
_h();
// Signal that all scripts (CDN + inline) have executed.
// Chart.js init runs synchronously inside inline scripts, so canvas is painted by now.
setTimeout(function(){parent.postMessage({type:'widget:scriptsReady'},'*')},50);
}
if(cdnScripts.length===0){
_appendInline();
}else{
// Wait for ALL CDN scripts to load/error, then run inline once
var _pending=cdnScripts.length;
function _onCdnDone(){_pending--;if(_pending<=0)_appendInline()}
for(var i=0;i<cdnScripts.length;i++){
var n=document.createElement('script');
n.src=cdnScripts[i].src;
n.onload=_onCdnDone;
n.onerror=_onCdnDone;
for(var j=0;j<cdnScripts[i].attrs.length;j++){
if(cdnScripts[i].attrs[j].name!=='onload')n.setAttribute(cdnScripts[i].attrs[j].name,cdnScripts[i].attrs[j].value);
}
root.appendChild(n);
}
}
_h();
}

window.addEventListener('message',function(e){
if(!e.data)return;
switch(e.data.type){
case 'widget:update':
applyHtml(e.data.html);
break;
case 'widget:finalize':
finalizeHtml(e.data.html);
setTimeout(_h,150);
break;
case 'widget:theme':
var r=document.documentElement,v=e.data.vars;
if(v)for(var k in v)r.style.setProperty(k,v[k]);
if(typeof e.data.isDark==='boolean')r.className=e.data.isDark?'dark':'';
setTimeout(_h,100);
break;
case 'widget:crossFilter':
// Received from parent: another widget published a filter event
window.dispatchEvent(new CustomEvent('widget-filter',{detail:e.data.payload}));
break;
case 'widget:capture':
// Send HTML + canvas snapshots back to parent for compositing.
// Parent renders HTML in a normal div and overlays canvas images.
// This avoids foreignObject limitations entirely.
try{
var rootEl=document.getElementById('__root');
var html=rootEl?rootEl.innerHTML:'';
var styles='';
var styleEls=document.querySelectorAll('style');
for(var si=0;si<styleEls.length;si++)styles+=styleEls[si].textContent;
// Snapshot each canvas as base64 image
var canvasSnapshots=[];
var allCanvases=document.querySelectorAll('canvas');
for(var ci=0;ci<allCanvases.length;ci++){
try{
var cvs=allCanvases[ci];
canvasSnapshots.push({dataUrl:cvs.toDataURL('image/png'),width:cvs.offsetWidth,height:cvs.offsetHeight});
// Replace canvas in HTML with a placeholder img
var placeholder=document.createElement('img');
placeholder.setAttribute('data-canvas-export',ci.toString());
placeholder.style.cssText='width:'+cvs.offsetWidth+'px;height:'+cvs.offsetHeight+'px;display:block;';
cvs.parentNode.insertBefore(placeholder,cvs);
cvs.style.display='none';
}catch(ce){canvasSnapshots.push(null)}
}
// Re-read HTML with placeholders
var htmlWithPlaceholders=rootEl?rootEl.innerHTML:'';
// Restore canvases
var placeholders=document.querySelectorAll('[data-canvas-export]');
for(var pi=0;pi<placeholders.length;pi++)placeholders[pi].remove();
for(var ci=0;ci<allCanvases.length;ci++)allCanvases[ci].style.display='';
parent.postMessage({type:'widget:captured',html:htmlWithPlaceholders,styles:styles,canvases:canvasSnapshots,bodyWidth:document.body.scrollWidth,bodyHeight:document.body.scrollHeight},'*');
}catch(err){parent.postMessage({type:'widget:captured',html:null},'*')}
break;
}
});

document.addEventListener('click',function(e){
var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;
if(!a)return;var h=a.getAttribute('href');
if(!h||h.charAt(0)==='#')return;
e.preventDefault();
parent.postMessage({type:'widget:link',href:h},'*');
});

window.__widgetSendMessage=function(t){
if(typeof t!=='string'||t.length>500)return;
parent.postMessage({type:'widget:sendMessage',text:t},'*');
};

// Cross-widget communication: publish filter/selection events to other widgets
window.__widgetPublish=function(topic,data){
if(typeof topic!=='string')return;
parent.postMessage({type:'widget:publish',topic:topic,data:data},'*');
};

parent.postMessage({type:'widget:ready'},'*');
})();`;

  return `<!DOCTYPE html>
<html class="${isDark ? 'dark' : ''}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
${styleBlock}
</style>
</head>
<body style="margin:0;padding:0;">
<div id="__root"></div>
<script>${receiverScript}</script>
</body>
</html>`;
}
