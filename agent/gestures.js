"use strict";
// 手势层（CLI 侧真源）：构造页内手势 JS，走扩展的通用 `cdp Runtime.evaluate` 通道发射。
// 扩展仓保持纯基建（snapshot/click-el/type-el/setfile/cdp/run）不再承载手势——
// 手势迭代只改本文件，不 bump / 重载扩展。
//
// ⚠ 同步纪律：下方 EL_CANDIDATE_SEL / COLLECTOR_SRC 必须与扩展仓
//   extension/src/lib/page-actions.js 的 EL_COLLECTOR_SRC / EL_CANDIDATE_SEL
// 逐字一致（枚举顺序相同，snapshot 索引才对齐）。test/test-gestures.js 有守卫。
//
// 页内事件都是合成事件（isTrusted:false，信任级别同 click-el）；只认受信输入的
// 站点用 `cdp Input.dispatch*` 配方兜底（配方在 SKILL.md「机制说明」的「交互原语」节）。

// 与扩展仓 page-actions.js 保持逐字一致（collector 镜像，勿手改）。
const EL_CANDIDATE_SEL =
  'input,button,select,textarea,a,[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="switch"],[data-testid]';

// 与扩展仓 EL_COLLECTOR_SRC 保持逐字一致（document 级枚举 + open shadowRoot 递归）。
const COLLECTOR_SRC =
  "function labelOf(e){return (e.getAttribute('aria-label')||e.getAttribute('placeholder')||e.getAttribute('name')) || String((e.innerText||e.textContent||'').trim()).slice(0,24);}" +
  "function __elNodes(){" +
  "var SEL=" +
  JSON.stringify(EL_CANDIDATE_SEL) +
  ";" +
  "var out=[];" +
  "function collect(root){var els=root.querySelectorAll(SEL);for(var k=0;k<els.length;k++)out.push(els[k]);" +
  "var hosts=root.querySelectorAll('*');for(var h=0;h<hosts.length;h++){var sr=null;try{sr=hosts[h].shadowRoot;}catch(_){}" +
  "if(sr)collect(sr);}}" +
  "collect(document);" +
  "return [].filter.call(out,function(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled;});" +
  "}";

// 与扩展仓 ACT_QUIET_DIALOGS_SRC 保持逐字一致（作用期间中和原生弹窗）。
const QUIET_SRC =
  "function withQuietDialogs(fn){var w=typeof window==='undefined'?null:window;if(!w||!w.alert)return fn();" +
  "var oa=w.alert,oc=w.confirm,op=w.prompt;" +
  "try{w.alert=function(){};w.confirm=function(){return true;};w.prompt=function(d){return d==null?'':d;};}catch(_){}" +
  "try{return fn();}finally{try{w.alert=oa;w.confirm=oc;w.prompt=op;}catch(_){}}}";

