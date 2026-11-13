/* Save Jensen — front-end behaviour. Content (timeline, library, letter) is already in the HTML;
   this script only adds filtering, favourites, the share card, and the server-backed support/messages. */
(function(){
"use strict";
var C = window.SJ_CONFIG || {}, $ = function(s,r){return (r||document).querySelector(s)}, $$ = function(s,r){return [].slice.call((r||document).querySelectorAll(s))};
var lang = document.documentElement.lang === "en" ? "en" : "zh";
function T(zh,en){return lang==="en"?en:zh}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}

/* ---------- local storage with in-memory fallback (favourites, draft) ---------- */
var mem = {}, storeOK = true;
var store = {
  get:function(k){try{var v=localStorage.getItem(k);return v===null?(k in mem?mem[k]:null):v}catch(e){storeOK=false;return k in mem?mem[k]:null}},
  set:function(k,v){mem[k]=v;try{localStorage.setItem(k,v)}catch(e){storeOK=false}},
  del:function(k){delete mem[k];try{localStorage.removeItem(k)}catch(e){storeOK=false}}
};

/* ---------- clipboard, download ---------- */
function copyText(text,msgEl,fbBox,fbTa){
  function ok(){msgEl.textContent=T("已复制到剪贴板","Copied to clipboard");setTimeout(function(){msgEl.textContent=""},2600)}
  function fallback(){
    var ta=document.createElement("textarea");ta.value=text;ta.setAttribute("readonly","");ta.style.cssText="position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);ta.select();var done=false;try{done=document.execCommand("copy")}catch(e){}
    document.body.removeChild(ta);
    if(done) ok(); else {fbBox.hidden=false;fbTa.value=text;fbTa.focus();fbTa.select();msgEl.textContent=T("请手动复制下方文本","Please copy the text below manually")}
  }
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(text).then(ok,fallback)}else fallback();
}
function download(name,blob){var a=document.createElement("a"),u=URL.createObjectURL(blob);a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(function(){URL.revokeObjectURL(u)},1500)}

/* ---------- navigation ---------- */
var menuBtn=$("#menuBtn"),nav=$("#nav"),hd=$("header.top");
menuBtn.addEventListener("click",function(){var o=nav.classList.toggle("open");hd.classList.toggle("open",o);menuBtn.setAttribute("aria-expanded",o)});
nav.addEventListener("click",function(e){if(e.target.tagName==="A"){nav.classList.remove("open");hd.classList.remove("open");menuBtn.setAttribute("aria-expanded","false")}});
// keep the current section when switching language
var langBtn=$("#langBtn");
langBtn.addEventListener("click",function(){if(location.hash)langBtn.href=langBtn.getAttribute("href").split("#")[0]+location.hash});

/* ---------- server API ---------- */
var ERR={
  unavailable:["暂时无法确认保存结果，请稍后重试。","Save could not be confirmed. Please retry."],
  rate_limited:["操作太频繁了，请过一会儿再试。","Too many requests. Please try again a little later."],
  bad_origin:["请求来源不被接受，请从本站页面操作。","This request was not accepted. Please use the site directly."],
  consent_required:["请先勾选同意公开展示。","Please tick the box to agree to public display."],
  invalid_nickname:["昵称需要 2–32 个字。","The nickname must be 2–32 characters."],
  reserved_nickname:["这个昵称留给站点团队使用，请换一个昵称。","That nickname is reserved for the site team. Please choose another."],
  profile_changed:["上榜信息已改变，请重新确认后提交。","Your profile changed. Review it and submit again."],
  profile_hidden:["此上榜资料已被隐藏，请联系站点团队。","This leaderboard profile is hidden. Please contact the site team."],
  invalid_content:["留言需要 1–280 个字。","The message must be 1–280 characters."],
  blocked_link:["留言里不能有链接或网址，请删掉后再提交。","Messages cannot contain links or web addresses. Please remove them and resubmit."],
  blocked_contact:["留言里不能有邮箱、电话或其他联系方式。","Messages cannot contain email addresses, phone numbers, or other contact details."],
  blocked_abuse:["自动检查发现了不合适的用词，请修改后再提交。","The automatic check found unsuitable language. Please edit and resubmit."],
  blocked_repeat:["内容重复字符太多，请改写后再提交。","Too many repeated characters. Please rewrite and resubmit."],
  already_exists:["这台设备已经有一条留言。撤回后才能再提交。","This device already has a message. Withdraw it before submitting another."],
  body_too_large:["内容太长了。","The content is too long."],
  invalid_avatar:["头像没有通过检查，请换一张图片，或不带头像提交。","The avatar did not pass the check. Try another image, or submit without one."],
  device_required:["设备凭据还没有准备好，请刷新页面后再试。这次操作没有被记录。","This device is not initialised yet. Please reload and try again; nothing was recorded."]
};
function errText(e){var k=e&&e.code&&ERR[e.code]?e.code:"unavailable";return T(ERR[k][0],ERR[k][1])}
function api(method,path,body){
  var opt={method:method,credentials:"same-origin",headers:{Accept:"application/json"}};
  if(body){opt.headers["Content-Type"]="application/json";opt.body=JSON.stringify(body)}
  return fetch((C.apiBase||"")+path,opt).then(function(r){
    var isJson=(r.headers.get("Content-Type")||"").indexOf("json")>-1;
    return (isJson?r.json():Promise.resolve(null)).then(function(j){
      if(!r.ok||!j){var e=new Error("api");e.code=j&&j.error;e.status=r.status;e.data=j;throw e}
      return j;
    });
  });
}

/* Every write waits for the one shared GET /api/state (which issues the device credential) to come back first.
   If the server still answers 428, initialise once more and retry a single time. */
var statePromise=null;
function ensureState(){if(!statePromise)statePromise=loadState();return statePromise}
function mutate(method,path,body){
  function go(){if(!S.ready){var e=new Error("unavailable");e.code="unavailable";throw e}return api(method,path,body)}
  return ensureState().then(go).catch(function(e){
    if(e&&e.status===428){statePromise=null;return ensureState().then(go)}
    throw e;
  });
}

