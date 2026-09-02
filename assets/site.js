/* PW3 예배팀 사이트 공통 모듈 */
var PW3 = (function(){
"use strict";

var API = 'https://script.google.com/macros/s/AKfycbyR8SLsBOI3udMaj_xtVyV5O-4WU7piBXkDSE1YjjBAynhCH3E-h6KOjYeTX5ZoUVSP/exec';

/* PIN 변경 방법: 브라우저 콘솔에서 btoa('새PIN') 실행 후 아래 값만 교체.
   현재 PIN = 1100  (소스에 인코딩만 되어 있으므로 완전한 보안은 아님) */
var PIN_B64 = 'MTEwMA==';

var DAYS = ['일','월','화','수','목','금','토'];

function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
function todayISO(){
  var d = new Date(), p = function(n){ return (n<10?'0':'')+n; };
  return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate());
}
function dateLabel(iso){
  if(!iso) return '';
  var p = String(iso).split('-');
  if(p.length<3) return iso;
  var dt = new Date(+p[0], +p[1]-1, +p[2]);
  return p[0].slice(2)+'.'+p[1]+'.'+p[2]+' ('+DAYS[dt.getDay()]+')';
}
function daysUntil(iso){
  var p = String(iso).split('-');
  var t = new Date(+p[0], +p[1]-1, +p[2]).setHours(0,0,0,0);
  var n = new Date().setHours(0,0,0,0);
  return Math.round((t-n)/86400000);
}

/* ---------- 상단 메뉴 ---------- */
var MENU = [
  {href:'index.html',      key:'home',       label:'홈'},
  {href:'schedule.html',   key:'schedule',   label:'일정'},
  {href:'attendance.html', key:'attendance', label:'출결부'},
  {href:'resources.html',  key:'resources',  label:'자료실'}
];
function navHTML(active){
  var h = '<nav class="sitenav">';
  for(var i=0;i<MENU.length;i++){
    var m = MENU[i];
    h += '<a href="'+m.href+'"'+(m.key===active?' class="on"':'')+'>'+m.label+'</a>';
  }
  return h+'</nav>';
}

/* ---------- 데이터 ---------- */
/* 저장 형식은 기존과 동일한 단일 JSON.
   members / meetings = 출결부 소유, notice / events / resources = 사이트 소유 */
function normalize(s){
  s = s || {};
  if(!s.members)   s.members = [];
  if(!s.meetings)  s.meetings = [];
  if(!s.notice)    s.notice = {text:'', at:0};
  if(!s.events)    s.events = [];
  if(!s.resources) s.resources = [];
  return s;
}
function load(cb){
  /* Apps Script가 간헐적으로 응답을 못 주는 경우가 있어 최대 3회 재시도 */
  var tries = 0;
  (function attempt(){
    tries++;
    fetch(API, {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(s){ cb(null, normalize(s)); })
      .catch(function(){
        if(tries < 3){ setTimeout(attempt, tries * 1200); }
        else { cb(new Error('load'), normalize(null)); }
      });
  })();
}
/* 내 섹션만 바꿔서 저장 — 최신본을 다시 받아 병합하므로 출결 데이터를 덮어쓰지 않음 */
function saveSection(patch, cb){
  fetch(API, {cache:'no-store'})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); })
    .catch(function(){ return null; })
    .then(function(remote){
      var s = normalize(remote);
      for(var k in patch){ if(patch.hasOwnProperty(k)) s[k] = patch[k]; }
      s.updatedAt = Date.now();
      return fetch(API, {method:'POST', body:JSON.stringify(s)})
        .then(function(r){ if(!r.ok) throw 0; return r.json(); })
        .then(function(res){ if(!res || !res.ok) throw 0; cb(null, s); });
    })
    .catch(function(){ cb(new Error('save')); });
}

/* ---------- PIN ---------- */
function pinOK(){ try{ return sessionStorage.getItem('pw3-pin')==='1'; }catch(e){ return false; } }
function pinSet(){ try{ sessionStorage.setItem('pw3-pin','1'); }catch(e){} }
function pinCheck(v){
  var want; try{ want = atob(PIN_B64); }catch(e){ want = ''; }
  return String(v) === want;
}
/* 잠금 화면을 el 안에 그리고, 통과하면 onOK 실행 */
function lockGate(el, title, onOK){
  if(pinOK()){ onOK(); return; }
  el.innerHTML =
    '<div class="lock card">'+
      '<div class="ico">🔒</div>'+
      '<h2 style="margin:10px 0 0">'+esc(title)+'</h2>'+
      '<p>리더십 PIN을 입력해 주세요.</p>'+
      '<input type="password" inputmode="numeric" id="pinInput" placeholder="PIN" autocomplete="off">'+
      '<div class="err" id="pinErr"></div>'+
      '<button class="primary" id="pinGo" style="width:100%;margin-top:10px">확인</button>'+
    '</div>';
  var inp = el.querySelector('#pinInput');
  var go = function(){
    if(pinCheck(inp.value)){ pinSet(); onOK(); }
    else { el.querySelector('#pinErr').textContent = 'PIN이 맞지 않습니다.'; inp.value=''; inp.focus(); }
  };
  el.querySelector('#pinGo').addEventListener('click', go);
  inp.addEventListener('keydown', function(e){ if(e.key==='Enter') go(); });
  inp.focus();
}

return {
  API:API, esc:esc, uid:uid, todayISO:todayISO, dateLabel:dateLabel, daysUntil:daysUntil,
  navHTML:navHTML, load:load, saveSection:saveSection, normalize:normalize,
  pinOK:pinOK, pinCheck:pinCheck, pinSet:pinSet, lockGate:lockGate
};
})();
