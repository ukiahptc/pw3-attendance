var SHEET_NAME = 'DATA';
var CHUNK = 40000;

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

/* 개인정보(명단·출결·사유)를 제거한 공개용 데이터 */
function publicView_(json) {
  var s;
  try { s = JSON.parse(json); } catch (err) { return { redacted: true, meetings: [], events: [], resources: [] }; }
  var src = s.meetings || [];
  var meetings = [];
  for (var i = 0; i < src.length; i++) meetings.push({ id: src[i].id, date: src[i].date });
  return {
    redacted: true,
    meetings: meetings,
    notice: s.notice || { text: '', at: 0 },
    events: s.events || [],
    resources: s.resources || [],
    updatedAt: s.updatedAt || 0
  };
}

function doGet(e) {
  /* PIN 확인 전용 요청 */
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
  var body = e && e.postData && e.postData.contents;
  if (!body) return out_({ ok: false, error: 'empty' });
  var parsed;
  try { parsed = JSON.parse(body); } catch (err) { return out_({ ok: false, error: 'invalid json' }); }
  /* 공개용 축약본이 잘못 올라와 명단을 덮어쓰는 사고 방지 */
  if (parsed && parsed.redacted) return out_({ ok: false, error: 'redacted' });

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
