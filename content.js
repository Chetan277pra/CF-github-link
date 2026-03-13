/* content.js — full, robust content script for CF → GitHub */

(() => {
  const log = (...args) => console.log("CF-CS:", ...args);
  const warn = (...args) => console.warn("CF-CS:", ...args);

  function sendResult(type, payload = null, error = null) {
    try {
      const base = { type, url: window.location.href, timestamp: Date.now() };
      const msgNew = Object.assign({}, base, { payload, error });
      const msgLegacy = Object.assign({}, base);
      if (type === "SUBMISSION_CODE") msgLegacy.code = payload && payload.code ? payload.code : (payload || null);
      if (type === "PROBLEM_STATEMENT") msgLegacy.html = payload && payload.html ? payload.html : (payload || null);
      
      // FIX: Silently ignore the harmless port closed warning
      const checkError = () => {
        if (chrome.runtime.lastError && chrome.runtime.lastError.message !== "The message port closed before a response was received.") {
           warn("Message error:", chrome.runtime.lastError.message);
        }
      };

      chrome.runtime.sendMessage(msgNew, checkError);
      chrome.runtime.sendMessage(msgLegacy, checkError);
    } catch (e) { warn(`Failed to send ${type}:`, e); }
  }

  function sendAction(actionObj) {
    try { 
      chrome.runtime.sendMessage(actionObj, () => {
        // FIX: Silently ignore the harmless port closed warning
        if (chrome.runtime.lastError && chrome.runtime.lastError.message !== "The message port closed before a response was received.") {
           warn("Message error:", chrome.runtime.lastError.message);
        }
      }); 
    } 
    catch (e) { warn("Failed to send action:", e); }
  }

  function parseContestAndSubmission(urlPath = window.location.pathname) {
    let m = urlPath.match(/\/contest\/(\d+)\/submission\/(\d+)/);
    if (m) return { contestId: m[1], submissionId: m[2] };
    m = urlPath.match(/\/submission\/(\d+)/);
    if (m) return { contestId: null, submissionId: m[1] };
    return { contestId: null, submissionId: null };
  }

  function parseProblem(urlPath = window.location.pathname) {
    let m = urlPath.match(/\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)/);
    if (m) return { contestId: m[1], index: m[2] };
    m = urlPath.match(/\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/);
    if (m) return { contestId: m[1], index: m[2] };
    return { contestId: null, index: null };
  }

  const CODE_SELECTORS = [ "#program-source-text", "pre.prettyprint", ".program-source", "pre#program-source-text", 'pre[class*="program-source"]', 'div[class*="source"] pre', 'pre:has(code)' ];
  const PROBLEM_SELECTORS = [ ".problem-statement", ".problemtext", "#problem-statement", ".statement", ".problem", '.problem-statement, .problemtext, #problem-statement' ];

  function scanPreForCode() {
    const pres = Array.from(document.querySelectorAll("pre"));
    for (const p of pres) {
      const text = p.textContent || "";
      if (text.trim().length < 40) continue;
      const lc = text.slice(0, 600);
      if (/(int\s+main|#include|def\s+main|console\.log|public\s+static|using\s+namespace|import\s+java)/i.test(lc)) return text.trim();
    }
    return null;
  }

  function extractCodeFromPage() {
    for (const sel of CODE_SELECTORS) {
      try {
        const node = document.querySelector(sel);
        if (node) {
          const txt = node.textContent || node.innerText || "";
          if (txt.trim().length > 0) return txt.trim();
        }
      } catch (e) {}
    }
    const scanned = scanPreForCode();
    if (scanned) return scanned;
    return null;
  }

  function extractProblemHtmlFromPage() {
    for (const sel of PROBLEM_SELECTORS) {
      try {
        const node = document.querySelector(sel);
        if (node) {
          const html = node.innerHTML || "";
          if (html.trim().length > 32) return html.trim();
        }
      } catch (e) {}
    }
    try {
      const fallback = document.querySelector(".main-content, #pageContent, .content, main");
      if (fallback && (fallback.innerHTML || "").trim().length > 50) return fallback.innerHTML.trim();
    } catch (e) {}
    return null;
  }

  function detectAccessDenied() {
    const denialSelectors = ['.access-denied', '[class*="error"]', '[class*="forbidden"]', '[class*="denied"]'];
    for (const s of denialSelectors) { try { if (document.querySelector(s)) return true; } catch (e) {} }
    if ((document.body && document.body.innerText || "").toLowerCase().includes("access denied")) return true;
    return false;
  }

  function gleanMetaFromSubmissionPage() {
    const meta = {};
    try {
      const problemLink = document.querySelector("table.status-frame-datatable tbody tr td:nth-child(3) a") || document.querySelector(".problemset-problem .title") || document.querySelector(".problem-title");
      meta.problemName = problemLink ? (problemLink.textContent || "").trim() : null;
    } catch (e) {}
    try {
      const langEl = document.querySelector(".program-language") || document.querySelector(".lang") || document.querySelector("td.program-language") || document.querySelector(".submission-language");
      meta.language = langEl ? (langEl.textContent || "").trim() : null;
    } catch (e) {}
    try {
      const problemIndexEl = document.querySelector(".problem-index") || document.querySelector("table.status-frame-datatable tbody tr td:nth-child(3) a");
      if (problemIndexEl) {
        const txt = problemIndexEl.textContent || "";
        const idxMatch = txt.match(/\b([A-Za-z][0-9A-Za-z]*)\b/);
        if (idxMatch) meta.problemIndex = idxMatch[1];
      }
    } catch (e) {}
    return meta;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (!msg) return false;
      if (msg.action === "extractSubmissionCode") {
        (async () => {
          let code = null; const maxMs = 5000; const start = Date.now();
          while (!code && Date.now() - start < maxMs) { code = extractCodeFromPage(); if (code) break; await new Promise(r => setTimeout(r, 200)); }
          try { sendResponse({ success: !!code, data: code, error: code ? null : "Code not found", url: window.location.href }); } catch (e) {}
        })();
        return true; 
      }
      if (msg.action === "extractProblemStatement") {
        (async () => {
          let html = null; const maxMs = 6000; const start = Date.now();
          while (!html && Date.now() - start < maxMs) { html = extractProblemHtmlFromPage(); if (html) break; await new Promise(r => setTimeout(r, 250)); }
          try { sendResponse({ success: !!html, data: html, error: html ? null : "Not found", url: window.location.href }); } catch (e) {}
        })();
        return true;
      }
    } catch (ex) { return false; }
    return false;
  });

  async function handlePageInit() {
    const path = window.location.pathname;
    const query = window.location.search;
    if (detectAccessDenied()) return;

    if (path.includes("/submission/")) {
      let code = extractCodeFromPage();
      if (!code) {
        const start = Date.now();
        while (!code && Date.now() - start < 5000) { await new Promise(r => setTimeout(r, 200)); code = extractCodeFromPage(); }
      }
      const parsed = parseContestAndSubmission(path);
      const meta = gleanMetaFromSubmissionPage();
      const payload = { code: code || null, contestId: parsed.contestId, submissionId: parsed.submissionId, problemIndex: meta.problemIndex || null, problemName: meta.problemName || null, language: meta.language || null };
      if (code) sendResult("SUBMISSION_CODE", payload, null);
      try { sendAction({ action: "triggerImmediateSync" }); } catch (e) { }
    }

    if (path.includes("/problem/")) {
      let html = extractProblemHtmlFromPage();
      if (!html) {
        const start = Date.now();
        while (!html && Date.now() - start < 6000) { await new Promise(r => setTimeout(r, 250)); html = extractProblemHtmlFromPage(); }
      }
      const parsed = parseProblem(path);
      if (html) sendResult("PROBLEM_STATEMENT", { html: html || null, contestId: parsed.contestId, problemIndex: parsed.index }, null);
    }

    const isMyStatusPage = 
      path.includes("/submissions/") || 
      /\/contest\/\d+\/my/.test(path) || 
      (path.includes("/status") && query.includes("my=on"));

    if (isMyStatusPage) {
      checkLatestAcceptedAndNotify();

      const statusTable = document.querySelector("table.status-frame-datatable");
      if (statusTable) {
        const tableObserver = new MutationObserver(() => {
          checkLatestAcceptedAndNotify();
        });
        tableObserver.observe(statusTable, { childList: true, subtree: true, characterData: true });
      }
    }
  }

  let lastSeenSubmission = null;
  let checkPending = false;

  function findLatestAcceptedFromStatusTable() {
    try {
      const rows = document.querySelectorAll("table.status-frame-datatable tr");
      for (let i = 1; i < rows.length; i++) { 
        const row = rows[i];
        const verdict = row.querySelector(".verdict-accepted, .verdict-accepted__text, span[submissionverdict='OK']");
        
        if (!verdict && !/accepted|OK/i.test(row.innerText)) continue; 
        
        const link = row.querySelector("a.view-source, td:nth-child(1) a, a[href*='/submission/']");
        if (!link) continue;
        
        const submissionId = (link.textContent || "").trim() || (link.getAttribute("href") || "").split("/").pop();
        
        let contestId = null;
        let problemIndex = 'A';
        let problemName = null;

        const problemLink = row.querySelector("td:nth-child(3) a, td.status-problem-cell a, a[href*='/problem/']");
        if (problemLink) {
          problemName = (problemLink.textContent || "").trim();
          const hrefMatch = (problemLink.getAttribute("href") || "").match(/contest\/(\d+)\/problem\/([A-Za-z0-9]+)/) || 
                            (problemLink.getAttribute("href") || "").match(/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/);
          if (hrefMatch) {
            contestId = hrefMatch[1];
            problemIndex = hrefMatch[2];
          } else {
             const txtMatch = problemName.match(/^([A-Za-z0-9]+)/);
             if (txtMatch) problemIndex = txtMatch[1];
          }
        }

        // ---> NEW FIX: Grabbing the programming language from the 5th column
        const langCell = row.querySelector("td:nth-child(5)");
        const language = langCell ? langCell.textContent.trim() : "txt";

        if (!contestId) {
          const urlMatch = window.location.pathname.match(/\/contest\/(\d+)/);
          if (urlMatch) contestId = urlMatch[1];
        }

        return { submissionId, problemName, contestId, problemIndex, language, pageUrl: window.location.href };
      }
    } catch (e) {}
    return null;
  }

  function checkLatestAcceptedAndNotify() {
    if (checkPending) return;
    checkPending = true;
    try {
      const res = findLatestAcceptedFromStatusTable();
      if (!res) return;

      if (res.submissionId && res.submissionId !== lastSeenSubmission) {
        lastSeenSubmission = res.submissionId;
        log("Detected new accepted submission:", res.submissionId);

        // ---> NEW FIX: Sending the correct language to the background
        sendAction({
          action: "cf_submission_detected",
          submissionId: res.submissionId,
          contestId: res.contestId,
          problemIndex: res.problemIndex || 'A',
          pageUrl: res.pageUrl,
          problemName: res.problemName || null,
          language: res.language 
        });
      }
    } catch (err) { console.error(err); } 
    finally { checkPending = false; }
  }

  setInterval(checkLatestAcceptedAndNotify, 2500);

  let currentUrl = location.href;
  const mo = new MutationObserver(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      setTimeout(handlePageInit, 150);
    }
  });

  if (document.body) mo.observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => handlePageInit().catch(e=>e));
  else handlePageInit().catch(e=>e);

})();