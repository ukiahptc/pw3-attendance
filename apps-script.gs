var SHEET_NAME = 'DATA';
var CHUNK = 40000;
var ROOT_FOLDER_NAME = 'PW3 예배팀 자료';

/* PIN은 코드에 쓰지 않는다. 프로젝트 설정 > 스크립트 속성에 PIN 이름으로 저장.
   속성이 비어 있으면 기존처럼 전부 공개된다(사이트가 죽지 않도록 한 안전장치). */
function getPin_() {
  return String(PropertiesService.getScriptProperties().getProperty('PIN') || '');
}
function pinOK_(e) {
  var want = getPin_();
  if (!want) return true;
  var got = e && e.parameter && e.parameter.pin;
  return String(got || '') === want;
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

/* 개인정보만 제거한 공개용 데이터.
   공개: 모임 날짜, 공지, 행사, 콘티 전체(곡·유튜브·악보·큐시트 링크), 섬김표, 자료실 전체
   비공개: 명단(members), 출결 기록·사유(meetings[].records) */
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
    sh.clearContents();
    var rows = [];
    for (var i = 0; i < body.length; i += CHUNK) rows.push([body.substring(i, i + CHUNK)]);
    sh.getRange(1, 1, rows.length, 1).setValues(rows);
  } finally {
    lock.releaseLock();
  }
  return out_({ ok: true });
}

/* ---------- 파일 업로드 ---------- */
/* 본문 형식: {"name":"...","mime":"application/pdf","folder":"콘티 악보","data":"<base64>"} */
function upload_(e) {
  var body = e && e.postData && e.postData.contents;
  if (!body) return out_({ ok: false, error: 'empty' });
  var req;
  try { req = JSON.parse(body); } catch (err) { return out_({ ok: false, error: 'invalid json' }); }
  if (!req.data || !req.name) return out_({ ok: false, error: 'no file' });

  try {
    var bytes = Utilities.base64Decode(req.data);
    var blob = Utilities.newBlob(bytes, req.mime || 'application/pdf', req.name);
    var folder = subFolder_(req.folder || '기타');
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