/* ---------- repeatable energy and share clicks; optimistic tap feedback reconciled with server totals ---------- */
var S={ready:false,total:null,mine:0,epoch:0,shares:null,message:null,note:"",err:false};
function newKey(){var a=new Uint8Array(16);(window.crypto||window.msCrypto).getRandomValues(a);return [].map.call(a,function(b){return ("0"+b.toString(16)).slice(-2)}).join("")}
/* Roll toward server totals plus taps currently in flight. It never moves on its own. */
var shown={},rolling={},settle={},still=matchMedia("(prefers-reduced-motion:reduce)").matches;
function rollTo(key,sel,target){
  var els=$$(sel);
  function put(v){var t=fmt(v);els.forEach(function(e){e.textContent=t})}
  if(target===null||target===undefined){put(null);return}
  var from=shown[key];
  if(from===undefined||still||document.hidden){shown[key]=target;put(target);return}
  if(from===target&&!rolling[key]){put(target);return}
  cancelAnimationFrame(rolling[key]);clearTimeout(settle[key]);
  var t0=performance.now(),dur=Math.min(900,260+Math.abs(target-from)*12);
  // If frames are not being painted (throttled or background tab), still land on the confirmed value.
  settle[key]=setTimeout(function(){cancelAnimationFrame(rolling[key]);rolling[key]=0;shown[key]=target;put(target);els.forEach(function(e){e.classList.remove("roll")})},dur+250);
  els.forEach(function(e){e.classList.add("roll");e.classList.remove("idle")});
  (function step(now){
    var k=Math.min(1,(now-t0)/dur),v=Math.round(from+(target-from)*(1-Math.pow(1-k,3)));
    shown[key]=v;put(v);
    if(k<1)rolling[key]=requestAnimationFrame(step);
    else{clearTimeout(settle[key]);rolling[key]=0;shown[key]=target;els.forEach(function(e){e.classList.remove("roll");if(key==="cheer")e.classList.add("idle")})}
  })(t0);
}
function fmt(n){return n===null||n===undefined?"—":Number(n).toLocaleString(lang==="en"?"en-US":"zh-CN")}
/* Collects taps for 500 ms, caps each queue independently, and retries failed batches with the same key. */
var rev=0;
function batcher(path,extra,apply,maxDelta){
  var q={pending:0,flight:null,failed:null,timer:null,retry:null,tries:0,gen:0,seq:0};
  function flush(){
    q.timer=null;
    if(q.flight||q.paused||(!q.pending&&!q.failed))return;
    var b=q.failed;
    if(!b){b={delta:Math.min(q.pending,maxDelta),key:newKey(),extra:extra()};q.pending-=b.delta} // extra (e.g. epoch) is fixed when the batch is created
    q.failed=null;q.flight=b;q.seq++;rev++;renderCheer();
    var gen=q.gen,body={delta:b.delta,idempotencyKey:b.key};for(var k in b.extra)body[k]=b.extra[k];
    mutate("POST",path,body).then(function(j){
      if(gen!==q.gen)return;                                    // a reset (withdraw) happened: ignore this late reply
      q.flight=null;q.seq++;rev++;q.tries=0;S.err=false;S.note="";apply(j);
    },function(e){
      if(gen!==q.gen)return;                                    // same for late failures: do not re-queue
      q.flight=null;q.seq++;rev++;
      // Withdrawn elsewhere (another tab): void the whole old queue, pending taps included, then take the server's state.
      if(e.code==="stale_epoch"&&e.data){q.reset();apply(e.data);S.err=false;S.note=T("这台设备的应援能量已在别处撤回，之前排队的点击已作废。","This device’s support energy was withdrawn elsewhere, so the queued taps were discarded.");renderCheer();return}
      if(e.status===400){S.err=true;S.note=errText(e);return}   // not retryable
      q.failed=b;q.tries++;S.err=true;S.note=errText(e);
      if(q.tries<=3){clearTimeout(q.retry);q.retry=setTimeout(function(){if(gen===q.gen&&q.failed&&!q.flight)flush()},4000*q.tries)}
    }).then(function(){if(gen!==q.gen)return;renderCheer();if(q.pending&&!q.failed)schedule()});
  }
  function schedule(){if(!q.timer&&!q.paused)q.timer=setTimeout(flush,500)}
  q.add=function(n){if(q.paused)return;rev++;q.pending+=n||1;if(q.failed&&!q.flight)q.tries=0;schedule();renderCheer()};
  q.unsynced=function(){return q.pending+(q.flight?q.flight.delta:0)+(q.failed?q.failed.delta:0)};
  /* Void everything queued or in flight: later replies for older generations are ignored. */
  q.reset=function(){rev++;q.gen++;q.pending=0;q.failed=null;q.flight=null;q.tries=0;clearTimeout(q.timer);clearTimeout(q.retry);q.timer=q.retry=null};
  q.resume=function(){q.paused=false};
  /* nothing queued, nothing in flight, nothing failed, no timer armed */
  q.idle=function(){return !q.pending&&!q.flight&&!q.failed&&!q.timer&&!q.paused};
  q.retryNow=function(){if(q.failed&&!q.flight){q.tries=0;clearTimeout(q.retry);flush()}};
  /* taps not yet confirmed but still on their way (a failed batch is NOT included: it is not saved) */
  q.optimistic=function(){return q.pending+(q.flight?q.flight.delta:0)};
  return q;
}
var cheerQ=batcher("/api/cheer",function(){return {epoch:S.epoch}},function(j){if(j.cheers){S.total=j.cheers.total;S.mine=j.cheers.mine;S.epoch=j.cheers.epoch;scheduleLeaderboard()}},10000);
var shareQ=batcher("/api/share",function(){return {}},function(j){if(typeof j.shares==="number")S.shares=j.shares},50);
function renderCheer(){
  $$(".js-cheer").forEach(function(b){b.disabled=!S.ready||!!cheerQ.paused});
  var total=S.total===null?null:S.total+cheerQ.optimistic(), mine=S.mine+cheerQ.optimistic();
  rollTo("cheer",".js-cheer-n",total);
  rollTo("share",".js-share-n",S.shares===null?null:S.shares+shareQ.optimistic());
  var goal=C.cheerGoal||0,gb=$("#goalBar");if(gb&&goal){var pct=total===null?0:Math.min(100,total/goal*100);gb.style.width=pct+"%";$("#goalPct").textContent=total===null?"":(pct<0.1&&total>0?"<0.1":pct.toFixed(pct<10?1:0))+"%"}
  var lost=(cheerQ.failed&&!cheerQ.flight?cheerQ.failed.delta:0), rb=$("#cheerRetry");
  rb.hidden=!lost;if(lost)rb.textContent=T(lost+" 能量保存未确认，点此重试",lost+" energy: save unconfirmed · retry");
  $("#top").classList.toggle("lit",mine>0);
  $("#cheerUndo").hidden=!(S.mine>0);
  var st=$(".js-cheer-status");st.classList.toggle("err",!!S.err);
  st.textContent=S.note||(!S.ready?T("正在连接服务器…","Connecting to the server…"):mine>0?T("这台设备已贡献 "+fmt(mine)+" 应援能量。","This device has contributed "+fmt(mine)+" support energy."):T("点“应援 +10”或“超级助力 +1,000”，都可以一直点。","Tap “Cheer +10” or “Boost +1,000” as often as you like."));
}
$("#cheerRetry").addEventListener("click",function(){S.err=false;S.note="";cheerQ.retryNow()});
function replay(el,cls){el.classList.remove(cls);void el.offsetWidth;el.classList.add(cls)}
var combo=0,comboT=null;
function bumpCombo(){
  var els=$$(".js-combo");
  combo++;clearTimeout(comboT);comboT=setTimeout(function(){combo=0;els.forEach(function(e){e.classList.remove("on")})},900);
  if(combo>=3&&!still)els.forEach(function(e){e.textContent="GPU COMBO x"+combo;e.classList.add("on");replay(e,"hit")});
}
function burst(b,n){
  if(still)return;
  if(b.querySelectorAll(".plus").length<4){var p=document.createElement("span");p.className="plus"+(n===1000?" super":"");var ic=document.createElement("i");ic.className="pi "+(n===1000?"chip":"jacket");p.appendChild(ic);p.appendChild(document.createTextNode("+"+fmt(n)));p.setAttribute("aria-hidden","true");b.appendChild(p);p.addEventListener("animationend",function(){b.removeChild(p)})}
  if(n!==1000)return;
  replay(b,"pulse");
  if(b.querySelectorAll(".spark").length>12)return;
  for(var k=0;k<6;k++){(function(k){var s=document.createElement("span");s.className="spark";s.setAttribute("aria-hidden","true");
    var ang=(k*60+Math.random()*30)*Math.PI/180,dist=46+Math.random()*26;s.style.setProperty("--rot",(Math.random()*240-120)+"deg");s.style.setProperty("--dx",Math.cos(ang)*dist+"px");s.style.setProperty("--dy",Math.sin(ang)*dist+"px");
    b.appendChild(s);s.addEventListener("animationend",function(){b.removeChild(s)})})(k)}
}
$$(".js-cheer").forEach(function(b){b.addEventListener("click",function(){
  if(!S.ready||cheerQ.paused)return;var n=b.dataset.n==="1000"?1000:10;
  cheerQ.add(n);replay(b,"pop");burst(b,n);bumpCombo();
})});
$("#cheerUndo").addEventListener("click",function(){
  var b=this;b.disabled=true;
  cheerQ.reset();cheerQ.paused=true;renderCheer();            // no cheering until the withdraw has finished
  mutate("DELETE","/api/cheer").then(function(j){rev++;S.total=j.cheers.total;S.mine=j.cheers.mine;S.epoch=j.cheers.epoch;S.err=false;clearMyLeaderboardScore();S.note=T("已撤回这台设备的全部应援能量。","All support energy from this device has been withdrawn.")},
    function(e){S.err=true;S.note=errText(e)+T(" 撤回没有完成。"," The withdraw did not complete.");return loadFresh()}).then(function(){b.disabled=false;cheerQ.resume();renderCheer();loadLeaderboard()});
});
/* after a failed withdraw we do not know the server's epoch any more: read it again before allowing new batches */
function loadFresh(){return api("GET","/api/state").then(function(j){if(j.cheers){S.total=j.cheers.total;S.mine=j.cheers.mine;S.epoch=j.cheers.epoch}},function(){})}
/* Timed refresh of the site-wide numbers (polling, not a live socket). It runs only while both queues are
   completely idle, and its answer is dropped if anything was tapped, sent, confirmed, failed or reset since
   the request left: a snapshot must never be combined with taps it may already contain. */
