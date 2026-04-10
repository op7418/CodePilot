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
var r=root.getBoundingClientRect();
var h=Math.ceil(r.height);
if(h>0&&h!==_lastH){_lastH=h;parent.postMessage({type:'widget:resize',height:h,first:_first},'*');}
_first=false;
},60);
}
var _lastH=0;
var _ro=new ResizeObserver(_h);
_ro.observe(root);

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
// Append and execute scripts without disturbing existing DOM
for(var i=0;i<scripts.length;i++){
var n=document.createElement('script');
if(scripts[i].src)n.src=scripts[i].src;
else if(scripts[i].text)n.textContent=scripts[i].text;
for(var j=0;j<scripts[i].attrs.length;j++)n.setAttribute(scripts[i].attrs[j].name,scripts[i].attrs[j].value);
root.appendChild(n);
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
<body style="margin:0;padding:0;height:fit-content;overflow:hidden;">
<div id="__root" style="height:fit-content;"></div>
<script>${receiverScript}</script>
</body>
</html>`;
}
