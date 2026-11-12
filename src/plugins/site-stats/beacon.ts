/**
 * Client beacon, injected at `body:end` of every counted page. The page key is baked in at
 * render time, so the route never maps a slug to an id and cached HTML keeps counting (the
 * browser still runs the script).
 */
const URL_PATH = "/_emdash/api/plugins/site-stats/track";

export function buildBeacon(key: string): string {
	return `(function(){try{
if(window.__siteStatsSent)return;window.__siteStatsSent=1;
if(document.visibilityState==="prerender")return;
var n=navigator;if(n.doNotTrack==="1"||n.globalPrivacyControl||n.webdriver)return;
var b=JSON.stringify({k:${JSON.stringify(key)},p:location.pathname,r:document.referrer});
var u=${JSON.stringify(URL_PATH)};
if(n.sendBeacon&&n.sendBeacon(u,new Blob([b],{type:"text/plain"})))return;
fetch(u,{method:"POST",body:b,keepalive:true,headers:{"content-type":"text/plain"}}).catch(function(){});
}catch(e){}})();`;
}