setInterval(function(){
  if(!S.ready||document.hidden||!cheerQ.idle()||!shareQ.idle())return;
  var r0=rev;
  api("GET","/api/cheers").then(function(j){
    if(r0!==rev||!cheerQ.idle()||!shareQ.idle())return;
    S.total=j.total;S.shares=j.shares;renderCheer();
  },function(){});
},12000);

/* ---------- share: counts the press, then opens the system share sheet or copies the link ---------- */
var toastT=null;
function toast(t){var el=$("#toast");el.textContent=t;el.classList.add("on");clearTimeout(toastT);toastT=setTimeout(function(){el.classList.remove("on")},2800)}
var SHARE_URL=(C.siteUrl||"https://savejensen.ai")+(lang==="en"?"/":"/zh/");
var SHARE_TEXT=T("支持黄仁勋重返领导岗位，继续推动 AI。——Save Jensen · 支持者社区","Bring Jensen back. Keep building AI. — Save Jensen · Supporters community");
function doShare(){
  if(S.ready)shareQ.add();
  if(navigator.share){navigator.share({title:"Save Jensen",text:SHARE_TEXT,url:SHARE_URL}).catch(function(){})}
  else{
    var full=SHARE_TEXT+" "+SHARE_URL,done=function(){toast(T("链接已复制，去粘贴分享吧。","Link copied. Paste it anywhere to share."))};
    var manual=function(){$("#shareFallback").hidden=false;$("#shareTa").value=full;$("#shareFallback").scrollIntoView({block:"center"});$("#shareTa").focus();$("#shareTa").select();toast(T("请手动复制下方文本。","Please copy the text below manually."))};
    if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(full).then(done,manual);else manual();
  }
  if(!S.ready)toast(T("分享已打开，但计数服务不可用，这次点击没有被记录。","Sharing opened, but the counter is unavailable, so this click was not recorded."));
}
$$(".js-share").forEach(function(b){b.addEventListener("click",doShare)});

