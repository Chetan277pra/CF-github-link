// background.js 
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

// ---- Utilities ----
function base64Encode(str){ return btoa(unescape(encodeURIComponent(str))); }
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function storageGet(keys){ return new Promise(resolve => chrome.storage.sync.get(keys, res => resolve(res || {}))); }
function storageGetLocal(keys){ return new Promise(resolve => chrome.storage.local.get(keys, res => resolve(res || {}))); }
function storageSet(obj){ return new Promise(resolve => chrome.storage.sync.set(obj, () => resolve())); }

// ---- Config helpers ----
async function getConfig(){
  const sync = await storageGet(['githubToken','linkedRepo','cf_handle','pathPrefix','syncIntervalMinutes','repoOwner','repoName']);
  const local = await storageGetLocal(['githubToken','linkedRepo','repoOwner','repoName','cf_handle','pathPrefix','syncIntervalMinutes']);
  const cfg = Object.assign({}, local, sync);
  if(!cfg.linkedRepo && cfg.repoOwner && cfg.repoName){
    cfg.linkedRepo = `${String(cfg.repoOwner).trim()}/${String(cfg.repoName).trim()}`;
  }
  if(cfg.linkedRepo) cfg.linkedRepo = String(cfg.linkedRepo).trim();
  if(cfg.githubToken) cfg.githubToken = String(cfg.githubToken).trim();
  if(cfg.cf_handle) cfg.cf_handle = String(cfg.cf_handle).trim();
  if(cfg.pathPrefix) cfg.pathPrefix = String(cfg.pathPrefix).trim();
  return cfg;
}

function parseRepoFullName(full){
  if(!full || typeof full !== 'string') return null;
  const parts = full.trim().split('/');
  if(parts.length !== 2) return null;
  return { owner: parts[0].trim(), repo: parts[1].trim() };
}
function isValidRepoFullName(full){ return !!parseRepoFullName(full); }

// ---- GitHub helpers ----
async function getFileSha(owner,repo,path,token){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;
  const r = await fetch(url,{ headers:{ Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" } });
  if(r.status === 200){ const j = await r.json(); return j.sha; }
  if(r.status === 404) return null;
  const text = await r.text();
  throw new Error(`GitHub getFileSha error ${r.status}: ${text}`);
}
async function pushFileToGitHub(repoFullName, token, path, content, message){
  if(!isValidRepoFullName(repoFullName)) throw new Error('Invalid repoFullName, expected "owner/repo"');
  const repo = parseRepoFullName(repoFullName);
  const sha = await getFileSha(repo.owner, repo.repo, path, token).catch(err => { throw err; });
  const body = { message, content: base64Encode(content) };
  if(sha) body.sha = sha;
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${encodeURIComponent(path)}`;
  const r = await fetch(url,{
    method: 'PUT',
    headers: { Authorization:`token ${token}`, Accept:'application/vnd.github.v3+json' },
    body: JSON.stringify(body)
  });
  if(!r.ok){ const t = await r.text(); throw new Error(`GitHub push failed ${r.status}: ${t}`); }
  return await r.json();
}

// ---- Rate limiting & cache ----
const rateState = { codeforcesRequests: [], githubRequests: [] };
function canMakeRequest(kind){
  const now = Date.now();
  const list = kind === 'codeforces' ? rateState.codeforcesRequests : rateState.githubRequests;
  const limit = kind === 'codeforces' ? 5 : 60;
  while(list.length > 0 && now - list[0] > 60000) list.shift();
  return list.length < limit;
}
function recordRequest(kind){ (kind === 'codeforces' ? rateState.codeforcesRequests : rateState.githubRequests).push(Date.now()); }

const cache = { submissions: { data: null, ts: 0, ttl: 30000 }, problems: new Map() };
function getCache(key){
  if(key === 'submissions'){
    if(cache.submissions.data && Date.now() - cache.submissions.ts < cache.submissions.ttl) return cache.submissions.data;
    return null;
  }
  const val = cache.problems.get(key);
  if(val && Date.now() - val.ts < 9e5) return val.data;
  return null;
}
function setCache(key, data){
  if(key === 'submissions') cache.submissions = { data, ts: Date.now(), ttl: 30000 };
  else cache.problems.set(key, { data, ts: Date.now() });
}

const LANG_MAP = { 'C++':'cpp', 'C':'c', 'Python':'py', 'Java':'java', 'JavaScript':'js', 'Rust':'rs', 'Ruby':'rb' };
function detectExtension(langString){
  if(!langString) return 'txt';
  for(const k in LANG_MAP) if(langString.indexOf(k)!==-1) return LANG_MAP[k];
  return 'txt';
}

const inFlight = new Set();
const failedAttempts = new Map();

async function fetchSubmissionCode_viaExistingTab(contestId, submissionId, timeoutMs = 8000){
  try{
    const tabs = await chrome.tabs.query({ url: "https://codeforces.com/*" });
    if(!tabs || tabs.length === 0) return null;
    let targetTab = tabs.find(t => !t.discarded && !t.url.includes('chrome://')) || tabs[0];
    if(!targetTab) return null;
    const submissionUrl = `https://codeforces.com/contest/${contestId}/submission/${submissionId}`;
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: async (url, timeout) => {
        try {
          if(location.href.includes('/submission/') && location.href.includes(url.split('/').slice(-2).join('/'))){
            const el = document.querySelector('#program-source-text') || document.querySelector('.program-source') || document.querySelector('pre.prettyprint') || document.querySelector('pre');
            if(el && (el.innerText || el.textContent || '').trim()) return { ok:true, code: (el.innerText || el.textContent).trim() };
          }
          const controller = new AbortController();
          const id = setTimeout(()=>controller.abort(), timeout);
          const r = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
          clearTimeout(id);
          if(!r.ok) return { ok:false, error:`HTTP ${r.status}` };
          const html = await r.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const el2 = doc.querySelector('#program-source-text') || doc.querySelector('.program-source') || doc.querySelector('pre.prettyprint') || doc.querySelector('pre');
          const code = el2 ? (el2.textContent || el2.innerText) : null;
          return code ? { ok:true, code: code } : { ok:false, error: 'Code not found' };
        } catch(err){ return { ok:false, error: err.message }; }
      },
      args: [submissionUrl, timeoutMs]
    });
    return results?.[0]?.result?.ok ? results[0].result.code : null;
  }catch(e){ return null; }
}

