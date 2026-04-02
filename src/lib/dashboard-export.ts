'use client';

/**
 * Dashboard Export — render widget to PNG.
 *
 * Electron only: builds standalone HTML, sends to main process which renders
 * in an isolated BrowserWindow and captures via Chromium screenshot.
 * No security compromise — the export window is sandboxed with its own partition.
 * Non-Electron environments throw (export is a desktop-only feature).
 */

import { resolveThemeVars, getWidgetIframeStyleBlock } from '@/lib/widget-css-bridge';
import { sanitizeForIframe, CDN_WHITELIST } from '@/lib/widget-sanitizer';

/**
 * Build a standalone HTML page for the widget (no receiver script needed).
 * Includes: CSS bridge, CSP, script execution, scriptsReady signal.
 */
function buildExportHtml(widgetCode: string, styleBlock: string, isDark: boolean): string {
  const sanitized = sanitizeForIframe(widgetCode);
  const cspDomains = CDN_WHITELIST.map(d => 'https://' + d).join(' ');

  // Separate CDN and inline scripts (same logic as receiver's finalizeHtml)
  const scriptExec = `
<script>
(function(){
  var tmp=document.createElement('div');
  tmp.innerHTML=document.getElementById('__raw').textContent;
  var ss=tmp.querySelectorAll('script');
  var scripts=[];
  for(var i=0;i<ss.length;i++){
    var attrs=[];
    for(var j=0;j<ss[i].attributes.length;j++){
      var a=ss[i].attributes[j];
      if(a.name!=='src')attrs.push({name:a.name,value:a.value});
    }
    scripts.push({src:ss[i].src||'',text:ss[i].textContent||'',attrs:attrs});
    ss[i].remove();
  }
  document.getElementById('__root').innerHTML=tmp.innerHTML;

  var cdnScripts=scripts.filter(function(s){return !!s.src});
  var inlineScripts=scripts.filter(function(s){return !s.src&&s.text});
  function runInline(){
    for(var k=0;k<inlineScripts.length;k++){
      var s=document.createElement('script');
      s.textContent=inlineScripts[k].text;
      for(var a=0;a<inlineScripts[k].attrs.length;a++)s.setAttribute(inlineScripts[k].attrs[a].name,inlineScripts[k].attrs[a].value);
      document.getElementById('__root').appendChild(s);
    }
    setTimeout(function(){console.log('__scriptsReady__')},50);
  }
  if(cdnScripts.length===0){runInline()}
  else{
    var pending=cdnScripts.length;
    function onDone(){pending--;if(pending<=0)runInline()}
    for(var i=0;i<cdnScripts.length;i++){
      var n=document.createElement('script');
      n.src=cdnScripts[i].src;
      for(var a=0;a<cdnScripts[i].attrs.length;a++){if(cdnScripts[i].attrs[a].name!=='onload')n.setAttribute(cdnScripts[i].attrs[a].name,cdnScripts[i].attrs[a].value)}
      n.onload=onDone;n.onerror=onDone;
      document.getElementById('__root').appendChild(n);
    }
  }
})();
</script>`;

  return `<!DOCTYPE html>
<html class="${isDark ? 'dark' : ''}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${cspDomains}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'">
<style>
${styleBlock}
</style>
</head>
<body style="margin:0;padding:0;background:${isDark ? '#1a1a2e' : '#ffffff'};">
<div id="__root"></div>
<script id="__raw" type="text/plain">${sanitized.replace(/<\/script>/g, '<\\/script>')}</script>
${scriptExec}
</body>
</html>`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const electronAPI = typeof window !== 'undefined' ? (window as any).electronAPI : null;

export async function exportWidgetAsImage(widgetCode: string, width = 640): Promise<Blob> {
  const isDark = document.documentElement.classList.contains('dark');
  const resolvedVars = resolveThemeVars();
  const styleBlock = getWidgetIframeStyleBlock(resolvedVars);
  const html = buildExportHtml(widgetCode, styleBlock, isDark);

  // Electron only: isolated BrowserWindow + Chromium capturePage
  if (!electronAPI?.widget?.exportPng) {
    throw new Error('Widget export is only available in the desktop app.');
  }

  const base64 = await electronAPI.widget.exportPng(html, width, isDark);
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
