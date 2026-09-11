/**
 * TEST PORTAL — Google Apps Script backend
 * ------------------------------------------------
 * 1. Create a new Google Sheet.
 * 2. Extensions > Apps Script. Delete any starter code and paste this whole file in.
 * 3. Click Deploy > New deployment > type: Web app.
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 4. Copy the Web app URL it gives you.
 * 5. Paste that URL into API_URL at the top of app.js.
 *
 * This script auto-creates two sheets the first time it runs: "Tests" and "Results".
 * Correct answers are NEVER sent to a student's browser — scoring happens here, server-side.
 */

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Test Portal API is running' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action;
    var payload = body.payload || {};

    // ---- Rate limiting (protects Apps Script's shared quota from one
    // student's script/bot flooding requests; normal usage never hits this) ----
    var rl = checkRateLimit_(action, payload);
    if (!rl.ok) {
      return ContentService.createTextOutput(JSON.stringify({ error: rl.message }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'saveTest') result = saveTest(payload);
    else if (action === 'listTestsForTeacher') result = listTestsForTeacher();
    else if (action === 'deleteTest') result = deleteTest(payload.id);
    else if (action === 'getTestForStudent') result = getTestForStudent(payload.id);
    else if (action === 'submitAttempt') result = submitAttempt(payload);
    else if (action === 'getResults') result = getResults(payload.testId);
    else if (action === 'generateResults') result = generateResults(payload);
    else if (action === 'saveProgress') result = saveProgress(payload);
    else if (action === 'getProgress') result = getProgress(payload);
    else if (action === 'checkTeacherPin') result = checkTeacherPin(payload);
    else if (action === 'uploadImage') result = uploadImage(payload);
    else result = { error: 'Unknown action: ' + action };
  } catch (err) {
    result = { error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Limits requests per "identity" (student+test, or a global bucket for
// unauthenticated actions like PIN checks) using CacheService — fast,
// automatic-expiry counters that don't touch the spreadsheet at all.
function checkRateLimit_(action, payload) {
  var cache = CacheService.getScriptCache();

  function bump(key, max, windowSec) {
    var count = Number(cache.get(key) || '0');
    if (count >= max) return false;
    cache.put(key, String(count + 1), windowSec);
    return true;
  }

  // Per student+test identity: generous headroom above normal autosave
  // frequency (~1 request/second), but blocks a script hammering the API.
  if (action === 'getTestForStudent' || action === 'getProgress' || action === 'saveProgress' || action === 'submitAttempt') {
    var idKey = 'id:' + action + ':' + (payload.testId || payload.id || '') + '|' + (payload.studentName || '') + '|' + (payload.rollNo || '');
    if (!bump(idKey, 15, 10)) {
      return { ok: false, message: 'Too many requests — please slow down and try again in a few seconds.' };
    }
  }

  // Global brute-force guard for the teacher PIN.
  if (action === 'checkTeacherPin') {
    if (!bump('pin-attempts', 20, 60)) {
      return { ok: false, message: 'Too many PIN attempts. Please wait a minute and try again.' };
    }
  }

  // Light global cap on teacher/admin actions, generous enough for normal use.
  if (action === 'saveTest' || action === 'deleteTest' || action === 'uploadImage' || action === 'generateResults') {
    if (!bump('teacher-write', 60, 60)) {
      return { ok: false, message: 'Too many requests right now. Please wait a moment and try again.' };
    }
  }

  return { ok: true };
}

function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
  }
  return sh;
}
function testsSheet_() { return getSheet_('Tests', ['id', 'title', 'json', 'createdAt']); }
function resultsSheet_() {
  return getSheet_('Results', ['id', 'testId', 'studentName', 'rollNo', 'score', 'total', 'correct', 'wrong', 'unattempted', 'violations', 'timeTakenSec', 'date', 'json']);
}
function progressSheet_() {
  return getSheet_('Progress', ['key', 'testId', 'studentName', 'rollNo', 'answersJson', 'statusJson', 'violations', 'startedAt', 'updatedAt']);
}
function progressKey_(testId, studentName, rollNo) {
  return testId + '||' + studentName + '||' + (rollNo || '');
}

// Called continuously while a student takes a test, so nothing is lost even if
// the final submit fails or the tab/browser closes unexpectedly.
function saveProgress(payload) {
  var sh = progressSheet_();
  var key = progressKey_(payload.testId, payload.studentName, payload.rollNo);
  var data = sh.getDataRange().getValues();
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) { if (data[i][0] === key) { rowIndex = i + 1; break; } }
  var row = [key, payload.testId, payload.studentName, payload.rollNo || '', JSON.stringify(payload.answers), JSON.stringify(payload.status), payload.violations || 0, payload.startedAt, Date.now()];
  if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, 9).setValues([row]);
  else sh.appendRow(row);
  return { ok: true };
}