/* ---------- opt-in leaderboard: only server-confirmed scores ---------- */
var LB={period:"all",generation:0,loaded:false,mutating:false,profile:null,mine:null,entries:[],ranks:{},timer:null,editing:false};
function clearMyLeaderboardScore(){var id=LB.profile&&LB.profile.id;LB.generation++;LB.mine=null;LB.entries=LB.entries.filter(function(e){return e.id!==id});LB.ranks={};renderLeaderboard()}
function lbStatus(t,bad){var el=$("#lbActionState");el.textContent=t;el.classList.toggle("err",!!bad)}
function renderLeaderboard(){
  var p=LB.profile,joined=!!(p&&p.enabled&&!p.hidden),mine=LB.mine;
  $("#lbLeave").hidden=!(p&&p.enabled);$("#lbLeave").disabled=LB.mutating;
  $("#lbEdit").hidden=!joined;$("#lbEdit").disabled=LB.mutating;
  $("#lbForm").hidden=!!(p&&p.hidden)||(joined&&!LB.editing);
  $("#lbJoin").disabled=!S.ready||!LB.loaded||LB.mutating;
  $("#lbNick").disabled=LB.mutating;$("#lbConsent").disabled=LB.mutating;
  $("#lbJoin").textContent=joined?T("保存昵称","Save name"):T("加入排行榜","Claim your place");
  $("#lbProfileName").textContent=joined?p.nickname:p&&p.hidden?T("此资料未公开展示。","This profile is not public."):"";
  $("#lbMyRank").textContent=mine?"#"+fmt(mine.rank):"—";
  $("#lbMyScore").textContent=mine?fmt(mine.energy)+T(" 应援能量"," energy"):"";
  $("#lbGap").textContent=!LB.loaded?T("正在读取你的席位…","Loading your place…"):!joined?T("让每一份支持，都有你的名字。","Put your name to the support you give."):!mine?T("在这个周期贡献能量，即可入榜。","Add energy in this period to enter the board."):mine.toNext!==null?T("再加 "+fmt(mine.toNext)+" 能量，就能超越上一名。","Add "+fmt(mine.toNext)+" energy to overtake the next rank."):T("你已在榜首，继续点亮这份支持。","You’re at the top. Keep the energy going.");
  var ul=$("#lbList");ul.textContent="";
  LB.entries.forEach(function(e){
    var li=document.createElement("li"),rank=document.createElement("span"),name=document.createElement("span"),score=document.createElement("strong");
    li.dataset.id=e.id;li.dataset.top=e.rank<=3?"true":"false";rank.className="lb-number";rank.textContent=String(e.rank).padStart(2,"0");
    name.className="lb-name";name.textContent=e.nickname;score.className="lb-score";score.textContent=fmt(e.energy);
    if(joined&&e.id===p.id){li.classList.add("is-mine");var you=document.createElement("span");you.className="lb-you";you.textContent=T("你","YOU");name.appendChild(you)}
    li.appendChild(rank);li.appendChild(avatarEl({id:e.avatarId,nickname:e.nickname,avatar:!!e.avatarId}));li.appendChild(name);li.appendChild(score);ul.appendChild(li);
  });
  $("#lbEmpty").hidden=!LB.loaded||LB.entries.length>0;
}
function loadLeaderboard(celebrate){
  if(LB.mutating)return Promise.resolve();
  var generation=++LB.generation,period=LB.period;
  $("#lbRefresh").disabled=true;
  return api("GET","/api/leaderboard?period="+period).then(function(j){
    if(generation!==LB.generation||period!==LB.period)return;
    var old=LB.ranks[period];LB.profile=j.profile;LB.mine=j.mine;LB.entries=j.entries;LB.loaded=true;
    LB.ranks[period]=j.mine?j.mine.rank:null;
    if(!$("#lbNick").value){$("#lbNick").value=(j.profile&&j.profile.nickname)||(S.message&&S.message.nickname)||""}
    renderLeaderboard();$("#lbState").classList.remove("err");$("#lbState").textContent=period==="today"?j.day+T(" · UTC 今日榜"," · Today in UTC"):T("累计榜 · 服务器确认的应援能量","All time · Server-confirmed energy");
    if(celebrate&&j.mine&&old!=null&&j.mine.rank<old){toast(T("上升至第 "+j.mine.rank+" 名！","You climbed to #"+j.mine.rank+"!"));if(!still)replay($("#lbMyRank"),"lb-climb")}
  },function(){if(generation!==LB.generation)return;$("#lbState").classList.add("err");$("#lbState").textContent=T("榜单暂时读取不到，点击刷新重试。","The leaderboard is unavailable. Refresh to retry.")}).then(function(){if(generation===LB.generation)$("#lbRefresh").disabled=false});
}
function scheduleLeaderboard(){
  if(!LB.timer)LB.timer=setTimeout(function(){LB.timer=null;loadLeaderboard(true)},900);
}
$("#lbRefresh").addEventListener("click",function(){loadLeaderboard()});
$("#lbTabs").addEventListener("click",function(e){var b=e.target.closest("[data-period]");if(!b||LB.mutating||b.dataset.period===LB.period)return;LB.period=b.dataset.period;LB.entries=[];LB.mine=null;LB.loaded=false;renderLeaderboard();$$("#lbTabs [data-period]").forEach(function(x){x.setAttribute("aria-pressed",x===b)});$("#lbState").textContent=T("正在读取排行榜…","Loading the leaderboard…");loadLeaderboard()});
$("#lbEdit").addEventListener("click",function(){LB.editing=true;$("#lbConsent").checked=false;renderLeaderboard();$("#lbNick").focus()});
$("#lbForm").addEventListener("submit",function(e){
  e.preventDefault();if(LB.mutating||!LB.loaded)return;
  var name=$("#lbNick").value.trim();if(Array.from(name).length<2||Array.from(name).length>32){lbStatus(errText({code:"invalid_nickname"}),true);return}
  if(!$("#lbConsent").checked){lbStatus(errText({code:"consent_required"}),true);return}
  LB.mutating=true;LB.generation++;renderLeaderboard();lbStatus(T("正在加入…","Saving your place…"));
  mutate("PUT","/api/leaderboard/profile",{nickname:name,consentPublic:true,expectedVersion:LB.profile?LB.profile.version:0}).then(function(j){LB.profile=j.profile;LB.editing=false;$("#lbConsent").checked=false;lbStatus(T("已加入排行榜，你已保存的贡献会一并计入。","You’re on the leaderboard. Your saved energy comes with you."))},function(e){if(e.data&&e.data.profile)LB.profile=e.data.profile;lbStatus(errText(e),true)}).then(function(){LB.mutating=false;renderLeaderboard();loadLeaderboard()});
});
$("#lbLeave").addEventListener("click",function(){
  if(LB.mutating)return;LB.mutating=true;LB.generation++;renderLeaderboard();lbStatus(T("正在退出…","Leaving the leaderboard…"));
  mutate("DELETE","/api/leaderboard/profile").then(function(j){var id=LB.profile&&LB.profile.id;LB.profile=j.profile;LB.mine=null;LB.entries=LB.entries.filter(function(e){return e.id!==id});LB.editing=false;LB.ranks={};$("#lbConsent").checked=false;lbStatus(T("已退出排行榜，应援能量仍然保留。","You’ve left the leaderboard. Your support energy is kept."))},function(e){lbStatus(errText(e),true)}).then(function(){LB.mutating=false;renderLeaderboard();loadLeaderboard()});
});
setInterval(function(){if(document.hidden||!S.ready||LB.mutating)return;var r=$("#leaderboard").getBoundingClientRect();if(r.top<innerHeight&&r.bottom>0)loadLeaderboard()},12000);

