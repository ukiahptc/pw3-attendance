var SHEET_NAME = 'DATA';
var BACKUP_SHEET = 'BACKUP';
var CHUNK = 40000;
var ROOT_FOLDER_NAME = 'PW3 예배팀 자료';

/* 덮어쓰기 직전 상태를 이 간격으로 한 세대만 남긴다.
   자동저장이 잦아서(출결부는 1.5초 디바운스) 매번 백업하면 쓰기 할당량을 먹는다. */
var BACKUP_INTERVAL_MS = 10 * 60 * 1000;

/* 업로드 제한. site.js에도 같은 검사가 있지만 그건 화면 편의일 뿐이고,
   API를 직접 부르면 그대로 통과한다. 실제 제한은 이 파일에서 건다. */
var UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
var UPLOAD_FOLDERS = { '콘티 악보': 1, '큐시트': 1, '곡별 악보': 1, '기타': 1 };

/* 파일 내려주기(mode=file)에서 base64를 한 번에 보내는 글자 수.
   응답이 너무 크면 Apps Script가 잘라 버리거나 실패하므로 조각으로 나눠 보낸다.
   2,000,000자 ≈ 1.5MB. 4의 배수여야 조각 하나만으로도 디코딩이 된다. */
var FILE_PART_CHARS = 2000000;

/* PIN 실패 시 지연. 자세한 배경은 pinOK_ 주석 참고. */
var FAIL_WINDOW_SEC = 600;
var FAIL_DELAY_MS = 1000;
var FAIL_DELAY_MAX_MS = 5000;

/* PIN은 코드에 쓰지 않는다. 프로젝트 설정 > 스크립트 속성에 PIN 이름으로 저장.
   속성이 비어 있으면 기존처럼 전부 공개된다(사이트가 죽지 않도록 한 안전장치). */
function getPin_() {
  return String(PropertiesService.getScriptProperties().getProperty('PIN') || '');
}
/* PIN 대입 속도를 늦춘다.
   Apps Script 웹앱은 호출자의 IP를 알 수 없어 기기별 차단을 만들 수 없다.
   전역 잠금(N회 실패 시 차단)도 쓰지 않는다 — 아무나 일부러 실패시켜
   팀 전체를 못 쓰게 만들 수 있기 때문이다. 대신 실패할 때마다 응답을 지연시켜
   시도 속도 자체를 떨어뜨린다.

   ※ 이것만으로는 충분하지 않다. 결정적인 방어는 PIN 길이다.
      4자리 숫자는 경우의 수가 1만뿐이라 이 지연을 걸어도 오래 버티지 못한다.
      스크립트 속성의 PIN을 영문+숫자 8자리 이상으로 바꿔 두는 것이 본 방어다. */
function pinOK_(e) {
  var want = getPin_();
  if (!want) return true;
  var got = String((e && e.parameter && e.parameter.pin) || '');
  if (got === want) return true;

  /* PIN을 아예 안 보낸 요청은 '공개 화면 보기'다. 실패로 세지 않는다.
     세면 로그인하지 않은 일반 방문자 때문에 지연이 계속 올라간다. */
  if (got === '') return false;

  var cache = CacheService.getScriptCache();
  var n = Number(cache.get('pinfail') || 0) + 1;
  cache.put('pinfail', String(n), FAIL_WINDOW_SEC);
  console.warn('PIN 실패 ' + n + '회 (최근 ' + (FAIL_WINDOW_SEC / 60) + '분)');
  Utilities.sleep(Math.min(FAIL_DELAY_MAX_MS, FAIL_DELAY_MS * n));
  return false;
}

function readAll_() {
  var sh = getSheet_();
  var last = sh.getLastRow();
  var json = '';
  if (last > 0) {
    var vals = sh.getRange(1, 1, last, 1).getValues();
    for (var i = 0; i < vals.length; i++) json += vals[i][0];
  }
  return json || '{}';
}

