// popup.js 

(() => {
  const $ = id => document.getElementById(id);

  function notify(msg, time = 2000) {
    let el = $('notify');
    if (!el) {
      el = document.createElement('div');
      el.id = 'notify';
      el.style.position = 'fixed';
      el.style.right = '12px';
      el.style.bottom = '12px';
      el.style.padding = '8px 12px';
      el.style.background = '#222';
      el.style.color = '#fff';
      el.style.borderRadius = '6px';
      el.style.boxShadow = '0 6px 18px rgba(0,0,0,0.15)';
      el.style.zIndex = '9999';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    setTimeout(() => { el.style.opacity = '0'; }, time);
  }

  function promisifyStorageGet(keys) {
    return new Promise(resolve => { chrome.storage.sync.get(keys, res => resolve(res || {})); });
  }

  function promisifyStorageSet(obj) {
    return new Promise(resolve => { chrome.storage.sync.set(obj, () => resolve()); });
  }

  function wireButtons() {
    if ($('save')) $('save').addEventListener('click', onSave);
    if ($('sync')) $('sync').addEventListener('click', onManualSync);
    if ($('loginBtn')) $('loginBtn').addEventListener('click', onLogin);
  }

  async function autoFetchCFHandle() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: "getCFHandle" }, (response) => {
        if (response && response.success) {
          resolve(response.handle);
        } else {
          resolve(null);
        }
      });
    });
  }

  async function loadSettings() {
    const keys = ['githubToken', 'linkedRepo', 'cf_handle', 'solves', 'cf-synced-problems'];
    const res = await promisifyStorageGet(keys);

    if (res.githubToken) {
      if ($('loginBtn')) {
        $('loginBtn').textContent = " GitHub Connected";
        $('loginBtn').style.background = "#27ae60";
        $('loginBtn').disabled = true;
      }
    }
    
    // Display the full URL to the user, even though we store "owner/repo"
    if (res.linkedRepo && $('repo')) {
      $('repo').value = `https://github.com/${res.linkedRepo}`;
    }

    if (!res.cf_handle) {
      const detectedHandle = await autoFetchCFHandle();
      if (detectedHandle) {
        await promisifyStorageSet({ cf_handle: detectedHandle });
      }
    }

    refreshStatsFromStorage(res);
  }

  function onLogin() {
    const loginBtn = $('loginBtn');
    loginBtn.textContent = "Connecting to GitHub...";
    loginBtn.disabled = true;

    chrome.runtime.sendMessage({ action: "authenticate" }, (response) => {
      if (response && response.success) {
        notify("Successfully Connected to GitHub!");
        loadSettings(); 
      } else {
        loginBtn.textContent = "Connect to GitHub";
        loginBtn.disabled = false;
        notify("Login failed or window closed.");
      }
    });
  }

  async function onSave() {
    let repoInput = $('repo') ? $('repo').value.trim() : '';

    if (!repoInput) {
      notify('Please enter your GitHub repository URL.');
      return;
    }

    // Extract "owner/repo" from the full URL safely
    let repoRaw = repoInput;
    if (repoRaw.startsWith('http') || repoRaw.includes('github.com')) {
       try {
         const urlObj = new URL(repoRaw.startsWith('http') ? repoRaw : 'https://' + repoRaw);
         repoRaw = urlObj.pathname.replace(/^\/|\/$/g, ''); // Removes leading/trailing slashes
         if (repoRaw.endsWith('.git')) repoRaw = repoRaw.slice(0, -4); // Remove .git if present
       } catch(e) {}
    }

    if (repoRaw.split("/").length !== 2) {
      notify('Invalid URL. Must be: https://github.com/owner/repo');
      return;
    }

    let handle = (await promisifyStorageGet(['cf_handle'])).cf_handle;
    if (!handle) handle = await autoFetchCFHandle();

    // Save formatted "owner/repo" to storage
    await promisifyStorageSet({ 
      linkedRepo: repoRaw, 
      cf_handle: handle || "unknown", 
      pathPrefix: "Codeforces" 
    });
    
    notify('Settings saved!');
    
    // Reformat input field to show full URL immediately
    if ($('repo')) $('repo').value = `https://github.com/${repoRaw}`;

    try { chrome.runtime.sendMessage({ action: 'triggerImmediateSync' }); } catch {}
  }

  function onManualSync() {
    notify('Starting manual sync…');
    chrome.runtime.sendMessage({ action: 'manualSync' }, (resp) => {
      if (resp && resp.success) notify('Manual sync succeeded!');
      else notify('Manual sync failed.');
      setTimeout(loadSettings, 800);
    });
  }

  function refreshStatsFromStorage(store) {
    const solves = store.solves || null;
    const syncedMap = store['cf-synced-problems'] || null;

    let total = 0, recent = [];

    if (Array.isArray(solves) && solves.length > 0) {
      total = solves.length;
      recent = solves.slice(0, 8);
    } else if (syncedMap && typeof syncedMap === 'object') {
      const ids = Object.keys(syncedMap || {});
      total = ids.length;
      recent = ids.slice().reverse().slice(0, 8).map(id => ({ title: `submission ${id}`, date: '' }));
    }

    if ($('total')) $('total').textContent = total;
    
    let streak = 0;
    if (Array.isArray(solves) && solves.length > 0) {
      const dates = new Set(solves.map(s => (new Date(s.date)).toISOString().slice(0,10)));
      let d = new Date();
      while (true) {
        if (dates.has(d.toISOString().slice(0,10))) {
          streak++; d.setDate(d.getDate() - 1);
        } else break;
      }
    }
    if ($('streak')) $('streak').textContent = streak;

    const lastUl = $('last');
    if (lastUl) {
      lastUl.innerHTML = '';
      if (recent.length === 0) {
        const li = document.createElement('li');
        li.textContent = 'No solves yet';
        lastUl.appendChild(li);
      } else {
        recent.forEach(s => {
          const li = document.createElement('li');
          li.textContent = s.title || s.submissionId || 'Unknown';
          lastUl.appendChild(li);
        });
      }
    }
  }

  function init() {
    wireButtons();
    loadSettings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && (changes.solves || changes['cf-synced-problems'])) {
        promisifyStorageGet(['solves','cf-synced-problems']).then(refreshStatsFromStorage);
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();