(function(){
  "use strict";

  /* ====================================================================
     PASTE YOUR GOOGLE APPS SCRIPT WEB APP URL BELOW (see Code.gs setup).
     It looks like: https://script.google.com/macros/s/AKfycb.../exec
  ==================================================================== */
  const API_URL = "https://script.google.com/macros/s/AKfycbzDzGvbB1NrGRvICQ-G63rrzds66Inesxl_YiI8WUN7GVPdbbqXeu_qjOTwRuxNzv_QGg/exec";

  // Bump this any time you deploy a new app.js — shown in the footer, so you
  // can always confirm at a glance whether your latest upload is actually live.
  const APP_VERSION = 'v14';

  const MAX_VIOLATIONS = 3;

  // Short, non-obvious student-link key — doesn't say "student" anywhere.
  // Change this string any time to invalidate old shared links.
  const STUDENT_LINK_KEY = 'k';
  const STUDENT_LINK_VALUE = 'p9x2q7';

  /* ============ STATE ============ */
  let view = 'role';           // role | teacher-pin | teacher-home | builder | teacher-results | student-entry | student-rules | player | result | submit-error
  let role = null;             // 'teacher' | 'student'
  let forcedRole = null;       // set once from the URL — 'student' link never exposes the teacher option
  let teacherPinError = '';
  let teacherTests = [];
  let builder = null;
  let studentTest = null;      // stripped test (no answers) for the student taking it
  let studentInfo = null;      // {name, rollNo}
  let resumedProgress = null;  // saved progress fetched on lookup, if any
  let attempt = null;
  let resultData = null;
  let reviewFilter = 'all';
  let teacherResultsCache = [];
  let teacherResultsTestTitle = '';

  const app = document.getElementById('app');

  /* ============ API ============ */
  async function apiCall(action, payload, timeoutMs){
    if(!API_URL || API_URL.indexOf('PASTE_YOUR') === 0){
      throw new Error('The teacher/student portal isn\'t connected to a database yet — paste your Google Apps Script URL into API_URL at the top of app.js.');
    }
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs || 12000;
    const timeoutId = setTimeout(()=>controller.abort(), effectiveTimeout);
    let res;
    try{
      res = await fetch(API_URL, { method:'POST', body: JSON.stringify({ action, payload }), signal: controller.signal });
    }catch(err){
      if(err.name==='AbortError') throw new Error(`The request to Google timed out after ${Math.round(effectiveTimeout/1000)}s. Check that your Apps Script is deployed with "Who has access: Anyone", and that you redeployed after any code changes (Deploy → Manage deployments → Edit → New version).`);
      throw new Error('Network request failed: ' + err.message + '. Check the API_URL at the top of app.js is correct and the deployment is live.');
    }finally{
      clearTimeout(timeoutId);
    }
    let data;
    try{
      data = await res.json();
    }catch(err){
      throw new Error('Got a response that wasn\'t valid JSON (status ' + res.status + '). This usually means the Apps Script isn\'t authorized yet, or access isn\'t set to "Anyone" — open the deployed URL directly in a browser tab to see the raw error.');
    }
    if(data.error) throw new Error(data.error);
    return data;
  }

  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
  function escapeHtml(s){ return String(s===null||s===undefined?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtTime(totalSec){
    totalSec = Math.max(0,Math.round(totalSec));
    const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), s = totalSec%60;
    if(h>0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  function setLoading(msg){
    app.innerHTML = `<div class="loading-row"><span class="spinner"></span><span class="helper">${escapeHtml(msg||'Loading…')}</span></div>`;
  }

  /* ============ NON-BLOCKING MODAL (replaces alert() for status/results,
     since alert() freezes all page JS — including pending fetches/timers —
     which made unrelated screens look frozen while a dialog was open) ============ */
  function showModal(title, bodyHtml, isError){
    let el = document.getElementById('generic-modal');
    if(!el){
      el = document.createElement('div');
      el.id = 'generic-modal';
      el.className = 'generic-modal-overlay';
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div class="generic-modal-box">
        <h3 style="${isError?'color:var(--red);':''}">${escapeHtml(title)}</h3>
        <div class="generic-modal-body">${bodyHtml}</div>
        <button class="btn" onclick="app_closeModal()">OK</button>
      </div>`;
    el.style.display = 'flex';
  }
  window.app_closeModal = function(){
    const el = document.getElementById('generic-modal');
    if(el) el.style.display = 'none';
  };
  function showError(err){ showModal('Something went wrong', escapeHtml(err.message || String(err)), true); }

  const TEACHER_VIEWS = ['role','teacher-pin','teacher-home','builder','teacher-results'];
  function render(){
    updateDiagFooterVisibility();
    if(view==='role') return renderRole();
    if(view==='teacher-pin') return renderTeacherPin();
    if(view==='teacher-home') return renderTeacherHome();
    if(view==='builder') return renderBuilder();
    if(view==='teacher-results') return renderTeacherResults();
    if(view==='student-entry') return renderStudentEntry();
    if(view==='student-rules') return renderStudentRules();
    if(view==='player') return renderPlayer();
    if(view==='result') return renderResult();
    if(view==='submit-error') return renderSubmitError();
  }
  function updateDiagFooterVisibility(){
    const el = document.getElementById('diag-footer');
    if(!el) return;
    // Only visible on teacher screens — students never see the debug badge/button.
    el.style.display = TEACHER_VIEWS.includes(view) ? 'flex' : 'none';
  }

  function topbar(tag, backFn){
    return `
      <div class="topbar">
        <div class="brand"><span class="display">Test Portal</span><span class="tag">${tag}</span></div>
        ${backFn ? `<button class="btn secondary small" onclick="${backFn}">← Back</button>` : ''}
      </div>`;
  }

  /* ============ ROLE PICKER ============ */
  function renderRole(){
    app.innerHTML = `
      ${topbar('Choose your role')}
      <div class="role-grid">
        ${forcedRole==='student' ? '' : `
        <div class="role-card" onclick="app_goTeacher()">
          <div class="role-icon">T</div>
          <h3>I'm a teacher</h3>
          <div class="helper">Create tests, share a test code with your class, and review every student's score and violations. PIN required.</div>
        </div>`}
        <div class="role-card" onclick="app_goStudentEntry()">
          <div class="role-icon">S</div>
          <h3>I'm a student</h3>
          <div class="helper">Enter the test code your teacher gave you and attempt the test under exam conditions.</div>
        </div>
      </div>
    `;
  }
  window.app_goTeacher = async function(){
    if(sessionStorage.getItem('teacherUnlocked')==='1'){
      await enterTeacherHome();
      return;
    }
    role='teacher'; view='teacher-pin'; teacherPinError=''; render();
  };
  function renderTeacherPin(){
    app.innerHTML = `
      ${topbar('Teacher access', 'app_backToRole()')}
      <div class="panel" style="max-width:380px; margin:0 auto; text-align:center;">
        <h2 class="section-title">Enter teacher PIN</h2>
        <div class="helper" style="margin:8px 0 16px;">This keeps students from opening the teacher dashboard.</div>
        <input id="t-pin" type="password" inputmode="numeric" placeholder="PIN" style="width:100%; padding:10px; text-align:center; font-size:18px; border:1px solid var(--line); border-radius:var(--radius); margin-bottom:12px;">
        <button class="btn" style="width:100%;" onclick="app_submitTeacherPin()">Unlock</button>
        <div class="helper" style="color:var(--red); margin-top:10px;">${escapeHtml(teacherPinError)}</div>
      </div>
    `;
    const pinEl = document.getElementById('t-pin');
    pinEl.focus();
    pinEl.onkeydown = (e)=>{ if(e.key==='Enter') window.app_submitTeacherPin(); };
  }
  window.app_submitTeacherPin = async function(){
    const pin = document.getElementById('t-pin').value.trim();
    if(!pin){ teacherPinError='Enter the PIN.'; renderTeacherPin(); return; }
    setLoading('Checking…');
    try{
      await apiCall('checkTeacherPin', {pin});
      sessionStorage.setItem('teacherUnlocked','1');
      await enterTeacherHome();
    }catch(e){
      teacherPinError = e.message;
      view='teacher-pin'; render();
    }
  };
  async function enterTeacherHome(){
    role='teacher'; view='teacher-home';
    setLoading('Loading your tests…');
    try{
      const data = await apiCall('listTestsForTeacher', {});
      teacherTests = data.tests || [];
      teacherTests.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    }catch(e){ showError(e); teacherTests=[]; }
    render();
  }
  window.app_goStudentEntry = function(){ role='student'; view='student-entry'; render(); };
  window.app_backToRole = function(){
    role=null;
    view = (forcedRole==='student') ? 'student-entry' : 'role';
    render();
  };

  /* ============ TEACHER HOME ============ */
  function renderTeacherHome(){
    const cards = teacherTests.map(t=>{
      const subjects = [...new Set(t.questions.map(q=>q.subject).filter(Boolean))];
      const isActive = t.active !== false;
      return `
      <div class="test-card ${isActive?'':'inactive-card'}">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div class="serial">TEST CODE — SHARE WITH STUDENTS</div>
          <span class="status-pill ${isActive?'correct':'skip'}">${isActive?'Active':'Inactive'}</span>
        </div>
        <div class="test-code">${t.id}</div>
        <h3>${escapeHtml(t.title)}</h3>
        <div class="meta-row">
          <span>${t.questions.length} question${t.questions.length!==1?'s':''}</span>
          <span>${t.duration} min</span>
          <span>${subjects.length ? escapeHtml(subjects.join(', ')) : 'No subjects tagged'}</span>
        </div>
        <div class="card-actions">
          <button class="btn secondary small" onclick="app_editTest('${t.id}')">Edit</button>
          <button class="btn secondary small" onclick="app_viewResults('${t.id}','${encodeURIComponent(t.title)}')">View results</button>
          <button class="btn secondary small" onclick="app_toggleActive('${t.id}')">${isActive?'Deactivate':'Activate'}</button>
          <button class="btn danger small" onclick="app_deleteTest('${t.id}')">Delete</button>
        </div>
      </div>`;
    }).join('');

    app.innerHTML = `
      ${topbar('Teacher dashboard', 'app_backToRole()')}
      <div class="home-head">
        <div>
          <h2 class="section-title">Your tests</h2>
          <div class="helper">Give students the test code shown on each card — that's all they need to attempt it.</div>
        </div>
        <button class="btn" onclick="app_newTest()">+ New test</button>
      </div>
      <div class="panel" style="margin-bottom:22px; padding:16px 20px; display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:18px;">
        <div style="flex:1; min-width:220px;">
          <div style="font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--ink-soft); margin-bottom:4px;">Student link — share this with your class</div>
          <div class="mono" style="font-size:13.5px; word-break:break-all;" id="student-link-text">${studentLinkUrl()}</div>
          <div style="display:flex; gap:8px; margin-top:10px;">
            <button class="btn secondary small" onclick="app_copyStudentLink()">Copy link</button>
            <button class="btn secondary small" onclick="app_downloadQR()">Download QR</button>
          </div>
        </div>
        <div id="qr-code-box" style="flex-shrink:0;"></div>
      </div>
      ${teacherTests.length===0 ? `
        <div class="empty-state">
          <h3>No tests yet</h3>
          <div>Create your first test to get a shareable test code.</div>
          <div style="margin-top:16px;"><button class="btn" onclick="app_newTest()">+ New test</button></div>
        </div>
      ` : `<div class="card-grid">${cards}</div>`}
    `;
    renderStudentQR();
  }

  function renderStudentQR(){
    const box = document.getElementById('qr-code-box');
    if(!box || typeof QRCode==='undefined') return;
    box.innerHTML = '';
    new QRCode(box, {
      text: studentLinkUrl(), width: 128, height: 128,
      colorDark: '#1B2340', colorLight: '#FFFFFF'
    });
  }
  window.app_downloadQR = function(){
    const canvas = document.querySelector('#qr-code-box canvas');
    if(!canvas){ alert('QR code not ready yet — try again in a moment.'); return; }
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = 'student-test-link-qr.png';
    a.click();
  };

  window.app_copyStudentLink = function(){
    const link = studentLinkUrl();
    navigator.clipboard.writeText(link).then(()=>{
      alert('Student link copied:\n' + link);
    }).catch(()=>{
      prompt('Copy this student link:', link);
    });
  };

  // Short, easy-to-read test codes (no 0/O/1/I/L, which get confused when spoken
  // or handwritten), checked against your currently-loaded tests to avoid collisions.
  function genTestCode(){
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code;
    do{
      code = '';
      for(let i=0;i<6;i++) code += alphabet[Math.floor(Math.random()*alphabet.length)];
    } while(teacherTests.some(t=>t.id===code));
    return code;
  }

  window.app_newTest = function(){
    builder = { id: genTestCode(), title:'', duration:60, marksCorrect:4, marksWrong:1, negativeMarking:true, active:true, showResultToStudent:false, questions:[], createdAt: Date.now() };
    view='builder'; render();
  };
  window.app_editTest = function(id){
    const t = teacherTests.find(x=>x.id===id);
    builder = JSON.parse(JSON.stringify(t));
    if(builder.negativeMarking===undefined) builder.negativeMarking = builder.marksWrong>0;
    if(builder.showResultToStudent===undefined) builder.showResultToStudent = false;
    view='builder'; render();
  };
  window.app_deleteTest = async function(id){
    if(!confirm('Delete this test and all its results? This cannot be undone.')) return;
    setLoading('Deleting…');
    try{ await apiCall('deleteTest', {id}); }catch(e){ showError(e); }
    await window.app_goTeacher();
  };
  window.app_toggleActive = async function(id){
    const t = teacherTests.find(x=>x.id===id);
    if(!t) return;
    const willBeActive = t.active === false;
    t.active = willBeActive;
    setLoading(willBeActive ? 'Activating…' : 'Deactivating…');
    try{ await apiCall('saveTest', t); }catch(e){ showError(e); }
    await enterTeacherHome();
  };
  let currentResultsTestId = '';
  let resultsSearchQuery = '';
  let selectedStudentIds = new Set();

  window.app_viewResults = async function(testId, encodedTitle){
    view='teacher-results';
    teacherResultsTestTitle = decodeURIComponent(encodedTitle);
    currentResultsTestId = testId;
    resultsSearchQuery = '';
    selectedStudentIds = new Set();
    setLoading('Loading results…');
    let loadError = null;
    try{
      const data = await apiCall('getResults', {testId});
      teacherResultsCache = data.results || [];
    }catch(e){ loadError = e.message; teacherResultsCache=[]; }
    renderTeacherResultsInner(testId, loadError);
  };

  function filteredResults(){
    if(!resultsSearchQuery.trim()) return teacherResultsCache;
    const q = resultsSearchQuery.trim().toLowerCase();
    return teacherResultsCache.filter(r =>
      (r.studentName||'').toLowerCase().includes(q) || String(r.rollNo||'').toLowerCase().includes(q)
    );
  }
  function getExportResults(){
    return selectedStudentIds.size>0 ? teacherResultsCache.filter(r=>selectedStudentIds.has(r.id)) : teacherResultsCache;
  }

  function renderTeacherResultsInner(testId, loadError){
    const visible = filteredResults();
    const allVisibleSelected = visible.length>0 && visible.every(r=>selectedStudentIds.has(r.id));
    const rows = visible.map(r=>`
      <tr class="${r.violations>0?'flagged':''}">
        <td><input type="checkbox" ${selectedStudentIds.has(r.id)?'checked':''} onchange="app_toggleResultSelect('${r.id}')"></td>
        <td>${escapeHtml(r.studentName)}</td>
        <td>${escapeHtml(r.rollNo||'—')}</td>
        <td class="mono">${r.score}/${r.total}</td>
        <td>${r.correct}</td>
        <td>${r.wrong}</td>
        <td>${r.unattempted}</td>
        <td>${fmtTime(r.timeTakenSec)}</td>
        <td>${r.violations>0 ? `<span class="status-pill wrong">${r.violations} flag${r.violations>1?'s':''}</span>` : '—'}</td>
        <td>${new Date(r.date).toLocaleString()}</td>
        <td>${r.perQuestion && r.perQuestion.length ? `<button class="btn secondary small" onclick="app_viewStudentAnswers('${r.id}')">View answers</button>` : '—'}</td>
      </tr>
    `).join('');
    app.innerHTML = `
      ${topbar('Results', 'app_goTeacher()')}
      <h2 class="section-title">${escapeHtml(teacherResultsTestTitle)}</h2>
      ${loadError ? `<div class="empty-state" style="border-color:var(--red); color:var(--red); text-align:left;"><h3 style="color:var(--red);">Couldn't load results</h3><div>${escapeHtml(loadError)}</div><div style="margin-top:14px;"><button class="btn secondary small" onclick="app_viewResults('${testId}','${encodeURIComponent(teacherResultsTestTitle)}')">Try again</button></div></div>` : `
      <div class="helper" style="margin-bottom:16px;">"Flags" mean the student exited fullscreen or switched tabs during the attempt.</div>
      ${teacherResultsCache.length===0 ? `<div class="empty-state"><h3>No attempts yet</h3><div>Results will appear here once students submit the test.</div></div>` : `
      <div style="display:flex; gap:10px; margin-bottom:14px; align-items:center; flex-wrap:wrap;">
        <input type="text" id="results-search" placeholder="Search by name or roll no." value="${escapeHtml(resultsSearchQuery)}" style="flex:1; min-width:220px; padding:9px 10px; border:1px solid var(--line); border-radius:var(--radius);">
        <span class="helper">${selectedStudentIds.size>0 ? selectedStudentIds.size+' student'+(selectedStudentIds.size>1?'s':'')+' selected — exports use only these' : 'No selection — exports include everyone'}</span>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap;">
        <button class="btn secondary small" onclick="app_downloadResultsCsv()">Download results (CSV)</button>
        <button class="btn secondary small" onclick="app_downloadResponsesCsv()">Download responses (CSV)</button>
        <button class="btn secondary small" onclick="app_downloadResultsPdf()">Download PDF report</button>
      </div>
      <table class="subj-table">
        <thead><tr>
          <th><input type="checkbox" ${allVisibleSelected?'checked':''} onchange="app_toggleSelectAllVisible()"></th>
          <th>Name</th><th>Roll no.</th><th>Score</th><th>Correct</th><th>Wrong</th><th>Unatt.</th><th>Time</th><th>Flags</th><th>Submitted</th><th></th>
        </tr></thead>
        <tbody>${rows || `<tr><td colspan="11" class="helper" style="padding:16px;">No students match "${escapeHtml(resultsSearchQuery)}".</td></tr>`}</tbody>
      </table>`}
      `}
    `;
    const searchInput = document.getElementById('results-search');
    if(searchInput){
      searchInput.oninput = (e)=>{ resultsSearchQuery = e.target.value; renderTeacherResultsInner(testId, loadError); };
      searchInput.focus();
      const pos = searchInput.value.length;
      searchInput.setSelectionRange(pos, pos);
    }
  }

  window.app_toggleResultSelect = function(id){
    if(selectedStudentIds.has(id)) selectedStudentIds.delete(id); else selectedStudentIds.add(id);
    renderTeacherResultsInner(currentResultsTestId, null);
  };
  window.app_toggleSelectAllVisible = function(){
    const visible = filteredResults();
    const allSelected = visible.length>0 && visible.every(r=>selectedStudentIds.has(r.id));
    visible.forEach(r=> allSelected ? selectedStudentIds.delete(r.id) : selectedStudentIds.add(r.id));
    renderTeacherResultsInner(currentResultsTestId, null);
  };

  window.app_viewStudentAnswers = function(id){
    const r = teacherResultsCache.find(x=>x.id===id);
    if(!r || !r.perQuestion) return;
    const body = r.perQuestion.map(pq=>{
      const yourAns = pq.sel===null||pq.sel===undefined ? '<em>Not attempted</em>' : `${String.fromCharCode(65+pq.sel)}. ${escapeHtml(pq.options[pq.sel])}`;
      const correctAns = `${String.fromCharCode(65+pq.correct)}. ${escapeHtml(pq.options[pq.correct])}`;
      const pillClass = pq.status==='correct'?'correct':pq.status==='wrong'?'wrong':'skip';
      const pillLabel = pq.status==='correct'?'Correct':pq.status==='wrong'?'Wrong':'Skipped';
      return `
        <div class="review-item" style="text-align:left;">
          <div class="review-item-head">
            <strong>Q${pq.i+1}. ${escapeHtml(pq.subject||'General')}</strong>
            <span class="status-pill ${pillClass}">${pillLabel}</span>
          </div>
          <div>${escapeHtml(pq.text)}</div>
          <div class="ans-line"><span class="lbl">Answered:</span>${yourAns}</div>
          ${pq.status!=='correct' ? `<div class="ans-line"><span class="lbl">Correct answer:</span>${correctAns}</div>` : ''}
        </div>`;
    }).join('');
    showModal(`${r.studentName}${r.rollNo ? ' · '+r.rollNo : ''} — ${r.score}/${r.total}`, body);
  };

  /* ============ RESULTS EXPORT (CSV + PDF) ============ */
  function sanitizeFilename(s){ return String(s).trim().replace(/[^a-z0-9\-]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase() || 'test'; }

  window.app_downloadResultsCsv = function(){
    const results = getExportResults();
    if(results.length===0){ showModal('Nothing to export', 'No students match your current selection.'); return; }
    const header = ['Name','Roll No','Score','Total','Correct','Wrong','Unattempted','Time (s)','Violations','Submitted'];
    const rows = results.map(r=>[
      r.studentName, r.rollNo||'', r.score, r.total, r.correct, r.wrong, r.unattempted,
      Math.round(r.timeTakenSec||0), r.violations||0, new Date(r.date).toLocaleString()
    ]);
    const csvText = [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
    downloadTextFile(csvText, sanitizeFilename(teacherResultsTestTitle)+'-results.csv', 'text/csv');
  };

  // Wide format: one row per student. Row directly under the header is the
  // answer key (correct option for each question), so it's easy to eyeball
  // right above the class's answers.
  window.app_downloadResponsesCsv = function(){
    const results = getExportResults();
    if(results.length===0){ showModal('Nothing to export', 'No students match your current selection.'); return; }
    const withDetail = results.find(r=>r.perQuestion && r.perQuestion.length);
    if(!withDetail){ showModal('Nothing to export', 'No detailed responses are available for this test yet.'); return; }
    const qCount = withDetail.perQuestion.length;
    const header = ['Name','Roll No', ...Array.from({length:qCount},(_,i)=>'Q.'+(i+1)), 'Correct','Incorrect','Left'];
    const answerKeyRow = ['Answer Key','', ...withDetail.perQuestion.map(pq=>String.fromCharCode(65+pq.correct)), '', '', ''];
    const rows = results.map(r=>{
      const byIndex = {};
      (r.perQuestion||[]).forEach(pq=>{ byIndex[pq.i] = pq; });
      const answers = Array.from({length:qCount},(_,i)=>{
        const pq = byIndex[i];
        if(!pq) return '';
        return pq.sel===null||pq.sel===undefined ? '-' : String.fromCharCode(65+pq.sel);
      });
      return [r.studentName, r.rollNo||'', ...answers, r.correct, r.wrong, r.unattempted];
    });
    const csvText = [header, answerKeyRow, ...rows].map(row => row.map(csvEscape).join(',')).join('\r\n');
    downloadTextFile(csvText, sanitizeFilename(teacherResultsTestTitle)+'-responses.csv', 'text/csv');
  };

  function buildPrintableReportHtml(title, results){
    const summaryRows = results.map(r=>`
      <tr><td>${escapeHtml(r.studentName)}</td><td>${escapeHtml(r.rollNo||'—')}</td><td>${r.score}/${r.total}</td>
      <td>${r.correct}</td><td>${r.wrong}</td><td>${r.unattempted}</td><td>${fmtTime(r.timeTakenSec)}</td>
      <td>${r.violations||0}</td><td>${new Date(r.date).toLocaleString()}</td></tr>`).join('');

    const detailSections = results.map(r=>{
      const qRows = (r.perQuestion||[]).map(pq=>{
        const yourAns = pq.sel===null||pq.sel===undefined ? 'Not attempted' : `${String.fromCharCode(65+pq.sel)}. ${escapeHtml(pq.options[pq.sel])}`;
        const correctAns = `${String.fromCharCode(65+pq.correct)}. ${escapeHtml(pq.options[pq.correct])}`;
        return `<tr><td>${pq.i+1}</td><td>${escapeHtml(pq.subject||'')}</td><td>${escapeHtml(pq.text)}</td><td>${yourAns}</td><td>${correctAns}</td><td>${pq.status}</td></tr>`;
      }).join('');
      return `
        <div class="student-section">
          <h3>${escapeHtml(r.studentName)}${r.rollNo?' · '+escapeHtml(r.rollNo):''} — ${r.score}/${r.total}</h3>
          <table>
            <thead><tr><th>Q#</th><th>Subject</th><th>Question</th><th>Answered</th><th>Correct answer</th><th>Status</th></tr></thead>
            <tbody>${qRows}</tbody>
          </table>
        </div>`;
    }).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} — Results</title>
    <style>
      body{font-family:Georgia,'Times New Roman',serif; color:#1B2340; padding:28px; font-size:13px;}
      h1{font-size:22px; border-bottom:2px solid #1B2340; padding-bottom:10px; margin-bottom:4px;}
      h2{font-size:16px; margin-top:26px;}
      h3{font-size:14px; margin:20px 0 8px; border-top:1px solid #ccc; padding-top:14px;}
      table{width:100%; border-collapse:collapse; margin-bottom:10px;}
      th,td{border:1px solid #ccc; padding:5px 8px; text-align:left; font-size:12px; vertical-align:top;}
      th{background:#F1E4C2;}
      .student-section{page-break-inside:avoid;}
      .print-btn{padding:8px 16px; margin-bottom:16px; cursor:pointer;}
      @media print{ .print-btn{display:none;} }
    </style></head>
    <body>
      <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
      <h1>${escapeHtml(title)}</h1>
      <div style="color:#555; margin-bottom:6px;">Results report</div>
      <h2>Summary</h2>
      <table>
        <thead><tr><th>Name</th><th>Roll No</th><th>Score</th><th>Correct</th><th>Wrong</th><th>Unatt.</th><th>Time</th><th>Flags</th><th>Submitted</th></tr></thead>
        <tbody>${summaryRows}</tbody>
      </table>
      <h2>Detailed responses</h2>
      ${detailSections || '<div>No detailed responses available.</div>'}
    </body></html>`;
  }

  window.app_downloadResultsPdf = function(){
    const results = getExportResults();
    if(results.length===0){ showModal('Nothing to export', 'No students match your current selection.'); return; }
    const html = buildPrintableReportHtml(teacherResultsTestTitle, results);
    const win = window.open('', '_blank');
    if(!win){ showModal('Pop-up blocked', 'Please allow pop-ups for this site in your browser, then try again.', true); return; }
    win.document.write(html);
    win.document.close();
    setTimeout(()=>{ try{ win.print(); }catch(e){} }, 400);
  };

  /* ============ BUILDER (teacher) ============ */
  function renderBuilder(){
    const qBlocks = builder.questions.map((q,i)=>`
      <div class="q-block" data-qi="${i}">
        <div class="q-block-head">
          <span class="qnum">QUESTION ${i+1}</span>
          <button class="btn danger small" onclick="app_removeQ(${i})">Remove</button>
        </div>
        <div class="field" style="margin-bottom:10px;">
          <label>Subject</label>
          <input class="subject-tag-input" data-field="subject" value="${escapeHtml(q.subject||'')}" placeholder="e.g. Physics">
        </div>
        <label style="display:block; font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--ink-soft); margin-bottom:6px;">Question text</label>
        <textarea data-field="text" placeholder="Type or paste the question text here…">${escapeHtml(q.text||'')}</textarea>
        ${q.image ? `
        <div class="img-row">
          <img src="${q.image}" alt="question image">
          <button class="btn danger small" data-field="removeImage">Remove image</button>
        </div>
        ` : `
        <div class="image-dropzone">
          <div>Drag &amp; drop an image here</div>
          <div class="helper" style="margin:6px 0;">or</div>
          <label class="btn secondary small" style="margin:0;">
            Browse file
            <input type="file" accept="image/*" data-field="image" style="display:none;">
          </label>
        </div>
        `}
        <label style="display:block; font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--ink-soft); margin:10px 0 6px;">Options — mark the correct one</label>
        ${[0,1,2,3].map(oi=>`
          <div class="opt-row">
            <input type="radio" name="correct-${i}" data-field="correct" value="${oi}" ${q.correct===oi?'checked':''}>
            <div class="letter">${String.fromCharCode(65+oi)}</div>
            <input type="text" data-field="opt${oi}" value="${escapeHtml(q.options[oi]||'')}" placeholder="Option ${String.fromCharCode(65+oi)}">
          </div>
        `).join('')}
      </div>
    `).join('');

    app.innerHTML = `
      ${topbar('Builder', 'app_cancelBuilder()')}
      <div class="panel">
        <h2 class="section-title">${builder.title || builder.questions.length ? 'Edit test' : 'New test'}</h2>
        <div class="field-row">
          <div class="field" style="flex:2;">
            <label>Test title</label>
            <input id="b-title" value="${escapeHtml(builder.title)}" placeholder="e.g. NEET Full Mock 1">
          </div>
          <div class="field">
            <label>Duration (minutes)</label>
            <input id="b-duration" type="number" min="1" value="${builder.duration}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Marks per correct answer</label>
            <input id="b-marks-correct" type="number" step="0.25" value="${builder.marksCorrect}">
          </div>
          <div class="field">
            <label>Negative marking</label>
            <select id="b-neg-toggle">
              <option value="yes" ${builder.negativeMarking?'selected':''}>Yes</option>
              <option value="no" ${!builder.negativeMarking?'selected':''}>No</option>
            </select>
          </div>
          <div class="field" style="${builder.negativeMarking?'':'display:none;'}" id="neg-marks-field">
            <label>Marks deducted per wrong answer</label>
            <input id="b-marks-wrong" type="number" step="0.25" value="${builder.marksWrong}">
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Show result to students after they submit</label>
            <select id="b-show-result-toggle">
              <option value="yes" ${builder.showResultToStudent===true?'selected':''}>Yes — score &amp; answer review</option>
              <option value="no" ${builder.showResultToStudent!==true?'selected':''}>No — just confirm submission</option>
            </select>
          </div>
        </div>
        <div class="helper" style="margin:-6px 0 16px;">${builder.showResultToStudent!==true ? 'Students will only see "Your test has been submitted." Scores are still saved and visible to you under Results.' : 'Students see their score and full answer review immediately after submitting.'}</div>

        <div id="q-list">${qBlocks || '<div class="helper" style="margin:16px 0;">No questions yet. Add your first question below, or import many at once from a CSV file.</div>'}</div>

        <div style="display:flex; gap:10px; margin-top:6px; flex-wrap:wrap;">
          <button class="btn secondary" onclick="app_addQ()">+ Add question</button>
          <label class="btn secondary" style="margin:0;">
            Import from CSV
            <input type="file" accept=".csv,text/csv" id="csv-import-input" style="display:none;">
          </label>
          <button class="btn secondary" onclick="app_downloadCsvTemplate()">Download CSV template</button>
        </div>
        <div class="helper" style="margin-top:8px;">CSV columns: Subject, Question, OptionA, OptionB, OptionC, OptionD, CorrectOption (A/B/C/D), ImageURL (optional, a public image link).</div>

        <div style="margin-top:24px; border-top:1px solid var(--line); padding-top:18px; display:flex; gap:10px;">
          <button class="btn" onclick="app_saveTest()">Save test</button>
          <button class="btn secondary" onclick="app_cancelBuilder()">Cancel</button>
        </div>
      </div>
    `;

    document.getElementById('b-title').oninput = e=> builder.title = e.target.value;
    document.getElementById('b-duration').oninput = e=> builder.duration = parseInt(e.target.value)||1;
    document.getElementById('b-marks-correct').oninput = e=> builder.marksCorrect = parseFloat(e.target.value)||0;
    const wrongField = document.getElementById('b-marks-wrong');
    if(wrongField) wrongField.oninput = e=> builder.marksWrong = parseFloat(e.target.value)||0;
    document.getElementById('b-neg-toggle').onchange = e=>{ builder.negativeMarking = e.target.value==='yes'; renderBuilder(); };
    document.getElementById('b-show-result-toggle').onchange = e=>{ builder.showResultToStudent = e.target.value==='yes'; renderBuilder(); };

    const qList = document.getElementById('q-list');
    if(qList){
      qList.addEventListener('input', onQFieldChange);
      qList.addEventListener('change', onQFieldChange);
      qList.addEventListener('dragover', (e)=>{
        const zone = e.target.closest('.image-dropzone');
        if(zone){ e.preventDefault(); zone.classList.add('drag-over'); }
      });
      qList.addEventListener('dragleave', (e)=>{
        const zone = e.target.closest('.image-dropzone');
        if(zone) zone.classList.remove('drag-over');
      });
      qList.addEventListener('drop', (e)=>{
        const zone = e.target.closest('.image-dropzone');
        if(!zone) return;
        e.preventDefault();
        zone.classList.remove('drag-over');
        const block = e.target.closest('.q-block');
        const i = parseInt(block.dataset.qi);
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        if(file) handleImageFile(i, file);
      });
      qList.querySelectorAll('[data-field="removeImage"]').forEach(btn=>{
        btn.onclick = (e)=>{
          const i = parseInt(e.target.closest('.q-block').dataset.qi);
          builder.questions[i].image = null;
          renderBuilder();
        };
      });
    }
    const csvInput = document.getElementById('csv-import-input');
    if(csvInput) csvInput.onchange = onCsvFileChosen;
  }

  // Uploads a question image to Google Drive (via Apps Script) and stores the
  // resulting link — used by both drag-and-drop and the "Browse file" fallback.
  async function handleImageFile(i, file){
    if(!file.type.startsWith('image/')){ showModal('Not an image', 'Please choose an image file (JPG, PNG, etc).', true); return; }
    if(file.size > 5*1024*1024){ showModal('Image too large', 'Please use an image under 5MB.', true); return; }
    const zone = document.querySelector(`.q-block[data-qi="${i}"] .image-dropzone`);
    if(zone) zone.innerHTML = '<div class="loading-row" style="padding:6px 0;"><span class="spinner"></span><span class="helper">Uploading…</span></div>';
    const reader = new FileReader();
    reader.onload = async ()=>{
      try{
        const base64 = reader.result.split(',')[1];
        const data = await apiCall('uploadImage', { filename: file.name, mimeType: file.type, data: base64 }, 30000);
        builder.questions[i].image = data.url;
      }catch(e){
        showError(e);
      }
      renderBuilder();
    };
    reader.onerror = ()=>{ showModal('Couldn\'t read that file', 'Please try again.', true); renderBuilder(); };
    reader.readAsDataURL(file);
  }

  /* ============ CSV IMPORT ============ */
  const CSV_HEADERS = ['Subject','Question','OptionA','OptionB','OptionC','OptionD','CorrectOption','ImageURL'];

  function parseCSV(text){
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for(let i=0;i<text.length;i++){
      const c = text[i], next = text[i+1];
      if(inQuotes){
        if(c==='"' && next==='"'){ field+='"'; i++; }
        else if(c==='"'){ inQuotes=false; }
        else field += c;
      } else {
        if(c==='"'){ inQuotes = true; }
        else if(c===','){ row.push(field); field=''; }
        else if(c==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
        else if(c==='\r'){ /* skip, \n handles the line break */ }
        else field += c;
      }
    }
    if(field.length>0 || row.length>0){ row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => f.trim() !== ''));
  }

  function onCsvFileChosen(e){
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        importQuestionsFromCsv(reader.result);
      }catch(err){
        alert('Could not read that CSV: ' + err.message);
      }
      e.target.value = '';
    };
    reader.readAsText(file);
  }

  function importQuestionsFromCsv(text){
    const rows = parseCSV(text);
    if(rows.length < 2){ alert('That CSV has no question rows below the header.'); return; }
    const header = rows[0].map(h=>h.trim().toLowerCase());
    const idx = {
      subject: header.indexOf('subject'),
      question: header.indexOf('question'),
      a: header.indexOf('optiona'),
      b: header.indexOf('optionb'),
      c: header.indexOf('optionc'),
      d: header.indexOf('optiond'),
      correct: header.indexOf('correctoption'),
      image: header.indexOf('imageurl')
    };
    if(idx.question<0 || idx.a<0 || idx.b<0 || idx.c<0 || idx.d<0 || idx.correct<0){
      alert('That CSV is missing required columns. Expected: ' + CSV_HEADERS.join(', '));
      return;
    }
    const correctMap = {A:0,B:1,C:2,D:3};
    let imported = 0;
    const skipped = [];
    for(let r=1;r<rows.length;r++){
      const row = rows[r];
      const text = (row[idx.question]||'').trim();
      if(!text) continue;
      const opts = [row[idx.a], row[idx.b], row[idx.c], row[idx.d]].map(v=>(v||'').trim());
      const correctLetter = (row[idx.correct]||'').trim().toUpperCase();
      const correct = correctMap[correctLetter];
      if(opts.some(o=>!o) || correct===undefined){
        skipped.push(`Row ${r+1}: ${text.slice(0,40) || '(blank question)'}`);
        continue;
      }
      builder.questions.push({
        id: uid(),
        subject: idx.subject>=0 ? (row[idx.subject]||'').trim() : '',
        text,
        image: idx.image>=0 && (row[idx.image]||'').trim() ? (row[idx.image]||'').trim() : null,
        options: opts,
        correct
      });
      imported++;
    }
    renderBuilder();
    let msg = `Imported ${imported} question${imported!==1?'s':''}.`;
    if(skipped.length) msg += `\n\nSkipped ${skipped.length} row(s) with missing options or an invalid CorrectOption letter:\n` + skipped.slice(0,10).join('\n') + (skipped.length>10?'\n…':'');
    alert(msg);
  }

  window.app_downloadCsvTemplate = function(){
    const exampleRow = ['Physics','Example: What is the SI unit of force?','Newton','Joule','Watt','Pascal','A',''];
    const csvRows = [CSV_HEADERS, exampleRow];
    const csvText = csvRows.map(r => r.map(csvEscape).join(',')).join('\r\n');
    downloadTextFile(csvText, 'question-upload-template.csv', 'text/csv');
  };
  function csvEscape(field){
    field = String(field);
    if(/[",\n]/.test(field)) return '"' + field.replace(/"/g,'""') + '"';
    return field;
  }
  function downloadTextFile(text, filename, mime){
    const blob = new Blob([text], {type: mime});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function onQFieldChange(e){
    const block = e.target.closest('.q-block');
    if(!block) return;
    const i = parseInt(block.dataset.qi);
    const field = e.target.dataset.field;
    const q = builder.questions[i];
    if(!field) return;
    if(field==='subject'){ q.subject = e.target.value; }
    else if(field==='text'){ q.text = e.target.value; }
    else if(field.startsWith('opt')){ q.options[parseInt(field.slice(3))] = e.target.value; }
    else if(field==='correct'){ q.correct = parseInt(e.target.value); }
    else if(field==='image'){
      const file = e.target.files[0];
      if(file) handleImageFile(i, file);
    }
  }

  window.app_addQ = function(){
    builder.questions.push({ id: uid(), subject:'', text:'', image:null, options:['','','',''], correct:null });
    renderBuilder();
    setTimeout(()=>{
      const blocks = document.querySelectorAll('.q-block');
      const last = blocks[blocks.length-1];
      if(last) last.scrollIntoView({behavior:'smooth', block:'center'});
    },30);
  };
  window.app_removeQ = function(i){ builder.questions.splice(i,1); renderBuilder(); };
  window.app_cancelBuilder = function(){ builder=null; window.app_goTeacher(); };
  window.app_saveTest = async function(){
    if(!builder.title.trim()){ alert('Give the test a title first.'); return; }
    if(builder.questions.length===0){ alert('Add at least one question before saving.'); return; }
    for(let i=0;i<builder.questions.length;i++){
      const q = builder.questions[i];
      if(!q.text.trim()){ alert(`Question ${i+1} needs question text.`); return; }
      if(q.options.some(o=>!o.trim())){ alert(`Question ${i+1} needs all four options filled in.`); return; }
      if(q.correct===null || q.correct===undefined){ alert(`Question ${i+1} needs a correct answer marked.`); return; }
    }
    if(!builder.negativeMarking) builder.marksWrong = 0;
    builder.updatedAt = Date.now();
    if(!builder.createdAt) builder.createdAt = Date.now();
    setLoading('Saving…');
    try{ await apiCall('saveTest', builder); }catch(e){ showError(e); }
    builder = null;
    await window.app_goTeacher();
  };

  /* ============ STUDENT ENTRY ============ */
  function renderStudentEntry(){
    app.innerHTML = `
      ${topbar('Student', forcedRole==='student' ? null : 'app_backToRole()')}
      <div class="panel" style="max-width:460px; margin:0 auto;">
        <h2 class="section-title">Enter the test</h2>
        <div class="field" style="margin-bottom:14px;">
          <label>Your name</label>
          <input id="s-name" placeholder="Full name">
        </div>
        <div class="field" style="margin-bottom:14px;">
          <label>Roll number / ID (optional)</label>
          <input id="s-roll" placeholder="e.g. 21B045">
        </div>
        <div class="field" style="margin-bottom:18px;">
          <label>Test code</label>
          <input id="s-code" placeholder="Code from your teacher">
        </div>
        <button class="btn" id="s-continue-btn" onclick="app_lookupTest()">Continue</button>
        <div id="s-error" class="helper" style="color:var(--red); margin-top:10px;"></div>
      </div>
    `;
  }
  window.app_lookupTest = async function(){
    const name = document.getElementById('s-name').value.trim();
    const roll = document.getElementById('s-roll').value.trim();
    const code = document.getElementById('s-code').value.trim();
    const errEl = document.getElementById('s-error');
    const btn = document.getElementById('s-continue-btn');
    errEl.textContent='';
    if(!name){ errEl.textContent='Enter your name to continue.'; return; }
    if(!code){ errEl.textContent='Enter the test code your teacher gave you.'; return; }
    if(btn){ btn.disabled = true; btn.innerHTML = '<span class="btn-spinner"></span>Checking…'; }
    try{
      const [testData, progressData] = await Promise.all([
        apiCall('getTestForStudent', {id: code}),
        apiCall('getProgress', {testId: code, studentName: name, rollNo: roll}).catch(()=>({progress:null}))
      ]);
      studentTest = testData.test;
      studentInfo = {name, rollNo: roll};
      resumedProgress = progressData.progress || null;
      view='student-rules'; render();
    }catch(e){
      errEl.textContent = e.message;
      if(btn){ btn.disabled = false; btn.innerHTML = 'Continue'; }
    }
  };

  /* ============ STUDENT RULES / LOCKDOWN NOTICE ============ */
  function renderStudentRules(){
    app.innerHTML = `
      ${topbar('Before you begin')}
      <div class="panel" style="max-width:560px; margin:0 auto;">
        <h2 class="section-title">${escapeHtml(studentTest.title)}</h2>
        <div class="meta-row" style="margin-bottom:18px;">
          <span>${studentTest.questions.length} questions</span>
          <span>${studentTest.duration} minutes</span>
          <span>+${studentTest.marksCorrect}${studentTest.marksWrong>0?' / −'+studentTest.marksWrong:''} marking</span>
        </div>
        ${resumedProgress ? `<div class="helper" style="background:var(--gold-soft); border:1px solid var(--gold); border-radius:var(--radius); padding:10px 12px; margin-bottom:16px;">You have an in-progress attempt for this test — your answers so far will be restored and the timer will continue from your original start time.</div>` : ''}
        <ul class="rules-list">
          <li>This test opens in <strong>fullscreen</strong> and stays locked until you submit.</li>
          <li>Exiting fullscreen or switching tabs/apps is <strong>detected and logged</strong> for your teacher to see.</li>
          <li>After ${MAX_VIOLATIONS} such warnings, the test <strong>submits automatically</strong>.</li>
          <li>Right-click and copy/paste are disabled during the test.</li>
          <li>The timer auto-submits your test when it reaches zero.</li>
          <li>Your answers are <strong>saved automatically</strong> as you go — closing the tab by accident won't lose your progress.</li>
        </ul>
        <button class="btn" id="s-begin-btn" onclick="app_beginTest()">${resumedProgress?'Resume test (fullscreen)':'Begin test (fullscreen)'}</button>
      </div>
    `;
  }

  window.app_beginTest = async function(){
    const btn = document.getElementById('s-begin-btn');
    if(btn){ btn.disabled = true; btn.innerHTML = '<span class="btn-spinner"></span>Starting…'; }
    const el = document.documentElement;
    try{
      if(el.requestFullscreen) await el.requestFullscreen();
      else if(el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    }catch(e){ /* proceed even if fullscreen is denied; violation tracking still runs */ }

    const startedAt = resumedProgress ? resumedProgress.startedAt : Date.now();
    const initialStatus = resumedProgress ? resumedProgress.status : studentTest.questions.map(()=> 'not-visited');
    const initialSelected = resumedProgress ? resumedProgress.answers : studentTest.questions.map(()=> null);
    let startIdx = initialStatus.findIndex(s=> s==='not-visited' || s==='not-answered');
    if(startIdx<0) startIdx = 0;

    attempt = {
      test: studentTest,
      status: initialStatus,
      selected: initialSelected,
      current: startIdx,
      startedAt,
      endAt: startedAt + studentTest.duration*60000,
      timer: null,
      violations: resumedProgress ? (resumedProgress.violations||0) : 0,
      submitting: false
    };
    if(attempt.status[attempt.current]==='not-visited') attempt.status[attempt.current] = 'not-answered';
    resumedProgress = null;
    setupAntiCheat();

    if(attempt.endAt <= Date.now()){
      view='player'; render();
      submitAttemptFlow(true, false);
      return;
    }
    view='player';
    render();
    startTimer();
  };

  /* ============ PROGRESS AUTOSAVE ============ */
  let progressSaveTimer = null;
  function scheduleSaveProgress(immediate){
    if(!attempt || attempt.submitting) return;
    if(progressSaveTimer) clearTimeout(progressSaveTimer);
    const doSave = ()=>{
      apiCall('saveProgress', {
        testId: attempt.test.id, studentName: studentInfo.name, rollNo: studentInfo.rollNo,
        answers: attempt.selected, status: attempt.status, violations: attempt.violations, startedAt: attempt.startedAt
      }).catch(()=>{ /* silent — next change will retry the save */ });
    };
    if(immediate) doSave();
    else progressSaveTimer = setTimeout(doSave, 1200);
  }
  window.addEventListener('beforeunload', function(){
    if(view==='player' && attempt && !attempt.submitting && API_URL.indexOf('PASTE_YOUR')!==0){
      const body = JSON.stringify({ action:'saveProgress', payload:{
        testId: attempt.test.id, studentName: studentInfo.name, rollNo: studentInfo.rollNo,
        answers: attempt.selected, status: attempt.status, violations: attempt.violations, startedAt: attempt.startedAt
      }});
      navigator.sendBeacon(API_URL, new Blob([body], {type:'text/plain'}));
    }
  });

  /* ============ ANTI-CHEAT ============ */
  function setupAntiCheat(){
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('contextmenu', blockDefault);
    document.addEventListener('copy', blockDefault);
    document.addEventListener('cut', blockDefault);
  }
  function teardownAntiCheat(){
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    document.removeEventListener('contextmenu', blockDefault);
    document.removeEventListener('copy', blockDefault);
    document.removeEventListener('cut', blockDefault);
  }
  function blockDefault(e){ if(view==='player') e.preventDefault(); }
  function onVisibilityChange(){
    if(document.hidden && view==='player' && !attempt.submitting) registerViolation('You switched tabs or minimized the window.');
  }
  function onFullscreenChange(){
    const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    if(!inFs && view==='player' && !attempt.submitting) registerViolation('You exited fullscreen mode.');
  }
  function registerViolation(msg){
    attempt.violations++;
    scheduleSaveProgress(true);
    showViolationOverlay(msg, attempt.violations);
    if(attempt.violations >= MAX_VIOLATIONS) submitAttemptFlow(false, true);
  }
  function showViolationOverlay(msg,count){
    let el = document.getElementById('violation-overlay');
    if(!el) return;
    el.querySelector('.v-msg').textContent = msg;
    el.querySelector('.v-count').textContent = count>=MAX_VIOLATIONS ? 'Limit reached — submitting your test now.' : `Warning ${count} of ${MAX_VIOLATIONS}. Reaching ${MAX_VIOLATIONS} auto-submits your test.`;
    el.style.display='flex';
  }
  window.app_resumeFullscreen = function(){
    const el = document.documentElement;
    if(el.requestFullscreen) el.requestFullscreen().catch(()=>{});
    const ov = document.getElementById('violation-overlay');
    if(ov) ov.style.display='none';
  };

  /* ============ TIMER ============ */
  function startTimer(){
    if(attempt.timer) clearInterval(attempt.timer);
    attempt.timer = setInterval(()=>{
      const remain = (attempt.endAt - Date.now())/1000;
      if(remain<=0){ clearInterval(attempt.timer); submitAttemptFlow(true, false); return; }
      updateTimerDisplay(remain);
    },1000);
  }
  function updateTimerDisplay(remain){
    const elT = document.getElementById('timer-display');
    if(!elT) return;
    elT.textContent = fmtTime(remain);
    const box = document.getElementById('timer-box');
    if(box) box.classList.toggle('critical', remain<=60);
  }

  /* ============ PLAYER ============ */
  function renderPlayer(){
    const t = attempt.test;
    const qi = attempt.current;
    const q = t.questions[qi];
    const sel = attempt.selected[qi];

    const optionsHtml = q.options.map((opt,oi)=>`
      <div class="bubble-opt ${sel===oi?'selected':''}" onclick="app_selectOption(${oi})">
        <div class="bubble">${String.fromCharCode(65+oi)}</div>
        <div class="opt-text">${escapeHtml(opt)}</div>
      </div>
    `).join('');

    const remainSec = (attempt.endAt - Date.now())/1000;

    const subjects = [...new Set(t.questions.map(x=>x.subject||'General'))];
    let paletteHtml = '';
    subjects.forEach(subj=>{
      paletteHtml += `<div class="subject-jump">${escapeHtml(subj)}</div><div class="qgrid">`;
      t.questions.forEach((qq,i)=>{
        if((qq.subject||'General')!==subj) return;
        const st = attempt.status[i];
        const cur = i===qi ? 'current' : '';
        paletteHtml += `<button class="qbtn ${st} ${cur}" onclick="app_goTo(${i})">${i+1}</button>`;
      });
      paletteHtml += `</div>`;
    });

    app.innerHTML = `
      <div id="violation-overlay" class="violation-overlay">
        <div class="violation-box">
          <h3>⚠ Activity flagged</h3>
          <div class="v-msg"></div>
          <div class="v-count" style="margin:10px 0 16px;"></div>
          <button class="btn" onclick="app_resumeFullscreen()">Resume test (fullscreen)</button>
        </div>
      </div>
      <div class="player-head">
        <div class="ptitle">${escapeHtml(t.title)}</div>
        <div id="timer-box" class="timer-box ${remainSec<=60?'critical':''}"><span id="timer-display" class="mono">${fmtTime(remainSec)}</span></div>
        <button class="btn danger small" onclick="app_confirmSubmit()">Submit test</button>
      </div>
      <div class="player-grid">
        <div class="qpanel">
          <div class="qmeta">
            <span>Question ${qi+1} of ${t.questions.length}</span>
            <span>${escapeHtml(q.subject||'General')} · +${t.marksCorrect}${t.marksWrong>0 ? ' / −'+t.marksWrong : ''}</span>
          </div>
          <div class="qtext">${escapeHtml(q.text)}</div>
          ${q.image ? `<img class="qimg" src="${q.image}" alt="question image">` : ''}
          ${optionsHtml}
          <div class="nav-buttons">
            <button class="btn secondary" onclick="app_prev()" ${qi===0?'disabled':''}>Previous</button>
            <button class="btn secondary" onclick="app_clearResponse()">Clear response</button>
            <button class="btn secondary" onclick="app_markReview()">Mark for review &amp; next</button>
            <button class="btn" onclick="app_saveNext()">Save &amp; next</button>
          </div>
        </div>
        <div class="palette-panel">
          <div class="legend">
            <div class="legend-item"><div class="legend-dot" style="background:var(--paper-dim); border-color:var(--line);"></div>Not visited</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--red-soft);"></div>Not answered</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--green-soft);"></div>Answered</div>
            <div class="legend-item"><div class="legend-dot" style="background:var(--gold-soft);"></div>Marked</div>
          </div>
          ${paletteHtml}
        </div>
      </div>
    `;
  }

  window.app_selectOption = function(oi){
    attempt.selected[attempt.current] = oi;
    const st = attempt.status[attempt.current];
    attempt.status[attempt.current] = st==='marked' ? 'answered-marked' : 'answered';
    scheduleSaveProgress(false);
    renderPlayer();
  };
  window.app_clearResponse = function(){
    attempt.selected[attempt.current] = null;
    attempt.status[attempt.current] = 'not-answered';
    scheduleSaveProgress(false);
    renderPlayer();
  };
  window.app_markReview = function(){
    const hasAns = attempt.selected[attempt.current]!==null;
    attempt.status[attempt.current] = hasAns ? 'answered-marked' : 'marked';
    scheduleSaveProgress(false);
    moveNext();
  };
  window.app_saveNext = function(){
    if(attempt.status[attempt.current]==='not-visited' && attempt.selected[attempt.current]===null){
      attempt.status[attempt.current]='not-answered';
    }
    scheduleSaveProgress(false);
    moveNext();
  };
  function moveNext(){
    if(attempt.current < attempt.test.questions.length-1){
      attempt.current++;
      if(attempt.status[attempt.current]==='not-visited') attempt.status[attempt.current]='not-answered';
    }
    renderPlayer();
  }
  window.app_prev = function(){ if(attempt.current>0){ attempt.current--; renderPlayer(); } };
  window.app_goTo = function(i){
    attempt.current = i;
    if(attempt.status[i]==='not-visited') attempt.status[i]='not-answered';
    renderPlayer();
  };
  window.app_confirmSubmit = function(){
    const unanswered = attempt.status.filter(s=>s==='not-visited'||s==='not-answered'||s==='marked').length;
    const msg = unanswered>0 ? `You have ${unanswered} unanswered question(s). Submit the test anyway?` : 'Submit the test now?';
    if(confirm(msg)) submitAttemptFlow(false, false);
  };

  async function submitAttemptFlow(timedOut, autoSubmittedForViolations){
    if(attempt.submitting) return;
    attempt.submitting = true;
    if(attempt.timer) clearInterval(attempt.timer);
    teardownAntiCheat();
    if(document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(()=>{});
    if(progressSaveTimer) clearTimeout(progressSaveTimer);

    const timeTakenSec = (Date.now()-attempt.startedAt)/1000;
    setLoading('Submitting your test…');
    try{
      const data = await apiCall('submitAttempt', {
        testId: attempt.test.id,
        studentName: studentInfo.name,
        rollNo: studentInfo.rollNo,
        answers: attempt.selected,
        violations: attempt.violations,
        timeTakenSec
      });
      resultData = data.result;
      resultData.test = attempt.test;
      resultData.timedOut = timedOut;
      resultData.autoSubmittedForViolations = autoSubmittedForViolations;
      reviewFilter='all';
      view='result';
      render();
    }catch(e){
      // IMPORTANT: don't discard `attempt` here — answers are still safe (they were
      // autosaved as the student worked, and remain in memory too). Let them retry.
      attempt.submitting = false;
      lastSubmitError = e.message;
      lastSubmitMeta = {timedOut, autoSubmittedForViolations};
      view = 'submit-error';
      render();
    }
  }

  let lastSubmitError = '';
  let lastSubmitMeta = null;
  function renderSubmitError(){
    app.innerHTML = `
      ${topbar('Submission issue')}
      <div class="panel" style="max-width:520px; margin:0 auto; text-align:center;">
        <h2 class="section-title" style="color:var(--red);">Couldn't submit just yet</h2>
        <div class="helper" style="margin:12px 0 18px;">${escapeHtml(lastSubmitError)}</div>
        <div class="helper" style="margin-bottom:20px;">Don't worry — none of your answers are lost. They've been saved automatically as you worked through the test.</div>
        <button class="btn" onclick="app_retrySubmit()">Retry submit</button>
      </div>
    `;
  }
  window.app_retrySubmit = function(){
    attempt.submitting = false;
    submitAttemptFlow(lastSubmitMeta.timedOut, lastSubmitMeta.autoSubmittedForViolations);
  };

  /* ============ RESULT (student view, server-scored) ============ */
  function renderResult(){
    const r = resultData;

    if(r.hidden){
      app.innerHTML = `
        ${topbar('Submitted')}
        <div class="panel" style="max-width:480px; margin:0 auto; text-align:center;">
          <h2 class="section-title">Your test has been submitted</h2>
          <div class="helper" style="margin:12px 0 4px;">${escapeHtml(r.testTitle||'')}</div>
          <div class="helper" style="margin-top:14px;">Your teacher has chosen not to show scores immediately. They'll share your result with you separately.</div>
          <div class="top-actions" style="margin-top:22px; justify-content:center;">
            <button class="btn secondary" onclick="app_backToRole()">Done</button>
          </div>
        </div>
      `;
      return;
    }

    const subjRows = Object.entries(r.perSubject).map(([name,s])=>`
      <tr>
        <td>${escapeHtml(name)}</td><td>${s.total}</td><td>${s.correct}</td><td>${s.wrong}</td><td>${s.unattempted}</td><td class="mono">${s.marks}</td>
      </tr>
    `).join('');

    const filters = [{k:'all', l:'All'}, {k:'correct', l:'Correct'}, {k:'wrong', l:'Wrong'}, {k:'skip', l:'Skipped'}];
    const filterHtml = filters.map(f=>`<button class="btn secondary small ${reviewFilter===f.k?'active':''}" onclick="app_setFilter('${f.k}')">${f.l}</button>`).join('');

    const items = r.perQuestion.filter(pq => reviewFilter==='all' || pq.status===reviewFilter);
    const reviewHtml = items.map(pq=>{
      const yourAns = pq.sel===null||pq.sel===undefined ? 'Not attempted' : `${String.fromCharCode(65+pq.sel)}. ${escapeHtml(pq.options[pq.sel])}`;
      const correctAns = `${String.fromCharCode(65+pq.correct)}. ${escapeHtml(pq.options[pq.correct])}`;
      const pillClass = pq.status==='correct'?'correct':pq.status==='wrong'?'wrong':'skip';
      const pillLabel = pq.status==='correct'?'Correct':pq.status==='wrong'?'Wrong':'Skipped';
      return `
        <div class="review-item">
          <div class="review-item-head">
            <strong>Q${pq.i+1}. ${escapeHtml(pq.subject||'General')}</strong>
            <span class="status-pill ${pillClass}">${pillLabel}</span>
          </div>
          <div>${escapeHtml(pq.text)}</div>
          ${pq.image ? `<img class="qimg" src="${pq.image}" style="max-height:140px; margin-top:8px;">` : ''}
          <div class="ans-line"><span class="lbl">Your answer:</span>${yourAns}</div>
          ${pq.status!=='correct' ? `<div class="ans-line"><span class="lbl">Correct answer:</span>${correctAns}</div>` : ''}
        </div>
      `;
    }).join('');

    app.innerHTML = `
      ${topbar('Result')}
      ${r.autoSubmittedForViolations ? `<div class="helper" style="color:var(--red); margin-bottom:14px;">Your test was auto-submitted after repeated fullscreen/tab warnings.</div>` : ''}
      ${r.timedOut ? `<div class="helper" style="margin-bottom:14px;">Time ran out — your test was submitted automatically.</div>`:''}
      <div class="score-hero">
        <div>
          <div class="score-num">${r.score} <span style="font-size:20px; opacity:0.7;">/ ${r.total}</span></div>
          <div class="score-sub">${escapeHtml(r.test.title)}</div>
        </div>
        <div class="stat-strip">
          <div class="stat"><div class="n">${r.correct}</div><div class="l">Correct</div></div>
          <div class="stat"><div class="n">${r.wrong}</div><div class="l">Wrong</div></div>
          <div class="stat"><div class="n">${r.unattempted}</div><div class="l">Unattempted</div></div>
          <div class="stat"><div class="n">${fmtTime(r.timeTakenSec)}</div><div class="l">Time taken</div></div>
        </div>
      </div>
      <h2 class="section-title">Subject-wise breakdown</h2>
      <table class="subj-table">
        <thead><tr><th>Subject</th><th>Total</th><th>Correct</th><th>Wrong</th><th>Unattempted</th><th>Marks</th></tr></thead>
        <tbody>${subjRows}</tbody>
      </table>
      <h2 class="section-title">Answer review</h2>
      <div class="filter-row">${filterHtml}</div>
      ${reviewHtml || '<div class="helper">No questions match this filter.</div>'}
      <div class="top-actions" style="margin-top:22px;">
        <button class="btn secondary" onclick="app_backToRole()">Done</button>
      </div>
    `;
  }
  window.app_setFilter = function(k){ reviewFilter=k; renderResult(); };

  function studentLinkUrl(){
    return `${window.location.origin}${window.location.pathname}?${STUDENT_LINK_KEY}=${STUDENT_LINK_VALUE}`;
  }

  /* ============ INIT ============ */
  (function init(){
    injectDiagnosticsFooter();
    const params = new URLSearchParams(window.location.search);
    const r = params.get('role');
    const isStudentLink = params.get(STUDENT_LINK_KEY) === STUDENT_LINK_VALUE || r==='student';
    if(isStudentLink){ forcedRole='student'; window.app_goStudentEntry(); }
    else if(r==='teacher'){ window.app_goTeacher(); }
    else { render(); }
  })();

  // Always-visible version stamp + one-click backend health check, so you never
  // have to guess whether a new upload is actually live or whether Google is reachable.
  function injectDiagnosticsFooter(){
    const el = document.createElement('div');
    el.id = 'diag-footer';
    el.innerHTML = `<span class="mono">${APP_VERSION}</span><button type="button" onclick="app_testConnection(this)">Test connection</button>`;
    document.body.appendChild(el);
  }
  window.app_testConnection = async function(btn){
    const original = btn ? btn.textContent : null;
    if(btn){ btn.textContent = 'Testing…'; btn.disabled = true; }
    const lines = [];
    // Test 1: GET (doGet)
    try{
      const controller = new AbortController();
      const timeoutId = setTimeout(()=>controller.abort(), 10000);
      const res = await fetch(API_URL, { method:'GET', signal: controller.signal });
      clearTimeout(timeoutId);
      const text = await res.text();
      lines.push(`<strong>GET (doGet):</strong> HTTP ${res.status} — ${res.ok ? '✅ reachable' : '⚠ unexpected status'}`);
      lines.push(`<div class="mono" style="font-size:12px; white-space:pre-wrap; margin:4px 0 12px;">${escapeHtml(text.slice(0,300))}</div>`);
    }catch(e){
      const reason = e.name==='AbortError' ? 'Timed out after 10s — Google never responded.' : e.message;
      lines.push(`<strong>GET (doGet):</strong> ❌ Failed — ${escapeHtml(reason)}`);
    }
    // Test 2: POST (doPost, the pathway saveTest/getResults etc. actually use)
    try{
      const controller = new AbortController();
      const timeoutId = setTimeout(()=>controller.abort(), 10000);
      const res = await fetch(API_URL, { method:'POST', body: JSON.stringify({action:'listTestsForTeacher', payload:{}}), signal: controller.signal });
      clearTimeout(timeoutId);
      const text = await res.text();
      let ok = false, preview = text;
      try{ const j = JSON.parse(text); ok = !j.error; preview = JSON.stringify(j).slice(0,200); }catch(e){}
      lines.push(`<strong>POST (doPost):</strong> HTTP ${res.status} — ${ok ? '✅ working correctly' : '⚠ responded, but with an error/unexpected body'}`);
      lines.push(`<div class="mono" style="font-size:12px; white-space:pre-wrap; margin:4px 0;">${escapeHtml(preview)}</div>`);
    }catch(e){
      const reason = e.name==='AbortError' ? 'Timed out after 10s — Google never responded.' : e.message;
      lines.push(`<strong>POST (doPost):</strong> ❌ Failed — ${escapeHtml(reason)}`);
    }
    showModal('Connection test', lines.join(''));
    if(btn){ btn.textContent = original; btn.disabled = false; }
  };
})();