/* ---------- my message + wall ---------- */
var nick=$("#nick"), story=$("#story"), consent=$("#consent"), cv=$("#card"), DR="sj_story_draft_v2", idem=null;
var STAT={pending:["尚未公开","Not published"],approved:["已发布","Published"],hidden:["未公开展示","Not shown publicly"],withdrawn:["已撤回","Withdrawn"]};
function setMsg(text,isErr){var el=$("#msgState");el.textContent=text;el.classList.toggle("err",!!isErr)}
function renderMine(){
  var m=S.message, box=$("#msgMine");
  box.hidden=!m;
  $("#msgSubmit").hidden=!!m;consent.closest("label").hidden=!!m;
  $("#msgSubmit").disabled=!S.ready||!!S.busyMsg||avatarBusy;
  $("#viewMyMessage").hidden=!m||m.status!=="approved";
  if(m){var state=STAT[m.status]||STAT.hidden;$("#mineStatus").textContent=T(state[0],state[1]);$("#mineStatus").className="b "+(m.status==="approved"?"community":"");
    $("#mineText").textContent=m.content+"\n— "+m.nickname+(m.hasAvatar?T("（含头像）"," (with avatar)"):"")}
}
function loadState(){
  return api("GET","/api/state").then(function(j){
    S.ready=true;S.message=j.message||null;S.note="";S.err=false;if(j.cheers){S.total=j.cheers.total;S.mine=j.cheers.mine;S.epoch=j.cheers.epoch}S.shares=typeof j.shares==="number"?j.shares:null;
    setMsg(S.message?T("这是这台设备提交的留言。","This is the message submitted from this device."):T("写下你的故事，发布后就能在留言墙看到。","Share your story. It appears on the wall as soon as it is published."));
  },function(e){
    S.ready=false;S.err=true;S.note=T("应援服务暂时不可用，现在无法应援，也读不到应援能量。","The service is unavailable, so adding and reading support energy are not working right now.");
    setMsg(T("留言服务暂时不可用，现在无法提交。","The message service is unavailable, so submitting is not possible right now."),true);
  }).then(function(){renderCheer();renderMine()});
}
$("#msgForm").addEventListener("submit",function(ev){
  ev.preventDefault();
  if(!S.ready||S.busyMsg||S.message||avatarBusy)return;
  var n=nick.value.replace(/\s+/g," ").trim(), c=story.value.trim(), len=function(s){return Array.from(s).length};
  if(len(n)<2||len(n)>32){setMsg(errText({code:"invalid_nickname"}),true);nick.focus();return}
  if(len(c)<1||len(c)>280){setMsg(errText({code:"invalid_content"}),true);story.focus();return}
  if(!consent.checked){setMsg(errText({code:"consent_required"}),true);consent.focus();return}
  if(!idem)idem=newKey();
  S.busyMsg=true;$("#msgSubmit").disabled=true;setMsg(T("正在提交…","Submitting…"));
  var payload={nickname:n,content:c,consentPublic:true,lang:lang,idempotencyKey:idem};if(avatarData)payload.avatar={mime:avatarData.mime,data:avatarData.data};
  mutate("POST","/api/messages",payload).then(function(j){
    S.message=j.message;idem=null;
    if(S.message&&S.message.status==="approved")setMsg(T("已发布！你的留言已加入留言墙。","Published! Your message is now on the wall."));
    else if(S.message&&S.message.status==="withdrawn"){S.message=null;setMsg(T("这条留言已撤回，未重新发布。","This message was withdrawn and has not been republished."))}
    else setMsg(T("这条留言当前未公开展示。","This message is not currently public."));
    loadWall(true);loadLeaderboard();
  },function(e){
    if(e.code==="already_exists"&&e.data&&e.data.message)S.message=e.data.message;
    setMsg(errText(e),true);
  }).then(function(){S.busyMsg=false;renderMine()});
});
$("#msgWithdraw").addEventListener("click",function(){
  var b=this,messageId=S.message&&S.message.id;b.disabled=true;setMsg(T("正在撤回…","Withdrawing…"));
  mutate("DELETE","/api/messages/mine").then(function(){wallGeneration++;$$("#wall li").forEach(function(li){if(li.dataset.messageId===messageId)li.remove()});wallIds.delete(messageId);S.message=null;consent.checked=false;setAvatar(null);setMsg(T("已撤回，留言和头像已从留言墙移除。","Withdrawn. The message and avatar have been removed from the wall."));loadWall(true);loadLeaderboard()},
    function(e){setMsg(errText(e),true)}).then(function(){b.disabled=false;renderMine()});
});
var wallNext=null,wallGeneration=0,wallBusy=false,wallIds=new Set();
/* Avatar shown on the wall: the uploaded image, otherwise the first character of the nickname. */
function avatarEl(m){
  var el=document.createElement("span");el.className="av";
  function initial(){el.textContent=Array.from(String(m.nickname||"?").trim())[0]||"?"}
  if(m.avatar){var im=new Image();im.width=im.height=40;im.alt="";im.loading="lazy";im.decoding="async";im.onerror=function(){el.textContent="";initial()};im.src=(C.apiBase||"")+"/api/avatars/"+encodeURIComponent(m.id);el.appendChild(im)}else initial();
  return el;
}
/* Optional avatar: decoded and cropped to a 96 px square JPEG here in the browser; only that small file is sent. */
var avatarData=null,avatarPick=0,avatarBusy=false;   // each selection/removal voids any decode still running
function setAvatar(d){avatarPick++;avatarBusy=false;avatarData=d;idem=null;var pv=$("#avPrev");pv.style.backgroundImage=d?"url(data:"+d.mime+";base64,"+d.data+")":"";pv.classList.toggle("has",!!d);$("#avClear").hidden=!d;if(!d)$("#avatar").value="";renderMine()}
$("#avClear").addEventListener("click",function(){setAvatar(null)});
$("#avatar").addEventListener("change",function(){
  var f=this.files&&this.files[0];if(!f)return;
  if(!/^image\/(jpeg|png|webp)$/.test(f.type)||f.size>12*1024*1024){setAvatar(null);setMsg(T("请选择 JPG、PNG 或 WebP 图片。","Please choose a JPG, PNG or WebP image."),true);return}
  avatarData=null;avatarBusy=true;idem=null;renderMine();
  var url=URL.createObjectURL(f),img=new Image(),pick=++avatarPick;
  img.onerror=function(){URL.revokeObjectURL(url);if(pick!==avatarPick)return;setAvatar(null);setMsg(T("这张图片读不出来，请换一张。","This image could not be read. Please try another."),true)};
  img.onload=function(){
    if(pick!==avatarPick){URL.revokeObjectURL(url);return}
    try{
    var c=document.createElement("canvas"),x=c.getContext("2d"),side=Math.min(img.naturalWidth,img.naturalHeight);c.width=c.height=96;
    if(!x||!side)throw new Error("avatar_canvas_unavailable");
    x.fillStyle="#fff";x.fillRect(0,0,96,96);x.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,96,96);URL.revokeObjectURL(url);
    var qs=[0.85,0.7,0.55,0.4],b64="";
    for(var k=0;k<qs.length;k++){b64=c.toDataURL("image/jpeg",qs[k]).split(",")[1]||"";if(b64.length*0.75<=22000)break}
    if(!b64||b64.length*0.75>22000){setAvatar(null);setMsg(T("头像压缩后仍然太大，请换一张。","The avatar is still too large after shrinking. Please try another."),true);return}
    setAvatar({mime:"image/jpeg",data:b64});setMsg(T("头像已就绪，会和留言一起发布。","Avatar ready. It will appear with your message."));
    }catch(e){setAvatar(null);setMsg(T("头像处理失败，请换一张图片或直接发布文字。","The avatar could not be processed. Try another image or post without one."),true)}
    finally{URL.revokeObjectURL(url)}
  };
  img.src=url;
});
function loadWall(reset){
  var ul=$("#wall"), msg=$("#wallMsg"), more=$("#wallMore");
  if(wallBusy&&!reset)return;
  var generation=++wallGeneration, cursor=reset?null:wallNext;
  wallBusy=true;more.disabled=true;
  return api("GET","/api/messages"+(cursor?"?before="+encodeURIComponent(cursor):"")).then(function(j){
    if(generation!==wallGeneration)return;
    if(reset){ul.textContent="";wallIds.clear()}
    j.messages.forEach(function(m){
      if(wallIds.has(m.id))return;wallIds.add(m.id);
      var li=document.createElement("li"),p=document.createElement("p"),who=document.createElement("div"),s=document.createElement("span");
      li.dataset.messageId=m.id;
      p.textContent=m.content;s.textContent=m.nickname;who.className="who";who.appendChild(avatarEl(m));who.appendChild(s);li.appendChild(p);li.appendChild(who);ul.appendChild(li);
    });
    wallNext=j.next;more.hidden=!j.next;msg.classList.remove("err");
    msg.textContent=ul.children.length?"":T("第一段故事，等你来写。","Be the first to share your story.");
  },function(){if(generation!==wallGeneration)return;msg.classList.add("err");msg.textContent=T("新留言暂时读取不到，请点击刷新重试。","New messages could not be loaded. Use Refresh to try again.")}).then(function(){if(generation===wallGeneration){wallBusy=false;more.disabled=false}});
}
$("#wallMore").addEventListener("click",function(){loadWall(false)});
$("#wallRefresh").addEventListener("click",function(){loadWall(true)});