function getProgress(payload) {
  var sh = progressSheet_();
  var key = progressKey_(payload.testId, payload.studentName, payload.rollNo);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      return { progress: {
        answers: JSON.parse(data[i][4]), status: JSON.parse(data[i][5]),
        violations: data[i][6], startedAt: data[i][7]
      }};
    }
  }
  return { progress: null };
}

function clearProgress_(testId, studentName, rollNo) {
  var sh = progressSheet_();
  var key = progressKey_(testId, studentName, rollNo);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) { if (data[i][0] === key) { sh.deleteRow(i + 1); break; } }
}

// Teacher access check — the correct PIN is never sent to the browser, only
// a true/false answer. Set it once: Project Settings (gear icon) > Script
// properties > Add property > TEACHER_PIN = your chosen PIN.
function checkTeacherPin(payload) {
  var correctPin = PropertiesService.getScriptProperties().getProperty('TEACHER_PIN');
  if (!correctPin) {
    return { error: 'No TEACHER_PIN is set yet. In the Apps Script editor, go to Project Settings > Script properties, and add TEACHER_PIN with your chosen PIN.' };
  }
  if (String(payload.pin) === String(correctPin)) return { ok: true };
  return { error: 'Incorrect PIN.' };
}

// Question images are uploaded here (base64 from the browser) instead of being
// stored inline in the sheet — keeps the spreadsheet fast even with hundreds
// of images, and avoids the ~50,000-character Google Sheets cell limit.
function uploadImage(payload) {
  if (!payload.data) return { error: 'No image data received.' };
  var bytes = Utilities.base64Decode(payload.data);
  if (bytes.length > 6 * 1024 * 1024) {
    return { error: 'That image is too large. Please use one under 5MB.' };
  }
  var blob = Utilities.newBlob(bytes, payload.mimeType || 'image/png', payload.filename || 'question-image');
  var folder = getOrCreateImagesFolder_();
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // Note: drive.google.com/uc?export=view is unreliable for hotlinking (Google
  // sometimes returns an HTML confirmation page instead of raw image bytes).
  // The thumbnail endpoint renders reliably in <img> tags.
  var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1000';
  return { url: url };
}

function getOrCreateImagesFolder_() {
  var name = 'Test Portal Images';
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

function saveTest(test) {
  var sh = testsSheet_();
  var data = sh.getDataRange().getValues();
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) { if (data[i][0] === test.id) { rowIndex = i + 1; break; } }
  var row = [test.id, test.title, JSON.stringify(test), test.createdAt || Date.now()];
  if (rowIndex > 0) sh.getRange(rowIndex, 1, 1, 4).setValues([row]);
  else sh.appendRow(row);
  // Refresh the cache immediately so the next student lookup is instant and
  // reflects this edit right away, instead of waiting for the old cache to expire.
  try { CacheService.getScriptCache().put('test:' + test.id, JSON.stringify(test), 300); } catch (e) {}
  return { ok: true, id: test.id };
}

function listTestsForTeacher() {
  var sh = testsSheet_();
  var data = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    try { out.push(JSON.parse(data[i][2])); } catch (e) {}
  }
  return { tests: out };
}

function deleteTest(id) {
  var sh = testsSheet_();
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) { if (data[i][0] === id) { sh.deleteRow(i + 1); break; } }
  var rsh = resultsSheet_();
  var rdata = rsh.getDataRange().getValues();
  for (var j = rdata.length - 1; j >= 1; j--) { if (rdata[j][1] === id) rsh.deleteRow(j + 1); }
  try { CacheService.getScriptCache().remove('test:' + id); } catch (e) {}
  return { ok: true };
}

// Strips correct answers before sending a test to a student's browser.
// Cached for 5 minutes — when a whole class opens the same test code at once,
// only the first request scans the sheet; everyone else hits the fast cache.
function getTestForStudent(id) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'test:' + id;
  var test;
  var cached = cache.get(cacheKey);
  if (cached) {
    test = JSON.parse(cached);
  } else {
    var sh = testsSheet_();
    var data = sh.getDataRange().getValues();
    var raw = null;
    for (var i = 1; i < data.length; i++) { if (data[i][0] === id) { raw = data[i][2]; break; } }
    if (!raw) return { error: 'No test found with that code. Check it and try again.' };
    test = JSON.parse(raw);
    try { cache.put(cacheKey, raw, 300); } catch (e) {}
  }

  if (test.active === false) {
    return { error: 'This test is currently inactive. Please check with your teacher for the current test code.' };
  }
  var stripped = {
    id: test.id, title: test.title, duration: test.duration,
    marksCorrect: test.marksCorrect, marksWrong: test.marksWrong,
    questions: test.questions.map(function (q) {
      return { id: q.id, subject: q.subject, text: q.text, image: q.image || null, options: q.options };
    })
  };
  return { test: stripped };
}