/* 공개용 데이터.
   공개: 모임 날짜, 공지, 행사, 콘티 전체(곡·유튜브·악보·큐시트 링크), 섬김표, 자료실 전체
   비공개: 명단(members), 출결 기록·사유(meetings[].records)

   ※ 섬김표(serves)의 슬롯에는 팀원 실명이 들어간다. 이걸 PIN 없이 내려보내는 것은
      홈 화면의 '금주 섬김'을 비로그인 팀원도 보게 하려는 의도적 결정이다.
      따라서 이 응답은 개인정보가 전혀 없는 데이터가 아니다. members를 감췄다고 해서
      이름까지 비공개가 되는 것은 아니라는 점을 전제하고 다룰 것.
      이름을 가려야 한다면 serves도 PIN 뒤로 옮기거나 공개용으로만 이니셜 처리해야 한다. */
function publicView_(json) {
  var s;
  try { s = JSON.parse(json); } catch (err) {
    return { redacted: true, meetings: [], events: [], resources: [], setlists: [], serves: [] };
  }
  var meetings = [];
  var ms = s.meetings || [];
  for (var i = 0; i < ms.length; i++) meetings.push({ id: ms[i].id, date: ms[i].date });

  return {
    redacted: true,
    meetings: meetings,
    setlists: s.setlists || [],
    serves: s.serves || [],
    notice: s.notice || { text: '', at: 0 },
    events: s.events || [],
    resources: s.resources || [],
    updatedAt: s.updatedAt || 0
  };
}

function doGet(e) {
  if (e && e.parameter && e.parameter.probe) {
    return out_({ ok: true, pinOK: pinOK_(e), configured: getPin_() !== '' });
  }
  if (e && e.parameter && e.parameter.mode === 'file') {
    if (!pinOK_(e)) return out_({ ok: false, error: 'pin' });
    return fetchFile_(e);
  }
  var json = readAll_();
  if (pinOK_(e)) {
    return ContentService.createTextOutput(json)
      .setMimeType(ContentService.MimeType.JSON);
  }
  return out_(publicView_(json));
}

function doPost(e) {
  if (!pinOK_(e)) return out_({ ok: false, error: 'pin' });
  var mode = e && e.parameter && e.parameter.mode;
  if (mode === 'upload') return upload_(e);
  return saveState_(e);
}