// el 解析 + 各手势的页内分支。el = snapshot 条目 {i,label} 或 {sel:"css"}；
// 执行前重解析（越界 / label 漂移 / sel 未命中 → 拒绝，不误点）。
// click/type 是"基础动词"，也走本构造器（与扩展 actExpr 行为逐字一致，含 __CLEAR__ 前缀
// 与 native value setter）；setfile 是 CDP DOM 域方法，不在此（留扩展基建）。
const GESTURE_BODIES = {
  click:
    "if(act==='click'){withQuietDialogs(function(){target.click();});return JSON.stringify({found:true,clicked:label,rect:[Math.round(target.getBoundingClientRect().x),Math.round(target.getBoundingClientRect().y)]});}",
  type:
    "if(act==='type'){var clear=typeof txt==='string'&&txt.indexOf('__CLEAR__')===0;if(clear){txt=String(txt).slice(9);try{target.value='';}catch(_){}}" +
    "var proto=target.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;" +
    "var d=Object.getOwnPropertyDescriptor(proto,'value');if(d&&d.set){d.set.call(target,txt);}else{target.value=txt;}" +
    "withQuietDialogs(function(){target.dispatchEvent(new Event('input',{bubbles:true}));target.dispatchEvent(new Event('change',{bubbles:true}));});" +
    "return JSON.stringify({found:true,typed:target.value});}",
  hover:
    "if(act==='hover'){withQuietDialogs(function(){['mouseover','mouseenter','mousemove'].forEach(function(t){target.dispatchEvent(new MouseEvent(t,{bubbles:t!=='mouseenter',cancelable:true,clientX:x,clientY:y}));});});" +
    "return JSON.stringify({found:true,hovered:label,x:x,y:y});}",
  dblclick:
    "if(act==='dblclick'){withQuietDialogs(function(){['mousedown','mouseup','mousedown','mouseup'].forEach(function(t){target.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));});" +
    "target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,detail:2}));" +
    "target.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,detail:2}));});" +
    "return JSON.stringify({found:true,dblclicked:label,x:x,y:y});}",
  contextmenu:
    "if(act==='contextmenu'){withQuietDialogs(function(){target.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:2,buttons:2}));});" +
    "return JSON.stringify({found:true,contextMenu:label,x:x,y:y});}",
  focus:
    "if(act==='focus'){withQuietDialogs(function(){try{target.focus();}catch(_){}});" +
    "return JSON.stringify({found:true,focused:label,active:document.activeElement===target});}",
  touch:
    "if(act==='touch'){withQuietDialogs(function(){var tp=null;if(typeof Touch!=='undefined'){try{tp=new Touch({identifier:1,target:target,clientX:x,clientY:y});}catch(_){}}" +
    "target.dispatchEvent(new TouchEvent('touchstart',{'touches':tp?[tp]:[],'changedTouches':tp?[tp]:[],'bubbles':true,'cancelable':true}));" +
    "target.dispatchEvent(new TouchEvent('touchend',{'touches':[],'changedTouches':tp?[tp]:[],'bubbles':true,'cancelable':true}));});" +
    "return JSON.stringify({found:true,tapped:label,x:x,y:y});}",
  scroll:
    "if(act==='scroll'){var scA='v',scD=null;try{var sj=JSON.parse(txt);}catch(_){sj=txt;}" +
    "if(sj&&typeof sj==='object'){if(sj.axis==='h')scA='h';if(sj.delta!=null)scD=parseInt(sj.delta,10);}" +
    "else if(sj){var dn=parseInt(sj,10);if(!isNaN(dn))scD=dn;}" +
    "withQuietDialogs(function(){if(scD==null){if(scA==='h'){target.scrollIntoView({inline:'center',block:'nearest'});}else{target.scrollIntoView({block:'center'});}}" +
    "else if(scA==='h'){if(target.scrollWidth>target.clientWidth){target.scrollLeft+=scD;}else{window.scrollBy(scD,0);}}" +
    "else{if(target.scrollHeight>target.clientHeight){target.scrollTop+=scD;}else{window.scrollBy(0,scD);}}});" +
    "return JSON.stringify({found:true,scrolled:label,axis:scA,by:scD});}",
  select:
    "if(act==='select'){withQuietDialogs(function(){try{target.value=txt;}catch(_){}try{target.dispatchEvent(new Event('change',{bubbles:true}));target.dispatchEvent(new Event('input',{bubbles:true}));}catch(_){}});" +
    "return JSON.stringify({found:true,selected:String(target.value)});}",
  media:
    "if(act==='media'){withQuietDialogs(function(){try{if(txt==='play'){target.play();}else if(txt==='pause'){target.pause();}else if(txt==='mute'){target.muted=true;}else if(txt==='unmute'){target.muted=false;}}catch(_){}});" +
    "return JSON.stringify({found:true,media:txt});}",
  drag:
    "if(act==='drag'){var to=null;try{var pj=JSON.parse(txt);if(pj&&pj.sel&&String(pj.sel)){to=document.querySelector(pj.sel);if(!to)return JSON.stringify({found:false,reason:'drag target sel not found: '+JSON.stringify(pj.sel)});}" +
    "else if(pj&&pj.i!=null&&pj.i>=0&&pj.i<nodes.length){to=nodes[pj.i];if(pj.label&&labelOf(to)!==String(pj.label))return JSON.stringify({found:false,reason:'drag target label drift, re-run snapshot'});}}catch(_){}" +
    "if(!to)return JSON.stringify({found:false,reason:'drag needs a target el (snapshot {i,label} or {sel}) in value'});" +
    "var tr=to.getBoundingClientRect(),tx=Math.round(tr.x+tr.width/2),ty=Math.round(tr.y+tr.height/2);" +
    "withQuietDialogs(function(){var dt=null;if(typeof DataTransfer!=='undefined'){try{dt=new DataTransfer();}catch(_){}}" +
    "function de(t,cx,cy){return new DragEvent(t,{bubbles:true,cancelable:true,clientX:cx,clientY:cy,dataTransfer:dt});}" +
    "target.dispatchEvent(de('dragstart',x,y));to.dispatchEvent(de('dragenter',tx,ty));to.dispatchEvent(de('dragover',tx,ty));to.dispatchEvent(de('drop',tx,ty));target.dispatchEvent(de('dragend',tx,ty));});" +
    "return JSON.stringify({found:true,draggedFrom:label,draggedTo:labelOf(to)});}",
  swipe:
    "if(act==='swipe'){var to=null;try{var pj=JSON.parse(txt);if(pj&&pj.sel&&String(pj.sel)){to=document.querySelector(pj.sel);if(!to)return JSON.stringify({found:false,reason:'swipe target sel not found: '+JSON.stringify(pj.sel)});}" +
    "else if(pj&&pj.i!=null&&pj.i>=0&&pj.i<nodes.length){to=nodes[pj.i];if(pj.label&&labelOf(to)!==String(pj.label))return JSON.stringify({found:false,reason:'swipe target label drift, re-run snapshot'});}}catch(_){}" +
    "if(!to)return JSON.stringify({found:false,reason:'swipe needs a target el (snapshot {i,label} or {sel}) in value'});" +
    "var tr=to.getBoundingClientRect(),tx=Math.round(tr.x+tr.width/2),ty=Math.round(tr.y+tr.height/2);" +
    "withQuietDialogs(function(){var mk=null;if(typeof Touch!=='undefined'){try{mk=function(cx,cy,t){return new Touch({identifier:1,target:t,clientX:cx,clientY:cy});};}catch(_){}}" +
    "function te(t2,cx,cy,t3){var ts=[];if(mk){try{var tc=mk(cx,cy,t3);ts=[tc];}catch(_){}}return new TouchEvent(t2,{touches:ts,changedTouches:ts,bubbles:true,cancelable:true});}" +
    "target.dispatchEvent(te('touchstart',x,y,target));" +
    "for(var k=1;k<=4;k++){var cx=Math.round(x+(tx-x)*k/5),cy=Math.round(y+(ty-y)*k/5);target.dispatchEvent(te('touchmove',cx,cy,target));}" +
    "to.dispatchEvent(te('touchend',tx,ty,to));});" +
    "return JSON.stringify({found:true,swipedFrom:label,swipedTo:labelOf(to)});}",
  longpress:
    "if(act==='longpress'){var hold=parseInt(txt,10)||600;return new Promise(function(res){withQuietDialogs(function(){" +
    "if(typeof PointerEvent!=='undefined'){target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,isPrimary:true}));}" +
    "target.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));});" +
    "setTimeout(function(){withQuietDialogs(function(){if(typeof PointerEvent!=='undefined'){target.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,isPrimary:true}));}" +
    "target.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0}));});" +
    "res(JSON.stringify({found:true,longPressed:label,hold:hold}));},hold);});}",
  key:
    "if(act==='key'){var ko={};try{ko=JSON.parse(txt)||{};}catch(_){}var kk=String(ko.key||''),mod=Number(ko.mod||0);" +
    "function ki(){return {key:kk,code:String(ko.code||''),bubbles:true,cancelable:true,altKey:!!(mod&1),ctrlKey:!!(mod&2),metaKey:!!(mod&4),shiftKey:!!(mod&8)};}" +
    "withQuietDialogs(function(){try{target.focus();}catch(_){}});return new Promise(function(res){" +
    "withQuietDialogs(function(){target.dispatchEvent(new KeyboardEvent('keydown',ki()));});" +
    "setTimeout(function(){withQuietDialogs(function(){target.dispatchEvent(new KeyboardEvent('keyup',ki()));});" +
    "res(JSON.stringify({found:true,pressed:kk,modifiers:mod,on:label}));},40);});}",
  "select-text":
    "if(act==='select-text'){var range=null;" +
    "if(txt){var tnodes=[];(function cw(r2){var c=r2.childNodes||[];for(var j=0;j<c.length;j++){var n=c[j];if(n.nodeType===3)tnodes.push(n);else cw(n);}})(target);" +
    "var buf='';for(var k=0;k<tnodes.length;k++)buf+=tnodes[k].nodeValue;" +
    "var at=buf.indexOf(txt);if(at<0)return JSON.stringify({found:false,reason:'text not found in element: '+JSON.stringify(txt)});" +
    "var ep=at+txt.length-1,sn=null,so=0,en=null,eo=0,acc=0;" +
    "for(k=0;k<tnodes.length;k++){var L=tnodes[k].nodeValue.length;if(sn==null&&at>=acc&&at<=acc+L-1){sn=tnodes[k];so=at-acc;}if(ep>=acc&&ep<=acc+L-1){en=tnodes[k];eo=ep-acc+1;}acc+=L;}" +
    "if(!sn||!en)return JSON.stringify({found:false,reason:'text selection failed'});" +
    "range=document.createRange();range.setStart(sn,so);range.setEnd(en,eo);}" +
    "else{range=document.createRange();range.selectNodeContents(target);}" +
    "var s2=window.getSelection?window.getSelection():null;if(!s2)return JSON.stringify({found:false,reason:'no window.getSelection()'});" +
    "withQuietDialogs(function(){s2.removeAllRanges();s2.addRange(range);});" +
    "return JSON.stringify({found:true,selected:(s2.toString?s2.toString():'').slice(0,200)});}",
};