/* ---------- timeline filter (rows are already in the HTML) ---------- */
$("#tlFilter").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;var k=b.dataset.k;
  $$("button",this).forEach(function(x){x.setAttribute("aria-pressed",x===b)});
  $$("#tl>li").forEach(function(li){li.hidden=k!=="all"&&li.dataset.kind!==k})});

/* ---------- library: search, category, sort, favourites over the prerendered cards ---------- */
var grid=$("#hubGrid"), cards=$$(".card",grid), FAV="sj_favs_v1", cat="all", sort="latest", favOnly=false;
var emptyEl=document.createElement("div");emptyEl.className="empty";
var EMPTY={video:["这个分类还没有经过核实的条目。视频只收录验证过的直达地址，我们宁可先空着。","Nothing verified here yet. We only list videos whose direct links we have checked, and would rather leave this empty for now."],speech:["还没有核实过出处的演讲或原话。没有可靠出处的“金句”不会出现在这里。","No talks or quotes with a verified source yet. A “quote” without a reliable source will not appear here."],fan:["还没有收录粉丝创作。欢迎到 Discord 的 #fan-art 分享；这里只会展示作者本人授权的作品。","No fan work listed yet. Share yours in #fan-art on Discord; only work authorized by its creator will be shown."]};
function loadFavs(){try{var a=JSON.parse(store.get(FAV)||"[]");return Array.isArray(a)?a:[]}catch(e){return []}}
var favs=loadFavs();
function catName(c){var b=$('#cats [data-c="'+c+'"]');return b?b.textContent:c}
function renderHub(){
  var q=$("#q").value.trim().toLowerCase();
  var vis=cards.filter(function(c){return (cat==="all"||c.dataset.type===cat)&&(!favOnly||favs.indexOf(c.dataset.id)>-1)&&(!q||c.dataset.search.indexOf(q)>-1)});
  vis.sort(function(a,b){
    if(sort==="featured"&&a.dataset.featured!==b.dataset.featured)return a.dataset.featured?-1:1;
    var ta=a.dataset.t, tb=b.dataset.t;
    if(!ta||!tb){if(ta===tb)return a.dataset.n-b.dataset.n;return ta?-1:1}
    return (tb-ta)||(a.dataset.n-b.dataset.n);
  });
  cards.forEach(function(c){c.hidden=true;c.classList.remove("first")});
  vis.forEach(function(c,i){c.hidden=false;c.classList.toggle("first",i===0);grid.appendChild(c)});
  cards.forEach(function(c){var b=$(".js-fav",c),f=favs.indexOf(c.dataset.id)>-1,t=$("h3",c).textContent;
    b.setAttribute("aria-pressed",f);b.textContent=f?T("★ 已收藏","★ Saved"):T("☆ 收藏","☆ Save");b.setAttribute("aria-label",(f?T("取消收藏","Remove from saved"):T("收藏","Save"))+": "+t)});
  $("#favCount").textContent=favs.length;
  if(!vis.length){
    var msg, hasAny=cards.some(function(c){return cat==="all"||c.dataset.type===cat});
    if(q) msg=T("没有找到与“"+esc(q)+"”匹配的内容。换个关键词，或清空搜索。","Nothing matches “"+esc(q)+"”. Try another keyword or clear the search.");
    else if(favOnly) msg=T("你还没有在"+(cat==="all"?"这里":"“"+esc(catName(cat))+"”")+"收藏内容。点条目上的 ☆ 即可收藏。","You have not saved anything "+(cat==="all"?"yet":"in “"+esc(catName(cat))+"” yet")+". Use ☆ on an item to save it.");
    else if(!hasAny) msg=EMPTY[cat]?T(EMPTY[cat][0],EMPTY[cat][1]):T("这个分类暂时没有条目。","Nothing in this category yet.");
    else msg=T("没有符合条件的内容。","Nothing matches these filters.");
    emptyEl.innerHTML='<h3 style="font-size:20px;margin-bottom:8px">'+T("暂无内容","Nothing here yet")+'</h3><p style="margin:0 auto 14px;max-width:32em;font-size:14px">'+msg+'</p>'+((q||favOnly||cat!=="all")?'<button class="btn sm" id="resetHub">'+T("清除筛选","Clear filters")+'</button>':'');
    grid.appendChild(emptyEl);
    $("#hubStatus").textContent=T("0 条结果","0 results");
  }else{
    if(emptyEl.parentNode)emptyEl.remove();
    $("#hubStatus").textContent=T("显示 "+vis.length+" / "+cards.length+" 条 · 编辑精选，手动更新","Showing "+vis.length+" of "+cards.length+" · editor-picked, updated by hand");
  }
}
$("#q").addEventListener("input",renderHub);
$("#cats").addEventListener("click",function(e){var b=e.target.closest("button");if(!b)return;cat=b.dataset.c;$$("button",this).forEach(function(x){x.setAttribute("aria-pressed",x===b)});renderHub()});
$$("[data-sort]").forEach(function(b){b.addEventListener("click",function(){sort=b.dataset.sort;$$("[data-sort]").forEach(function(x){x.setAttribute("aria-pressed",x===b)});renderHub()})});
$("#favOnly").addEventListener("click",function(){favOnly=!favOnly;this.setAttribute("aria-pressed",favOnly);renderHub()});
grid.addEventListener("click",function(e){
  if(e.target.closest("#resetHub")){$("#q").value="";cat="all";favOnly=false;$("#favOnly").setAttribute("aria-pressed","false");$$("#cats button").forEach(function(x){x.setAttribute("aria-pressed",x.dataset.c==="all")});renderHub();$("#q").focus();return}
  var b=e.target.closest(".js-fav");if(!b)return;
  var id=b.closest(".card").dataset.id,i=favs.indexOf(id);if(i>-1)favs.splice(i,1);else favs.push(id);
  store.set(FAV,JSON.stringify(favs));renderHub();b.focus();
  $("#hubStatus").textContent=(i>-1?T("已取消收藏","Removed from saved"):T("已收藏到此设备","Saved on this device"))+(storeOK?"":T("（本地存储不可用，仅本次有效）"," (local storage unavailable; this visit only)"));
});
window.addEventListener("storage",function(e){if(e.key===FAV){favs=loadFavs();renderHub()}});