/* ---------- 상태 저장 ---------- */
function saveState_(e) {
  var body = e && e.postData && e.postData.contents;
  if (!body) return out_({ ok: false, error: 'empty' });
  var parsed;
  try { parsed = JSON.parse(body); } catch (err) { return out_({ ok: false, error: 'invalid json' }); }
  if (parsed && parsed.redacted) return out_({ ok: false, error: 'redacted' });
  /* 업로드 요청이 상태 저장으로 잘못 흘러들어 DB를 덮어쓰는 사고 방지 */
  if (parsed && parsed.data && parsed.name && !parsed.members && !parsed.meetings) {
    return out_({ ok: false, error: 'upload payload' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = getSheet_();
    snapshotIfDue_(sh);

    var prevLast = sh.getLastRow();
    var rows = [];
    for (var i = 0; i < body.length; i += CHUNK) rows.push([body.substring(i, i + CHUNK)]);

    /* 새 값을 먼저 쓰고, 남는 옛 행만 지운다.
       먼저 clearContents를 하면 그 다음 쓰기가 실패했을 때(실행 시간 초과, 할당량)
       시트가 빈 채로 남아 DB 전체가 사라진다. 이 순서면 그 구간이 없다. */
    sh.getRange(1, 1, rows.length, 1).setValues(rows);
    if (prevLast > rows.length) {
      sh.getRange(rows.length + 1, 1, prevLast - rows.length, 1).clearContent();
    }
  } finally {
    lock.releaseLock();
  }
  return out_({ ok: true });
}

/* 덮어쓰기 직전 상태를 BACKUP 시트에 한 세대 남긴다.
   이 스프레드시트가 유일한 저장소라, 잘못된 상태를 저장했을 때
   되돌릴 방법이 이것뿐이다. 실패해도 저장 자체는 막지 않는다. */
function snapshotIfDue_(sh) {
  try {
    var props = PropertiesService.getScriptProperties();
    if (Date.now() - Number(props.getProperty('BACKUP_AT') || 0) < BACKUP_INTERVAL_MS) return;

    var last = sh.getLastRow();
    if (!last) return;
    var vals = sh.getRange(1, 1, last, 1).getValues();
    var prev = '';
    for (var i = 0; i < vals.length; i++) prev += vals[i][0];
    if (!prev || prev === '{}') return;

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var bk = ss.getSheetByName(BACKUP_SHEET) || ss.insertSheet(BACKUP_SHEET);
    bk.clearContents();
    var rows = [['PW3 백업 · ' + new Date().toISOString() + ' · 되돌리려면 restoreFromBackup 실행']];
    for (var j = 0; j < prev.length; j += CHUNK) rows.push([prev.substring(j, j + CHUNK)]);
    bk.getRange(1, 1, rows.length, 1).setValues(rows);
    props.setProperty('BACKUP_AT', String(Date.now()));
  } catch (err) {
    console.warn('백업 실패(저장은 계속 진행): ' + err);
  }
}

/* ===== 수동 복구 =====
   편집기 상단 함수 목록에서 restoreFromBackup 을 고르고 [실행].
   BACKUP 시트의 내용을 DATA로 되돌린다.
   ※ 되돌리기 전의 DATA는 사라진다. 실행 전에 DATA 시트를 복사해 두는 편이 안전하다. */
function restoreFromBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var bk = ss.getSheetByName(BACKUP_SHEET);
  if (!bk) throw new Error('BACKUP 시트가 없습니다. 아직 백업이 만들어지지 않았습니다.');
  var last = bk.getLastRow();
  if (last < 2) throw new Error('BACKUP 시트가 비어 있습니다.');

  var label = String(bk.getRange(1, 1).getValue());
  var vals = bk.getRange(2, 1, last - 1, 1).getValues();
  var json = '';
  for (var i = 0; i < vals.length; i++) json += vals[i][0];

  /* 깨진 백업으로 멀쩡한 데이터를 덮어쓰지 않도록 먼저 검증한다 */
  var parsed = JSON.parse(json);
  if (!parsed || !parsed.members) throw new Error('백업에 members가 없습니다. 복구를 중단합니다.');

  var sh = getSheet_();
  var prevLast = sh.getLastRow();
  var rows = [];
  for (var j = 0; j < json.length; j += CHUNK) rows.push([json.substring(j, j + CHUNK)]);
  sh.getRange(1, 1, rows.length, 1).setValues(rows);
  if (prevLast > rows.length) {
    sh.getRange(rows.length + 1, 1, prevLast - rows.length, 1).clearContent();
  }

  Logger.log('복구 완료 — ' + label);
  return label;
}

/* ---------- 파일 업로드 ---------- */
/* 본문 형식: {"name":"...","mime":"application/pdf","folder":"콘티 악보","data":"<base64>"} */
function upload_(e) {
  var body = e && e.postData && e.postData.contents;
  if (!body) return out_({ ok: false, error: 'empty' });
  var req;
  try { req = JSON.parse(body); } catch (err) { return out_({ ok: false, error: 'invalid json' }); }
  if (!req.data || !req.name) return out_({ ok: false, error: 'no file' });

  /* 형식·폴더·크기 검사. PIN을 아는 사람만 여기까지 오지만, PIN은 팀 전체가
     공유하는 값이라 이것까지 통과하면 소유자 계정의 드라이브가 임의 파일
     공개 호스팅으로 쓰일 수 있다(업로드 파일은 아래에서 링크 공개로 바뀐다). */
  var mime = String(req.mime || 'application/pdf');
  if (mime !== 'application/pdf' && mime.indexOf('image/') !== 0) {
    return out_({ ok: false, error: '허용하지 않는 형식입니다 (' + mime.slice(0, 60) + ')' });
  }
  var folderName = String(req.folder || '기타');
  if (!UPLOAD_FOLDERS[folderName]) {
    return out_({ ok: false, error: '허용하지 않는 폴더입니다 (' + folderName.slice(0, 40) + ')' });
  }
  var safeName = String(req.name).replace(/[\r\n\t]/g, ' ').slice(0, 120);

  try {
    var bytes = Utilities.base64Decode(req.data);
    if (bytes.length > UPLOAD_MAX_BYTES) {
      return out_({ ok: false, error: '파일이 ' + Math.round(UPLOAD_MAX_BYTES / 1048576) + 'MB를 넘습니다' });
    }
    var blob = Utilities.newBlob(bytes, mime, safeName);
    var folder = subFolder_(folderName);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return out_({
      ok: true,
      id: file.getId(),
      name: file.getName(),
      url: 'https://drive.google.com/file/d/' + file.getId() + '/view'
    });
  } catch (err) {
    return out_({ ok: false, error: String(err) });
  }
}

/* ---------- 올린 파일 내려주기 ---------- */
/* 악보 분리 도구가 콘티에 등록된 악보 PDF를 다시 받아올 때 쓴다.
   브라우저에서 드라이브 링크를 직접 fetch하면 CORS로 막히므로 여기서 중계한다.
     ?mode=file&id=<드라이브 파일 id>&part=<n>
   응답: {ok, name, mime, size, parts, part, data(base64 조각)}
   part를 0부터 parts-1까지 차례로 받아 이어 붙이면 원본이 된다.

   보안: PIN을 아는 사람이 소유자 드라이브의 아무 파일이나 id로 꺼내 가지 못하도록
   이 사이트가 만든 폴더(루트와 그 바로 아래 하위 폴더) 안의 PDF만 허용한다. */
function fetchFile_(e) {
  var id = String(e.parameter.id || '');
  var part = Number(e.parameter.part || 0);
  if (!/^[\w-]{10,}$/.test(id)) return out_({ ok: false, error: 'bad id' });

  var file;
  try { file = DriveApp.getFileById(id); }
  catch (err) { return out_({ ok: false, error: 'not found' }); }
  if (!inOurFolder_(file)) return out_({ ok: false, error: 'not ours' });
  if (file.getMimeType() !== 'application/pdf') return out_({ ok: false, error: 'not pdf' });
  if (file.getSize() > UPLOAD_MAX_BYTES) return out_({ ok: false, error: 'too big' });

  var b64 = Utilities.base64Encode(file.getBlob().getBytes());
  var parts = Math.max(1, Math.ceil(b64.length / FILE_PART_CHARS));
  if (!(part >= 0 && part < parts)) return out_({ ok: false, error: 'bad part' });
  return out_({
    ok: true, name: file.getName(), mime: 'application/pdf', size: file.getSize(),
    parts: parts, part: part, data: b64.substr(part * FILE_PART_CHARS, FILE_PART_CHARS)
  });
}
function inOurFolder_(file) {
  var root = rootFolder_();
  var ok = {};
  ok[root.getId()] = true;
  var subs = root.getFolders();
  while (subs.hasNext()) ok[subs.next().getId()] = true;
  var ps = file.getParents();
  while (ps.hasNext()) if (ok[ps.next().getId()]) return true;
  return false;
}

/* ===== 최초 1회만 실행 =====
   편집기 상단 함수 목록에서 setupDrive 를 고르고 [실행]을 누르면
   드라이브 접근 권한 승인 창이 뜬다. 승인하면 폴더가 만들어지고 업로드가 동작한다. */
function setupDrive() {
  var who = Session.getEffectiveUser().getEmail();
  Logger.log('이 스크립트가 실행되는 계정: ' + who);
  var root = rootFolder_();
  subFolder_('콘티 악보');
  subFolder_('큐시트');
  subFolder_('곡별 악보');
  Logger.log('준비 완료 — 폴더 "' + root.getName() + '"');
  Logger.log(root.getUrl());
  Logger.log('업로드된 파일의 소유자는 ' + who + ' 가 됩니다.');
  return root.getUrl();
}

/* 스크립트가 어느 계정으로 도는지만 확인하고 싶을 때 실행 */
function whoAmI() {
  var who = Session.getEffectiveUser().getEmail();
  Logger.log('실행 계정: ' + who);
  return who;
}

function rootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) {
    /* 지정한 폴더에 못 들어가면 조용히 다른 폴더를 쓰지 않고 바로 알린다 */
    try { return DriveApp.getFolderById(id); }
    catch (err) {
      throw new Error('FOLDER_ID 폴더에 접근할 수 없습니다. 그 폴더를 ' +
        Session.getEffectiveUser().getEmail() + ' 계정에 편집자로 공유했는지 확인하세요. (FOLDER_ID=' + id + ')');
    }
  }
  var it = DriveApp.getFoldersByName(ROOT_FOLDER_NAME);
  var f = it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_FOLDER_NAME);
  props.setProperty('FOLDER_ID', f.getId());
  return f;
}
function subFolder_(name) {
  var root = rootFolder_();
  var it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function getSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  return sh;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
