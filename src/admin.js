/* Admin review page. The token lives only in this closure. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var token = "", status = "approved";
  var NAMES = { pending: "待审核", approved: "已发布", hidden: "已隐藏", withdrawn: "已撤回" };
  var ERR = { unauthorized: "令牌不正确。", admin_disabled: "服务器没有配置 ADMIN_TOKEN，管理功能未启用。", rate_limited: "请求太频繁，请稍后再试。", not_allowed: "这条留言当前状态不允许此操作（例如已被留言者撤回）。", conflict_active: "该设备已有另一条待审核或已通过的留言，不能同时通过两条。", not_found: "找不到这条留言。", bad_origin: "请求来源不被接受。" };

  function say(t, bad) { var m = $("#msg"); m.textContent = t || ""; m.classList.toggle("err", !!bad); }
  function call(method, path) {
    return fetch(path, { method: method, credentials: "same-origin", cache: "no-store", headers: { Authorization: "Bearer " + token, Accept: "application/json" } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error(j.error || "http_" + r.status); e.code = j.error; throw e; } return j; }); });
  }
  function fail(e) { say(ERR[e.code] || "请求失败，未做任何更改。", true); if (e.code === "unauthorized") lock(); }
  function lock() { token = ""; $("#panel").hidden = true; $("#auth").hidden = false; $("#list").textContent = ""; $("#profiles").textContent=""; }

  function load() {
    say("正在读取…");
    return call("GET", "/api/admin/messages?status=" + status + "&limit=100").then(function (j) {
      $("#auth").hidden = true; $("#panel").hidden = false;
      var c = j.counts || {};
      $("#stats").textContent = "支持记录 " + j.supportCount + " 条 · 待审核 " + (c.pending || 0) + " · 已发布 " + (c.approved || 0) + " · 已隐藏 " + (c.hidden || 0) + " · 已撤回 " + (c.withdrawn || 0);
      var ul = $("#list"); ul.textContent = "";
      j.messages.forEach(function (m) {
        var li = document.createElement("li"), meta = document.createElement("div"), p = document.createElement("p"), who = document.createElement("strong"), acts = document.createElement("div");
        meta.className = "note"; meta.textContent = NAMES[m.status] + " · " + m.lang + " · " + new Date(m.createdAt).toLocaleString("zh-CN");
        who.textContent = m.nickname; p.textContent = m.content; acts.className = "srow";
        if (m.hasAvatar) {
          // The avatar is fetched with the token (no cookie, no URL secret) and shown from memory.
          var im = document.createElement("img"); im.width = im.height = 96; im.alt = "留言头像"; im.className = "avadm";
          fetch("/api/admin/messages/" + m.id + "/avatar", { headers: { Authorization: "Bearer " + token }, cache: "no-store" })
            .then(function (r) { if (!r.ok) throw new Error("avatar"); return r.blob(); })
            .then(function (b) { im.src = URL.createObjectURL(b); }, function () { im.alt = "头像读取失败"; });
          li.appendChild(im);
        }
        [["approve", "通过", m.status === "pending" || m.status === "hidden"], ["hide", "隐藏", m.status === "pending" || m.status === "approved"]].forEach(function (a) {
          if (!a[2]) return;
          var b = document.createElement("button"); b.className = "btn sm" + (a[0] === "approve" ? " pri" : ""); b.type = "button"; b.textContent = a[1];
          b.addEventListener("click", function () { b.disabled = true; call("POST", "/api/admin/messages/" + m.id + "/" + a[0]).then(function () { return load(); }).then(function () { say("已" + a[1] + "。"); }, function (e) { b.disabled = false; fail(e); }); });
          acts.appendChild(b);
        });
        li.appendChild(meta); li.appendChild(who); li.appendChild(p); li.appendChild(acts); ul.appendChild(li);
      });
      say(j.messages.length ? "" : "这个状态下没有留言。");
    }, fail);
  }

  function loadProfiles(){
    return call("GET","/api/admin/leaderboard?q="+encodeURIComponent($("#profileQuery").value.trim())).then(function(j){var ul=$("#profiles");ul.textContent="";j.profiles.forEach(function(p){var li=document.createElement("li"),name=document.createElement("strong"),b=document.createElement("button");name.textContent=p.nickname+(p.hidden?" · 已隐藏":p.enabled?" · 已公开":" · 已退出");b.className="btn sm";b.type="button";b.textContent=p.hidden?"恢复上榜":"隐藏资料";b.addEventListener("click",function(){b.disabled=true;call("POST","/api/admin/leaderboard/"+p.id+"/"+(p.hidden?"restore":"hide")).then(loadProfiles,function(e){b.disabled=false;fail(e)})});li.appendChild(name);li.appendChild(b);ul.appendChild(li)});if(!j.profiles.length)say("暂无主动上榜资料。")},fail);
  }
  $("#loadProfiles").addEventListener("click",loadProfiles);
  $("#auth").addEventListener("submit", function (ev) { ev.preventDefault(); token = $("#tok").value.trim(); $("#tok").value = ""; if (token) load(); });
  $("#tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-s]"); if (!b) return; status = b.dataset.s;
    [].forEach.call(document.querySelectorAll("[data-s]"), function (x) { x.setAttribute("aria-pressed", x === b); }); load();
  });
  $("#reload").addEventListener("click", load);
  $("#lock").addEventListener("click", function () { lock(); say("已退出。"); });
})();