// 返回 Promise 的手势：需 Runtime.evaluate 带 awaitPromise:true。
const ASYNC_ACTS = { longpress: true, key: true };

const GUARD_SRC =
  "var target=null,label='';" +
  "if(el!=null){" +
  "if(el.sel&&String(el.sel)){var qs=null;try{qs=document.querySelector(el.sel);}catch(_){}" +
  "if(!qs)return JSON.stringify({found:false,reason:'sel not found: '+JSON.stringify(el.sel)+' — check selector / page state, re-run'});" +
  "target=qs;label=labelOf(target);}" +
  "else{if(!(el.i>=0&&el.i<nodes.length))return JSON.stringify({found:false,reason:'index out of range: page changed, re-run snapshot'});" +
  "target=nodes[el.i];label=labelOf(target);" +
  "if(el.label&&String(el.label).length&&label!==String(el.label))" +
  " return JSON.stringify({found:false,reason:'label drift: expected '+JSON.stringify(el.label)+' actual '+JSON.stringify(label)+', re-run snapshot'});}}" +
  "if(target==null){target=document.body;label=labelOf(target);}" +
  "var r=target.getBoundingClientRect?target.getBoundingClientRect():{x:0,y:0,width:0,height:0};" +
  "var x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);";

// buildGestureExpr(act, el, value)：返回可直接喂给 Runtime.evaluate 的页内 IIFE。
//   act   —— GESTURE_BODIES 的键（hover/dblclick/contextmenu/focus/touch/scroll/
//            select/media/drag/swipe/longpress/key/select-text）
//   el    —— snapshot 条目 {i,label} | 选择器目标 {sel:"css"} | null（页面级）
//   value —— 各手势的取值（scroll: JSON {axis,delta}；key: JSON {key,code,mod}；
//            drag/swipe: 目标 el 的 JSON；select-text: 子串或 ""；其余 ""/枚举）
// 未知 act 在 CLI 侧就抛错，不产出坏表达式。
function buildGestureExpr(act, el, value) {
  if (!GESTURE_BODIES[act])
    throw new Error(
      "unknown gesture act: " +
        act +
        " (known: " +
        Object.keys(GESTURE_BODIES).join(", ") +
        ")",
    );
  const txt = value == null ? "" : String(value);
  const body =
    COLLECTOR_SRC +
    QUIET_SRC +
    "var nodes=__elNodes();" +
    GUARD_SRC +
    GESTURE_BODIES[act] +
    "return JSON.stringify({found:false,reason:'unknown gesture '+JSON.stringify(act)});";
  const args =
    JSON.stringify(el) + "," + JSON.stringify(act) + "," + JSON.stringify(txt);
  const open = ASYNC_ACTS[act]
    ? "(async function(el,act,txt){"
    : "(function(el,act,txt){";
  return open + body + "})(" + args + ")";
}

function isAsyncAct(act) {
  return !!ASYNC_ACTS[act];
}

module.exports = {
  EL_CANDIDATE_SEL,
  COLLECTOR_SRC,
  QUIET_SRC,
  GUARD_SRC,
  GESTURE_BODIES,
  ASYNC_ACTS,
  buildGestureExpr,
  isAsyncAct,
};