async function fetchSubmissionCode_viaNewTab(contestId, submissionId, timeoutMs = 10000){
  if(inFlight.has(submissionId)) return null;
  inFlight.add(submissionId);
  let tabId = null;
  try{
    const url = `https://codeforces.com/contest/${contestId}/submission/${submissionId}`;
    const tab = await new Promise((resolve,reject)=>{
      chrome.tabs.create({ url, active: false, pinned: false }, t => {
        if(chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(t);
      });
    });
    tabId = tab.id;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(()=> { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('Timeout')); }, timeoutMs);
      function listener(updatedTabId, changeInfo) {
        if(updatedTabId !== tabId) return;
        if(changeInfo.status === 'complete') { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
    
    // FIX: Added retry loop to wait for Codeforces code block to render
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        let attempts = 0;
        while(attempts < 10) {
           const el = document.querySelector('#program-source-text') || document.querySelector('.program-source') || document.querySelector('pre');
           if (el && (el.innerText || el.textContent)) return (el.innerText || el.textContent);
           await new Promise(r => setTimeout(r, 500));
           attempts++;
        }
        return null;
      }
    });
    return results?.[0]?.result || null;
  }catch(e){ 
    console.error("fetchSubmissionCode_viaNewTab error:", e);
    return null; 
  }
  finally{ if(tabId) chrome.tabs.remove(tabId).catch(()=>{}); inFlight.delete(submissionId); }
}

