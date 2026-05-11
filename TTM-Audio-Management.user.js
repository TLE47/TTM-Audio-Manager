// ==UserScript==
// @name         🎧 TTM Audiobook Manager
// @namespace    https://tieuthuyetmang.com/
// @version      4.6.0
// @description  Professional background downloader with Pause/Resume & Retry features
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

  // ─── AUTHOR & JSON EXTRACTION UTILITIES ────────────────────────────────────
  function findAuthorInJson(obj, depth = 0) {
    if (!obj || depth > 12) return null;
    if (typeof obj === 'string') { if (obj.includes('/tac-gia/')) return obj; }
    if (Array.isArray(obj)) { for (const item of obj) { const r = findAuthorInJson(item, depth + 1); if (r) return r; } return null; }
    if (typeof obj === 'object') {
      const prioKeys = ['author', 'authorName', 'tacGia', 'authors'];
      for (const k of prioKeys) { if (obj[k]) { const r = findAuthorInJson(obj[k], depth + 1); if (r) return r; } }
      const keys = Object.keys(obj);
      for (const k of keys) { if (prioKeys.includes(k)) continue; try { const r = findAuthorInJson(obj[k], depth + 1); if (r) return r; } catch {} }
    }
    return null;
  }

  function extractAuthorFromHTMLString(htmlString) {
    const regex1 = /<a[^>]*href="[^"]*\/tac-gia\/[^"]*"[^>]*>(.*?)<\/a>/;
    let match = htmlString.match(regex1);
    const regex2 = /Tác giả:\s*<\/span><a[^>]*>(.*?)<\/a>/;
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
             return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\/:*?"<>|]/g, '_');
          }
          return String(authorData).trim().replace(/\/:*?"<>|]/g, '_');
        }
      } catch (e) {}
    }
    return 'Unknown_Author';
  }

  function getAuthorFromDOM() {
    const spans = document.querySelectorAll('span.font-medium');
    for (const span of spans) {
      if (span.textContent.includes('Tác giả:')) {
        if (span.nextElementSibling && span.nextElementSibling.tagName === 'A') return span.nextElementSibling.textContent.trim().replace(/[\\/:*?"<>|]/g, '_');
        const parentLink = span.closest('span').querySelector('a[href*="/tac-gia/"]');
        if (parentLink) return parentLink.textContent.trim().replace(/\/:*?"<>|]/g, '_');
      }
    }
    const authorEl = document.querySelector('a[href*="/tac-gia/"]') || document.querySelector('.author') || document.querySelector('[itemprop="author"]');
    if (authorEl) return authorEl.textContent.trim().replace(/\/:*?"<>|]/g, '_');
    return null;
  }

  try { GM_registerMenuCommand('🎧 Open TTM Manager', () => { window.open('https://tieuthuyetmang.com/#ttm-dashboard', '_blank'); }); } catch (e) {}

  // ─── BOOK PAGE LOGIC ───────────────────────────────────────────────────────
  if (location.hash !== '#ttm-dashboard') {
    const style = document.createElement('style');
    style.textContent = `
      #ttm-page-actions { position: fixed!important; bottom: 28px!important; right: 28px!important; z-index: 2147483647!important; display: flex!important; flex-direction: column!important; gap: 12px!important; }
      .ttm-page-btn { width: 52px!important; height: 52px!important; border-radius: 50%!important; display: flex!important; align-items: center!important; justify-content: center!important; text-decoration: none!important; border: 2px solid rgba(255,255,255,.18)!important; cursor: pointer!important; font-size: 24px!important; box-shadow: 0 4px 24px rgba(0,0,0,.6)!important; transition: transform .15s, box-shadow .2s!important; color: #fff!important; line-height: 1!important; font-family: "Segoe UI Emoji",sans-serif!important; }
      .ttm-page-btn:hover { transform: scale(1.1)!important; box-shadow: 0 6px 36px rgba(0,0,0,.8)!important; }
      .ttm-btn-queue { background: linear-gradient(135deg,#30c97a,#1a8a4a)!important; }
      .ttm-btn-dash { background: linear-gradient(135deg,#e8a020,#9b6c0e)!important; }
    `;
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
            const fullUrl = href.startsWith('http') ? href : `https://tieuthuyetmang.com${href}`;
            if (seen.has(fullUrl)) return; seen.add(fullUrl);
            let title = tEl ? (tEl.getAttribute('title') || tEl.textContent.trim()) : '';
            title = title.replace(/[\\/:*?"<>|]/g, '_').trim() || `Tap_${idx + 1}`;
            eps.push({ epNum: idx + 1, title, url: fullUrl, status: 'pending' });
          }
        });
      }
      return eps;
    }

    function saveEpsToDB(episodes, author) {
      const url = location.href.split('?')[0].split('#')[0]; const id = safeId(url); const db = getDB();
      if (db[id] && db[id].episodes.length > 0) return false;
      const titleEl = document.querySelector('h1'); const bookTitle = titleEl ? titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '_') : 'Unknown_Book';
      db[id] = { bookTitle, author, url, status: 'pending', episodes }; saveDB(db); return true;
    }

    document.addEventListener('click', (e) => {
      if (e.target.closest('#ttm-queue-btn')) {
        const btn = document.getElementById('ttm-queue-btn'); if (!btn) return;
        btn.textContent = '⏳'; btn.style.pointerEvents = 'none';
        const currentAuthor = getAuthorFromDOM() || 'Unknown_Author'; // SCRAPE AUTHOR BEFORE SWITCHING TABS
        clickAudioTab();
        setTimeout(() => {
          const eps = scrapeEpisodesFromDOM();
          if (eps.length > 0) {
            const wasNew = saveEpsToDB(eps, currentAuthor); btn.textContent = '✅'; 
            if (wasNew) window.open('https://tieuthuyetmang.com/#ttm-dashboard', '_blank');
            setTimeout(() => { const b = document.getElementById('ttm-queue-btn'); if(b) { b.textContent = '➕'; b.style.pointerEvents = 'auto'; } }, 3000);
          } else { alert("Could not find episodes."); btn.textContent = '➕'; btn.style.pointerEvents = 'auto'; }
        }, 2000);
      }
    });
    injectUI(); return; 
  }

  // ─── DASHBOARD LOGIC ───────────────────────────────────────────────────────
  window.stop(); document.head.innerHTML = ''; document.body.style.margin = '0';
  document.body.innerHTML = '<div id="app"></div><div id="dbg-panel"><div class="dbg-header"><span>Debug Log</span><span class="dbg-close" id="dbg-close">✕</span></div><div id="dbg-log"></div></div>';

  const debugLog = []; let debugOpen = false; let isPaused = false;

  function getSettings() { try { const s = JSON.parse(GM_getValue(SETTINGS_KEY, '{"basePath":"TTM_Audiobooks","promptSave":false}')); if (typeof s.promptSave === 'undefined') s.promptSave = false; return s; } catch { return { basePath: 'TTM_Audiobooks', promptSave: false }; } }
  function saveSettings(s) { GM_setValue(SETTINGS_KEY, JSON.stringify(s)); }
  function mlog(msg, type = 'info') { const ts = new Date().toLocaleTimeString(); debugLog.push({ ts, msg, type }); if (debugLog.length > 150) debugLog.shift(); console.log(`[TTM-MGR ${type.toUpperCase()}]`, msg); renderDebugLog(); }

  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'GET', url, headers: { 'Referer': 'https://tieuthuyetmang.com/' }, onload: r => (r.status >= 200 && r.status < 400) ? resolve(r.responseText) : reject(new Error(`HTTP ${r.status}`)), onerror: e => reject(e), ontimeout: () => reject(new Error('Timeout')) });
    });
  }

  function findAudioUrl(obj, depth = 0) {
    if (!obj || depth > 12) return null;
    if (typeof obj === 'string') { const m = obj.match(/(https?:\/\/[^\s"'<>]+\.(mp3|m4a|ogg|aac)(\?[^\s"'<>]*)?)/i); return m ? m[1] : null; }
    if (Array.isArray(obj)) { for (const item of obj) { const r = findAudioUrl(item, depth + 1); if (r) return r; } return null; }
    if (typeof obj === 'object') {
      const keys = Object.keys(obj); const prio = keys.filter(k => /audio|src|url|link|file|mp3|stream|source|media/i.test(k)); const rest = keys.filter(k => !prio.includes(k));
      for (const k of [...prio, ...rest]) { try { const r = findAudioUrl(obj[k], depth + 1); if (r) return r; } catch {} }
    }
    return null;
  }

  async function fetchBookDetailsViaNetwork(url) {
    mlog(`Fetching book via network: ${url}`); const html = await gmFetch(url); const doc = new DOMParser().parseFromString(html, 'text/html');
    const titleEl = doc.querySelector('h1'); const bookTitle = titleEl ? titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '_') : 'Unknown_Book';
    const author = extractAuthorFromHTMLString(html);
    const episodes = []; const seenUrls = new Set(); const regex = /href="([^"]*\/nghe\/[^"]*)"/g; let match;
    while ((match = regex.exec(html)) !== null) { let href = match[1]; const fullUrl = href.startsWith('http') ? href : `https://tieuthuyetmang.com${href}`; if (!seenUrls.has(fullUrl)) { seenUrls.add(fullUrl); episodes.push({ url: fullUrl }); } }
    const finalEps = []; const finalSeen = new Set();
    episodes.forEach((ep, idx) => { if (!finalSeen.has(ep.url)) { finalSeen.add(ep.url); finalEps.push({ epNum: idx + 1, title: `Tap_${idx + 1}`, url: ep.url, status: 'pending' }); } });
    if (finalEps.length > 0) { doc.querySelectorAll('a[href*="/nghe/"]').forEach(a => { const href = a.getAttribute('href'); const fullUrl = href.startsWith('http') ? href : `https://tieuthuyetmang.com${href}`; const ep = finalEps.find(e => e.url === fullUrl); if (ep) { const tEl = a.querySelector('span.truncate[title]') || a.querySelector('span'); if (tEl) { let title = tEl.getAttribute('title') || tEl.textContent.trim(); title = title.replace(/[\\/:*?"<>|]/g, '_').trim(); if (title) ep.title = title; } } }); }
    mlog(`Found ${finalEps.length} episodes via network fetch. Author: ${author}`);
    return { bookTitle, author, episodes: finalEps };
  }

  async function fetchAudioUrl(epUrl) {
    const html = await gmFetch(epUrl); const doc = new DOMParser().parseFromString(html, 'text/html');
    const audioEl = doc.querySelector('audio[src], audio source[src]');
    if (audioEl) { let s = audioEl.getAttribute('src'); if (s && !s.startsWith('blob:')) { if (s.startsWith('/')) s = `https://tieuthuyetmang.com${s}`; if (s.startsWith('http')) return s; } }
    const nd = doc.getElementById('__NEXT_DATA__'); if (nd) { try { const u = findAudioUrl(JSON.parse(nd.textContent)); if (u) return u; } catch {} }
    const m = html.match(/(https?:\/\/[^\s"'<>]+\.(mp3|m4a|ogg|aac)(\?[^\s"'<>]*)?)/i); if (m) return m[1];
    throw new Error('Audio URL not found');
  }

  async function addBook(url) {
    const id = safeId(url); const db = getDB();
    if (db[id] && db[id].episodes.length > 0) { db[id].status = 'downloading'; db[id].episodes.forEach(ep => { if (ep.status === 'error' || ep.status === 'pending') ep.status = 'pending'; }); saveDB(db); renderUI(); showToast(`Resuming "${db[id].bookTitle}"`); return; }
    db[id] = { bookTitle: 'Loading...', author: 'Unknown_Author', url, status: 'scanning', episodes: [] }; saveDB(db); renderUI();
    try {
      const details = await fetchBookDetailsViaNetwork(url); details.url = url; details.status = 'pending'; 
      db[id] = details; saveDB(db); renderUI(); showToast(`Added "${details.bookTitle}" to queue!`);
    } catch (e) {
      mlog(`Failed to fetch book: ${e.message}`, 'error'); const currentDb = getDB();
      if (currentDb[id]) { currentDb[id].status = 'error'; currentDb[id].bookTitle = 'Error fetching book'; saveDB(currentDb); renderUI(); }
      showToast('Failed to fetch book details.');
    }
  }

  // Removed Blob Fallback to prevent duplicate (1).mp3 files and flat directory issues
  async function downloadFile(audioUrl, filename, promptSave) {
    return new Promise((resolve, reject) => {
      GM_download({ url: audioUrl, name: filename, saveAs: promptSave, onload: () => resolve(true), onerror: (e) => reject(new Error(e.error || e.details || JSON.stringify(e))), ontimeout: () => reject(new Error('Timeout')) });
    });
  }

  let isProcessing = false;
  async function processQueue() {
    if (isProcessing || isPaused) return; 
    isProcessing = true; 
    const db = getDB(); 

    // Reset stuck 'downloading' states from previous browser sessions
    let needsSave = false;
    for (const bookId of Object.keys(db)) {
      const book = db[bookId]; if (!book || !book.episodes) continue;
      for (const ep of book.episodes) {
        if (ep.status === 'downloading') { mlog(`Found stuck episode ${ep.epNum}. Resetting to pending.`, 'warn'); ep.status = 'pending'; needsSave = true; }
      }
      if (book.status === 'downloading' || book.status === 'scanning') { book.status = 'pending'; needsSave = true; }
    }
    if (needsSave) saveDB(db);

    outerLoop:
    for (const bookId of Object.keys(db)) {
      const book = db[bookId]; 
      if (!book || book.status === 'completed' || book.status === 'error' || book.episodes.length === 0) continue;
      
      for (const ep of book.episodes) {
        if (!getDB()[bookId]) { mlog(`Book removed by user. Canceling queue.`, 'warn'); isProcessing = false; return; }
        if (isPaused) { book.status = 'paused'; saveDB(db); renderUI(); mlog('⏸️ Queue Paused by user.'); break outerLoop; }
        
        // ONLY PROCESS PENDING. If it's error, skip it so the book pauses and waits for manual Retry
        if (ep.status === 'done' || ep.status === 'error') continue; 
        
        if (ep.status === 'pending') {
          const currentSettings = getSettings(); 
          book.status = 'downloading'; ep.status = 'downloading'; saveDB(db); renderUI();
          try {
            const audioUrl = await fetchAudioUrl(ep.url);
            const ext = (audioUrl.match(/\.(mp3|m4a|ogg|aac)/i) || ['', 'mp3'])[1];
            const safeAuthor = sanitizePath(book.author || 'Unknown_Author');
            const safeBookTitle = sanitizePath(book.bookTitle) || `Book_${bookId}`;
            const safeEpTitle = sanitizePath(ep.title) || `Tap_${ep.epNum}`;
            const filename = `${currentSettings.basePath}/${safeAuthor}/${safeBookTitle}/${safeBookTitle} - ${String(ep.epNum).padStart(3, '0')} - ${safeEpTitle}.${ext}`;
            
            await downloadFile(audioUrl, filename, currentSettings.promptSave);
            ep.status = 'done';
          } catch (e) { 
            ep.status = 'error'; 
            book.status = 'error'; // Pause the whole book on error to prevent out-of-order downloads
            mlog(`Episode ${ep.epNum} failed: ${e.message}`, 'error'); 
            saveDB(db); renderUI();
            continue outerLoop; // Move to next book in library
          }
          
          if (!getDB()[bookId]) { mlog(`Book removed during download. Halting queue.`, 'warn'); isProcessing = false; return; }
          book.status = 'downloading'; saveDB(db); renderUI();
          await new Promise(r => setTimeout(r, 1500)); continue outerLoop;
        }
      }
      
      if (book.episodes.every(e => e.status === 'done')) { book.status = 'completed'; }
      else if (book.episodes.some(e => e.status === 'error')) { book.status = 'error'; }
      else { book.status = 'pending'; }
      saveDB(db); renderUI();
    }
    isProcessing = false; renderUI();
  }
  setInterval(processQueue, 5000);

  // ─── CSS ─────────────────────────────────────────────────────────────────
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@400;500&display=swap');
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --bg: #0a0a0f; --surface: #111118; --raised: #18181f; --border: rgba(255,255,255,0.07); --border-hi: rgba(255,255,255,0.13); --t1: #f0f0f5; --t2: #8888a0; --t3: #44445a; --gold: #e8a020; --gold-lo: rgba(232,160,32,0.1); --gold-md: rgba(232,160,32,0.22); --green: #30c97a; --green-lo: rgba(48,201,122,0.1); --green-md: rgba(48,201,122,0.2); --red: #f05858; --red-lo: rgba(240,88,88,0.1); --red-md: rgba(240,88,88,0.2); --blue: #5090f8; --blue-lo: rgba(80,144,248,0.1); --blue-md: rgba(80,144,248,0.2); --font: 'Syne', system-ui, sans-serif; --mono: 'DM Mono', monospace; --ease: cubic-bezier(0.16, 1, 0.3, 1); }
    html, body { background: var(--bg); color: var(--t1); font-family: var(--font); min-height: 100vh; }
    #app { max-width: 920px; margin: 0 auto; padding: 32px 28px 80px; transition: padding-bottom 0.3s var(--ease); }
    #app.debug-active { padding-bottom: 260px; }
    .nav { display: flex; align-items: center; justify-content: space-between; padding-bottom: 24px; margin-bottom: 32px; border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 16px; }
    .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
    .brand-icon { width: 38px; height: 38px; flex-shrink: 0; border-radius: 10px; border: 1px solid var(--border-hi); background: var(--surface); display: flex; align-items: center; justify-content: center; color: var(--gold); }
    .brand-name { font-size: 17px; font-weight: 700; letter-spacing: -0.3px; line-height: 1.2; }
    .brand-sub { font-family: var(--mono); font-size: 10px; color: var(--t2); letter-spacing: 0.06em; }
    .toolbar-pill { display: inline-flex; align-items: center; height: 36px; border: 1px solid var(--border); border-radius: 9px; background: var(--surface); overflow: hidden; }
    .pill-label { font-family: var(--mono); font-size: 9px; letter-spacing: 0.07em; color: var(--t3); padding: 0 8px; white-space: nowrap; height: 100%; display: flex; align-items: center; }
    .pill-input { background: none; border: none; outline: none; color: var(--t1); font-family: var(--mono); font-size: 11px; padding: 0 8px; width: 120px; border-right: 1px solid var(--border); height: 100%; }
    .pill-btn { border: none; background: none; color: var(--t2); font-family: var(--font); font-size: 13px; font-weight: 600; padding: 0 8px; height: 100%; cursor: pointer; white-space: nowrap; transition: color 0.15s, background 0.15s; border-right: 1px solid var(--border); text-decoration: none; display: inline-flex; align-items: center; gap: 3px; }
    .pill-btn:last-child { border-right: none; } .pill-btn:hover { color: var(--gold); background: var(--gold-lo); } .pill-btn.active { color: var(--gold); background: var(--gold-lo); }
    .nav-hint { width: 100%; font-family: var(--mono); font-size: 8.5px; color: var(--t3); margin-top: 4px; padding-left: 2px; line-height: 1.5; } .nav-hint b { color: var(--t2); font-weight: 600; }
    .add-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; margin-bottom: 28px; }
    .add-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--t3); margin-bottom: 12px; }
    .add-row { display: flex; gap: 10px; }
    .url-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 9px; padding: 10px 14px; color: var(--t1); font-family: var(--font); font-size: 13px; outline: none; transition: border-color 0.15s, box-shadow 0.15s; } .url-input::placeholder { color: var(--t3); font-size: 12px; } .url-input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-lo); }
    .btn-add { display: inline-flex; align-items: center; gap: 7px; height: 40px; padding: 0 18px; background: var(--gold); color: #000; font-family: var(--font); font-size: 12px; font-weight: 700; border: none; border-radius: 9px; cursor: pointer; white-space: nowrap; transition: background 0.15s; } .btn-add:hover { background: #c8880e; }
    .lib-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .lib-title { font-family: var(--mono); font-size: 9.5px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--t3); } .lib-count { font-family: var(--mono); font-size: 10px; color: var(--t3); }
    .book { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; margin-bottom: 10px; transition: border-color 0.2s; animation: fadeUp 0.3s var(--ease) both; } @keyframes fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } } .book:hover { border-color: var(--border-hi); }
    .book.is-downloading, .book.is-paused { border-color: rgba(232,160,32,0.22); } .book.is-completed { border-color: rgba(48,201,122,0.18); } .book.is-error { border-color: rgba(240,88,88,0.18); }
    .book-top { display: flex; align-items: flex-start; gap: 14px; margin-bottom: 18px; }
    .book-icon { width: 40px; height: 40px; flex-shrink: 0; border-radius: 9px; border: 1px solid var(--border); background: var(--raised); display: flex; align-items: center; justify-content: center; color: var(--t3); }
    .book.is-downloading .book-icon, .book.is-paused .book-icon { color: var(--gold); border-color: var(--gold-md); background: var(--gold-lo); } .book.is-completed .book-icon { color: var(--green); border-color: var(--green-md); background: var(--green-lo); } .book.is-error .book-icon { color: var(--red); border-color: var(--red-md); background: var(--red-lo); }
    .book-body { flex: 1; min-width: 0; } .book-name { font-size: 14px; font-weight: 700; letter-spacing: -0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 6px; } .book-author { font-size: 11px; color: var(--t2); margin-bottom: 6px; }
    .book-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .badge { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 9.5px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; border: 1px solid transparent; line-height: 1.4; } .badge-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .badge-downloading { background: var(--gold-lo); color: var(--gold); border-color: var(--gold-md); } .badge-downloading .badge-dot { animation: blink 1.4s infinite ease-in-out; } .badge-paused { background: var(--blue-lo); color: var(--blue); border-color: var(--blue-md); } .badge-completed { background: var(--green-lo); color: var(--green); border-color: var(--green-md); } .badge-scanning { background: var(--blue-lo); color: var(--blue); border-color: var(--blue-md); } .badge-scanning .badge-dot { animation: blink 1s infinite ease-in-out; } .badge-error { background: var(--red-lo); color: var(--red); border-color: var(--red-md); } .badge-pending { background: var(--raised); color: var(--t2); border-color: var(--border); } @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.2; } }
    .ep-count { font-family: var(--mono); font-size: 10px; color: var(--t2); } .book-actions { display: flex; gap: 4px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
    .act-btn { display: inline-flex; align-items: center; gap: 4px; background: none; border: 1px solid var(--border-hi); color: var(--t2); border-radius: 6px; font-family: var(--font); font-size: 10px; font-weight: 600; padding: 4px 7px; cursor: pointer; transition: all 0.15s; } .act-btn.act-err { border-color: var(--red-md); color: var(--red); } .act-btn.act-err:hover { background: var(--red-lo); } .act-btn.act-rst { border-color: var(--gold-md); color: var(--gold); } .act-btn.act-rst:hover { background: var(--gold-lo); } .act-btn.act-rm { border-color: var(--red-md); color: var(--red); } .act-btn.act-rm:hover { background: var(--red-lo); }
    .prog-wrap { margin-bottom: 16px; } .prog-track { height: 2px; background: var(--raised); border-radius: 999px; overflow: hidden; margin-bottom: 7px; } .prog-fill { height: 100%; border-radius: 999px; transition: width 0.6s var(--ease); } .prog-fill.dl { background: var(--gold); } .prog-fill.done { background: var(--green); } .prog-nums { display: flex; justify-content: space-between; font-family: var(--mono); font-size: 9.5px; color: var(--t3); letter-spacing: 0.05em; text-transform: uppercase; }
    .ep-pips { display: flex; flex-wrap: wrap; gap: 3px; } .ep-pip { width: 9px; height: 9px; border-radius: 2px; cursor: default; flex-shrink: 0; position: relative; transition: transform 0.12s; } .ep-pip:hover { transform: scale(1.9); z-index: 10; } .ep-pip.ep-pending { background: var(--raised); } .ep-pip.ep-downloading { background: var(--gold); animation: blink 1.4s infinite ease-in-out; } .ep-pip.ep-done { background: var(--green); } .ep-pip.ep-error { background: var(--red); } .ep-pip::after { content: attr(data-tip); pointer-events: none; opacity: 0; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); background: var(--raised); color: var(--t1); font-family: var(--mono); font-size: 10px; white-space: nowrap; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--border); transition: opacity 0.12s; z-index: 20; } .ep-pip:hover::after { opacity: 1; }
    .empty { text-align: center; padding: 64px 24px; border: 1px dashed var(--border); border-radius: 14px; background: var(--surface); } .empty-icon { width: 48px; height: 48px; border-radius: 12px; background: var(--raised); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; color: var(--t3); margin: 0 auto 16px; } .empty h3 { font-size: 15px; font-weight: 700; color: var(--t1); margin-bottom: 6px; } .empty p { font-size: 12px; color: var(--t2); line-height: 1.75; }
    .toast { position: fixed; bottom: 20px; right: 20px; z-index: 9999; background: var(--surface); border: 1px solid var(--border-hi); border-radius: 10px; padding: 14px 20px; font-family: var(--font); font-size: 13px; color: var(--t1); box-shadow: 0 12px 40px rgba(0,0,0,0.6); opacity: 0; transform: translateY(10px); transition: all 0.3s var(--ease); } .toast.show { opacity: 1; transform: translateY(0); }
    #dbg-panel { position: fixed; bottom: 0; left: 0; right: 0; height: 240px; background: #050508; border-top: 2px solid var(--gold); z-index: 10000; display: none; flex-direction: column; padding: 12px; font-family: var(--mono); box-shadow: 0 -10px 40px rgba(0,0,0,0.8); } #dbg-panel.open { display: flex; } .dbg-header { padding: 4px 0 8px; color: var(--gold); font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; border-bottom: 1px solid var(--border); margin-bottom: 8px; display: flex; justify-content: space-between; } .dbg-close { color: var(--t2); cursor: pointer; } .dbg-close:hover { color: var(--t1); } #dbg-log { flex: 1; overflow-y: auto; font-size: 11px; line-height: 1.5; color: var(--t2); } #dbg-log div.log-error { color: var(--red); } #dbg-log div.log-warn { color: var(--gold); }
  `;

  const styleEl = document.createElement('style'); styleEl.textContent = CSS; document.head.appendChild(styleEl);

  function showToast(msg) { let t = document.getElementById('ttm-toast'); if (!t) { t = document.createElement('div'); t.id = 'ttm-toast'; t.className = 'toast'; document.body.appendChild(t); } t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3500); }
  function renderDebugLog() { const logEl = document.getElementById('dbg-log'); if (!logEl) return; logEl.innerHTML = debugLog.map(l => `<div class="log-${l.type}">[${l.ts}] ${l.msg.replace(/</g, '&lt;')}</div>`).join(''); logEl.scrollTop = logEl.scrollHeight; }

  function renderUI() {
    const db = getDB(); const settings = getSettings(); const app = document.getElementById('app'); if (!app) return;
    app.classList.toggle('debug-active', debugOpen); const bookIds = Object.keys(db).reverse(); let booksHtml = '';
    if (bookIds.length === 0) { booksHtml = `<div class="empty"><div class="empty-icon"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><h3>Library is empty</h3><p>Go to a story page and click the green ➕ button to add books!</p></div>`; } 
    else {
      for (const id of bookIds) {
        const book = db[id]; const done = book.episodes.filter(e => e.status === 'done').length; const errs = book.episodes.filter(e => e.status === 'error').length; const total = book.episodes.length; const pct = total > 0 ? Math.round(((done + errs) / total) * 100) : 0;
        const stClass = { downloading: 'is-downloading', paused: 'is-paused', completed: 'is-completed', error: 'is-error' }[book.status] || '';
        const fillClass = book.status === 'completed' ? 'done' : 'dl';
        const statusLabel = { downloading: 'Downloading', paused: 'Paused', completed: 'Completed', scanning: 'Scanning', error: 'Error', pending: 'Pending' }[book.status] || book.status;
        const pips = book.episodes.map(ep => `<div class="ep-pip ep-${ep.status}" data-tip="${ep.epNum}. ${ep.title.substring(0, 28)} — ${ep.status}"></div>`).join('');
        const errBadge = errs > 0 ? `<span style="font-family:var(--mono);font-size:10px;color:var(--red)">${errs} err</span>` : '';
        const errBtn = errs > 0 ? `<button class="act-btn act-err" data-action="retry" data-id="${id}">↻ Retry</button>` : '';
        const authorHtml = book.author && book.author !== 'Unknown_Author' ? `<div class="book-author">by ${book.author}</div>` : '';
        booksHtml += `
        <div class="book ${stClass}">
          <div class="book-top">
            <div class="book-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div>
            <div class="book-body">
              <div class="book-name">${book.bookTitle}</div>
              ${authorHtml}
              <div class="book-meta"><span class="badge badge-${book.status}"><span class="badge-dot"></span>${statusLabel}</span><span class="ep-count">${total} eps</span>${errBadge}</div>
            </div>
            <div class="book-actions">${errBtn}<button class="act-btn act-rst" data-action="reset" data-id="${id}">↩ Reset</button><button class="act-btn act-rm" data-action="remove" data-id="${id}">✕</button></div>
          </div>
          <div class="prog-wrap"><div class="prog-track"><div class="prog-fill ${fillClass}" style="width:${pct}%"></div></div><div class="prog-nums"><span>${done + errs} of ${total}</span><span>${pct}%</span></div></div>
          <div class="ep-pips">${pips}</div>
        </div>`;
      }
    }
    const promptActive = settings.promptSave ? 'active' : ''; const debugActive = debugOpen ? 'active' : ''; const pauseActive = isPaused ? 'active' : '';
    app.innerHTML = `
      <nav class="nav">
        <a href="https://tieuthuyetmang.com/#ttm-dashboard" class="brand"><div class="brand-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg></div><div><div class="brand-name">TTM Manager</div><div class="brand-sub">Audiobook Downloader</div></div></a>
        <div class="toolbar-pill"><span class="pill-label">PATH</span><input class="pill-input" type="text" id="base-path" value="${settings.basePath}" spellcheck="false" autocomplete="off"><button class="pill-btn" id="btn-save-path">Save</button><button class="pill-btn ${promptActive}" id="btn-prompt" title="Toggle 'Save As' Prompt">📥</button><button class="pill-btn ${pauseActive}" id="btn-pause" title="Pause / Resume Queue">⏸</button><button class="pill-btn ${debugActive}" id="btn-debug" title="Toggle Debug Console">🐛</button><a class="pill-btn" href="https://tieuthuyetmang.com/" target="_blank" title="Back to Site">🔗</a></div>
        <div class="nav-hint">Path: <b>Relative</b> or <b>Absolute</b> (e.g. <i>D:/Books</i>). 📥 Prompt to pick folder. ⏸ Pause/Resume queue.<br><span style="color:var(--gold)">📂 Saves as: <i>Path/Author/BookTitle/BookTitle - 001 - Chapter.mp3</i> (Plappa/Plex/Audiobookshelf standard)</span></div>
      </nav>
      <div class="add-card"><div class="add-label">Fallback: Add by URL</div><div class="add-row"><input class="url-input" type="text" id="book-url" placeholder="https://tieuthuyetmang.com/truyen/..." spellcheck="false" autocomplete="off"><button class="btn-add" id="btn-add-book"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Add to queue</button></div></div>
      <div class="lib-header"><span class="lib-title">Library</span><span class="lib-count">${bookIds.length} ${bookIds.length === 1 ? 'book' : 'books'}</span></div>${booksHtml}`;
  }

  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('button, a.pill-btn, span.dbg-close'); if (!target) return;
    if (target.id === 'btn-add-book') { const urlInput = document.getElementById('book-url'); const url = urlInput.value.trim(); if (!url) return; urlInput.value = ''; addBook(url); } 
    else if (target.id === 'btn-save-path') { const input = document.getElementById('base-path'); const settings = getSettings(); settings.basePath = input.value.trim(); saveSettings(settings); showToast('Path saved!'); }
    else if (target.id === 'btn-prompt') { const settings = getSettings(); settings.promptSave = !settings.promptSave; saveSettings(settings); if (settings.promptSave) showToast("⚠️ 'Save As' asks for EVERY file."); else showToast("Auto-save ON."); renderUI(); }
    else if (target.id === 'btn-pause') { isPaused = !isPaused; if (!isPaused) processQueue(); }
    else if (target.id === 'btn-debug') { debugOpen = !debugOpen; const dbgPanel = document.getElementById('dbg-panel'); if (dbgPanel) dbgPanel.classList.toggle('open', debugOpen); renderUI(); }
    else if (target.id === 'dbg-close') { debugOpen = false; const dbgPanel = document.getElementById('dbg-panel'); if (dbgPanel) dbgPanel.classList.remove('open'); renderUI(); }
    else if (target.dataset.action === 'retry') { const db = getDB(); const bookId = target.dataset.id; if (db[bookId]) { db[bookId].episodes.forEach(ep => { if(ep.status === 'error') ep.status = 'pending'; }); db[bookId].status = 'downloading'; saveDB(db); renderUI(); } }
    else if (target.dataset.action === 'reset') { const db = getDB(); const bookId = target.dataset.id; if (db[bookId]) { db[bookId].episodes.forEach(ep => { if (ep.status !== 'done') ep.status = 'pending'; }); db[bookId].status = 'pending'; saveDB(db); renderUI(); showToast("Reset: Skipped 'Done' episodes to prevent (1).mp3 duplicates."); } }
    else if (target.dataset.action === 'remove') { const db = getDB(); delete db[target.dataset.id]; saveDB(db); renderUI(); showToast("Book removed. Active downloads will halt shortly."); }
  });

  document.body.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'book-url') document.getElementById('btn-add-book').click(); });

})(); // Closes the IIFE
