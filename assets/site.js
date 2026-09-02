/* PW3 예배팀 사이트 공통 모듈 */
var PW3 = (function(){
"use strict";

var API = 'https://script.google.com/macros/s/AKfycbyR8SLsBOI3udMaj_xtVyV5O-4WU7piBXkDSE1YjjBAynhCH3E-h6KOjYeTX5ZoUVSP/exec';

/* PIN은 이 파일에 없다. 사용자가 입력한 값을 서버(Apps Script 스크립트 속성)와 대조한다.
   PIN 없이 요청하면 서버가 명단·출결·사유를 뺀 축약본만 내려준다. */
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
function safeURL(u){
  u = String(u||'').trim();
  if(!u) return '';
  if(!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return /^https?:\/\//i.test(u) ? u : '';
}
/* 오늘 이후 가장 가까운 항목, 없으면 가장 최근 지난 항목 */
function currentByDate(list){
  if(!list || !list.length) return null;
  var today = todayISO();
  var sorted = list.slice().sort(function(a,b){ return a.date < b.date ? -1 : 1; });
  for(var i=0;i<sorted.length;i++) if(sorted[i].date >= today) return sorted[i];
  return sorted[sorted.length-1];
}
function daysUntil(iso){
  var p = String(iso).split('-');
  var t = new Date(+p[0], +p[1]-1, +p[2]).setHours(0,0,0,0);
  var n = new Date().setHours(0,0,0,0);
  return Math.round((t-n)/86400000);
}

/* ---------- PIN ---------- */
function getPin(){ try{ return sessionStorage.getItem('pw3-pin') || ''; }catch(e){ return ''; } }
function setPin(p){ try{ sessionStorage.setItem('pw3-pin', p); }catch(e){} }
function clearPin(){ try{ sessionStorage.removeItem('pw3-pin'); }catch(e){} }
function hasPin(){ return getPin() !== ''; }

function apiURL(extra){
  var q = [], pin = getPin();
  if(pin) q.push('pin='+encodeURIComponent(pin));
  if(extra) q.push(extra);
  return API + (q.length ? '?'+q.join('&') : '');
}
/* 입력한 PIN을 서버에 확인시킨다. cb(ok) */
function verifyPin(p, cb){
  fetch(API+'?probe=1&pin='+encodeURIComponent(p), {cache:'no-store'})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); })
    .then(function(d){ cb(!!(d && d.pinOK)); })
    .catch(function(){ cb(false); });
}
/* 컨테이너 el 안에 PIN 입력줄을 그린다. 성공하면 onOK(), 취소하면 onCancel() */
function inlinePin(el, onOK, onCancel){
  el.innerHTML =
    '<div class="row">'+
      '<input type="password" inputmode="numeric" id="ipin" class="grow" placeholder="리더십 PIN" autocomplete="off">'+
      '<button class="primary" id="ipinGo">확인</button>'+
      '<button class="ghost" id="ipinX">취소</button>'+
    '</div>'+
    '<div id="ipinErr" style="color:var(--bad);font-size:.82rem;font-weight:700;margin-top:8px;min-height:18px"></div>';
  var inp = el.querySelector('#ipin'), go = el.querySelector('#ipinGo');
  function submit(){
    var v = inp.value;
    if(!v) return;
    go.disabled = true;
    el.querySelector('#ipinErr').textContent = '확인 중…';
    verifyPin(v, function(ok){
      go.disabled = false;
      if(ok){ setPin(v); onOK(); }
      else {
        el.querySelector('#ipinErr').textContent = 'PIN이 맞지 않습니다.';
        inp.value = ''; inp.focus();
      }
    });
  }
  go.addEventListener('click', submit);
  el.querySelector('#ipinX').addEventListener('click', function(){ if(onCancel) onCancel(); });
  inp.addEventListener('keydown', function(e){ if(e.key === 'Enter') submit(); });
  inp.focus();
}