// Scores the attempt server-side so the answer key never reaches the browser.
// Submission now only stores what the student answered — it does NOT score.
// Scoring happens later, on demand, via generateResults() (the teacher's
// "Generate results" button). This lets teachers use quick placeholder
// questions during a rushed test-creation session and mark correct answers
// afterward, any time before results are generated.
function submitAttempt(payload) {
  var sh = testsSheet_();
  var data = sh.getDataRange().getValues();
  var test = null;
  for (var i = 1; i < data.length; i++) { if (data[i][0] === payload.testId) { test = JSON.parse(data[i][2]); break; } }
  if (!test) return { error: 'Test not found' };

  clearProgress_(payload.testId, payload.studentName, payload.rollNo);

  var record = {
    id: Utilities.getUuid(), testId: test.id,
    studentName: payload.studentName || 'Unnamed', rollNo: payload.rollNo || '',
    violations: payload.violations || 0, timeTakenSec: payload.timeTakenSec || 0, date: Date.now()
  };

  var rsh = resultsSheet_();
  // score/total/correct/wrong/unattempted (columns E–I) are left blank until
  // generateResults() fills them in — that blank-ness is how we know a row
  // hasn't been scored yet.
  rsh.appendRow([record.id, record.testId, record.studentName, record.rollNo, '', '', '', '',
    '', record.violations, record.timeTakenSec, record.date,
    JSON.stringify({ answers: payload.answers })]);

  return { result: { hidden: true, testTitle: test.title } };
}

// Scores (or re-scores) every submitted attempt for a test, using whatever
// correct answers are currently set on the test. Safe to call repeatedly —
// e.g. after fixing a correct answer, click it again to refresh everyone's score.
function generateResults(payload) {
  var testId = payload.testId;
  var tsh = testsSheet_();
  var tdata = tsh.getDataRange().getValues();
  var test = null;
  for (var i = 1; i < tdata.length; i++) { if (tdata[i][0] === testId) { test = JSON.parse(tdata[i][2]); break; } }
  if (!test) return { error: 'Test not found' };

  var rsh = resultsSheet_();
  var rdata = rsh.getDataRange().getValues();
  var updatedCount = 0;

  for (var i = 1; i < rdata.length; i++) {
    if (rdata[i][1] !== testId) continue;
    var stored = {};
    try { stored = JSON.parse(rdata[i][12]); } catch (e) { stored = {}; }
    var answers = stored.answers || [];

    var correct = 0, wrong = 0, unattempted = 0, marks = 0;
    var perSubject = {}, perQuestion = [];
    test.questions.forEach(function (q, idx) {
      var subj = q.subject || 'General';
      if (!perSubject[subj]) perSubject[subj] = { total: 0, correct: 0, wrong: 0, unattempted: 0, marks: 0 };
      perSubject[subj].total++;
      var sel = answers[idx];
      var status;
      if (sel === null || sel === undefined) {
        unattempted++; perSubject[subj].unattempted++; status = 'skip';
      } else if (sel === q.correct) {
        correct++; marks += test.marksCorrect; perSubject[subj].correct++; perSubject[subj].marks += test.marksCorrect; status = 'correct';
      } else {
        wrong++; marks -= test.marksWrong; perSubject[subj].wrong++; perSubject[subj].marks -= test.marksWrong; status = 'wrong';
      }
      perQuestion.push({ i: idx, text: q.text, subject: q.subject, options: q.options, correct: q.correct, sel: (sel === undefined ? null : sel), status: status, image: q.image || null });
    });
    var totalPossible = test.questions.length * test.marksCorrect;

    rsh.getRange(i + 1, 5, 1, 5).setValues([[marks, totalPossible, correct, wrong, unattempted]]);
    rsh.getRange(i + 1, 13).setValue(JSON.stringify({ perSubject: perSubject, perQuestion: perQuestion }));
    updatedCount++;
  }

  return { ok: true, updated: updatedCount };
}

function getResults(testId) {
  var rsh = resultsSheet_();
  var data = rsh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === testId) {
      var detail = null;
      try { detail = JSON.parse(data[i][12]); } catch (e) { detail = null; }
      var scored = data[i][4] !== '' && data[i][4] !== null && data[i][4] !== undefined;
      out.push({
        id: data[i][0], studentName: data[i][2], rollNo: data[i][3],
        score: scored ? data[i][4] : null, total: scored ? data[i][5] : null,
        correct: scored ? data[i][6] : null, wrong: scored ? data[i][7] : null, unattempted: scored ? data[i][8] : null,
        violations: data[i][9], timeTakenSec: data[i][10], date: data[i][11],
        scored: scored,
        perQuestion: (detail && detail.perQuestion) ? detail.perQuestion : []
      });
    }
  }
  out.sort(function (a, b) { return b.date - a.date; });
  return { results: out };
}
