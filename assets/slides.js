/* PW3 자막 연습 — 슬라이드 만들기 (순수 함수)
   찬양보관함의 가사 구조 { sections:[{id,type,label,text}], arrangement:[sectionId…] } 를
   주일 자막처럼 "한 장에 N줄" 슬라이드 목록으로 바꾼다. DOM·네트워크 없음. */
var PW3SLIDES = (function(){
"use strict";

/* 유튜브 링크에서 영상 id. watch?v= / youtu.be/ / shorts/ / embed/ 모두 받는다 */
function youtubeId(url){
  var u = String(url||'').trim();
  if(!u) return '';
  var m = u.match(/[?&]v=([\w-]{11})/) ||
          u.match(/youtu\.be\/([\w-]{11})/) ||
          u.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
  return m ? m[1] : '';
}

/* 가사 한 파트를 줄 단위로. 빈 줄은 버리고 앞뒤 공백을 지운다 */
function linesOf(text){
  return String(text||'').replace(/\r/g,'').split('\n')
    .map(function(l){ return l.trim(); })
    .filter(Boolean);
}
/* 빈 줄을 기준으로 묶음(연)으로 나눈다. 한 장은 묶음을 넘어가지 않는다.
   "3줄 / 빈 줄 / 4줄" 이면 두 줄씩 잘라 2-1-2-2 가 된다 */
function blocksOf(text){
  return String(text||'').replace(/\r/g,'').split(/\n\s*\n/)
    .map(function(b){ return linesOf(b); })
    .filter(function(b){ return b.length; });
}

/* 배치 순서. 비어 있으면 파트를 적은 순서 */
function sequence(lyrics){
  var secs = (lyrics && lyrics.sections) || [];
  var ids = {}; secs.forEach(function(s){ ids[s.id] = true; });
  var arr = ((lyrics && lyrics.arrangement) || []).filter(function(id){ return ids[id]; });
  return arr.length ? arr : secs.map(function(s){ return s.id; });
}

/* 슬라이드 목록.
   opts.perSlide: 한 장 줄 수 (기본 2)
   opts.title:    첫 장에 곡 제목 장을 넣을지 (기본 true)
   각 슬라이드: { kind:'title'|'lyric', label, lines[], sectionId, partIndex(파트 안 몇 번째 장), partCount } */
function build(lyrics, opts){
  opts = opts || {};
  var per = Math.max(1, Number(opts.perSlide) || 2);
  var out = [];
  if(opts.title){
    out.push({ kind:'title', label:'제목', lines:[String(opts.title)], sectionId:'', partIndex:0, partCount:1 });
  }
  var map = {};
  ((lyrics && lyrics.sections) || []).forEach(function(s){ map[s.id] = s; });
  sequence(lyrics).forEach(function(id){
    var s = map[id]; if(!s) return;
    var chunks = [];
    blocksOf(s.text).forEach(function(ls){
      for(var i=0;i<ls.length;i+=per) chunks.push(ls.slice(i, i+per));
    });
    if(!chunks.length) return;
    chunks.forEach(function(c, k){
      out.push({ kind:'lyric', label:String(s.label||s.type||''), lines:c, sectionId:s.id, partIndex:k, partCount:chunks.length });
    });
  });
  return out;
}

/* 파트 점프용: 각 파트(배치 순서상 등장)마다 첫 슬라이드 번호.
   같은 파트가 배치에 두 번 나오면(1절-후렴-1절) 두 번 다 나온다 */
function partStarts(slides){
  var out = [];
  slides.forEach(function(sl, i){
    if(sl.kind !== 'lyric') return;
    if(sl.partIndex === 0) out.push({ index:i, label:sl.label, sectionId:sl.sectionId });
  });
  return out;
}

return { youtubeId:youtubeId, linesOf:linesOf, blocksOf:blocksOf, sequence:sequence, build:build, partStarts:partStarts };
})();
if(typeof module !== 'undefined' && module.exports) module.exports = PW3SLIDES;