/* ---------- 데이터 ---------- */
/* members / meetings = 출결부 소유, notice / events / resources = 사이트 소유 */
function normalize(s){
  s = s || {};
  if(!s.members)   s.members = [];
  if(!s.meetings)  s.meetings = [];
  if(!s.notice)    s.notice = {text:'', at:0};
  if(!s.events)    s.events = [];
  if(!s.resources) s.resources = [];
  if(!s.setlists)  s.setlists = [];
  return s;
}
function load(cb){
  /* Apps Script가 간헐적으로 응답을 못 주는 경우가 있어 최대 3회 재시도 */
  var tries = 0;
  (function attempt(){
    tries++;
    fetch(apiURL(), {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(s){ cb(null, normalize(s), !!(s && s.redacted)); })
      .catch(function(){
        if(tries < 3){ setTimeout(attempt, tries * 1200); }
        else { cb(new Error('load'), normalize(null), true); }
      });
  })();
}
/* 내 섹션만 바꿔서 저장. 최신본을 다시 받아 병합하므로 다른 섹션을 덮어쓰지 않는다.
   PIN이 없어 축약본이 내려온 경우에는 저장을 중단한다(명단 유실 방지). */
function saveSection(patch, cb){
  if(!hasPin()){ cb(new Error('pin')); return; }
  fetch(apiURL(), {cache:'no-store'})
    .then(function(r){ if(!r.ok) throw 0; return r.json(); })
    .then(function(remote){
      if(!remote || remote.redacted){ throw new Error('redacted'); }
      var s = normalize(remote);
      for(var k in patch){ if(patch.hasOwnProperty(k)) s[k] = patch[k]; }
      s.updatedAt = Date.now();
      return fetch(apiURL(), {method:'POST', body:JSON.stringify(s)})
        .then(function(r){ if(!r.ok) throw 0; return r.json(); })
        .then(function(res){
          if(!res || !res.ok) throw new Error(res && res.error ? res.error : 'save');
          cb(null, s);
        });
    })
    .catch(function(err){ cb(err instanceof Error ? err : new Error('save')); });
}

/* ---------- 파일 업로드 ---------- */
var MAX_UPLOAD = 20 * 1024 * 1024;   /* 20MB */

function bytesToB64(bytes){
  var bin = '', chunk = 0x8000;
  for(var i=0;i<bytes.length;i+=chunk){
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
  }
  return btoa(bin);
}
/* file: File 또는 {name, bytes:Uint8Array}. cb(err, {url, name}) */
function uploadFile(file, folder, cb){
  if(!hasPin()){ cb(new Error('pin')); return; }
  function send(name, mime, b64){
    fetch(apiURL('mode=upload'), {
      method:'POST',
      body: JSON.stringify({ name:name, mime:mime||'application/pdf', folder:folder||'기타', data:b64 })
    })
      .then(function(r){ if(!r.ok) throw 0; return r.json(); })
      .then(function(res){
        if(!res || !res.ok) throw new Error(res && res.error ? res.error : 'upload');
        cb(null, res);
      })
      .catch(function(err){ cb(err instanceof Error ? err : new Error('upload')); });
  }
  if(file.bytes){
    if(file.bytes.length > MAX_UPLOAD){ cb(new Error('size')); return; }
    send(file.name, 'application/pdf', bytesToB64(file.bytes));
    return;
  }
  if(file.size > MAX_UPLOAD){ cb(new Error('size')); return; }
  var reader = new FileReader();
  reader.onload = function(){
    var res = String(reader.result), i = res.indexOf(',');
    send(file.name, file.type, res.slice(i+1));
  };
  reader.onerror = function(){ cb(new Error('read')); };
  reader.readAsDataURL(file);
}
function uploadError(err){
  var m = err && err.message;
  if(m === 'pin')  return 'PIN이 필요합니다';
  if(m === 'size') return '파일이 20MB를 넘습니다';
  if(m === 'read') return '파일을 읽지 못했습니다';
  return '업로드 실패';
}

/* ---------- 상단 메뉴 ---------- */
var MENU = [
  {href:'index.html',      key:'home',       label:'홈'},
  {href:'setlist.html',    key:'setlist',    label:'콘티'},
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

return {
  API:API, apiURL:apiURL, esc:esc, uid:uid, todayISO:todayISO, dateLabel:dateLabel, daysUntil:daysUntil,
  navHTML:navHTML, load:load, safeURL:safeURL, currentByDate:currentByDate, saveSection:saveSection, normalize:normalize,
  getPin:getPin, setPin:setPin, clearPin:clearPin, hasPin:hasPin, verifyPin:verifyPin, inlinePin:inlinePin,
  uploadFile:uploadFile, uploadError:uploadError, bytesToB64:bytesToB64
};
})();
