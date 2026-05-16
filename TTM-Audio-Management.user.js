// ==UserScript==
// @name         🎧 TTM Audiobook Manager
// @namespace    https://tieuthuyetmang.com/
// @version      5.3.0
// @description  Audiobook downloader with ID3 tagging, chapter selection before download, and selection-aware reset
// @author       GLM
// @match        https://tieuthuyetmang.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const DB_KEY = 'ttm_manager_db';
  const SETTINGS_KEY = 'ttm_manager_settings';

  function getDB() { try { return JSON.parse(GM_getValue(DB_KEY, '{}')); } catch { return {}; } }
  function saveDB(db) { GM_setValue(DB_KEY, JSON.stringify(db)); }
  function safeId(str) { return Array.from(str).map(c => c.charCodeAt(0).toString(16)).join(''); }

  function sanitizePath(str) {
    if (!str) return '';
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9\s.]/g, '').replace(/\s+/g, ' ').trim();
  }

  // ─── ID3 TAG WRITER ────────────────────────────────────────────────────────
  let ID3Writer = null;
  let ID3LoadError = null;

  async function loadID3Writer() {
    if (ID3Writer) return;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/browser-id3-writer@6/+esm');
      if (mod.ID3Writer) { ID3Writer = mod.ID3Writer; }
      else if (mod.default) { ID3Writer = mod.default; }
      else { throw new Error('ID3Writer not found in module export'); }
    } catch (e) {
      ID3LoadError = e.message;
      try {
        const mod2 = await import('https://unpkg.com/browser-id3-writer@6/src/ID3Writer.mjs');
        if (mod2.ID3Writer) { ID3Writer = mod2.ID3Writer; }
        else if (mod2.default) { ID3Writer = mod2.default; }
        ID3LoadError = null;
      } catch (e2) {
        ID3LoadError = 'jsdelivr: ' + e.message + ' | unpkg: ' + e2.message;
      }
    }
  }

  // ─── AUTHOR EXTRACTION ─────────────────────────────────────────────────────
  function findAuthorInJson(obj, depth = 0) {
    if (!obj || depth > 12) return null;
    if (typeof obj === 'string') { if (obj.includes('/tac-gia/')) return obj; }
    if (Array.isArray(obj)) { for (const item of obj) { const r = findAuthorInJson(item, depth + 1); if (r) return r; } return null; }
    if (typeof obj === 'object') {
      const prioKeys = ['author', 'authorName', 'tacGia', 'authors'];
      for (const k of prioKeys) { if (obj[k]) { const r = findAuthorInJson(obj[k], depth + 1); if (r) return r; } }
      for (const k of Object.keys(obj)) { if (prioKeys.includes(k)) continue; try { const r = findAuthorInJson(obj[k], depth + 1); if (r) return r; } catch {} }
    }
    return null;
  }

  function extractAuthorFromHTMLString(htmlString) {
    const regex1 = /<a[^>]*href="[^"]*\/tac-gia\/[^"]*"[^>]*>(.*?)<\/a>/;
    let match = htmlString.match(regex1);
    const regex2 = /T\u00e1c gi\u1ea3:\s*<\/span><a[^>]*>(.*?)<\/a>/;
    if (!match) match = htmlString.match(regex2);
    if (match && match[1]) return match[1].trim().replace(/[\\/:*?"<>|]/g, '_');
    const nextDataRegex = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
    const nextMatch = htmlString.match(nextDataRegex);
    if (nextMatch && nextMatch[1]) {
      try {
        const json = JSON.parse(nextMatch[1]);
        const authorData = findAuthorInJson(json);
        if (authorData) {
          if (typeof authorData === 'string' && authorData.includes('/tac-gia/')) {
            const parts = authorData.split('/').filter(Boolean);
            const slug = parts[parts.length - 1];
            return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/[\\/:*?"<>|]/g, '_');
          }
          return String(authorData).trim().replace(/[\\/:*?"<>|]/g, '_');
        }
      } catch (e) {}
    }
    return 'Unknown_Author';
  }

  function getAuthorFromDOM() {
    const spans = document.querySelectorAll('span.font-medium');
    for (const span of spans) {
      if (span.textContent.includes('T\u00e1c gi\u1ea3:')) {
        if (span.nextElementSibling && span.nextElementSibling.tagName === 'A') return span.nextElementSibling.textContent.trim().replace(/[\\/:*?"<>|]/g, '_');
        const parentLink = span.closest('span').querySelector('a[href*="/tac-gia/"]');
        if (parentLink) return parentLink.textContent.trim().replace(/[\\/:*?"<>|]/g, '_');
      }
    }
    const authorEl = document.querySelector('a[href*="/tac-gia/"]') || document.querySelector('.author') || document.querySelector('[itemprop="author"]');
    if (authorEl) return authorEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '_');
    return null;
  }

  try { GM_registerMenuCommand('🎧 Open TTM Manager', () => { window.open('https://tieuthuyetmang.com/#ttm-dashboard', '_blank'); }); } catch (e) {}

  // ─── BOOK PAGE LOGIC ───────────────────────────────────────────────────────
  if (location.hash !== '#ttm-dashboard') {
    const style = document.createElement('style');
    style.textContent = '#ttm-page-actions{position:fixed!important;bottom:28px!important;right:28px!important;z-index:2147483647!important;display:flex!important;flex-direction:column!important;gap:12px!important}.ttm-page-btn{width:52px!important;height:52px!important;border-radius:50%!important;display:flex!important;align-items:center!important;justify-content:center!important;text-decoration:none!important;border:2px solid rgba(255,255,255,.18)!important;cursor:pointer!important;font-size:24px!important;box-shadow:0 4px 24px rgba(0,0,0,.6)!important;transition:transform .15s,box-shadow .2s!important;color:#fff!important;line-height:1!important;font-family:"Segoe UI Emoji",sans-serif!important}.ttm-page-btn:hover{transform:scale(1.1)!important;box-shadow:0 6px 36px rgba(0,0,0,.8)!important}.ttm-btn-queue{background:linear-gradient(135deg,#30c97a,#1a8a4a)!important}.ttm-btn-dash{background:linear-gradient(135deg,#e8a020,#9b6c0e)!important}';
    document.head.appendChild(style);

    function injectUI() {
      if (document.getElementById('ttm-page-actions')) return;
      const container = document.createElement('div'); container.id = 'ttm-page-actions';
      const queueBtn = document.createElement('button'); queueBtn.id = 'ttm-queue-btn'; queueBtn.className = 'ttm-page-btn ttm-btn-queue'; queueBtn.textContent = '➕'; queueBtn.title = 'Add this book to TTM Queue';
      const dashBtn = document.createElement('a'); dashBtn.id = 'ttm-dash-btn'; dashBtn.className = 'ttm-page-btn ttm-btn-dash'; dashBtn.href = 'https://tieuthuyetmang.com/#ttm-dashboard'; dashBtn.target = '_blank'; dashBtn.title = 'Open TTM Manager Dashboard'; dashBtn.innerHTML = '🎧';
      container.appendChild(queueBtn); container.appendChild(dashBtn); document.body.appendChild(container);
    }
    setInterval(() => { if (!document.body.contains(document.getElementById('ttm-page-actions'))) injectUI(); }, 1000);

    function clickAudioTab() { const buttons = document.querySelectorAll('button'); for (const btn of buttons) { if (btn.textContent.includes('🎧 Audio')) { btn.click(); return true; } } return false; }

    function scrapeEpisodesFromDOM() {
      const eps = []; const seen = new Set(); const listContainer = document.querySelector('ul.divide-y');
      if (listContainer) {
        listContainer.querySelectorAll(':scope > li').forEach((li, idx) => {
          const linkEl = li.querySelector('a[href*="/nghe/"]'); const tEl = li.querySelector('span.truncate[title]') || li.querySelector('span.truncate');
          if (linkEl) {
            let href = linkEl.getAttribute('href'); if (!href || href === '#') return;
            const fullUrl = href.startsWith('http') ? href : 'https://tieuthuyetmang.com' + href;
            if (seen.has(fullUrl)) return; seen.add(fullUrl);
            let title = tEl ? (tEl.getAttribute('title') || tEl.textContent.trim()) : '';
            title = title.replace(/[\\/:*?"<>|]/g, '_').trim() || ('Tap_' + (idx + 1));
            // selected defaults to true; status awaiting-selection until user picks
            eps.push({ epNum: idx + 1, title: title, url: fullUrl, status: 'pending', selected: true });
          }
        });
      }
      return eps;
    }

    function saveEpsToDB(episodes, author) {
      const url = location.href.split('?')[0].split('#')[0]; const id = safeId(url); const db = getDB();
      if (db[id] && db[id].episodes.length > 0) return false;
      const titleEl = document.querySelector('h1'); const bookTitle = titleEl ? titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '_') : 'Unknown_Book';
      // status = 'awaiting-selection' so queue won't touch it until user picks chapters
      db[id] = { bookTitle, author, url, status: 'awaiting-selection', episodes }; saveDB(db); return true;
    }

    document.addEventListener('click', function(e) {
      if (e.target.closest('#ttm-queue-btn')) {
        const btn = document.getElementById('ttm-queue-btn'); if (!btn) return;
        btn.textContent = '⏳'; btn.style.pointerEvents = 'none';
        const currentAuthor = getAuthorFromDOM() || 'Unknown_Author';
        clickAudioTab();
        setTimeout(function() {
          const eps = scrapeEpisodesFromDOM();
          if (eps.length > 0) {
            const wasNew = saveEpsToDB(eps, currentAuthor); btn.textContent = '✅';
            if (wasNew) window.open('https://tieuthuyetmang.com/#ttm-dashboard', '_blank');
            setTimeout(function() { const b = document.getElementById('ttm-queue-btn'); if(b) { b.textContent = '➕'; b.style.pointerEvents = 'auto'; } }, 3000);
          } else { alert("Could not find episodes."); btn.textContent = '➕'; btn.style.pointerEvents = 'auto'; }
        }, 2000);
      }
    });
    injectUI(); return;
  }

  // ─── DASHBOARD ─────────────────────────────────────────────────────────────
  window.stop(); document.head.innerHTML = ''; document.body.style.margin = '0';
  document.body.innerHTML = '<div id="app"></div><div id="dbg-panel"><div class="dbg-header"><span>Debug Log</span><span class="dbg-close" id="dbg-close">✕</span></div><div id="dbg-log"></div></div>';

  // ─── CHAPTER SELECTOR MODAL ────────────────────────────────────────────────
  let modalEl = null;
  let modalBookId = null;
  let modalIsFirstTime = false; // true when opened for a brand-new awaiting-selection book

  function openChapterSelector(bookId, isFirstTime) {
    modalBookId = bookId;
    modalIsFirstTime = !!isFirstTime;
    const db = getDB();
    const book = db[bookId];
    if (!book) return;

    if (!modalEl) {
      modalEl = document.createElement('div');
      modalEl.id = 'ttm-modal-overlay';
      document.body.appendChild(modalEl);
    }

    const episodes = book.episodes;
    const totalEps = episodes.length;

    const epRowsHtml = episodes.map(ep => {
      const isDone    = ep.status === 'done';
      const isError   = ep.status === 'error';
      const isSkipped = ep.status === 'skipped';
      // For awaiting-selection books all are pending; check the `selected` flag
      // For already-started books, checked = not skipped
      const checked = isDone ? true : !isSkipped;
      const statusBadge = isDone
        ? '<span class="cs-badge cs-done">done</span>'
        : isError
          ? '<span class="cs-badge cs-error">error</span>'
          : isSkipped
            ? '<span class="cs-badge cs-skip">skipped</span>'
            : '<span class="cs-badge cs-pending">pending</span>';
      const shortTitle = ep.title.length > 48 ? ep.title.substring(0, 48) + '…' : ep.title;
      return `<label class="cs-ep-row${isDone ? ' cs-ep-done' : ''}">
        <input type="checkbox" class="cs-ep-cb" data-ep="${ep.epNum}" ${checked ? 'checked' : ''} ${isDone ? 'disabled title="Already downloaded"' : ''}>
        <span class="cs-ep-num">${String(ep.epNum).padStart(3, '0')}</span>
        <span class="cs-ep-title">${shortTitle}</span>
        ${statusBadge}
      </label>`;
    }).join('');

    const headerNote = isFirstTime
      ? '<div class="cs-first-note">Choose which chapters to download, then click <b>Start downloading</b>.</div>'
      : '';

    const saveLabel = isFirstTime ? '▶ Start downloading' : 'Save selection';

    modalEl.innerHTML = `
      <div class="cs-backdrop" id="cs-backdrop"></div>
      <div class="cs-modal" role="dialog" aria-modal="true" aria-label="Chapter selection">
        <div class="cs-header">
          <div>
            <div class="cs-book-title">${book.bookTitle}</div>
            <div class="cs-book-author">${book.author && book.author !== 'Unknown_Author' ? 'by ' + book.author : ''}</div>
          </div>
          ${isFirstTime ? '' : '<button class="cs-close" id="cs-close" title="Close">✕</button>'}
        </div>
        ${headerNote}
        <div class="cs-toolbar">
          <div class="cs-toolbar-left">
            <button class="cs-tb-btn" id="cs-select-all">Select All</button>
            <button class="cs-tb-btn" id="cs-deselect-all">Deselect All</button>
            <button class="cs-tb-btn" id="cs-select-pending">Pending only</button>
          </div>
          <div class="cs-range-row">
            <span class="cs-range-label">Range:</span>
            <input class="cs-range-input" type="number" id="cs-range-from" min="1" max="${totalEps}" placeholder="From" value="1">
            <span class="cs-range-sep">–</span>
            <input class="cs-range-input" type="number" id="cs-range-to" min="1" max="${totalEps}" placeholder="To" value="${totalEps}">
            <button class="cs-tb-btn cs-tb-apply" id="cs-apply-range">Apply</button>
          </div>
        </div>
        <div class="cs-ep-list" id="cs-ep-list">${epRowsHtml}</div>
        <div class="cs-footer">
          <span class="cs-sel-count" id="cs-sel-count"></span>
          <div class="cs-footer-btns">
            ${isFirstTime ? '' : '<button class="cs-btn-cancel" id="cs-btn-cancel">Cancel</button>'}
            <button class="cs-btn-save${isFirstTime ? ' cs-btn-start' : ''}" id="cs-btn-save">${saveLabel}</button>
          </div>
        </div>
      </div>`;

    modalEl.style.display = 'flex';
    updateSelCount();

    modalEl.querySelector('#cs-backdrop').addEventListener('click', () => { if (!isFirstTime) closeChapterSelector(); });
    const closeBtn = modalEl.querySelector('#cs-close');
    if (closeBtn) closeBtn.addEventListener('click', closeChapterSelector);
    const cancelBtn = modalEl.querySelector('#cs-btn-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeChapterSelector);
    modalEl.querySelector('#cs-btn-save').addEventListener('click', saveChapterSelection);
    modalEl.querySelector('#cs-select-all').addEventListener('click', () => setAllChecked(true));
    modalEl.querySelector('#cs-deselect-all').addEventListener('click', () => setAllChecked(false));
    modalEl.querySelector('#cs-select-pending').addEventListener('click', selectPendingOnly);
    modalEl.querySelector('#cs-apply-range').addEventListener('click', applyRange);
    modalEl.querySelectorAll('.cs-ep-cb').forEach(cb => cb.addEventListener('change', updateSelCount));
  }

  function closeChapterSelector() {
    if (modalEl) modalEl.style.display = 'none';
    modalBookId = null;
  }

  function updateSelCount() {
    const countEl = document.getElementById('cs-sel-count');
    if (!countEl) return;
    const cbs     = modalEl.querySelectorAll('.cs-ep-cb:not([disabled])');
    const checked = modalEl.querySelectorAll('.cs-ep-cb:checked:not([disabled])');
    countEl.textContent = checked.length + ' of ' + cbs.length + ' chapters selected';
  }

  function setAllChecked(val) {
    modalEl.querySelectorAll('.cs-ep-cb:not([disabled])').forEach(cb => { cb.checked = val; });
    updateSelCount();
  }

  function selectPendingOnly() {
    const db = getDB(); const book = db[modalBookId]; if (!book) return;
    modalEl.querySelectorAll('.cs-ep-cb:not([disabled])').forEach(cb => {
      const epNum = parseInt(cb.dataset.ep);
      const ep = book.episodes.find(e => e.epNum === epNum);
      cb.checked = ep && (ep.status === 'pending' || ep.status === 'skipped');
    });
    updateSelCount();
  }

  function applyRange() {
    const from = parseInt(document.getElementById('cs-range-from').value) || 1;
    const to   = parseInt(document.getElementById('cs-range-to').value)   || 9999;
    modalEl.querySelectorAll('.cs-ep-cb:not([disabled])').forEach(cb => {
      cb.checked = (parseInt(cb.dataset.ep) >= from && parseInt(cb.dataset.ep) <= to);
    });
    updateSelCount();
  }

  function saveChapterSelection() {
    if (!modalBookId) return;
    const db = getDB(); const book = db[modalBookId]; if (!book) return;
    const checkedNums = new Set();
    modalEl.querySelectorAll('.cs-ep-cb:checked').forEach(cb => checkedNums.add(parseInt(cb.dataset.ep)));

    if (checkedNums.size === 0) { showToast('Please select at least one chapter.'); return; }

    book.episodes.forEach(ep => {
      if (ep.status === 'done') {
        // Keep done flag but record selection for reset purposes
        ep.selected = checkedNums.has(ep.epNum);
        return;
      }
      const shouldDownload = checkedNums.has(ep.epNum);
      ep.selected = shouldDownload; // <── persisted for reset
      if (shouldDownload) {
        // Re-activate if it was skipped or stuck
        if (ep.status === 'skipped' || ep.status === 'error') ep.status = 'pending';
        // If status was already 'pending' (first-time or re-selection), keep it
      } else {
        ep.status = 'skipped';
      }
    });

    // Move book out of awaiting-selection into the active queue
    const anyPending = book.episodes.some(e => e.status === 'pending');
    book.status = anyPending ? 'pending' : 'completed';

    saveDB(db); renderUI();
    closeChapterSelector();

    if (modalIsFirstTime) {
      showToast('▶ ' + checkedNums.size + ' chapters queued — downloading will start shortly.');
      processQueue();
    } else {
      showToast(checkedNums.size + ' chapters selected for download.');
    }
  }

  const debugLog = []; let debugOpen = false; let isPaused = false;

  function getSettings() {
    try {
      const s = JSON.parse(GM_getValue(SETTINGS_KEY, '{"basePath":"TTM_Audiobooks","promptSave":false}'));
      if (typeof s.promptSave === 'undefined') s.promptSave = false;
      return s;
    } catch { return { basePath: 'TTM_Audiobooks', promptSave: false }; }
  }
  function saveSettings(s) { GM_setValue(SETTINGS_KEY, JSON.stringify(s)); }

  function mlog(msg, type) {
    type = type || 'info';
    const ts = new Date().toLocaleTimeString();
    debugLog.push({ ts, msg, type });
    if (debugLog.length > 150) debugLog.shift();
    console.log('[TTM-MGR ' + type.toUpperCase() + ']', msg);
    renderDebugLog();
  }

  mlog('[DEBUG] Dashboard loaded, preloading ID3Writer...');
  loadID3Writer().then(() => mlog('ID3Writer ready: ' + (ID3Writer ? 'YES' : 'NO')))
                 .catch(e => mlog('ID3Writer load failed: ' + e.message, 'error'));

  function gmFetch(url) {
    return new Promise(function(resolve, reject) {
      GM_xmlhttpRequest({ method: 'GET', url, headers: { 'Referer': 'https://tieuthuyetmang.com/' },
        onload: r => (r.status >= 200 && r.status < 400) ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)),
        onerror: e => reject(e), ontimeout: () => reject(new Error('Timeout')) });
    });
  }

  function gmFetchBinary(url) {
    mlog('[DEBUG] gmFetchBinary: ' + url.substring(0, 80) + '...');
    return new Promise(function(resolve, reject) {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'arraybuffer',
        headers: { 'Referer': 'https://tieuthuyetmang.com/' },
        onload: function(r) {
          if (r.status >= 200 && r.status < 400 && r.response && r.response.byteLength > 0) {
            resolve(r.response);
          } else {
            reject(new Error(r.response ? 'Empty response' : 'HTTP ' + r.status));
          }
        },
        onprogress: function(p) {
          if (p.lengthComputable) {
            const pct = Math.round((p.loaded / p.total) * 100);
            if (pct % 25 === 0 || pct === 100) mlog('[DEBUG] Download progress: ' + pct + '%');
          }
        },
        onerror: () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Timeout'))
      });
    });
  }

  function findAudioUrl(obj, depth) {
    depth = depth || 0;
    if (!obj || depth > 12) return null;
    if (typeof obj === 'string') { var m = obj.match(/(https?:\/\/[^\s"'<>]+\.(mp3|m4a|ogg|aac)(\?[^\s"'<>]*)?)/i); return m ? m[1] : null; }
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) { var r = findAudioUrl(obj[i], depth + 1); if (r) return r; } return null; }
    if (typeof obj === 'object') {
      var keys = Object.keys(obj);
      var prio = keys.filter(k => /audio|src|url|link|file|mp3|stream|source|media/i.test(k));
      var rest = keys.filter(k => !prio.includes(k));
      for (var k2 of prio.concat(rest)) { try { var r2 = findAudioUrl(obj[k2], depth + 1); if (r2) return r2; } catch(e) {} }
    }
    return null;
  }

  async function fetchBookDetailsViaNetwork(url) {
    mlog('Fetching book via network: ' + url);
    var html = await gmFetch(url);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var titleEl = doc.querySelector('h1');
    var bookTitle = titleEl ? titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '_') : 'Unknown_Book';
    var author = extractAuthorFromHTMLString(html);
    var episodes = []; var seenUrls = new Set();
    var regex = /href="([^"]*\/nghe\/[^"]*)"/g; var match;
    while ((match = regex.exec(html)) !== null) {
      var href = match[1]; var fullUrl = href.startsWith('http') ? href : 'https://tieuthuyetmang.com' + href;
      if (!seenUrls.has(fullUrl)) { seenUrls.add(fullUrl); episodes.push({ url: fullUrl }); }
    }
    var finalEps = []; var finalSeen = new Set();
    episodes.forEach(function(ep, idx) {
      if (!finalSeen.has(ep.url)) {
        finalSeen.add(ep.url);
        finalEps.push({ epNum: idx + 1, title: 'Tap_' + (idx + 1), url: ep.url, status: 'pending', selected: true });
      }
    });
    if (finalEps.length > 0) {
      doc.querySelectorAll('a[href*="/nghe/"]').forEach(function(a) {
        var href2 = a.getAttribute('href');
        var fullUrl2 = href2.startsWith('http') ? href2 : 'https://tieuthuyetmang.com' + href2;
        var ep2 = finalEps.find(e => e.url === fullUrl2);
        if (ep2) { var tEl = a.querySelector('span.truncate[title]') || a.querySelector('span'); if (tEl) { var t = tEl.getAttribute('title') || tEl.textContent.trim(); t = t.replace(/[\\/:*?"<>|]/g, '_').trim(); if (t) ep2.title = t; } }
      });
    }
    mlog('Found ' + finalEps.length + ' episodes. Author: ' + author);
    return { bookTitle, author, episodes: finalEps };
  }

  async function fetchAudioUrl(epUrl) {
    var html = await gmFetch(epUrl);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var audioEl = doc.querySelector('audio[src], audio source[src]');
    if (audioEl) { var s = audioEl.getAttribute('src'); if (s && !s.startsWith('blob:')) { if (s.startsWith('/')) s = 'https://tieuthuyetmang.com' + s; if (s.startsWith('http')) return s; } }
    var nd = doc.getElementById('__NEXT_DATA__'); if (nd) { try { var u = findAudioUrl(JSON.parse(nd.textContent)); if (u) return u; } catch(e) {} }
    var m = html.match(/(https?:\/\/[^\s"'<>]+\.(mp3|m4a|ogg|aac)(\?[^\s"'<>]*)?)/i); if (m) return m[1];
    throw new Error('Audio URL not found');
  }

  async function addBook(url) {
    var id = safeId(url); var db = getDB();
    if (db[id] && db[id].episodes.length > 0) {
      if (db[id].status === 'awaiting-selection') {
        showToast('Select chapters to begin downloading "' + db[id].bookTitle + '"');
        openChapterSelector(id, true);
      } else {
        db[id].status = 'pending'; db[id].episodes.forEach(ep => { if (ep.status === 'error') ep.status = 'pending'; });
        saveDB(db); renderUI(); showToast('Resuming "' + db[id].bookTitle + '"');
      }
      return;
    }
    db[id] = { bookTitle: 'Loading...', author: 'Unknown_Author', url, status: 'scanning', episodes: [] };
    saveDB(db); renderUI();
    try {
      var details = await fetchBookDetailsViaNetwork(url);
      details.url = url;
      details.status = 'awaiting-selection'; // ← always starts here
      db[id] = details; saveDB(db); renderUI();
      showToast('Book ready — please select chapters to download.');
      openChapterSelector(id, true);
    } catch (e) {
      mlog('Failed to fetch book: ' + e.message, 'error');
      var cur = getDB();
      if (cur[id]) { cur[id].status = 'error'; cur[id].bookTitle = 'Error fetching book'; saveDB(cur); renderUI(); }
      showToast('Failed to fetch book details.');
    }
  }

  function saveViaAnchor(blob, filenameOnly) {
    return new Promise(function(resolve) {
      var a = document.createElement('a'); var burl = URL.createObjectURL(blob);
      a.href = burl; a.download = filenameOnly; a.style.display = 'none';
      document.body.appendChild(a); a.click();
      setTimeout(function() { URL.revokeObjectURL(burl); document.body.removeChild(a); resolve(true); }, 1000);
    });
  }

  function tryGMDownloadBlob(blobUrl, filename, promptSave) {
    return new Promise(function(resolve) {
      try {
        GM_download({ url: blobUrl, name: filename, saveAs: promptSave,
          onload: () => resolve(true), onerror: () => resolve(false), ontimeout: () => resolve(false) });
      } catch(e) { resolve(false); }
    });
  }

  async function downloadWithTags(audioUrl, filename, promptSave, tags) {
    mlog('Downloading: ' + filename.split('/').pop());
    var arrayBuffer = await gmFetchBinary(audioUrl);
    await loadID3Writer();
    var taggedBlob;
    if (ID3Writer) {
      try {
        var writer = new ID3Writer(arrayBuffer);
        writer.setFrame('TALB', tags.album).setFrame('TPE1', [tags.artist]).setFrame('TPE2', tags.artist)
              .setFrame('TIT2', tags.title).setFrame('TRCK', tags.track)
              .setFrame('TCON', ['Audiobook']).setFrame('TYER', new Date().getFullYear());
        writer.addTag(); taggedBlob = writer.getBlob();
        mlog('ID3 tags injected: ' + tags.title);
      } catch (tagErr) {
        mlog('ID3 tag error: ' + tagErr.message + '. Saving without tags.', 'warn');
        taggedBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
      }
    } else {
      taggedBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
    }
    var blobUrl = URL.createObjectURL(taggedBlob);
    var gmWorked = await tryGMDownloadBlob(blobUrl, filename, promptSave);
    URL.revokeObjectURL(blobUrl);
    if (gmWorked) return;
    var parts = filename.split('/'); await saveViaAnchor(taggedBlob, parts[parts.length - 1]);
  }

  var isProcessing = false;
  async function processQueue() {
    if (isProcessing || isPaused) return;
    isProcessing = true;
    var db = getDB();

    // Reset stuck 'downloading' states
    var needsSave = false;
    for (var bookId of Object.keys(db)) {
      var book = db[bookId]; if (!book || !book.episodes) continue;
      for (var ep of book.episodes) {
        if (ep.status === 'downloading') { ep.status = 'pending'; needsSave = true; }
      }
      if (book.status === 'downloading' || book.status === 'scanning') { book.status = 'pending'; needsSave = true; }
    }
    if (needsSave) saveDB(db);

    outerLoop:
    for (var bookId2 of Object.keys(db)) {
      var book2 = db[bookId2];
      // Skip books that haven't had chapters selected yet
      if (!book2 || book2.status === 'completed' || book2.status === 'error'
          || book2.status === 'awaiting-selection' || book2.episodes.length === 0) continue;

      for (var ep2 of book2.episodes) {
        if (!getDB()[bookId2]) { isProcessing = false; return; }
        if (isPaused) { book2.status = 'paused'; saveDB(db); renderUI(); mlog('⏸️ Queue Paused.'); break outerLoop; }
        if (ep2.status === 'done' || ep2.status === 'error' || ep2.status === 'skipped') continue;

        if (ep2.status === 'pending') {
          var currentSettings = getSettings();
          book2.status = 'downloading'; ep2.status = 'downloading'; saveDB(db); renderUI();
          try {
            var audioUrl = await fetchAudioUrl(ep2.url);
            var ext = (audioUrl.match(/\.(mp3|m4a|ogg|aac)/i) || ['', 'mp3'])[1];
            var safeAuthor    = sanitizePath(book2.author || 'Unknown_Author');
            var safeBookTitle = sanitizePath(book2.bookTitle) || ('Book_' + bookId2);
            var safeEpTitle   = sanitizePath(ep2.title) || ('Tap_' + ep2.epNum);
            var filename = currentSettings.basePath + '/' + safeAuthor + '/' + safeBookTitle + '/' + String(ep2.epNum).padStart(3, '0') + ' - ' + safeEpTitle + '.' + ext;
            var selectedEps = book2.episodes.filter(e => e.selected !== false && e.status !== 'skipped');
            var totalSelected = selectedEps.length;
            var trackPos = selectedEps.filter(e => e.epNum <= ep2.epNum).length;
            await downloadWithTags(audioUrl, filename, currentSettings.promptSave, {
              album: book2.bookTitle, artist: book2.author || 'Unknown Author',
              title: ep2.title || ('Tap ' + ep2.epNum), track: trackPos + '/' + totalSelected
            });
            ep2.status = 'done';
          } catch (e) {
            ep2.status = 'error'; book2.status = 'error';
            mlog('Episode ' + ep2.epNum + ' failed: ' + e.message, 'error');
            saveDB(db); renderUI(); continue outerLoop;
          }
          if (!getDB()[bookId2]) { isProcessing = false; return; }
          book2.status = 'downloading'; saveDB(db); renderUI();
          await new Promise(r => setTimeout(r, 1500)); continue outerLoop;
        }
      }

      const nonSkipped = book2.episodes.filter(e => e.status !== 'skipped');
      if (nonSkipped.length === 0 || nonSkipped.every(e => e.status === 'done')) { book2.status = 'completed'; }
      else if (nonSkipped.some(e => e.status === 'error')) { book2.status = 'error'; }
      else { book2.status = 'pending'; }
      saveDB(db); renderUI();
    }
    isProcessing = false; renderUI();
  }
  setInterval(processQueue, 5000);

  // ─── CSS ──────────────────────────────────────────────────────────────────
  var CSS = "@import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}:root{--bg:#0a0a0f;--surface:#111118;--raised:#18181f;--border:rgba(255,255,255,0.07);--border-hi:rgba(255,255,255,0.13);--t1:#f0f0f5;--t2:#8888a0;--t3:#44445a;--gold:#e8a020;--gold-lo:rgba(232,160,32,0.1);--gold-md:rgba(232,160,32,0.22);--green:#30c97a;--green-lo:rgba(48,201,122,0.1);--green-md:rgba(48,201,122,0.2);--red:#f05858;--red-lo:rgba(240,88,88,0.1);--red-md:rgba(240,88,88,0.2);--blue:#5090f8;--blue-lo:rgba(80,144,248,0.1);--blue-md:rgba(80,144,248,0.2);--font:'Syne',system-ui,sans-serif;--mono:'DM Mono',monospace;--ease:cubic-bezier(0.16,1,0.3,1)}html,body{background:var(--bg);color:var(--t1);font-family:var(--font);min-height:100vh}#app{max-width:920px;margin:0 auto;padding:32px 28px 80px;transition:padding-bottom 0.3s var(--ease)}#app.debug-active{padding-bottom:260px}.nav{display:flex;align-items:center;justify-content:space-between;padding-bottom:24px;margin-bottom:32px;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:16px}.brand{display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit}.brand-icon{width:38px;height:38px;flex-shrink:0;border-radius:10px;border:1px solid var(--border-hi);background:var(--surface);display:flex;align-items:center;justify-content:center;color:var(--gold)}.brand-name{font-size:17px;font-weight:700;letter-spacing:-0.3px;line-height:1.2}.brand-sub{font-family:var(--mono);font-size:10px;color:var(--t2);letter-spacing:0.06em}.toolbar-pill{display:inline-flex;align-items:center;height:36px;border:1px solid var(--border);border-radius:9px;background:var(--surface);overflow:hidden}.pill-label{font-family:var(--mono);font-size:9px;letter-spacing:0.07em;color:var(--t3);padding:0 8px;white-space:nowrap;height:100%;display:flex;align-items:center}.pill-input{background:none;border:none;outline:none;color:var(--t1);font-family:var(--mono);font-size:11px;padding:0 8px;width:120px;border-right:1px solid var(--border);height:100%}.pill-btn{border:none;background:none;color:var(--t2);font-family:var(--font);font-size:13px;font-weight:600;padding:0 8px;height:100%;cursor:pointer;white-space:nowrap;transition:color 0.15s,background 0.15s;border-right:1px solid var(--border);text-decoration:none;display:inline-flex;align-items:center;gap:3px}.pill-btn:last-child{border-right:none}.pill-btn:hover{color:var(--gold);background:var(--gold-lo)}.pill-btn.active{color:var(--gold);background:var(--gold-lo)}.nav-hint{width:100%;font-family:var(--mono);font-size:8.5px;color:var(--t3);margin-top:4px;padding-left:2px;line-height:1.5}.nav-hint b{color:var(--t2);font-weight:600}.add-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px 22px;margin-bottom:28px}.add-label{font-family:var(--mono);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--t3);margin-bottom:12px}.add-row{display:flex;gap:10px}.url-input{flex:1;background:var(--bg);border:1px solid var(--border);border-radius:9px;padding:10px 14px;color:var(--t1);font-family:var(--font);font-size:13px;outline:none;transition:border-color 0.15s,box-shadow 0.15s}.url-input::placeholder{color:var(--t3);font-size:12px}.url-input:focus{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-lo)}.btn-add{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 18px;background:var(--gold);color:#000;font-family:var(--font);font-size:12px;font-weight:700;border:none;border-radius:9px;cursor:pointer;white-space:nowrap;transition:background 0.15s}.btn-add:hover{background:#c8880e}.lib-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}.lib-title{font-family:var(--mono);font-size:9.5px;letter-spacing:0.12em;text-transform:uppercase;color:var(--t3)}.lib-count{font-family:var(--mono);font-size:10px;color:var(--t3)}.book{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px 22px;margin-bottom:10px;transition:border-color 0.2s;animation:fadeUp 0.3s var(--ease) both}@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}.book:hover{border-color:var(--border-hi)}.book.is-awaiting{border-color:rgba(80,144,248,0.35)}.book.is-downloading,.book.is-paused{border-color:rgba(232,160,32,0.22)}.book.is-completed{border-color:rgba(48,201,122,0.18)}.book.is-error{border-color:rgba(240,88,88,0.18)}.book-top{display:flex;align-items:flex-start;gap:14px;margin-bottom:18px}.book-icon{width:40px;height:40px;flex-shrink:0;border-radius:9px;border:1px solid var(--border);background:var(--raised);display:flex;align-items:center;justify-content:center;color:var(--t3)}.book.is-awaiting .book-icon{color:var(--blue);border-color:var(--blue-md);background:var(--blue-lo)}.book.is-downloading .book-icon,.book.is-paused .book-icon{color:var(--gold);border-color:var(--gold-md);background:var(--gold-lo)}.book.is-completed .book-icon{color:var(--green);border-color:var(--green-md);background:var(--green-lo)}.book.is-error .book-icon{color:var(--red);border-color:var(--red-md);background:var(--red-lo)}.book-body{flex:1;min-width:0}.book-name{font-size:14px;font-weight:700;letter-spacing:-0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:6px}.book-author{font-size:11px;color:var(--t2);margin-bottom:6px}.book-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.badge{display:inline-flex;align-items:center;gap:5px;font-family:var(--mono);font-size:9.5px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid transparent;line-height:1.4}.badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}.badge-downloading{background:var(--gold-lo);color:var(--gold);border-color:var(--gold-md)}.badge-downloading .badge-dot{animation:blink 1.4s infinite ease-in-out}.badge-paused{background:var(--blue-lo);color:var(--blue);border-color:var(--blue-md)}.badge-completed{background:var(--green-lo);color:var(--green);border-color:var(--green-md)}.badge-scanning{background:var(--blue-lo);color:var(--blue);border-color:var(--blue-md)}.badge-scanning .badge-dot{animation:blink 1s infinite ease-in-out}.badge-error{background:var(--red-lo);color:var(--red);border-color:var(--red-md)}.badge-pending{background:var(--raised);color:var(--t2);border-color:var(--border)}.badge-awaiting-selection{background:var(--blue-lo);color:var(--blue);border-color:var(--blue-md)}@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}.ep-count{font-family:var(--mono);font-size:10px;color:var(--t2)}.book-actions{display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}.act-btn{display:inline-flex;align-items:center;gap:4px;background:none;border:1px solid var(--border-hi);color:var(--t2);border-radius:6px;font-family:var(--font);font-size:10px;font-weight:600;padding:4px 7px;cursor:pointer;transition:all 0.15s}.act-btn.act-sel{border-color:var(--blue-md);color:var(--blue)}.act-btn.act-sel:hover{background:var(--blue-lo)}.act-btn.act-sel-start{border-color:var(--blue-md);color:#fff;background:var(--blue)}.act-btn.act-sel-start:hover{background:#3070d8;border-color:#3070d8}.act-btn.act-err{border-color:var(--red-md);color:var(--red)}.act-btn.act-err:hover{background:var(--red-lo)}.act-btn.act-rst{border-color:var(--gold-md);color:var(--gold)}.act-btn.act-rst:hover{background:var(--gold-lo)}.act-btn.act-rm{border-color:var(--red-md);color:var(--red)}.act-btn.act-rm:hover{background:var(--red-lo)}.prog-wrap{margin-bottom:16px}.prog-track{height:2px;background:var(--raised);border-radius:999px;overflow:hidden;margin-bottom:7px}.prog-fill{height:100%;border-radius:999px;transition:width 0.6s var(--ease)}.prog-fill.dl{background:var(--gold)}.prog-fill.done{background:var(--green)}.prog-nums{display:flex;justify-content:space-between;font-family:var(--mono);font-size:9.5px;color:var(--t3);letter-spacing:0.05em;text-transform:uppercase}.awaiting-prompt{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:var(--blue-lo);border:1px solid var(--blue-md);margin-bottom:12px;cursor:pointer;transition:background 0.15s}.awaiting-prompt:hover{background:rgba(80,144,248,0.15)}.awaiting-prompt-icon{font-size:18px;flex-shrink:0}.awaiting-prompt-text{font-size:12px;color:var(--blue);font-weight:600}.awaiting-prompt-sub{font-size:10px;color:var(--t2);margin-top:2px;font-weight:400}.ep-pips{display:flex;flex-wrap:wrap;gap:3px}.ep-pip{width:9px;height:9px;border-radius:2px;cursor:default;flex-shrink:0;position:relative;transition:transform 0.12s}.ep-pip:hover{transform:scale(1.9);z-index:10}.ep-pip.ep-pending{background:var(--raised)}.ep-pip.ep-downloading{background:var(--gold);animation:blink 1.4s infinite ease-in-out}.ep-pip.ep-done{background:var(--green)}.ep-pip.ep-error{background:var(--red)}.ep-pip.ep-skipped{background:transparent;border:1px solid var(--t3)}.ep-pip::after{content:attr(data-tip);pointer-events:none;opacity:0;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--raised);color:var(--t1);font-family:var(--mono);font-size:10px;white-space:nowrap;padding:4px 8px;border-radius:6px;border:1px solid var(--border);transition:opacity 0.12s;z-index:20}.ep-pip:hover::after{opacity:1}.empty{text-align:center;padding:64px 24px;border:1px dashed var(--border);border-radius:14px;background:var(--surface)}.empty-icon{width:48px;height:48px;border-radius:12px;background:var(--raised);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--t3);margin:0 auto 16px}.empty h3{font-size:15px;font-weight:700;color:var(--t1);margin-bottom:6px}.empty p{font-size:12px;color:var(--t2);line-height:1.75}.toast{position:fixed;bottom:20px;right:20px;z-index:9999;background:var(--surface);border:1px solid var(--border-hi);border-radius:10px;padding:14px 20px;font-family:var(--font);font-size:13px;color:var(--t1);box-shadow:0 12px 40px rgba(0,0,0,0.6);opacity:0;transform:translateY(10px);transition:all 0.3s var(--ease)}.toast.show{opacity:1;transform:translateY(0)}#dbg-panel{position:fixed;bottom:0;left:0;right:0;height:240px;background:#050508;border-top:2px solid var(--gold);z-index:10000;display:none;flex-direction:column;padding:12px;font-family:var(--mono);box-shadow:0 -10px 40px rgba(0,0,0,0.8)}#dbg-panel.open{display:flex}.dbg-header{padding:4px 0 8px;color:var(--gold);font-size:10px;letter-spacing:0.12em;text-transform:uppercase;border-bottom:1px solid var(--border);margin-bottom:8px;display:flex;justify-content:space-between}.dbg-close{color:var(--t2);cursor:pointer}.dbg-close:hover{color:var(--t1)}#dbg-log{flex:1;overflow-y:auto;font-size:11px;line-height:1.5;color:var(--t2)}#dbg-log div.log-error{color:var(--red)}#dbg-log div.log-warn{color:var(--gold)}";

  var MODAL_CSS = `
    #ttm-modal-overlay{display:none;position:fixed;inset:0;z-index:2147483646;align-items:center;justify-content:center;padding:20px}
    .cs-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px)}
    .cs-modal{position:relative;background:#111118;border:1px solid rgba(255,255,255,0.13);border-radius:16px;width:100%;max-width:660px;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,0.9)}
    .cs-header{display:flex;align-items:flex-start;justify-content:space-between;padding:20px 22px 14px;border-bottom:1px solid rgba(255,255,255,0.07)}
    .cs-book-title{font-size:15px;font-weight:700;color:#f0f0f5;letter-spacing:-0.2px;margin-bottom:4px}
    .cs-book-author{font-size:11px;color:#8888a0}
    .cs-close{background:none;border:1px solid rgba(255,255,255,0.1);color:#8888a0;width:28px;height:28px;border-radius:7px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:color 0.15s,background 0.15s}
    .cs-close:hover{color:#f0f0f5;background:rgba(255,255,255,0.07)}
    .cs-first-note{padding:10px 22px;background:rgba(80,144,248,0.08);border-bottom:1px solid rgba(80,144,248,0.18);font-size:12px;color:#8aaeee;line-height:1.5}
    .cs-first-note b{color:#5090f8;font-weight:700}
    .cs-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px 22px;border-bottom:1px solid rgba(255,255,255,0.07);background:#0d0d14}
    .cs-toolbar-left{display:flex;gap:6px;flex-wrap:wrap}
    .cs-tb-btn{background:none;border:1px solid rgba(255,255,255,0.1);color:#8888a0;font-family:'Syne',system-ui,sans-serif;font-size:10px;font-weight:600;padding:5px 10px;border-radius:6px;cursor:pointer;transition:all 0.15s;white-space:nowrap}
    .cs-tb-btn:hover{color:#e8a020;border-color:rgba(232,160,32,0.4);background:rgba(232,160,32,0.08)}
    .cs-tb-apply{color:#5090f8;border-color:rgba(80,144,248,0.35)}
    .cs-tb-apply:hover{color:#5090f8;border-color:rgba(80,144,248,0.6);background:rgba(80,144,248,0.1)}
    .cs-range-row{display:flex;align-items:center;gap:6px}
    .cs-range-label{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:#44445a}
    .cs-range-input{background:#0a0a0f;border:1px solid rgba(255,255,255,0.1);color:#f0f0f5;font-family:'DM Mono',monospace;font-size:11px;padding:4px 8px;border-radius:6px;width:68px;outline:none;transition:border-color 0.15s}
    .cs-range-input:focus{border-color:rgba(80,144,248,0.6)}
    .cs-range-sep{color:#44445a;font-size:12px}
    .cs-ep-list{flex:1;overflow-y:auto;padding:10px 14px}
    .cs-ep-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:7px;cursor:pointer;transition:background 0.12s;user-select:none}
    .cs-ep-row:hover{background:rgba(255,255,255,0.04)}
    .cs-ep-row.cs-ep-done{opacity:0.55}
    .cs-ep-row input[type=checkbox]{width:15px;height:15px;flex-shrink:0;accent-color:#5090f8;cursor:pointer}
    .cs-ep-row input[type=checkbox][disabled]{cursor:not-allowed;accent-color:#30c97a}
    .cs-ep-num{font-family:'DM Mono',monospace;font-size:10px;color:#44445a;width:28px;flex-shrink:0;text-align:right}
    .cs-ep-title{flex:1;font-size:12px;color:#c0c0d8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cs-badge{font-family:'DM Mono',monospace;font-size:9px;letter-spacing:0.06em;text-transform:uppercase;padding:2px 7px;border-radius:999px;flex-shrink:0;border:1px solid transparent}
    .cs-done{background:rgba(48,201,122,0.1);color:#30c97a;border-color:rgba(48,201,122,0.2)}
    .cs-error{background:rgba(240,88,88,0.1);color:#f05858;border-color:rgba(240,88,88,0.2)}
    .cs-skip{background:rgba(255,255,255,0.04);color:#44445a;border-color:rgba(255,255,255,0.07)}
    .cs-pending{background:rgba(255,255,255,0.04);color:#8888a0;border-color:rgba(255,255,255,0.07)}
    .cs-footer{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-top:1px solid rgba(255,255,255,0.07);background:#0d0d14}
    .cs-sel-count{font-family:'DM Mono',monospace;font-size:10px;color:#8888a0}
    .cs-footer-btns{display:flex;gap:8px}
    .cs-btn-cancel{background:none;border:1px solid rgba(255,255,255,0.1);color:#8888a0;font-family:'Syne',system-ui,sans-serif;font-size:12px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer;transition:all 0.15s}
    .cs-btn-cancel:hover{color:#f0f0f5;background:rgba(255,255,255,0.07)}
    .cs-btn-save{background:#5090f8;color:#fff;font-family:'Syne',system-ui,sans-serif;font-size:12px;font-weight:700;padding:8px 18px;border-radius:8px;border:none;cursor:pointer;transition:background 0.15s}
    .cs-btn-save:hover{background:#3070d8}
    .cs-btn-start{background:#30c97a;color:#000}
    .cs-btn-start:hover{background:#22a862}
  `;

  var styleEl = document.createElement('style');
  styleEl.textContent = CSS + MODAL_CSS;
  document.head.appendChild(styleEl);

  function showToast(msg) { var t = document.getElementById('ttm-toast'); if (!t) { t = document.createElement('div'); t.id = 'ttm-toast'; t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3500); }
  function renderDebugLog() { var logEl = document.getElementById('dbg-log'); if (!logEl) return; logEl.innerHTML = debugLog.map(l => '<div class="log-' + l.type + '">[' + l.ts + '] ' + l.msg.replace(/</g, '&lt;') + '</div>').join(''); logEl.scrollTop = logEl.scrollHeight; }

  function renderUI() {
    var db = getDB(); var settings = getSettings(); var app = document.getElementById('app'); if (!app) return;
    app.classList.toggle('debug-active', debugOpen);
    var bookIds = Object.keys(db).reverse(); var booksHtml = '';

    if (bookIds.length === 0) {
      booksHtml = '<div class="empty"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><h3>Library is empty</h3><p>Go to a story page and click the green ➕ button to add books!</p></div>';
    } else {
      for (var i = 0; i < bookIds.length; i++) {
        var id = bookIds[i]; var book = db[id];
        var isAwaiting = book.status === 'awaiting-selection';
        var done    = book.episodes.filter(e => e.status === 'done').length;
        var skipped = book.episodes.filter(e => e.status === 'skipped').length;
        var errs    = book.episodes.filter(e => e.status === 'error').length;
        var total   = book.episodes.length;
        var queued  = total - skipped;
        var pct     = queued > 0 ? Math.round((done / queued) * 100) : 100;
        var stMap   = { downloading: 'is-downloading', paused: 'is-paused', completed: 'is-completed', error: 'is-error', 'awaiting-selection': 'is-awaiting' };
        var stClass = stMap[book.status] || '';
        var fillClass = book.status === 'completed' ? 'done' : 'dl';
        var labelMap = { downloading: 'Downloading', paused: 'Paused', completed: 'Completed', scanning: 'Scanning', error: 'Error', pending: 'Pending', 'awaiting-selection': 'Awaiting selection' };
        var statusLabel = labelMap[book.status] || book.status;
        var pips = book.episodes.map(ep => '<div class="ep-pip ep-' + ep.status + '" data-tip="' + ep.epNum + '. ' + ep.title.substring(0,28) + ' — ' + ep.status + '"></div>').join('');
        var errBadge  = errs > 0   ? '<span style="font-family:var(--mono);font-size:10px;color:var(--red)">' + errs + ' err</span>' : '';
        var skipBadge = skipped > 0 ? '<span style="font-family:var(--mono);font-size:10px;color:var(--t3)">' + skipped + ' skipped</span>' : '';
        var errBtn    = errs > 0   ? '<button class="act-btn act-err" data-action="retry" data-id="' + id + '">↻ Retry</button>' : '';
        var authorHtml = book.author && book.author !== 'Unknown_Author' ? '<div class="book-author">by ' + book.author + '</div>' : '';
        var id3Badge  = ID3Writer   ? '<span style="font-family:var(--mono);font-size:10px;color:#30c97a">🏷️ ID3</span>' : '<span style="font-family:var(--mono);font-size:10px;color:var(--gold)">⚠️ No ID3</span>';

        // Button label & style changes when awaiting selection
        var selBtnClass = isAwaiting ? 'act-btn act-sel-start' : 'act-btn act-sel';
        var selLabel    = isAwaiting ? '▶ Select chapters' : (skipped > 0 ? '☑ ' + queued + '/' + total : '☑ Chapters');

        // Progress / awaiting area
        var progressArea = isAwaiting
          ? `<div class="awaiting-prompt" data-action="select" data-id="${id}">
               <span class="awaiting-prompt-icon">☑</span>
               <div>
                 <div class="awaiting-prompt-text">Select chapters to begin downloading</div>
                 <div class="awaiting-prompt-sub">${total} chapters available — click to choose which ones to download</div>
               </div>
             </div>`
          : `<div class="prog-wrap">
               <div class="prog-track"><div class="prog-fill ${fillClass}" style="width:${pct}%"></div></div>
               <div class="prog-nums"><span>${done} of ${queued} queued${skipped > 0 ? ' (' + skipped + ' skipped)' : ''}</span><span>${pct}%</span></div>
             </div>`;

        booksHtml += `<div class="book ${stClass}">
          <div class="book-top">
            <div class="book-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
            <div class="book-body">
              <div class="book-name">${book.bookTitle}</div>
              ${authorHtml}
              <div class="book-meta"><span class="badge badge-${book.status.replace(/[^a-z-]/g,'')}""><span class="badge-dot"></span>${statusLabel}</span><span class="ep-count">${total} eps</span>${id3Badge}${errBadge}${skipBadge}</div>
            </div>
            <div class="book-actions">
              ${errBtn}
              <button class="${selBtnClass}" data-action="select" data-id="${id}">${selLabel}</button>
              <button class="act-btn act-rst" data-action="reset" data-id="${id}">↩ Reset</button>
              <button class="act-btn act-rm"  data-action="remove" data-id="${id}">✕</button>
            </div>
          </div>
          ${progressArea}
          <div class="ep-pips">${pips}</div>
        </div>`;
      }
    }

    var promptActive = settings.promptSave ? 'active' : '';
    var debugActive  = debugOpen   ? 'active' : '';
    var pauseActive  = isPaused    ? 'active' : '';
    var id3Status    = ID3Writer   ? '🏷️ ID3 Ready' : '⚠️ ID3 Loading...';

    app.innerHTML = `<nav class="nav">
      <a href="https://tieuthuyetmang.com/#ttm-dashboard" class="brand">
        <div class="brand-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
        <div><div class="brand-name">TTM Manager</div><div class="brand-sub">v5.3 · Select Before Download · ${id3Status}</div></div>
      </a>
      <div class="toolbar-pill">
        <span class="pill-label">PATH</span>
        <input class="pill-input" type="text" id="base-path" value="${settings.basePath}" spellcheck="false" autocomplete="off">
        <button class="pill-btn" id="btn-save-path">Save</button>
        <button class="pill-btn ${promptActive}" id="btn-prompt" title="Toggle Save As Prompt">📥</button>
        <button class="pill-btn ${pauseActive}"  id="btn-pause"  title="Pause / Resume Queue">⏸</button>
        <button class="pill-btn ${debugActive}"  id="btn-debug"  title="Toggle Debug Console">🐛</button>
        <a class="pill-btn" href="https://tieuthuyetmang.com/" target="_blank" title="Back to Site">🔗</a>
      </div>
      <div class="nav-hint">Path: <b>Relative</b> or <b>Absolute</b> (e.g. <i>D:/Books</i>). 📥 Prompt to pick folder. ⏸ Pause/Resume.<br>
        <span style="color:var(--blue)">New books pause for chapter selection before any downloading begins. Reset re-queues only your saved selection.</span>
      </div>
    </nav>
    <div class="add-card">
      <div class="add-label">Fallback: Add by URL</div>
      <div class="add-row">
        <input class="url-input" type="text" id="book-url" placeholder="https://tieuthuyetmang.com/truyen/..." spellcheck="false" autocomplete="off">
        <button class="btn-add" id="btn-add-book"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add to queue</button>
      </div>
    </div>
    <div class="lib-header"><span class="lib-title">Library</span><span class="lib-count">${bookIds.length} ${bookIds.length === 1 ? 'book' : 'books'}</span></div>
    ${booksHtml}`;
  }

  document.body.addEventListener('click', function(e) {
    var target = e.target.closest('button, a.pill-btn, span.dbg-close, div.awaiting-prompt');
    if (!target) return;

    if (target.id === 'btn-add-book') {
      var urlInput = document.getElementById('book-url'); var url = urlInput.value.trim();
      if (!url) return; urlInput.value = ''; addBook(url);
    }
    else if (target.id === 'btn-save-path') {
      var input = document.getElementById('base-path'); var s = getSettings();
      s.basePath = input.value.trim(); saveSettings(s); showToast('Path saved!');
    }
    else if (target.id === 'btn-prompt') {
      var s2 = getSettings(); s2.promptSave = !s2.promptSave; saveSettings(s2);
      showToast(s2.promptSave ? "⚠️ 'Save As' asks for EVERY file." : "Auto-save ON."); renderUI();
    }
    else if (target.id === 'btn-pause') { isPaused = !isPaused; if (!isPaused) processQueue(); renderUI(); }
    else if (target.id === 'btn-debug') {
      debugOpen = !debugOpen;
      var dbgPanel = document.getElementById('dbg-panel');
      if (dbgPanel) dbgPanel.classList.toggle('open', debugOpen); renderUI();
    }
    else if (target.id === 'dbg-close') {
      debugOpen = false;
      var dbgPanel2 = document.getElementById('dbg-panel');
      if (dbgPanel2) dbgPanel2.classList.remove('open'); renderUI();
    }
    else if (target.dataset.action === 'select') {
      var db = getDB(); var book = db[target.dataset.id];
      openChapterSelector(target.dataset.id, book && book.status === 'awaiting-selection');
    }
    else if (target.dataset.action === 'retry') {
      var db2 = getDB(); var bookId = target.dataset.id;
      if (db2[bookId]) { db2[bookId].episodes.forEach(ep => { if (ep.status === 'error') ep.status = 'pending'; }); db2[bookId].status = 'pending'; saveDB(db2); renderUI(); }
    }
    else if (target.dataset.action === 'reset') {
      var db3 = getDB(); var bookId3 = target.dataset.id;
      if (db3[bookId3]) {
        var book3 = db3[bookId3];
        var hasAnySelection = book3.episodes.some(ep => ep.selected === true);
        book3.episodes.forEach(ep => {
          if (ep.status === 'done') {
            // Re-queue done episodes according to their saved selection
            if (hasAnySelection) {
              ep.status = ep.selected !== false ? 'pending' : 'skipped';
            } else {
              // No selection saved yet — reset everything to pending
              ep.status = 'pending';
            }
          } else if (ep.status !== 'skipped') {
            // Non-done, non-skipped: restore to pending
            ep.status = 'pending';
          } else if (ep.status === 'skipped' && ep.selected === true) {
            // Was skipped but user had selected it — restore
            ep.status = 'pending';
          }
          // skipped + selected===false: stays skipped (intentionally excluded)
        });
        book3.status = book3.episodes.some(e => e.status === 'pending') ? 'pending' : 'completed';
        saveDB(db3); renderUI();
        showToast(hasAnySelection ? 'Reset to saved selection — re-queuing selected chapters.' : 'Reset — all chapters re-queued.');
      }
    }
    else if (target.dataset.action === 'remove') {
      var db4 = getDB(); delete db4[target.dataset.id]; saveDB(db4); renderUI();
      showToast('Book removed.');
    }
  });

  document.body.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && e.target.id === 'book-url') document.getElementById('btn-add-book').click();
    if (e.key === 'Escape') closeChapterSelector();
  });

  renderUI();
  processQueue();

})();