$("#shareText").textContent=SHARE_TEXT+" "+SHARE_URL;

/* ---------- local draft + share card (canvas; nothing is uploaded) ---------- */
try{var d=JSON.parse(store.get(DR)||"{}");nick.value=d.nick||"";story.value=d.story||""}catch(e){}
function wrap(ctx,text,maxW){var lines=[];text.split("\n").forEach(function(par){var line="";
  var toks=par.match(/[A-Za-z0-9'’\-]+|\s+|[^\sA-Za-z0-9]/g)||[];
  function push(t){if(ctx.measureText(line+t).width<=maxW){line+=t;return}
    if(line){lines.push(line.replace(/\s+$/,""));line="";t=t.replace(/^\s+/,"");if(!t)return}
    if(ctx.measureText(t).width<=maxW){line=t;return}
    Array.from(t).forEach(function(ch){if(ctx.measureText(line+ch).width>maxW&&line){lines.push(line);line=""}line+=ch})}
  toks.forEach(push);lines.push(line)});return lines}
function fitOne(ctx,text,maxW){if(ctx.measureText(text).width<=maxW)return text;var a=Array.from(text);while(a.length&&ctx.measureText(a.join("")+"…").width>maxW)a.pop();return a.join("")+"…"}
function draw(){
  var x=cv.getContext("2d");if(!x)return false;var W=1080,H=1350,F='"Songti SC","Noto Serif SC",Georgia,serif',Sf='-apple-system,"PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif',cut=false,en=lang==="en";
  x.textAlign="left";x.fillStyle="#f7f4ec";x.fillRect(0,0,W,H);
  x.fillStyle="#131210";x.beginPath();x.arc(915,215,118,0,7);x.fill();
  x.fillStyle="#b6f22e";x.beginPath();x.moveTo(915,97);x.lineTo(985,333);x.lineTo(845,333);x.closePath();x.globalAlpha=.9;x.fill();x.globalAlpha=1;
  x.fillStyle="#131210";x.beginPath();x.moveTo(880,215);x.lineTo(915,240);x.lineTo(950,215);x.lineTo(985,238);x.lineTo(995,333);x.lineTo(835,333);x.lineTo(845,238);x.closePath();x.fill();
  x.font="500 28px "+Sf;x.fillStyle="#6b675c";x.fillText(en?"Save Jensen · Supporters community":"Save Jensen · 支持者社区",80,120);
  x.fillStyle="#131210";
  if(en){x.font="700 78px "+Sf;x.fillText("How his work",80,240);x.fillText("changed mine",80,332)}
  else{x.font="900 84px "+F;x.fillText("他的工作，",80,244);x.fillText("怎样影响了我",80,344)}
  x.fillStyle="#b6f22e";x.fillRect(80,392,96,10);x.fillStyle="#131210";
  var has=!!story.value.trim(), t=has?story.value.trim().replace(/[ \t]+/g," ").replace(/\s*\n\s*/g,"\n"):(en?"(Write your real story and it will appear here.)":"（写下你的真实故事，这里会实时预览）");
  var sizes=[50,44,38,34,30,26],boxH=580,fs,lh,ls;
  for(var k=0;k<sizes.length;k++){fs=sizes[k];lh=Math.round(fs*1.5);x.font="500 "+fs+"px "+(en?Sf:F);ls=wrap(x,t,920);if(ls.length*lh<=boxH)break}
  var maxL=Math.floor(boxH/lh);
  if(ls.length>maxL){cut=true;ls=ls.slice(0,maxL);ls[maxL-1]=fitOne(x,ls[maxL-1]+"…",920);if(ls[maxL-1].slice(-1)!=="…")ls[maxL-1]+="…"}
  x.fillStyle=has?"#131210":"#a39e90";var y=470+fs;ls.forEach(function(l){x.fillText(l,80,y);y+=lh});
  x.fillStyle="#131210";var nm="— "+(nick.value.trim().replace(/\s+/g," ")||(en?"A supporter":"一位支持者")),ns=38;
  x.font="600 "+ns+"px "+Sf;while(ns>28&&x.measureText(nm).width>920){ns-=2;x.font="600 "+ns+"px "+Sf}
  x.fillText(fitOne(x,nm,920),80,1130);
  x.fillStyle="#e2ddcf";x.fillRect(80,1180,920,2);
  x.fillStyle="#6b675c";x.font="500 26px "+Sf;x.fillText(en?"Bring Jensen back · Keep building AI":"支持重返领导岗位 · 继续推动 AI",80,1236);
  x.fillStyle="#131210";x.font="700 34px "+Sf;x.fillText((C.siteUrl||"https://savejensen.ai").replace(/^https?:\/\//,""),80,1292);
  x.font="500 24px "+Sf;x.fillStyle="#6b675c";x.textAlign="right";x.fillText(en?"A supporter’s own words":"支持者的个人表达",1000,1292);x.textAlign="left";
  return cut;
}
function cardNote(cut){$("#cnt").textContent=Array.from(story.value).length+"/280";
  $("#draftMsg").textContent=cut?T("内容超出卡片可容纳的行数，卡片末尾已用“…”截断（不影响提交的留言）。","Your text is longer than the card can hold, so the card ends with “…” (the submitted message is unaffected)."):T("卡片预览。在你的浏览器里生成，下载不会上传任何内容。","Card preview. Generated in your browser; downloading it uploads nothing.")}
function onDraft(){idem=null;store.set(DR,JSON.stringify({nick:nick.value,story:story.value}));cardNote(draw())}
nick.addEventListener("input",onDraft);story.addEventListener("input",onDraft);
$("#clearDraft").addEventListener("click",function(){nick.value="";story.value="";consent.checked=false;setAvatar(null);idem=null;store.del(DR);cardNote(draw())});
$("#dlCard").addEventListener("click",function(){
  if(!story.value.trim()){setMsg(T("请先写下内容，再下载卡片。","Write something first, then download the card."),true);story.focus();return}
  try{cv.toBlob(function(b){if(b){download("save-jensen-story.png",b);$("#draftMsg").textContent=T("卡片已下载到本机（没有上传）。","Card downloaded to this device (nothing uploaded).")}else $("#draftMsg").textContent=T("生成失败，请长按或右键预览图另存。","Could not generate the file. Long-press or right-click the preview to save it.")},"image/png")}
  catch(e){$("#draftMsg").textContent=T("此浏览器无法导出，请长按或右键预览图另存。","This browser cannot export. Long-press or right-click the preview to save it.")}
});

/* ---------- open letter (both languages are embedded as JSON; the page shows its own by default) ---------- */
var LET={};try{LET=JSON.parse($("#sj-letters").textContent)}catch(e){}
var llang=lang;
function renderLetter(){if(!LET[llang])return;var el=$("#letterText");el.textContent=LET[llang];el.lang=llang==="zh"?"zh-CN":"en";$$("[data-lang]").forEach(function(x){x.setAttribute("aria-pressed",x.dataset.lang===llang)})}
$$("[data-lang]").forEach(function(b){b.addEventListener("click",function(){llang=b.dataset.lang;renderLetter()})});
$("#copyLetter").addEventListener("click",function(){copyText(LET[llang]||$("#letterText").textContent,$("#letterMsg"),$("#letterFallback"),$("#letterTa"))});
$("#dlLetter").addEventListener("click",function(){download("save-jensen-open-letter-"+llang+"-v1.0.txt",new Blob([LET[llang]||$("#letterText").textContent],{type:"text/plain;charset=utf-8"}));$("#letterMsg").textContent=T("已下载 v1.0 全文（2026-11-13 发出的版本）","Downloaded v1.0 (the version sent on Nov 13, 2026)")});
$("#printLetter").addEventListener("click",function(){window.print()});

/* ---------- delivery status: prerendered by the build ---------- */
if(C.organizerContact)$("#orgContact").textContent=C.organizerContact;

/* ---------- next official live event: countdown from the visitor's clock ---------- */
var liveAt=C.nextLive?Date.parse(C.nextLive.at):NaN;
function renderLive(){
  var el=$("#cd"),nt=$("#cdNote");if(!el||isNaN(liveAt))return;
  var ms=liveAt-Date.now(),loc="";
  try{loc=new Date(liveAt).toLocaleString(lang==="en"?"en-US":"zh-CN",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit",timeZoneName:"short"})}catch(e){}
  if(ms>0){var s=Math.floor(ms/1000),dd=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60),x=s%60,p=function(n){return n<10?"0"+n:n};
    el.textContent=T(dd+" 天 "+p(h)+":"+p(m)+":"+p(x),dd+"d "+p(h)+":"+p(m)+":"+p(x));
    nt.textContent=(loc?T("你的时间 ","Your time: ")+loc+T("。","。").replace("。",lang==="en"?". ":"。"):"")+T("日程以官方为准；本站不转播。","Check official sources for changes; this site does not carry the stream.")}
  else if(ms>-3*3600e3){el.textContent=T("预定时间已到","Scheduled time reached");nt.textContent=T("请到官方页面确认是否正在进行。本站不转播，也无法确认直播状态。","Check the official page to see whether it is under way. This site does not carry the stream and cannot confirm its status.")}
  else{el.textContent=T("预定时间已过","Scheduled time has passed");nt.textContent=T("这是 11 月 17 日的日程，本页尚未更新下一场。","This was the Nov 17 schedule; this page has not been updated with the next one.")}
}
setInterval(renderLive,1000);

/* ---------- sticky boost dock ---------- */
(function(){
  var dock=$("#dock"),seen={};
  if(!("IntersectionObserver" in window))return;
  function update(){var hide=false;for(var k in seen)if(seen[k])hide=true;dock.classList.toggle("on",!hide&&!nav.classList.contains("open"))}
  var io=new IntersectionObserver(function(es){es.forEach(function(e){seen[e.target.dataset.dockKey]=e.isIntersecting});update()},{threshold:0.05});
  [$(".hero .cta"),$(".boost")].forEach(function(el,i){if(el){el.dataset.dockKey="k"+i;seen["k"+i]=true;io.observe(el)}});
  menuBtn.addEventListener("click",update);nav.addEventListener("click",update);
})();

/* ---------- NVDA market card ----------
   TradingView's Symbol Overview widget (delayed quotes). It is display only: no code on this page reads from it,
   writes to it or reloads it, and cheering never touches it. A blocked or failed script leaves the link in place. */
(function(){
  var box=document.getElementById("nvdaChart"),st=document.getElementById("nvdaState");
  if(!box||!st)return;
  var started=false;
  function fail(){if(box.querySelector("iframe"))return;st.textContent=T("行情图未能加载（可能被浏览器或网络拦截）。请用下方链接查看。","The chart could not load (it may be blocked by the browser or network). Please use the link below.")}
  function ready(){
    var f=box.querySelector("iframe");if(!f)return false;
    f.setAttribute("title",T("NVDA 股价走势图（TradingView 提供，延迟行情）","NVDA share price chart (by TradingView, delayed quotes)"));
    box.classList.add("on");return true;
  }
  function start(){
    if(started)return;started=true;
    try{
      var w=document.createElement("div");w.className="tradingview-widget-container__widget";
      var s=document.createElement("script");s.type="text/javascript";s.async=true;
      s.src="https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js";
      s.text=JSON.stringify({symbols:[["NVIDIA","NASDAQ:NVDA|1D"]],chartOnly:false,width:"100%",height:"100%",autosize:true,
        locale:T("zh_CN","en"),colorTheme:"dark",isTransparent:false,showVolume:false,showMA:false,
        hideDateRanges:false,hideMarketStatus:false,hideSymbolLogo:false,scalePosition:"right",scaleMode:"Normal",
        fontSize:"10",noTimeScale:false,valuesTracking:"1",changeMode:"price-and-percent",chartType:"area",
        dateRanges:["1d|1","1m|30","3m|60","12m|1D","60m|1W","all|1M"]});
      s.onerror=fail;
      if("MutationObserver" in window){var mo=new MutationObserver(function(){if(ready())mo.disconnect()});mo.observe(box,{childList:true,subtree:true})}
      box.appendChild(w);box.appendChild(s);
      setTimeout(function(){if(!ready())fail()},12000);
    }catch(e){fail()}
  }
  if(document.readyState==="complete")setTimeout(start,600);
  else window.addEventListener("load",function(){setTimeout(start,600)});
})();

/* ---------- init ---------- */
renderLive();renderHub();renderLetter();cardNote(draw());renderCheer();renderMine();
ensureState().then(function(){loadLeaderboard()});loadWall(true);
function onS(){hd.classList.toggle("scrolled",window.scrollY>8)}window.addEventListener("scroll",onS,{passive:true});onS();
if("IntersectionObserver" in window&&!matchMedia("(prefers-reduced-motion:reduce)").matches){
  var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add("in");io.unobserve(e.target)}})},{rootMargin:"0px 0px -8% 0px"});
  $$(".rev").forEach(function(e){io.observe(e)});
}else $$(".rev").forEach(function(e){e.classList.add("in")});
})();
