(function(){
  "use strict";

  /* ============ STATE ============ */
  let view = 'loading';
  let tests = [];              // [{id, title, ...}]
  let resultHistory = {};      // testId -> [{score,total,date}]
  let builder = null;          // {id, title, duration, marksCorrect, marksWrong, questions:[]}
  let attempt = null;          // active test-taking state
  let resultData = null;       // computed result for result view
  let reviewFilter = 'all';
  let knownSubjects = [];

  const app = document.getElementById('app');

  /* ============ STORAGE HELPERS (browser localStorage) ============ */
  async function loadTests(){
    tests = [];
    try{
      for(let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if(k && k.startsWith('test:')){
          try{ tests.push(JSON.parse(localStorage.getItem(k))); }catch(e){}
        }
      }
    }catch(e){}
    tests.sort((a,b)=> (b.createdAt||0) - (a.createdAt||0));
    knownSubjects = [...new Set(tests.flatMap(t=>t.questions.map(q=>q.subject).filter(Boolean)))];
  }

  async function loadResultHistory(testId){
    try{
      const raw = localStorage.getItem('result:'+testId);
      return raw ? JSON.parse(raw) : [];
    }catch(e){ return []; }
  }

  async function saveTest(t){
    localStorage.setItem('test:'+t.id, JSON.stringify(t));
  }
  async function deleteTestStorage(id){
    try{ localStorage.removeItem('test:'+id); }catch(e){}
    try{ localStorage.removeItem('result:'+id); }catch(e){}
  }
  async function appendResult(testId, record){
    let hist = await loadResultHistory(testId);
    hist.unshift(record);
    hist = hist.slice(0,20);
    localStorage.setItem('result:'+testId, JSON.stringify(hist));
    return hist;
  }

  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }
  function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtTime(totalSec){
    totalSec = Math.max(0,Math.round(totalSec));
    const h = Math.floor(totalSec/3600), m = Math.floor((totalSec%3600)/60), s = totalSec%60;
    if(h>0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  /* ============ ROUTER / RENDER ============ */
  async function goHome(){
    view = 'home';
    await loadTests();
    render();
  }

  function render(){
    if(view==='loading'){ app.innerHTML = `<div class="helper">Loading your tests…</div>`; return; }
    if(view==='home') return renderHome();
    if(view==='builder') return renderBuilder();
    if(view==='player') return renderPlayer();
    if(view==='result') return renderResult();
  }

  /* ============ HOME ============ */
  function renderHome(){
    const cards = tests.map(t=>{
      const subjects = [...new Set(t.questions.map(q=>q.subject).filter(Boolean))];
      const best = t._bestScore;
      return `
      <div class="test-card">
        <div class="serial">TEST ID · ${t.id.toUpperCase()}</div>
        <h3>${escapeHtml(t.title)}</h3>
        <div class="meta-row">
          <span>${t.questions.length} question${t.questions.length!==1?'s':''}</span>
          <span>${t.duration} min</span>
          <span>${subjects.length ? escapeHtml(subjects.join(', ')) : 'No subjects tagged'}</span>
        </div>
        <div class="best-score" data-best-slot="${t.id}"></div>
        <div class="card-actions">
          <button class="btn small" onclick="app_startTest('${t.id}')" ${t.questions.length===0?'disabled':''}>Start test</button>
          <button class="btn secondary small" onclick="app_editTest('${t.id}')">Edit</button>
          <button class="btn danger small" onclick="app_deleteTest('${t.id}')">Delete</button>
        </div>
      </div>`;
    }).join('');

    app.innerHTML = `
      <div class="topbar">
        <div class="brand"><span class="display">Test Portal</span><span class="tag">Practice · Timed · Scored</span></div>
      </div>
      <div class="home-head">
        <div>
          <h2 class="section-title">Your tests</h2>
          <div class="helper">Build a custom test with your own subjects and questions, then take it under exam conditions.</div>
        </div>
        <button class="btn" onclick="app_newTest()">+ New test</button>
      </div>
      ${tests.length===0 ? `
        <div class="empty-state">
          <h3>No tests yet</h3>
          <div>Create your first test — add questions by typing them out, or paste in text from a screenshot.</div>
          <div style="margin-top:16px;"><button class="btn" onclick="app_newTest()">+ New test</button></div>
        </div>
      ` : `<div class="card-grid">${cards}</div>`}
    `;

    // fill in best-score asynchronously
    tests.forEach(async t=>{
      const hist = await loadResultHistory(t.id);
      const slot = app.querySelector(`[data-best-slot="${t.id}"]`);
      if(!slot) return;
      if(hist.length===0){ slot.textContent=''; return; }
      const best = hist.reduce((a,b)=> b.score>a.score?b:a, hist[0]);
      slot.textContent = `Best: ${best.score}/${best.total} · Last attempt ${hist[0].score}/${hist[0].total}`;
    });
  }

  window.app_newTest = function(){
    builder = { id: uid(), title:'', duration:60, marksCorrect:4, marksWrong:1, negativeMarking:true, questions:[], createdAt: Date.now() };
    view='builder'; render();
  };
  window.app_editTest = function(id){
    const t = tests.find(x=>x.id===id);
    builder = JSON.parse(JSON.stringify(t));
    if(builder.negativeMarking===undefined) builder.negativeMarking = builder.marksWrong>0;
    view='builder'; render();
  };
  window.app_deleteTest = async function(id){
    if(!confirm('Delete this test? This cannot be undone.')) return;
    await deleteTestStorage(id);
    await goHome();
  };
  window.app_startTest = async function(id){
    const t = tests.find(x=>x.id===id);
    if(!t || t.questions.length===0) return;
    attempt = {
      testId: t.id,
      test: t,
      status: t.questions.map(()=> 'not-visited'),
      selected: t.questions.map(()=> null),
      current: 0,
      startedAt: Date.now(),
      endAt: Date.now() + t.duration*60000,
      timer: null
    };
    attempt.status[0] = 'not-answered';
    view='player';
    render();
    startTimer();
  };

  /* ============ BUILDER ============ */
  function renderBuilder(){
    const subjOptions = knownSubjects.map(s=>`<option value="${escapeHtml(s)}">`).join('');
    const qBlocks = builder.questions.map((q,i)=>`
      <div class="q-block" data-qi="${i}">
        <div class="q-block-head">
          <span class="qnum">QUESTION ${i+1}</span>
          <button class="btn danger small" onclick="app_removeQ(${i})">Remove</button>
        </div>
        <div class="field" style="margin-bottom:10px;">
          <label>Subject</label>
          <input list="subj-list" class="subject-tag-input" data-field="subject" value="${escapeHtml(q.subject||'')}" placeholder="e.g. Physics">
        </div>
        <label style="display:block; font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--ink-soft); margin-bottom:6px;">Question text</label>
        <textarea data-field="text" placeholder="Type or paste the question text here…">${escapeHtml(q.text||'')}</textarea>
        <div class="img-row">
          <label class="btn secondary small" style="margin:0;">
            Attach image
            <input type="file" accept="image/*" data-field="image" style="display:none;">
          </label>
          ${q.image ? `<img src="${q.image}" alt="question image"><button class="btn danger small" data-field="removeImage">Remove image</button>` : `<span>Optional — for a diagram or screenshot</span>`}
        </div>
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
      <div class="topbar">
        <div class="brand"><span class="display">Test Portal</span><span class="tag">Builder</span></div>
        <button class="btn secondary small" onclick="app_cancelBuilder()">← Back</button>
      </div>
      <div class="panel">
        <h2 class="section-title">${builder.questions.length || builder.title ? 'Edit test' : 'New test'}</h2>
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

        <datalist id="subj-list">${subjOptions}</datalist>

        <div id="q-list">${qBlocks || '<div class="helper" style="margin:16px 0;">No questions yet. Add your first question below — type it out, or type up what you see in a screenshot.</div>'}</div>

        <div style="display:flex; gap:10px; margin-top:6px;">
          <button class="btn secondary" onclick="app_addQ()">+ Add question</button>
        </div>

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
    document.getElementById('b-neg-toggle').onchange = e=>{
      builder.negativeMarking = e.target.value==='yes';
      renderBuilder();
    };

    const qList = document.getElementById('q-list');
    if(qList){
      qList.addEventListener('input', onQFieldChange);
      qList.addEventListener('change', onQFieldChange);
      qList.querySelectorAll('[data-field="removeImage"]').forEach(btn=>{
        btn.onclick = (e)=>{
          const i = parseInt(e.target.closest('.q-block').dataset.qi);
          builder.questions[i].image = null;
          renderBuilder();
        };
      });
    }
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
      if(file){
        const reader = new FileReader();
        reader.onload = ()=>{ q.image = reader.result; renderBuilder(); };
        reader.readAsDataURL(file);
      }
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
  window.app_removeQ = function(i){
    builder.questions.splice(i,1);
    renderBuilder();
  };
  window.app_cancelBuilder = function(){
    builder = null; goHome();
  };
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
    await saveTest(builder);
    builder = null;
    await goHome();
  };

  /* ============ PLAYER ============ */
  function startTimer(){
    if(attempt.timer) clearInterval(attempt.timer);
    attempt.timer = setInterval(()=>{
      const remain = (attempt.endAt - Date.now())/1000;
      if(remain<=0){
        clearInterval(attempt.timer);
        submitAttempt(true);
        return;
      }
      updateTimerDisplay(remain);
    },1000);
  }
  function updateTimerDisplay(remain){
    const el = document.getElementById('timer-display');
    if(!el) return;
    el.textContent = fmtTime(remain);
    const box = document.getElementById('timer-box');
    if(box) box.classList.toggle('critical', remain<=60);
  }

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

    // palette
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
    renderPlayer();
  };
  window.app_clearResponse = function(){
    attempt.selected[attempt.current] = null;
    attempt.status[attempt.current] = 'not-answered';
    renderPlayer();
  };
  window.app_markReview = function(){
    const hasAns = attempt.selected[attempt.current]!==null;
    attempt.status[attempt.current] = hasAns ? 'answered-marked' : 'marked';
    moveNext();
  };
  window.app_saveNext = function(){
    if(attempt.status[attempt.current]==='not-visited' && attempt.selected[attempt.current]===null){
      attempt.status[attempt.current]='not-answered';
    }
    moveNext();
  };
  function moveNext(){
    if(attempt.current < attempt.test.questions.length-1){
      attempt.current++;
      if(attempt.status[attempt.current]==='not-visited') attempt.status[attempt.current]='not-answered';
    }
    renderPlayer();
  }
  window.app_prev = function(){
    if(attempt.current>0){
      attempt.current--;
      renderPlayer();
    }
  };
  window.app_goTo = function(i){
    attempt.current = i;
    if(attempt.status[i]==='not-visited') attempt.status[i]='not-answered';
    renderPlayer();
  };
  window.app_confirmSubmit = function(){
    const unanswered = attempt.status.filter(s=>s==='not-visited'||s==='not-answered'||s==='marked').length;
    const msg = unanswered>0
      ? `You have ${unanswered} unanswered question(s). Submit the test anyway?`
      : 'Submit the test now?';
    if(confirm(msg)) submitAttempt(false);
  };

  async function submitAttempt(timedOut){
    if(attempt.timer) clearInterval(attempt.timer);
    const t = attempt.test;
    let correct=0, wrong=0, unattempted=0, marks=0;
    const perSubject = {};
    const perQuestion = [];

    t.questions.forEach((q,i)=>{
      const subj = q.subject || 'General';
      if(!perSubject[subj]) perSubject[subj] = {total:0, correct:0, wrong:0, unattempted:0, marks:0};
      perSubject[subj].total++;
      const sel = attempt.selected[i];
      let status;
      if(sel===null || sel===undefined){
        unattempted++; perSubject[subj].unattempted++;
        status='skip';
      } else if(sel===q.correct){
        correct++; marks+=t.marksCorrect; perSubject[subj].correct++; perSubject[subj].marks+=t.marksCorrect;
        status='correct';
      } else {
        wrong++; marks-=t.marksWrong; perSubject[subj].wrong++; perSubject[subj].marks-=t.marksWrong;
        status='wrong';
      }
      perQuestion.push({i, q, sel, status, marked: attempt.status[i]==='marked'||attempt.status[i]==='answered-marked'});
    });

    const totalPossible = t.questions.length * t.marksCorrect;
    const timeTakenSec = (Date.now()-attempt.startedAt)/1000;

    resultData = {
      test: t, correct, wrong, unattempted, marks, totalPossible,
      perSubject, perQuestion, timeTakenSec, timedOut
    };

    const record = { score: marks, total: totalPossible, date: Date.now(), correct, wrong, unattempted };
    await appendResult(t.id, record);

    reviewFilter='all';
    view='result';
    render();
  }

  /* ============ RESULT ============ */
  function renderResult(){
    const r = resultData;
    const subjRows = Object.entries(r.perSubject).map(([name,s])=>`
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${s.total}</td>
        <td>${s.correct}</td>
        <td>${s.wrong}</td>
        <td>${s.unattempted}</td>
        <td class="mono">${s.marks}</td>
      </tr>
    `).join('');

    const filters = [
      {k:'all', l:'All'}, {k:'correct', l:'Correct'}, {k:'wrong', l:'Wrong'}, {k:'skip', l:'Skipped'}
    ];
    const filterHtml = filters.map(f=>`<button class="btn secondary small ${reviewFilter===f.k?'active':''}" onclick="app_setFilter('${f.k}')">${f.l}</button>`).join('');

    const items = r.perQuestion.filter(pq => reviewFilter==='all' || pq.status===reviewFilter);
    const reviewHtml = items.map(pq=>{
      const q = pq.q;
      const yourAns = pq.sel===null||pq.sel===undefined ? 'Not attempted' : `${String.fromCharCode(65+pq.sel)}. ${escapeHtml(q.options[pq.sel])}`;
      const correctAns = `${String.fromCharCode(65+q.correct)}. ${escapeHtml(q.options[q.correct])}`;
      const pillClass = pq.status==='correct'?'correct':pq.status==='wrong'?'wrong':'skip';
      const pillLabel = pq.status==='correct'?'Correct':pq.status==='wrong'?'Wrong':'Skipped';
      return `
        <div class="review-item">
          <div class="review-item-head">
            <strong>Q${pq.i+1}. ${escapeHtml(q.subject||'General')}</strong>
            <span class="status-pill ${pillClass}">${pillLabel}${pq.marked?' · Marked':''}</span>
          </div>
          <div>${escapeHtml(q.text)}</div>
          ${q.image ? `<img class="qimg" src="${q.image}" style="max-height:140px; margin-top:8px;">` : ''}
          <div class="ans-line"><span class="lbl">Your answer:</span>${yourAns}</div>
          ${pq.status!=='correct' ? `<div class="ans-line"><span class="lbl">Correct answer:</span>${correctAns}</div>` : ''}
        </div>
      `;
    }).join('');

    app.innerHTML = `
      <div class="topbar">
        <div class="brand"><span class="display">Test Portal</span><span class="tag">Result</span></div>
        <button class="btn secondary small" onclick="app_backHome()">← Back to home</button>
      </div>
      ${r.timedOut ? `<div class="helper" style="margin-bottom:14px;">Time ran out — your test was submitted automatically.</div>`:''}
      <div class="score-hero">
        <div>
          <div class="score-num">${r.marks} <span style="font-size:20px; opacity:0.7;">/ ${r.totalPossible}</span></div>
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
        <button class="btn" onclick="app_retake('${r.test.id}')">Retake test</button>
        <button class="btn secondary" onclick="app_backHome()">Back to home</button>
      </div>
    `;
  }
  window.app_setFilter = function(k){ reviewFilter=k; renderResult(); };
  window.app_backHome = async function(){ resultData=null; attempt=null; await goHome(); };
  window.app_retake = async function(id){
    resultData=null;
    await window.app_startTest(id);
  };

  /* ============ INIT ============ */
  goHome();
})();
