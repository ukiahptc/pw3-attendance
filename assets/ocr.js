/* PW3 악보 인식 보조 — 곡 시작 페이지·제목·키 판정
   순수 함수만 둔다. DOM·네트워크를 만지지 않아 node에서도 그대로 검증할 수 있다.
   글자를 읽는 일(PDF 텍스트 레이어, Tesseract OCR)은 split.html이 하고,
   여기서는 "읽힌 줄 목록"을 받아 판단만 한다. */
var PW3OCR = (function(){
"use strict";

/* 찬양보관함(praise-archive)과 같은 키 표기 */
var KEYS = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B',
            'Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','Abm','Am','Bbm','Bm'];
var ENHARMONIC = { 'Db':'C#', 'D#':'Eb', 'Gb':'F#', 'G#':'Ab', 'A#':'Bb',
                   'Cb':'B', 'B#':'C', 'E#':'F', 'Fb':'E' };

var MATCH_MIN = 0.55;      /* 콘티 곡 제목과 이 이상 닮으면 그 곡으로 본다 */
var TALL_RATIO = 1.5;      /* 보통 줄보다 이만큼 큰 글자면 제목 줄로 본다 */
var TOP_FRAC = 0.4;        /* 페이지 위쪽 이 비율 안의 줄만 제목·키 후보 */
var TOP_LINES = 16;        /* 글자 레이어 + OCR 줄을 합치면 위쪽에 잡음 줄이 많아 넉넉히 본다 */

/* 비교용 정규화: 소문자로 바꾸고 한글·영문·숫자만 남긴다.
   OCR은 띄어쓰기를 자주 틀리고 '&', '>' 같은 잡기호를 끼워 넣는다 */
function norm(s){
  return String(s||'').toLowerCase().replace(/[^0-9a-z가-힣]+/g, '');
}
function bigrams(s){
  var o = {};
  for(var i=0;i<s.length-1;i++){ var g = s.substr(i,2); o[g] = (o[g]||0)+1; }
  return o;
}
/* 가장 긴 공통 부분 문자열 길이 */
function lcsLen(a, b){
  var best = 0, prev = [], cur, i, j;
  for(i=0;i<=b.length;i++) prev.push(0);
  for(i=1;i<=a.length;i++){
    cur = [0];
    for(j=1;j<=b.length;j++){
      var v = a.charAt(i-1) === b.charAt(j-1) ? prev[j-1] + 1 : 0;
      cur.push(v);
      if(v > best) best = v;
    }
    prev = cur;
  }
  return best;
}
/* 두 문자열의 닮은 정도 0~1 (바이그램 Dice). 한 쪽이 다른 쪽을 통째로 품으면 1.
   OCR이 제목 앞뒤에 깨진 글자를 붙인 경우("8-ABCCYao 찬양드리며 6")를 위해
   4자 이상 이어지는 공통 부분이 있으면 그 비율도 (조금 깎아서) 본다 */
function sim(a, b){
  a = norm(a); b = norm(b);
  if(!a || !b) return 0;
  if(a === b) return 1;
  var shortLen = Math.min(a.length, b.length), longLen = Math.max(a.length, b.length);
  var contains = a.indexOf(b) >= 0 || b.indexOf(a) >= 0;
  if(contains && (shortLen >= 3 || longLen <= shortLen + 3)) return 1;
  if(a.length < 2 || b.length < 2) return 0;
  var A = bigrams(a), B = bigrams(b), n = 0, na = 0, nb = 0, k;
  for(k in A){ na += A[k]; if(B[k]) n += Math.min(A[k], B[k]); }
  for(k in B) nb += B[k];
  var s = 2*n/(na+nb);
  if(shortLen >= 4){
    var l = lcsLen(a, b);
    if(l >= 4) s = Math.max(s, 0.9 * l / shortLen);
  }
  return s;
}

/* 포함 관계 없이 바이그램만으로 닮은 정도. 보관함 곡 찾기처럼 "We Praise You" ≠ "Praise" 여야 할 때 */
function dice(a, b){
  a = norm(a); b = norm(b);
  if(!a || !b) return 0;
  if(a === b) return 1;
  if(a.length < 2 || b.length < 2) return 0;
  var A = bigrams(a), B = bigrams(b), n = 0, na = 0, nb = 0, k;
  for(k in A){ na += A[k]; if(B[k]) n += Math.min(A[k], B[k]); }
  for(k in B) nb += B[k];
  return 2*n/(na+nb);
}

/* 제목으로 쓸 만한 줄인지. 실제 악보의 OCR 결과에는 코드 줄("Bb Gm7 Eb F7"),
   연주 지시("INTRO(8) Vx2 PC"), 편곡자 표기, 깨진 글자가 큰 글씨로 잔뜩 나온다 */
var NOT_TITLE = /intro|outro|interlude|verse|chorus|bridge|pre-?chorus|ending|\btag\b|arrange|words|music by|lyrics|\bkey\b|작곡|작사|편곡|싱어|코러스|인도자|간주|전주|후주|반주/i;
var CHORD_TOKEN = /^[A-G][#♯b♭]?(?:m|maj|min|sus|add|dim|aug|aug|\d|\/|\(|\)|[A-G])*$/;
function looksLikeTitle(text){
  var t = stripKey(text);
  if(NOT_TITLE.test(t)) return false;
  var chars = t.replace(/\s+/g, '');
  if(!chars) return false;
  var hangul = (chars.match(/[가-힣]/g) || []).length;
  var latin  = (chars.match(/[A-Za-z]/g) || []).length;
  if(hangul < 2 && latin < 4) return false;
  if((hangul + latin) / chars.length < 0.6) return false;
  var toks = t.split(/\s+/).filter(Boolean);
  /* 기호만인 토큰("|", "=")이 끼어 있으면 악보 기호를 잘못 읽은 줄 ("8 페-니2 PC | C = Inter") */
  if(hangul < 4 && toks.length >= 3 && toks.some(function(x){ return !/[0-9A-Za-z가-힣]/.test(x); })) return false;
  /* 한글이 조금 섞인 영문 잡음: 한글이 글자의 40%는 돼야 한글 제목으로 본다 ("Way Maker 길을 만드시는 주"는 통과) */
  if(hangul >= 2 && hangul / (hangul + latin) < 0.4) return false;
  var chords = toks.filter(function(x){ return CHORD_TOKEN.test(x); }).length;
  if(toks.length >= 2 && chords / toks.length >= 0.6) return false;
  /* "2HIHET 160t" 처럼 숫자와 영문이 한 토큰에 섞이면 깨진 글자다 */
  var mixed = toks.filter(function(x){ return /\d/.test(x) && /[A-Za-z]/.test(x) && !CHORD_TOKEN.test(x); }).length;
  if(mixed && mixed / toks.length >= 0.34) return false;
  /* 한글이 없는 줄은 영문 제목일 때만 인정: 토큰이 전부 낱말·숫자 꼴이고("ASSESS = Se." 탈락),
     3자 이상 낱말이 있으며, 대문자만인 낱말이 절반을 넘지 않아야 한다("YA Nee LF TET" 탈락) */
  if(hangul < 2){
    var WORD = /^[A-Za-z][A-Za-z'’\-]*[.,!?]?$|^\(?\d{1,3}\)?$/;
    if(!toks.every(function(x){ return WORD.test(x); })) return false;
    var words = toks.filter(function(x){ return /^[A-Za-z]/.test(x) && x.replace(/[^A-Za-z]/g,'').length >= 3; });
    if(!words.length) return false;
    var caps = words.filter(function(x){ return x === x.toUpperCase(); }).length;
    if(caps / words.length > 0.5) return false;
  }
  return true;
}

/* ---------- 키 ---------- */
function normKey(letter, acc, minor){
  var k = String(letter||'').toUpperCase();
  if(acc){
    acc = String(acc);
    k += (acc === '#' || acc === '♯') ? '#' : 'b';
  }
  if(ENHARMONIC[k]) k = ENHARMONIC[k];
  if(minor) k += 'm';
  return KEYS.indexOf(k) >= 0 ? k : '';
}
var MINOR = '(m(?![a-z])|minor|단조)';   /* 3번째 캡처 = 단조 표시 */
var KEY_PATTERNS = [
  /* Key: G / key G / 키: G / 조: Gm / Key of G */
  new RegExp('(?:^|[^a-z가-힣])(?:key|키|조)\\s*(?:of)?\\s*[:：=]?\\s*([A-G])\\s*([#♯b♭])?\\s*' + MINOR + '?(?![a-z#♯b♭])', 'i'),
  /* G Key / G키 / G조 / G major / Gm minor / G장조 */
  new RegExp('(?:^|[^a-z가-힣])([A-G])\\s*([#♯b♭])?\\s*' + MINOR + '?\\s*(key|키|조|major|장조|minor|단조)(?![a-z])', 'i')
];
/* (G) / [Eb] / (Am) — 제목 옆에 붙는 꼴. 코드와 헷갈리므로 제목 근처 줄에서만 쓴다 */
var KEY_PAREN = /[\(\[]\s*([A-G])\s*([#♯b♭])?\s*(m)?\s*[\)\]]/;

function parseKey(text){
  var t = String(text||'');
  for(var i=0;i<KEY_PATTERNS.length;i++){
    var m = t.match(KEY_PATTERNS[i]);
    if(m){
      var minor = !!m[3] || /^(?:minor|단조)$/i.test(m[4] || '');
      var k = normKey(m[1], m[2], minor);
      if(k) return k;
    }
  }
  return '';
}
/* 제목 줄들에서만 괄호 꼴을 허용 */
function parseKeyLoose(text){
  var k = parseKey(text);
  if(k) return k;
  var m = String(text||'').match(KEY_PAREN);
  return m ? normKey(m[1], m[2], !!m[3]) : '';
}
/* 제목에서 번호 머리표와 키 표기를 떼어 낸다: "1. 은혜 (G)" → "은혜", "주 품에 G key" → "주 품에" */
function stripKey(title){
  return String(title||'')
    .replace(/^\s*(?:\d{1,2}\s*[.)]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*|[-•●◦▪■□★☆*·♪♬]\s*)+/, '')
    .replace(/[\(\[]\s*[A-G]\s*[#♯b♭]?\s*m?\s*[\)\]]\s*$/i, '')
    .replace(/\s*[-·|]?\s*(?:key|키|조)\s*(?:of)?\s*[:：=]?\s*[A-G][#♯b♭]?m?\s*$/i, '')
    .replace(/\s*[-·|]?\s*[A-G][#♯b♭]?m?\s*(?:key|키|조|major|minor|장조|단조)\s*$/i, '')
    .trim();
}

/* ---------- 줄 목록 만들기 ---------- */
/* pdf.js getTextContent() 결과 → [{text, height, y}]  (y는 위에서부터, 같은 높이끼리 한 줄로 묶음) */
function linesFromPdfText(textContent, pageHeight){
  var items = [];
  (textContent && textContent.items || []).forEach(function(it){
    if(!it.str || !it.str.trim()) return;
    var tr = it.transform || [1,0,0,1,0,0];
    var h = Math.abs(tr[3]) || it.height || 0;
    items.push({ x: tr[4], y: pageHeight - tr[5], h: h, s: it.str });
  });
  items.sort(function(a,b){ return (a.y - b.y) || (a.x - b.x); });
  var lines = [], cur = null;
  items.forEach(function(it){
    if(cur && Math.abs(it.y - cur.y) <= Math.max(it.h, cur.height, 1) * 0.5){
      cur.items.push(it);
      cur.height = Math.max(cur.height, it.h);
    } else {
      cur = { y: it.y, height: it.h, items: [it] };
      lines.push(cur);
    }
  });
  return lines.map(function(l){
    l.items.sort(function(a,b){ return a.x - b.x; });
    return { text: l.items.map(function(i){ return i.s; }).join(' ').replace(/\s+/g,' ').trim(),
             height: l.height, y: l.y };
  }).filter(function(l){ return l.text; });
}
/* Tesseract.js recognize() 결과 → [{text, height, y}]
   v5는 data.lines, blocks 옵션을 켜면 data.blocks[].paragraphs[].lines[] 로 온다. 둘 다 받는다 */
function linesFromTesseract(data){
  var raw = [];
  if(data && Array.isArray(data.lines) && data.lines.length) raw = data.lines;
  else if(data && Array.isArray(data.blocks)){
    data.blocks.forEach(function(b){
      (b.paragraphs||[]).forEach(function(p){ (p.lines||[]).forEach(function(l){ raw.push(l); }); });
    });
  }
  return raw.map(function(l){
    var bb = l.bbox || {};
    return { text: String(l.text||'').replace(/\s+/g,' ').trim(),
             height: (bb.y1 - bb.y0) || 0, y: bb.y0 || 0,
             confidence: l.confidence };
  }).filter(function(l){ return l.text; });
}
/* 텍스트 레이어만으로 부족한지: 콘티 곡 제목이 하나도 안 맞거나(콘티 없으면 제목 같은 줄이 없거나)
   한글이 거의 없으면 OCR을 추가로 돌려 줄을 합친다. 실제 콘티 PDF는 키("Ckey")는 글자로 있지만
   제목은 그림이거나 깨진 글자로만 들어 있는 경우가 있었다 */
function needsOCR(lines, pageHeight, songs){
  var top = topLines(lines, pageHeight);
  if(songs && songs.length){
    var med = lines.length >= 2 ? median(lines.map(function(l){ return l.height; })) : 0;
    return bestMatch(top, songs, -1, med).score < MATCH_MIN;   /* 콘티 곡이 맞으면 그걸로 충분 */
  }
  var hangul = (lines.map(function(l){ return l.text; }).join('').match(/[가-힣]/g) || []).length;
  return hangul < 2 || !tallTitle(lines, pageHeight);
}
/* 다른 좌표계(OCR 이미지 픽셀)의 줄을 PDF 좌표로 맞춰 텍스트 레이어 줄과 합친다 */
function scaleLines(lines, factor){
  return lines.map(function(l){ return { text: l.text, height: l.height * factor, y: l.y * factor }; });
}
/* 텍스트 레이어가 쓸 만한지: 한글·영문·숫자가 전체 글자의 60% 이상이고 3자 이상 */
function textLayerUsable(lines){
  var all = lines.map(function(l){ return l.text; }).join('');
  var good = (all.match(/[가-힣A-Za-z0-9]/g) || []).length;
  return all.length >= 3 && good / all.length >= 0.6;
}

/* ---------- 페이지 판정 ---------- */
function median(arr){
  if(!arr.length) return 0;
  var a = arr.slice().sort(function(x,y){ return x-y; });
  return a[Math.floor((a.length-1)/2)];   /* 줄이 2개면 작은 쪽. 큰 쪽이면 제목 줄이 '보통'이 돼 버린다 */
}
function topLines(lines, pageHeight){
  var ls = lines.slice().sort(function(a,b){ return a.y - b.y; });
  if(pageHeight > 0) ls = ls.filter(function(l){ return l.y <= pageHeight * TOP_FRAC; });
  return ls.slice(0, TOP_LINES);
}
/* 보통 줄보다 눈에 띄게 큰 글자 줄 (제목 후보). 페이지 전체 줄 높이의 중앙값과 비교 */
function tallTitle(lines, pageHeight){
  if(lines.length < 2) return lines[0] && norm(lines[0].text).length >= 2 && looksLikeTitle(lines[0].text) ? lines[0] : null;
  var med = median(lines.map(function(l){ return l.height; }));
  var top = topLines(lines, pageHeight);
  var best = null;
  top.forEach(function(l){
    if(norm(stripKey(l.text)).length < 2) return;
    if(med > 0 && l.height < med * TALL_RATIO) return;
    if(!looksLikeTitle(l.text)) return;
    if(!best || l.height > best.height) best = l;
  });
  return best;
}
/* 콘티 곡 목록 중 이 페이지 윗부분과 가장 닮은 곡. 바로 다음 곡이면 조금 가산.
   med = 페이지 줄 높이 중앙값. 큰 글자 줄(tall)에서 맞은 건지, 첫 줄에서 맞은 건지도 돌려준다 */
function bestMatch(top, songs, curIdx, med){
  var cands = top.map(function(l, i){
    return { text: l.text, tall: med > 0 && l.height >= med * TALL_RATIO, first: i === 0 };
  });
  for(var i=0;i<top.length-1;i++){   /* 두 줄로 쪼개진 제목 */
    cands.push({ text: top[i].text + top[i+1].text, tall: cands[i].tall || cands[i+1].tall, first: i === 0 });
  }
  var best = { idx: -1, score: 0, tall: false, first: false };
  songs.forEach(function(title, idx){
    var nt = norm(title), s = 0, hit = null;
    cands.forEach(function(c){
      var cs = sim(stripKey(c.text), title);
      /* '은혜'처럼 짧은 제목은 가사 줄("은혜였소")에도 들어 있기 쉽다.
         큰 글자 줄이 아니면 글자가 똑같을 때만 인정 */
      if(nt.length <= 2 && !c.tall && norm(stripKey(c.text)) !== nt) cs = 0;
      if(cs > s){ s = cs; hit = c; }
    });
    if(idx === curIdx + 1) s = Math.min(1, s + 0.05);
    if(s > best.score) best = { idx: idx, score: s, tall: !!(hit && hit.tall), first: !!(hit && hit.first) };
  });
  return best;
}

/* pages: [{lines:[{text,height,y}], pageHeight}] · songs: 콘티 곡 제목 배열
   → [{start, title, key, score, matched, note}] */
function decide(pages, songs){
  songs = (songs||[]).map(function(t){ return String(t||'').trim(); }).filter(Boolean);
  var out = [], curIdx = -1, curTitle = '';
  pages.forEach(function(p, i){
    var lines = p.lines || [], H = p.pageHeight || 0;
    var top = topLines(lines, H);
    var topText = top.map(function(l){ return l.text; }).join('\n');
    var key = parseKey(lines.map(function(l){ return l.text; }).join('\n')) ||
              parseKeyLoose(top.slice(0, 3).map(function(l){ return l.text; }).join('\n'));
    var med = lines.length >= 2 ? median(lines.map(function(l){ return l.height; })) : 0;
    var m = songs.length ? bestMatch(top, songs, curIdx, med) : { idx:-1, score:0 };
    var tall = tallTitle(lines, H);
    var r = { start:false, title:'', key:key, score: m.score, matched:false, note:'' };
    /* 콘티 곡 제목과 맞으면 새 곡. 단, 이 페이지의 큰 제목 줄이 '지금 곡' 제목과 닮았으면
       (예: "주님 다시 오실 때까지 2") 이어지는 페이지로 보고, 아래 가사 줄의 우연한 일치는 무시한다.
       큰 글자 줄 자체는 실제 OCR에서 코드·지시문·깨진 글자가 많아 결정 근거로 쓰지 않는다 */
    var contTall = !!(tall && curTitle && sim(stripKey(tall.text), curTitle) >= 0.8);
    var newSong = m.score >= MATCH_MIN && m.idx !== curIdx && !contTall;
    /* "Key: G" 같은 명시적 키 줄이 페이지 위쪽에 있으면 그 자체로 새 곡 신호.
       제목이 짧아 OCR이 못 읽은 경우('은혜' → 'ㄷㄷ')를 이걸로 건진다 */
    var keyLine = top.some(function(l){ return !!parseKey(l.text); });
    var sameSong = m.score >= MATCH_MIN && m.idx === curIdx;

    if(newSong){
      r.start = true; r.matched = true; r.title = songs[m.idx];
      curIdx = m.idx; curTitle = r.title;
    } else if(m.score >= MATCH_MIN && m.idx === curIdx){
      r.note = '이어지는 페이지';
    } else if(tall && sim(stripKey(tall.text), curTitle) < 0.5){
      r.start = true; r.title = stripKey(tall.text);
      curIdx = -1; curTitle = r.title;
    } else if(keyLine && !sameSong && i > 0){
      r.start = true; r.title = '';
      curIdx = -1; curTitle = '';
      r.note = '키 줄로 새 곡 추정';
    } else if(!lines.length){
      r.note = '글자를 못 읽음';
    } else {
      r.note = '이어지는 페이지';
    }
    if(i === 0 && !r.start){
      r.start = true;
      r.title = r.title || (tall ? stripKey(tall.text) : (songs[0] || ''));
      if(!r.matched && songs.length && sim(r.title, songs[0]) >= MATCH_MIN){ r.matched = true; r.title = songs[0]; curIdx = 0; }
      curTitle = r.title;
    }
    r.text = topText;
    out.push(r);
  });
  /* 매칭 안 된 시작 페이지가 콘티 순서상 비어 있는 자리면 그 곡 제목을 제안 */
  if(songs.length){
    var used = {}; out.forEach(function(r){ if(r.matched) used[r.title] = true; });
    var free = songs.filter(function(t){ return !used[t]; }), k = 0;
    out.forEach(function(r){
      if(r.start && !r.matched && k < free.length){ r.suggest = free[k++]; }
    });
  }
  return out;
}

return { KEYS:KEYS, norm:norm, sim:sim, dice:dice, parseKey:parseKey, parseKeyLoose:parseKeyLoose, stripKey:stripKey,
         looksLikeTitle:looksLikeTitle, linesFromPdfText:linesFromPdfText, linesFromTesseract:linesFromTesseract,
         textLayerUsable:textLayerUsable, needsOCR:needsOCR, scaleLines:scaleLines,
         tallTitle:tallTitle, bestMatch:bestMatch, decide:decide, MATCH_MIN:MATCH_MIN };
})();
if(typeof module !== 'undefined' && module.exports) module.exports = PW3OCR;