async function fetchProblemStatement(contestId, problemIndex){
  try{
    const tabs = await chrome.tabs.query({ url: "https://codeforces.com/*" });
    if(tabs && tabs.length > 0){
      const targetTab = tabs[0];
      const problemUrl = `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`;
      const results = await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: async (url, timeout) => {
          try {
            if(location.href.includes('/problem/') && location.href.includes(url.split('/').slice(-2).join('/'))){
              const el = document.querySelector('.problem-statement') || document.querySelector('.problemtext') || document.querySelector('.problem');
              if(el && (el.innerHTML || '').trim()) return { ok:true, html: el.innerHTML.trim() };
            }
            const controller = new AbortController();
            const id = setTimeout(()=>controller.abort(), timeout);
            const r = await fetch(url, { credentials: 'same-origin', signal: controller.signal });
            clearTimeout(id);
            if(!r.ok) return { ok:false, error:`HTTP ${r.status}` };
            const html = await r.text();
            const doc = new DOMParser().parseFromString(html,'text/html');
            const el2 = doc.querySelector('.problem-statement') || doc.querySelector('.problemtext') || doc.querySelector('.problem');
            return el2 ? { ok:true, html: el2.innerHTML } : { ok:false, error:'Not found' };
          } catch(err) { return { ok:false, error: err.message }; }
        },
        args: [problemUrl, 6000]
      });
      if(results?.[0]?.result?.ok) return results[0].result.html;
    }
  }catch(e){ }
  let tabId = null;
  try{
    const url = `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`;
    const tab = await new Promise((resolve,reject)=>{
      chrome.tabs.create({ url, active: false, pinned: false }, t => resolve(t));
    });
    tabId = tab.id;
    await new Promise((resolve) => {
      const timer = setTimeout(()=> { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 8000);
      function listener(updatedTabId, changeInfo){ if(updatedTabId !== tabId) return; if(changeInfo.status === 'complete'){ clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); resolve(); } }
      chrome.tabs.onUpdated.addListener(listener);
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector('.problem-statement') || document.querySelector('.problemtext') || document.querySelector('.problem');
        return el ? el.innerHTML : null;
      }
    });
    return results?.[0]?.result || null;
  }catch(e){ return null; }
  finally{ if(tabId) chrome.tabs.remove(tabId).catch(()=>{}); }
}

async function fetchAcceptedSubmissions(handle, count=50){
  if(!canMakeRequest('codeforces')) throw new Error('Rate limit');
  recordRequest('codeforces');
  const r = await fetch(`https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=${count}`);
  const j = await r.json();
  if(j.status !== 'OK') throw new Error('CF API error');
  const accepted = j.result.filter(s => s.verdict === 'OK');
  return accepted.map(s => ({ contestId: s.problem.contestId || s.contestId, id: s.id, index: s.problem.index, problemName: s.problem.name, language: s.programmingLanguage }));
}

