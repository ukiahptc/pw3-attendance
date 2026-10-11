/* PW3 → 찬양보관함(praise-archive) 연동
   보관함은 Supabase(songs·sheets 표 + sheets 버킷)를 쓰고, 읽기·쓰기가 anon key로 공개돼 있다.
   supabase-js 없이 REST만 쓴다 (PostgREST + Storage API). 악보 분리 도구가
   곡마다 잘라 낸 PDF를 "그 곡의 그 키 악보"로 넣는다.

   규칙
   - 곡은 제목으로 찾는다 (띄어쓰기·문장부호 무시, 닮은 정도 SIM_MIN 이상). 없으면 새 곡을 만든다.
   - 같은 곡에 같은 키 악보가 이미 있으면 건너뛴다 (중복 등록 방지).
   - 키를 고르지 않은 곡은 보관함에 넣지 않는다 (보관함은 악보마다 키가 필수). */
var PW3ARCHIVE = (function(){
"use strict";

/* praise-archive/docs/config.js 와 같은 값. anon key는 공개용 키다 */
var CFG = {
  url: 'https://tdbihbyrnzjodrldclmi.supabase.co',
  anonKey: 'sb_publishable_uPW98AJxgCslOhdjbZqWrQ_OYXf8LIB',
  bucket: 'sheets',
  site: 'https://ukiahptc.github.io/praise-archive/'
};
var SIM_MIN = 0.85;

function headers(extra){
  var h = { apikey: CFG.anonKey, Authorization: 'Bearer ' + CFG.anonKey };
  for(var k in extra) if(extra.hasOwnProperty(k)) h[k] = extra[k];
  return h;
}
function rid(){ return Math.random().toString(36).slice(2, 6); }

function api(path, opt){
  return fetch(CFG.url + path, opt).catch(function(){
    throw new Error('보관함 서버에 연결할 수 없습니다 (Supabase 일시정지 상태일 수 있음)');
  }).then(function(r){
    return r.text().then(function(t){
      var d = null;
      try { d = t ? JSON.parse(t) : null; } catch(e){}
      if(!r.ok){
        var msg = (d && (d.message || d.error || d.msg || d.hint)) || ('HTTP ' + r.status);
        throw new Error(String(msg).slice(0, 200));
      }
      return d;
    });
  });
}

/* 전체 곡 목록 (id, title, 키별 악보). 분리 작업 시작 때 한 번만 받는다 */
function listSongs(){
  return api('/rest/v1/songs?select=id,title,sheets(music_key,ord)', { headers: headers() })
    .then(function(rows){ return Array.isArray(rows) ? rows : []; });
}
/* 제목이 가장 닮은 곡. {song, score}
   포함 관계는 쓰지 않는다 ("We Praise You" ≠ "Praise", "은혜였소" ≠ "은혜").
   짧은 제목(3자 이하)은 정규화한 글자가 똑같을 때만 같은 곡으로 본다 */
function findSong(songs, title){
  var nt = PW3OCR.norm(title), best = { song: null, score: 0 };
  (songs || []).forEach(function(s){
    var ns = PW3OCR.norm(s.title), sc;
    if(Math.min(ns.length, nt.length) <= 3) sc = (ns === nt && nt) ? 1 : 0;
    else sc = PW3OCR.dice(s.title, title);
    if(sc > best.score) best = { song: s, score: sc };
  });
  return best.score >= SIM_MIN ? best : { song: null, score: best.score };
}
function hasKey(song, key){
  return (song.sheets || []).some(function(sh){ return sh.music_key === key; });
}
function nextOrd(song, key){
  var m = 0;
  (song.sheets || []).forEach(function(sh){ if(sh.music_key === key && sh.ord > m) m = sh.ord; });
  return m + 1;
}
function createSong(title){
  return api('/rest/v1/songs', {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify({ title: title })
  }).then(function(rows){
    var s = rows && rows[0];
    if(!s || !s.id) throw new Error('곡을 만들지 못했습니다');
    s.sheets = [];
    return s;
  });
}
function removeObject(path){
  return api('/storage/v1/object/' + CFG.bucket, {
    method: 'DELETE',
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: [path] })
  });
}
/* 파일을 버킷에 올리고 sheets 행을 넣는다. 행 넣기가 실패하면 올린 파일을 지운다.
   경로 규칙은 보관함 앱(app.js onPickFiles)과 같다: <곡id>/<키>_p<쪽>_<시각>_<난수>.pdf
   (스토리지 키는 ASCII만 허용되므로 한글 제목은 filename 컬럼에만 둔다) */
function uploadSheet(song, key, bytes, filename){
  var ord = nextOrd(song, key);
  var path = song.id + '/' + key + '_p' + ord + '_' + Date.now() + '_' + rid() + '.pdf';
  return api('/storage/v1/object/' + CFG.bucket + '/' + path, {
    method: 'POST',
    headers: headers({ 'Content-Type': 'application/pdf', 'x-upsert': 'false' }),
    body: new Blob([bytes], { type: 'application/pdf' })
  }).then(function(){
    return api('/rest/v1/sheets', {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
      body: JSON.stringify({
        song_id: song.id, music_key: key, file_path: path,
        filename: filename, mime: 'application/pdf', size: bytes.length, ord: ord
      })
    }).catch(function(err){
      return removeObject(path).catch(function(){}).then(function(){ throw err; });
    });
  }).then(function(){
    song.sheets = (song.sheets || []).concat([{ music_key: key, ord: ord }]);
    return { path: path, ord: ord };
  });
}
function songURL(id){ return CFG.site + '#/song/' + id; }

/* 분리된 한 곡을 보관함에 넣는다. songs는 listSongs() 결과를 그대로 넘긴다(새 곡이 생기면 여기에 추가됨).
   → Promise<{status:'created'|'added'|'skipped'|'nokey', song, key, url}>
     created: 새 곡 만들고 악보 추가 · added: 있던 곡에 이 키 악보 추가
     skipped: 그 곡에 같은 키 악보가 이미 있음 · nokey: 키를 안 골라 넣지 않음 */
function register(songs, title, key, bytes){
  title = String(title || '').trim();
  key = String(key || '').trim();
  if(!key) return Promise.resolve({ status: 'nokey', song: null, key: '', url: '' });
  var found = findSong(songs, title);
  var song = found.song;
  if(song && hasKey(song, key)){
    return Promise.resolve({ status: 'skipped', song: song, key: key, url: songURL(song.id) });
  }
  var p = song ? Promise.resolve(song) : createSong(title).then(function(s){ songs.push(s); return s; });
  var created = !song;
  return p.then(function(s){
    return uploadSheet(s, key, bytes, title + '.pdf').then(function(){
      return { status: created ? 'created' : 'added', song: s, key: key, url: songURL(s.id) };
    });
  });
}
function statusText(r){
  if(!r) return '';
  var k = r.key ? r.key.replace(/b/g,'♭').replace(/#/g,'♯') : '';
  if(r.status === 'created') return '보관함: 새 곡 등록 (' + k + ' 키)';
  if(r.status === 'added')   return '보관함: 기존 곡 "' + r.song.title + '"에 ' + k + ' 키 악보 추가';
  if(r.status === 'skipped') return '보관함: "' + r.song.title + '"에 ' + k + ' 키 악보가 이미 있어 건너뜀';
  if(r.status === 'nokey')   return '보관함: 키를 고르지 않아 넣지 않음';
  return '';
}

return { CFG: CFG, listSongs: listSongs, findSong: findSong, register: register, songURL: songURL,
         statusText: statusText, SIM_MIN: SIM_MIN };
})();