function cleanHTML(html){
  if(!html) return null;
  try{
    let e = html.replace(/<script[^>]*type=["']math\/tex["'][^>]*>(.*?)<\/script>/g,(m,c)=>`$${c.trim()}$`);
    e = e.replace(/<script[^>]*>.*?<\/script>/gs,'');
    e = e.replace(/<style[^>]*>.*?<\/style>/gs,'');
    return e;
  }catch(err){ return html; }
}

let syncing = false;
let lastProcessedSubmissionId = null;

async function syncLatest(githubToken, repoFullName, cfHandle){
  if(syncing) return;
  if(!githubToken || !repoFullName || !cfHandle) return;
  if(!isValidRepoFullName(repoFullName)) return;

  try{
    syncing = true;
    let submissions = getCache('submissions');
    if(!submissions){
      try{ submissions = await fetchAcceptedSubmissions(cfHandle, 100); setCache('submissions', submissions); }
      catch(e){ submissions = []; }
    }
    if(!submissions || submissions.length === 0) return;
    const latest = submissions[0];

    // Verify it isn't already pushed by checking storage DB!
    const res = await storageGet(['cf-synced-problems']);
    const syncedMap = res['cf-synced-problems'] || {};
    if (syncedMap[latest.id] || latest.id === lastProcessedSubmissionId) {
      return; // ALREADY PUSHED
    }

    let contestId = latest.contestId;
    const submissionId = latest.id, problemIndex = latest.index, problemName = latest.problemName, language = latest.language;
    if(Date.now() - (failedAttempts.get(submissionId) || 0) < 30_000) return;
    if(!contestId) return;

    let code = await fetchSubmissionCode_viaExistingTab(contestId, submissionId, 8000) || await fetchSubmissionCode_viaNewTab(contestId, submissionId, 10000);
    if(!code){ failedAttempts.set(submissionId, Date.now()); return; }

    const problemCacheKey = `cf-problem-${contestId}-${problemIndex}`;
    let problemHtml = getCache(problemCacheKey);
    if(!problemHtml){
      problemHtml = await fetchProblemStatement(contestId, problemIndex);
      if(problemHtml) setCache(problemCacheKey, problemHtml);
    }

    const ext = detectExtension(language || '');
    const safeTitle = (problemName || `${contestId}${problemIndex}`).replace(/[\\/:*?"<>|]+/g,'').replace(/\s+/g,'_');
    const cfg = await getConfig();
    const prefix = (cfg.pathPrefix && cfg.pathPrefix.trim()) || 'Codeforces';
    const folder = `${prefix}/${contestId}`;
    const codePath = `${folder}/${problemIndex}_${safeTitle}_solution.${ext}`;
    const readmePath = `${folder}/${problemIndex}_${safeTitle}_README.md`;
    const problemUrl = `https://codeforces.com/contest/${contestId}/problem/${problemIndex}`;
    
    const readmeContent = problemHtml ? `<h3><a href="${problemUrl}" target="_blank">${problemName}</a></h3>\n\n${cleanHTML(problemHtml)}` : `<h3><a href="${problemUrl}" target="_blank">${problemName}</a></h3>`;
    const codeContent = `// Problem: ${problemName}\n// Contest: ${contestId}\n// Link: ${problemUrl}\n// Submission id: ${submissionId}\n\n${code}`;

    if(!canMakeRequest('github')) return;
    recordRequest('github');

    let pushedReadme = false, pushedCode = false;
    try{
      await pushFileToGitHub(repoFullName, githubToken, readmePath, readmeContent, `Add ${problemName} (Statement)`); pushedReadme = true;
      await sleep(200); recordRequest('github');
      await pushFileToGitHub(repoFullName, githubToken, codePath, codeContent, `Add ${problemName} [${problemIndex}]`); pushedCode = true;
    }catch(err){ console.error('Error pushing:', err); }

    if(pushedReadme && pushedCode){
      chrome.storage.sync.get(['cf-synced-problems'], async res =>{
        const map = res['cf-synced-problems'] || {};
        map[submissionId] = { ts: Date.now(), title: problemName };
        chrome.storage.sync.set({ 'cf-synced-problems': map });
      });
      lastProcessedSubmissionId = submissionId;
    } else { failedAttempts.set(submissionId, Date.now()); }

  }catch(err){} finally{ syncing = false; }
}

async function setupPeriodicSync(){
  try{
    const cfg = await getConfig();
    if(cfg.githubToken && cfg.linkedRepo && cfg.cf_handle){
      await chrome.alarms.clear('cfPusherSync');
      chrome.alarms.create('cfPusherSync', { delayInMinutes: 0.5, periodInMinutes: 0.5 });
      await syncLatest(cfg.githubToken, cfg.linkedRepo, cfg.cf_handle);
    } else { await chrome.alarms.clear('cfPusherSync'); }
  }catch(e){ }
}

chrome.alarms.onAlarm.addListener(async alarm =>{
  if(alarm.name === 'cfPusherSync'){
    const cfg = await getConfig();
    if(cfg.githubToken && cfg.linkedRepo && cfg.cf_handle) await syncLatest(cfg.githubToken, cfg.linkedRepo, cfg.cf_handle);
  }
});
chrome.runtime.onStartup.addListener(setupPeriodicSync);
chrome.runtime.onInstalled.addListener(setupPeriodicSync);
chrome.storage.onChanged.addListener((changes, area) =>{
  if(area === 'sync' && (changes.githubToken || changes.linkedRepo || changes.cf_handle || changes.pathPrefix)) setTimeout(setupPeriodicSync, 1000);
});

// ---- MESSAGES FROM POPUP & CONTENT SCRIPT ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  
  if (msg.action === 'authenticate') {
    // 1. Keep your Client ID to open the login window, but the Secret is completely REMOVED!
    const CLIENT_ID = "Ov23liHDX7AZD7tHScJS"; 
    
    const redirectUri = chrome.identity.getRedirectURL(); 
    const authUrl = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo`;

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, async (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        sendResponse({ success: false, error: "Login window closed or failed." });
        return;
      }
      const urlParams = new URLSearchParams(new URL(responseUrl).search);
      const code = urlParams.get('code');

      if (code) {
        try {
          // 2. Send the code to YOUR new Vercel proxy server!
          const tokenRes = await fetch("https://cf-github-link.vercel.app/api/authenticate", {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            // Notice we only send the code now. The server handles the secret.
            body: JSON.stringify({ code: code }) 
          });
          
          const tokenData = await tokenRes.json();
          
          if (tokenData.access_token) {
            await storageSet({ githubToken: tokenData.access_token });
            await chrome.storage.local.set({ githubToken: tokenData.access_token });
            sendResponse({ success: true });
          } else { 
            sendResponse({ success: false, error: "Failed to get token from server." }); 
          }
        } catch (err) { 
          sendResponse({ success: false, error: err.message }); 
        }
      } else { 
        sendResponse({ success: false, error: "No code found." }); 
      }
    });
    return true; 
  }

  if (msg.action === 'getCFHandle') {
    fetch("https://codeforces.com/")
    .then(res => res.text())
    .then(html => {
      const match = html.match(/\/profile\/([a-zA-Z0-9_-]+)/);
      if (match && match[1] && match[1] !== 'Register' && match[1] !== 'Enter') { sendResponse({ success: true, handle: match[1] }); } 
      else { sendResponse({ success: false }); }
    }).catch(err => sendResponse({ success: false }));
    return true;
  }

  // --- FORCE MANUAL SYNC LOGIC ---
  if(msg.action === 'manualSync'){
    getConfig().then(cfg=>{
      if(cfg.githubToken && cfg.linkedRepo && cfg.cf_handle){
        
        // FORCIBLY CLEAR MEMORY TO ALLOW PUSHING THE LAST PROBLEM AGAIN
        lastProcessedSubmissionId = null;
        failedAttempts.clear();
        cache.submissions = { data: null, ts: 0, ttl: 30000 };
        syncing = false; 

        syncLatest(cfg.githubToken, cfg.linkedRepo, cfg.cf_handle)
          .then(()=> sendResponse({ success:true }))
          .catch(e=> sendResponse({ success:false, error: e.message }));
          
      } else sendResponse({ success:false, error:'Missing credentials' });
    });
    return true;
  }

  if(msg.action === 'triggerImmediateSync'){
    getConfig().then(cfg=> { if(cfg.githubToken && cfg.linkedRepo && cfg.cf_handle){ cache.submissions = { data:null, ts:0 }; syncLatest(cfg.githubToken, cfg.linkedRepo, cfg.cf_handle); } });
    return;
  }

  if(msg.action === 'cf_submission_detected' && msg.submissionId){
    const submissionId = String(msg.submissionId);
    
    // PREVENT DUPLICATES: Check Chrome Storage directly before proceeding
    chrome.storage.sync.get(['cf-synced-problems'], async (res) => {
      const syncedMap = res['cf-synced-problems'] || {};
      if (syncedMap[submissionId] || submissionId === lastProcessedSubmissionId || inFlight.has(submissionId)) {
        console.log("Duplicate blocked: Already pushed", submissionId);
        return; // HALT DUPLICATE
      }
      
      lastProcessedSubmissionId = submissionId; 
      try {
        console.log(`Processing submission: ${submissionId}`);
        const cfg = await getConfig();
        if(!cfg.githubToken || !cfg.linkedRepo || !cfg.cf_handle || !isValidRepoFullName(cfg.linkedRepo) || !msg.contestId) {
            console.error("Missing config or invalid repo name. Push aborted.", cfg);
            return;
        }
        
        let code = await fetchSubmissionCode_viaExistingTab(msg.contestId, submissionId, 8000) || await fetchSubmissionCode_viaNewTab(msg.contestId, submissionId, 10000);
        
        if(!code) {
            console.error("Code extraction failed! Codeforces returned null.");
            return;
        }
        
        const name = msg.problemName || `${msg.contestId}_${msg.problemIndex || 'A'}`;
        const ext = detectExtension(msg.language || 'txt');
        const prefix = (cfg.pathPrefix && cfg.pathPrefix.trim()) || 'Codeforces';
        const safeTitle = (name).replace(/[\\/:*?"<>|]+/g,'').replace(/\s+/g,'_');
        const codePath = `${prefix}/${msg.contestId}/${msg.problemIndex || 'A'}_${safeTitle}_solution.${ext}`;
        const codeContent = `// Problem: ${name}\n// Contest: ${msg.contestId}\n// Submission id: ${submissionId}\n\n${code}`;
        
        recordRequest('github');
        console.log(`Attempting to push to GitHub path: ${codePath}`);
        
        // FIX: The error is actually caught and logged now if GitHub fails
        await pushFileToGitHub(cfg.linkedRepo, cfg.githubToken, codePath, codeContent, `Add ${name}`);
        
        console.log("Successfully pushed to GitHub!");
        
        // Save to storage lock so it NEVER pushes again
        syncedMap[submissionId] = { ts: Date.now(), title: name };
        await chrome.storage.sync.set({ 'cf-synced-problems': syncedMap });
      } catch(e) { 
        // FIX: Silent crash is gone. You will see the error in the background console!
        console.error("CRITICAL ERROR pushing to GitHub:", e); 
      }
    });
    return;
  }
});