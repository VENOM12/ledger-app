const { app, BrowserWindow, Menu, ipcMain, safeStorage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { autoUpdater } = require('electron-updater');
const nodemailer = require('nodemailer');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0A0A12',
    title: 'Restock',
    icon: path.join(__dirname, 'icon.ico'),
    // Replaces the plain default Windows title bar with one matching the
    // app's dark theme, while keeping the real minimize/maximize/close
    // buttons (with Windows 11 snap-layout hover menu etc.) — just recolored.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0D0D16',
      symbolColor: '#EDEDF5',
      height: 40
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile('index.html');
  setupAutoUpdater();
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* =========================================================
   Auto-updater
   Uses electron-builder's GitHub-releases provider. This only
   does anything once you (a) fill in the real owner/repo under
   "build.publish" in package.json, and (b) publish a release
   there with `electron-builder --publish always`. Until then,
   checks simply fail quietly — see README.
   ========================================================= */

function sendUpdateStatus(status, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, data: data || null });
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return; // updater APIs error out on unpackaged dev builds

  // Don't download automatically — wait for the person to say "Update Now"
  // in the popup, so it's their choice whether to spend the bandwidth/time.
  autoUpdater.autoDownload = false;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus('none'));
  autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err ? (err.message || String(err)) : 'Unknown error' }));
  autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('downloaded', { version: info.version }));

  // Quiet check shortly after launch; ignore failures (e.g. no publish config yet).
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 4000);
}

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { ok: false, error: 'Updates only run in a packaged build, not "npm start".' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('updater:download', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall();
  return { ok: true };
});

ipcMain.handle('app:getVersion', () => app.getVersion());

/* =========================================================
   Email account storage
   The IMAP password is encrypted at rest using Electron's
   safeStorage, which is backed by the OS keychain (Windows
   Credential Manager / DPAPI on Windows). It never touches
   the renderer or gets written to the app's regular JSON state.
   ========================================================= */

// ---------------- Licensing (Whop activation) ----------------
//
// The API key lives in a separate, gitignored file (whop-config.js) so it
// never ends up in the public GitHub repo — the build still bundles it
// fine since electron-builder packages whatever's on disk locally,
// gitignore only affects what gets pushed to GitHub.
let WHOP_CONFIG = { WHOP_API_KEY: null };
try { WHOP_CONFIG = require('./whop-config.js'); } catch (e) { /* not configured yet */ }

const REVALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // re-check with Whop once a week

function licenseFilePath() {
  return path.join(app.getPath('userData'), 'license.json');
}

function loadLicenseState() {
  try {
    const raw = fs.readFileSync(licenseFilePath(), 'utf-8');
    const data = JSON.parse(raw);
    if (data.encryptedKey && safeStorage.isEncryptionAvailable()) {
      data.licenseKey = safeStorage.decryptString(Buffer.from(data.encryptedKey, 'base64'));
    }
    return data;
  } catch (e) {
    return null;
  }
}

function saveLicenseState({ licenseKey, machineId, activated, lastValidatedAt, expiresAt }) {
  const data = { machineId, activated, lastValidatedAt, expiresAt: expiresAt || null };
  if (safeStorage.isEncryptionAvailable()) {
    data.encryptedKey = safeStorage.encryptString(licenseKey).toString('base64');
  } else {
    data.licenseKey = licenseKey;
  }
  fs.writeFileSync(licenseFilePath(), JSON.stringify(data), 'utf-8');
}

// A random ID generated once and stored locally — simpler and more
// privacy-respecting than fingerprinting real hardware, and it still lets
// Whop bind a key to "this specific install" the same way.
function getOrCreateMachineId() {
  const existing = loadLicenseState();
  if (existing && existing.machineId) return existing.machineId;
  return crypto.randomUUID();
}

async function validateWithWhop(licenseKey, machineId) {
  if (!WHOP_CONFIG.WHOP_API_KEY) {
    return { ok: false, error: 'config', message: 'This build is missing its Whop configuration. Contact support.' };
  }
  try {
    const resp = await fetch(`https://api.whop.com/api/v2/memberships/${encodeURIComponent(licenseKey)}/validate_license`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHOP_CONFIG.WHOP_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ metadata: { machine_id: machineId } })
    });
    if (resp.status === 201) {
      // Whop returns expires_at and renewal_period_end as Unix timestamps
      // (seconds) — expires_at is the more direct "when this membership
      // actually ends" field, but isn't always set for an active
      // subscription, so renewal_period_end is kept as a fallback.
      let expiresAt = null;
      try {
        const body = await resp.json();
        const raw = body.expires_at || body.renewal_period_end || null;
        if (raw) expiresAt = new Date(raw * 1000).toISOString().slice(0, 10);
      } catch (e) { /* body parsing is best-effort — activation still succeeded */ }
      return { ok: true, expiresAt };
    }
    if (resp.status === 400) return { ok: false, error: 'invalid', message: 'That key isn\'t valid, or it\'s already active on a different computer.' };
    return { ok: false, error: 'unexpected', message: `Unexpected response from the activation server (${resp.status}).` };
  } catch (e) {
    return { ok: false, error: 'network', message: 'Couldn\'t reach the activation server — check your internet connection and try again.' };
  }
}

ipcMain.handle('license:getStatus', () => {
  const state = loadLicenseState();
  if (!state || !state.activated) return { activated: false };
  const needsRevalidation = !state.lastValidatedAt || (Date.now() - new Date(state.lastValidatedAt).getTime()) > REVALIDATE_INTERVAL_MS;
  return { activated: true, needsRevalidation, expiresAt: state.expiresAt || null };
});

ipcMain.handle('license:activate', async (evt, { licenseKey }) => {
  const key = (licenseKey || '').trim();
  if (!key) return { ok: false, error: 'Enter a license key.' };
  const machineId = getOrCreateMachineId();
  const result = await validateWithWhop(key, machineId);
  if (result.ok) {
    saveLicenseState({ licenseKey: key, machineId, activated: true, lastValidatedAt: new Date().toISOString(), expiresAt: result.expiresAt });
    return { ok: true };
  }
  return { ok: false, error: result.message };
});

ipcMain.handle('license:revalidate', async () => {
  const state = loadLicenseState();
  if (!state || !state.activated || !state.licenseKey) return { ok: false, error: 'not_activated' };
  const result = await validateWithWhop(state.licenseKey, state.machineId);
  if (result.ok) {
    saveLicenseState({ licenseKey: state.licenseKey, machineId: state.machineId, activated: true, lastValidatedAt: new Date().toISOString(), expiresAt: result.expiresAt });
    return { ok: true, expiresAt: result.expiresAt };
  }
  if (result.error === 'network' || result.error === 'config' || result.error === 'unexpected') {
    // Don't lock someone out just because we couldn't reach the server —
    // only an explicit "invalid" response from Whop revokes access.
    return { ok: false, error: result.error };
  }
  saveLicenseState({ licenseKey: state.licenseKey, machineId: state.machineId, activated: false, lastValidatedAt: new Date().toISOString(), expiresAt: state.expiresAt });
  return { ok: false, error: result.error, message: result.message };
});

ipcMain.handle('shell:openExternal', (evt, url) => {
  if (/^https:\/\//i.test(url)) shell.openExternal(url);
});

function accountFilePath() {
  return path.join(app.getPath('userData'), 'email-account.json'); // old single-account format, read once for migration
}
function accountsFilePath() {
  return path.join(app.getPath('userData'), 'email-accounts.json');
}

function loadAccounts() {
  try {
    const raw = fs.readFileSync(accountsFilePath(), 'utf-8');
    const data = JSON.parse(raw);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    let needsSave = false;
    accounts.forEach(acc => {
      if (acc.encryptedPassword && safeStorage.isEncryptionAvailable()) {
        acc.password = safeStorage.decryptString(Buffer.from(acc.encryptedPassword, 'base64'));
      }
      if (!Array.isArray(acc.catchAllDomains)) acc.catchAllDomains = [];
      if (!Array.isArray(acc.processedMessageIds)) acc.processedMessageIds = [];
      // Accounts connected before invoice-sending existed have no SMTP
      // settings saved at all — this is exactly why "no account has
      // sending set up" showed even for a genuinely connected account.
      // Derived here from the same known provider host patterns the
      // connect form itself uses, so an existing account doesn't need to
      // be manually reconnected just to gain this.
      if (!acc.smtpHost) {
        const smtpMap = {
          'imap.gmail.com': 'smtp.gmail.com',
          'outlook.office365.com': 'smtp.office365.com',
          'imap.mail.yahoo.com': 'smtp.mail.yahoo.com',
          'imap.mail.me.com': 'smtp.mail.me.com'
        };
        const derived = smtpMap[acc.host];
        if (derived) {
          acc.smtpHost = derived;
          acc.smtpPort = 587;
          acc.smtpSecure = false;
          needsSave = true;
        }
      }
    });
    if (needsSave) {
      saveAccounts(accounts.map(a => { const { password, ...rest } = a; return rest; }));
    }
    return accounts;
  } catch (e) {
    // No multi-account file yet — check for the old single-account format
    // and migrate it in, so upgrading doesn't silently disconnect anyone's
    // existing email connection.
    try {
      const raw = fs.readFileSync(accountFilePath(), 'utf-8');
      const old = JSON.parse(raw);
      const migrated = [{
        id: 'acc_' + Date.now().toString(36),
        email: old.email, host: old.host, port: old.port, secure: old.secure,
        encryptedPassword: old.encryptedPassword, password: old.password, unencrypted: old.unencrypted,
        catchAllDomains: Array.isArray(old.catchAllDomains) ? old.catchAllDomains : (old.catchAllEmail ? [old.catchAllEmail] : []),
        processedMessageIds: Array.isArray(old.processedMessageIds) ? old.processedMessageIds : []
      }];
      saveAccounts(migrated);
      if (migrated[0].encryptedPassword && safeStorage.isEncryptionAvailable()) {
        migrated[0].password = safeStorage.decryptString(Buffer.from(migrated[0].encryptedPassword, 'base64'));
      }
      return migrated;
    } catch (e2) {
      return [];
    }
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(accountsFilePath(), JSON.stringify({ accounts }), 'utf-8');
}

function addAccount({ email, host, port, secure, password, catchAllDomains, smtpHost, smtpPort, smtpSecure }) {
  const accounts = loadAccounts();
  const account = {
    id: 'acc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    email, host, port, secure, catchAllDomains: catchAllDomains || [], processedMessageIds: [],
    smtpHost: smtpHost || '', smtpPort: smtpPort || 587, smtpSecure: !!smtpSecure
  };
  if (safeStorage.isEncryptionAvailable()) {
    account.encryptedPassword = safeStorage.encryptString(password).toString('base64');
  } else {
    account.password = password;
    account.unencrypted = true;
  }
  accounts.push(account);
  saveAccounts(accounts.map(a => { const { password, ...rest } = a; return rest; })); // never persist decrypted password field
  return account;
}

function removeAccountById(id) {
  const accounts = loadAccounts();
  const filtered = accounts.filter(a => a.id !== id);
  saveAccounts(filtered.map(a => { const { password, ...rest } = a; return rest; }));
  return filtered.length !== accounts.length;
}

function patchAccountById(id, patch) {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === id);
  if (!account) return false;
  Object.assign(account, patch);
  saveAccounts(accounts.map(a => { const { password, ...rest } = a; return rest; }));
  return true;
}

// Returns every connected account (never includes passwords — only what
// the renderer needs to display and manage each connection).
ipcMain.handle('email:getAccounts', () => {
  return loadAccounts().map(a => ({
    id: a.id, email: a.email, host: a.host, port: a.port, secure: a.secure,
    catchAllDomains: a.catchAllDomains || [], lastSyncISO: a.lastSyncISO || null,
    smtpHost: a.smtpHost || '', smtpPort: a.smtpPort || 587, smtpSecure: !!a.smtpSecure
  }));
});

// Adds a NEW account alongside any already connected — tests the
// connection first, same as before, just appends rather than replacing.
ipcMain.handle('email:addAccount', async (evt, { email, password, host, port, secure, catchAllDomains, smtpHost, smtpPort, smtpSecure }) => {
  const client = new ImapFlow({
    host, port, secure,
    auth: { user: email, pass: password },
    logger: false
  });
  try {
    await client.connect();
    await client.logout();
    const account = addAccount({ email, host, port, secure, password, catchAllDomains, smtpHost, smtpPort, smtpSecure });
    return { ok: true, id: account.id };
  } catch (err) {
    return { ok: false, error: humanizeImapError(err) };
  }
});

ipcMain.handle('email:updateAccountCatchAll', (evt, { id, catchAllDomains }) => {
  const ok = patchAccountById(id, { catchAllDomains: catchAllDomains || [] });
  return { ok };
});

ipcMain.handle('email:removeAccount', (evt, { id }) => {
  const ok = removeAccountById(id);
  return { ok };
});

// Clears the "already looked at this" tracking AND the last-synced
// timestamp, forcing the next sync to look back 48 hours regardless of
// whether messages in that window were already marked seen — not just
// new mail. A 90-day fallback (the previous behavior) is thorough but
// slow; 48 hours is enough to catch a recent status-update email (shipped
// → out for delivery → delivered) that arrived after a detection fix,
// without re-scanning months of already-settled history every time. This
// is the same button every user already has, not a one-off fix for any
// single account. Re-processing an email that was already correctly
// merged in is safe and won't create duplicates or extra sales — the
// merge logic itself (matching by order number for orders, and by
// sender+date+amount for sales) is what actually prevents duplicates, not
// the "already seen" tracking this clears.
ipcMain.handle('email:resetTracking', (evt, { id }) => {
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const ok = patchAccountById(id, { processedMessageIds: [], lastSyncISO: fortyEightHoursAgo });
  return { ok };
});

// Core per-account sync — unchanged logic from the single-account version,
// just extracted so it can run once per connected account. Returns results
// scoped to this one account; never throws, always resolves with an ok flag.
async function syncOneAccount(acc, { blockPromotions, excludeList, rules }) {
  if (!acc.password) return { ok: false, error: 'No password available for this account.', accountId: acc.id };
  const seenMessageIds = new Set(acc.processedMessageIds || []);

  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: acc.secure,
    auth: { user: acc.email, pass: acc.password },
    logger: false
  });

  const results = [];
  const expenseResults = [];
  const newlySeenIds = [];
  const KEYWORDS = /(order|shipped|shipment|delivered|delivery|arriv|tracking|confirmation|receipt|out for delivery|sold|sale|payout|paid|payment received)/i;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Always look back at least 24 hours, even if the last sync was
      // more recent than that — a rolling safety window, so a transient
      // issue (or a classification bug that's since been fixed) doesn't
      // permanently miss something. Message-ID dedup still prevents this
      // from reprocessing anything already successfully handled.
      const sinceFromLastSync = acc.lastSyncISO ? new Date(acc.lastSyncISO) : new Date(Date.now() - 90 * 86400000);
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const since = sinceFromLastSync < twentyFourHoursAgo ? sinceFromLastSync : twentyFourHoursAgo;

      const baseUids = await client.search({ since });
      const forceProcess = new Set();

      if (acc.catchAllDomains && acc.catchAllDomains.length) {
        for (const domain of acc.catchAllDomains) {
          try {
            const catchAllUids = await client.search({ since, to: domain });
            catchAllUids.forEach(u => forceProcess.add(u));
          } catch (e) {
            // Some servers don't support this search key well — skip silently.
          }
        }
      }

      // Expense-rule senders need force-processing the same way catch-all
      // domains do — a subscription receipt or invoice email might not
      // contain any of the order-related KEYWORDS at all, so it would
      // otherwise get skipped before ever being fetched.
      if (rules.length) {
        for (const rule of rules) {
          try {
            const ruleUids = await client.search({ since, from: rule.senderPattern });
            ruleUids.forEach(u => forceProcess.add(u));
          } catch (e) {
            // Some servers don't support this search key well — skip silently.
          }
        }
      }

      const capped = baseUids.slice(-300);
      const uidsToInspect = new Set([...capped, ...forceProcess]);

      for (const uid of uidsToInspect) {
        let envMsg;
        try { envMsg = await client.fetchOne(uid, { envelope: true }); } catch (e) { continue; }
        if (!envMsg || !envMsg.envelope) continue;

        // Cheapest possible skip: the envelope fetch alone tells us the
        // message's stable, globally-unique Message-ID — no need to fetch
        // and parse the full body again for something we've already seen.
        const messageId = envMsg.envelope.messageId || null;
        if (messageId && seenMessageIds.has(messageId)) continue;

        const subject = envMsg.envelope.subject || '';
        const subjectMatches = KEYWORDS.test(subject);
        if (!subjectMatches && !forceProcess.has(uid)) continue;

        let full;
        try { full = await client.fetchOne(uid, { source: true }); } catch (e) { continue; }
        if (!full || !full.source) continue;

        let parsed;
        try { parsed = await simpleParser(full.source); } catch (e) { continue; }

        const fromAddr = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
        const fromEmail = (fromAddr.address || '').toLowerCase();

        if (fromEmail && excludeList.some(ex => fromEmail.includes(ex))) {
          if (messageId) newlySeenIds.push(messageId); // deliberately blocked — a definitive outcome, safe to remember
          continue;
        }

        // mailparser normally auto-generates parsed.text even for
        // HTML-only emails, but falling back to raw parsed.html directly
        // is a real risk if that's ever unavailable — RAW HTML carries
        // CSS class names, hidden ARIA labels, and tracking URLs that can
        // false-match keyword regexes against text nobody actually sees.
        // Confirmed directly: a real eBay sale email's own CSS class
        // ".couponCode" and template accessibility label "eBay Newsletter"
        // both matched the promotional-content filter, despite the
        // visible email having nothing promotional in it at all. Stripped
        // here as a safety net specifically for the html fallback path.
        // Confirmed directly against real data: a real Pokémon Center
        // email's text/plain part parsed to just "\n" — whitespace, but
        // still truthy in JavaScript, so `parsed.text ? ... : ...` was
        // using that near-empty text directly and never falling back to
        // the HTML at all, silently losing every bit of actual content
        // (including the order number) despite the HTML being perfectly
        // parseable. Checking for meaningfully non-empty text instead of
        // just truthy fixes this.
        const bodyText = (parsed.text && parsed.text.toString().trim().length > 0) ? parsed.text.toString() : stripHtmlToText(parsed.html || '');

        // Expense-rule match takes priority over everything else — these
        // are never orders, only expenses, regardless of what the email
        // text itself might otherwise look like. Skips the promotional
        // filter too, since a legitimate invoice/receipt can innocently
        // carry an unsubscribe link without actually being unwanted noise.
        const matchedRule = fromEmail ? rules.find(r => fromEmail.includes(r.senderPattern)) : null;
        if (matchedRule) {
          const amtMatch = bodyText.match(/(?<!sub)\btotal\*?(?!\s*includes)[\s\S]{0,15}?[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i) ||
                            bodyText.match(/[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/);
          const amount = amtMatch ? parseFloat(amtMatch[1].replace(',', '')) : null;
          expenseResults.push({
            amount, tag: matchedRule.tag, description: subject,
            date: (parsed.date || envMsg.envelope.date || new Date()).toISOString(),
            fromEmail
          });
          if (messageId) newlySeenIds.push(messageId); // successfully handled as an expense
          continue;
        }

        if (blockPromotions && looksPromotional(subject, bodyText, parsed.headers)) {
          if (messageId) newlySeenIds.push(messageId); // deliberately filtered as promotional — a definitive outcome
          continue;
        }

        const toAddr = (parsed.to && parsed.to.value && parsed.to.value[0]) || {};

        const classified = classifyEmail({
          subject,
          bodyText,
          fromName: fromAddr.name || '',
          fromEmail: fromAddr.address || '',
          toEmail: toAddr.address || '',
          date: (parsed.date || envMsg.envelope.date || new Date()).toISOString()
        });
        if (classified) {
          results.push(classified);
          if (messageId) newlySeenIds.push(messageId); // successfully classified — a definitive outcome
        }
        // If classification returned null, deliberately NOT marking this
        // seen — an email that doesn't match anything today stays
        // eligible for re-examination on future syncs, in case a later
        // fix changes that outcome. This is exactly the bug that caused a
        // real PKC preorder to stop being detected: it was marked "seen"
        // the moment it was parsed, regardless of whether classification
        // actually succeeded, so a since-fixed bug in classifyEmail could
        // never get a second chance at the same email.
      }
    } finally {
      lock.release();
    }
    await client.logout();

    if (newlySeenIds.length) {
      const combined = [...seenMessageIds, ...newlySeenIds];
      // Cap the tracked list so this file doesn't grow forever — a
      // reseller's inbox won't realistically need more than the most
      // recent few hundred remembered at once.
      const trimmed = combined.slice(-500);
      patchAccountById(acc.id, { processedMessageIds: trimmed, lastSyncISO: new Date().toISOString() });
    } else {
      patchAccountById(acc.id, { lastSyncISO: new Date().toISOString() });
    }

    return { ok: true, results, expenseResults, accountId: acc.id };
  } catch (err) {
    try { await client.logout(); } catch (e) { /* ignore */ }
    return { ok: false, error: humanizeImapError(err), accountId: acc.id };
  }
}

ipcMain.handle('email:sync', async (evt, { blockPromotions, excludedSenders, expenseRules }) => {
  const accounts = loadAccounts();
  if (!accounts.length) return { ok: false, error: 'No email account connected.' };
  const excludeList = (excludedSenders || []).map(s => s.toLowerCase()).filter(Boolean);
  const rules = (expenseRules || []).map(r => ({ senderPattern: (r.senderPattern || '').toLowerCase(), tag: r.tag }));

  // Each account keeps its own since/lastSyncISO and processedMessageIds,
  // so one account's sync history never affects another's — syncing them
  // one at a time (not in parallel) keeps this simple and avoids opening
  // many simultaneous IMAP connections at once, which some providers rate
  // limit or reject.
  const allResults = [];
  const allExpenseResults = [];
  const accountErrors = [];

  for (const acc of accounts) {
    const outcome = await syncOneAccount(acc, { blockPromotions, excludeList, rules });
    if (outcome.ok) {
      allResults.push(...outcome.results);
      allExpenseResults.push(...outcome.expenseResults);
    } else {
      // One account having trouble (wrong password now, server down,
      // etc.) shouldn't stop the others from syncing — collected and
      // surfaced together so the renderer can show which one needs
      // attention without losing results from accounts that worked fine.
      accountErrors.push({ accountId: acc.id, email: acc.email, error: outcome.error });
    }
  }

  if (allResults.length === 0 && allExpenseResults.length === 0 && accountErrors.length === accounts.length) {
    // every single account failed — surface the first error directly
    // rather than a generic message, most useful when there's only one
    // account connected anyway.
    return { ok: false, error: accountErrors[0].error, accountErrors };
  }

  return { ok: true, results: allResults, expenseResults: allExpenseResults, accountErrors };
});

// Renders an HTML invoice to a real PDF using Electron's own built-in
// Chromium engine — no separate PDF library needed. Loads the HTML into
// a hidden, offscreen window, waits for it to finish rendering, then
// asks Chromium's own print pipeline for a PDF of the page. Lets the
// user pick where to save via a native save dialog, standard for a
// desktop app's "export" action.
ipcMain.handle('invoice:exportPdf', async (evt, { html, suggestedName }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Invoice PDF',
    defaultPath: suggestedName || 'invoice.pdf',
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { ok: false, cancelled: true };

  // Deliberately NOT offscreen — that combination has known
  // compatibility problems with printToPDF specifically (well-documented
  // in the Electron community: blank or failed PDFs). A plain hidden
  // window works reliably for this. Margins are handled by the
  // template's own CSS padding instead of the printToPDF margins option,
  // since that option's exact expected format has changed across
  // Electron versions and getting it wrong risks the whole call failing.
  const pdfWindow = new BrowserWindow({ show: false });
  try {
    await pdfWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdfBuffer = await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4'
    });
    fs.writeFileSync(filePath, pdfBuffer);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not generate PDF' };
  } finally {
    pdfWindow.destroy();
  }
});

// Generates the PDF the same way as export, but keeps it as a Buffer to
// attach directly to an outgoing email instead of writing it to a
// user-chosen location — used by the "send by email" flow.
async function renderInvoicePdfBuffer(html) {
  const pdfWindow = new BrowserWindow({ show: false });
  try {
    await pdfWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    return await pdfWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4'
    });
  } finally {
    pdfWindow.destroy();
  }
}

// Sends an invoice PDF by email using the same account credentials
// already stored for IMAP, just pointed at that provider's SMTP server
// instead — most providers use the same login for both. Needs an app
// password with SMTP permission enabled, same as IMAP sync does.
ipcMain.handle('invoice:sendEmail', async (evt, { accountId, toEmail, subject, bodyText, invoiceHtml, pdfFileName }) => {
  const accounts = loadAccounts();
  const account = accounts.find(a => a.id === accountId);
  if (!account) return { ok: false, error: 'That email account is no longer connected.' };
  if (!account.smtpHost) return { ok: false, error: 'This account has no SMTP server configured — try reconnecting it, or use a different account.' };
  if (!account.password) return { ok: false, error: 'No password available for this account.' };

  try {
    const pdfBuffer = await renderInvoicePdfBuffer(invoiceHtml);
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort || 587,
      secure: !!account.smtpSecure,
      auth: { user: account.email, pass: account.password }
    });
    await transporter.sendMail({
      from: account.email,
      to: toEmail,
      subject,
      text: bodyText,
      attachments: [{ filename: pdfFileName || 'invoice.pdf', content: pdfBuffer }]
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Could not send the email.' };
  }
});


// Lightweight fallback text extraction for when parsed.text isn't
// available — strips <style>/<script> blocks entirely (their content is
// never visible to a real reader, but is exactly where things like CSS
// class names live that can accidentally contain keyword-like text), then
// strips remaining tags, leaving just the visible text. Not a full
// HTML-to-text engine, but far safer than matching against raw markup.
function stripHtmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function looksPromotional(subject, bodyText, headers) {
  // Real order/shipping emails essentially never carry a List-Unsubscribe
  // header — that's a marketing-platform signature (Mailchimp, Klaviyo, etc).
  try {
    if (headers && typeof headers.has === 'function') {
      if (headers.has('list-unsubscribe') || headers.has('list-unsubscribe-post')) return true;
    }
  } catch (e) { /* ignore malformed headers */ }

  const hay = (subject + ' ' + bodyText).toLowerCase();
  // 'unsubscribe' deliberately removed from here — confirmed on a real
  // eBay "you made a sale" email that it has a completely standard
  // transactional footer ("...email preferences, unsubscribe or learn
  // about account protection"), which silently discarded the entire
  // email before classification ever got a chance to run. Almost any
  // legitimate transactional email can carry an unsubscribe-from-marketing
  // footer without being promotional itself — the List-Unsubscribe HEADER
  // check above is the reliable signal for genuine marketing platforms,
  // this body-text keyword was redundant and too broad.
  const PROMO = /(% off|percent off|clearance|coupon|promo code|newsletter|limited time|flash sale|deal of the day|weekly ad|special offer|sneak peek|new arrivals|shop now)/i;
  return PROMO.test(hay);
}

// Same fix as the renderer side's todayISO()/localISO(): local date
// components directly, not toISOString().slice(0,10) — that converts to
// UTC first, which silently shifts the date by a day for anyone in a
// timezone ahead of UTC. Used below for dates parsed out of email text
// (delivery estimates, payment deadlines), where the email itself has no
// timezone info to anchor to, so "the machine's local date" is the only
// sensible interpretation.
function localISO(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function classifyEmail({ subject, bodyText, fromName, fromEmail, toEmail, date }) {
  // Invisible Unicode formatting characters (zero-width spaces, RTL/LTR
  // embedding marks, word joiners, BOM) show up in real marketing emails
  // and silently break "\s*" gap-matching between a label and its value —
  // a real Amazon order number sat right after one of these and was
  // missed entirely until this was stripped.
  const stripInvisible = s => (s || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  subject = stripInvisible(subject);
  bodyText = stripInvisible(bodyText);

  const hay = (subject + '\n' + bodyText).toLowerCase();

  let status = null;
  if (/(you sold|item sold|has sold|your listing sold|congratulations.*sold|payment received|you.ve been paid|payout (of|is|available)|funds available)/i.test(hay)) status = 'sold';
  // A cancellation email shares the exact same "Order Details / Order
  // Summary" template as a normal confirmation — without checking for
  // this first, a real cancellation was being misclassified as a brand
  // new 'confirmed' order below, which would have created a phantom
  // duplicate order instead of actually cancelling anything. Checked
  // early, ahead of the broad 'confirmed' pattern, since this is a
  // definitive terminal state.
  else if (/(?:order|item)s?\s+(?:has|have)\s+been\s+cancell?ed|will\s+be\s+cancell?ed/i.test(hay)) status = 'cancelled';
  // Account-level suspension/hold notices cascade to cancel every pending
  // (non-delivered) order under that account — a real example explicitly
  // said "all pending orders and subscriptions have been cancelled." The
  // sender-address check catches a Swedish example that used different
  // body wording but the same distinctive "baa-customer-appeal" sender.
  // Scoped to Amazon specifically — this exact phrasing is Amazon's own
  // wording, and other services could plausibly use similar "account on
  // hold" language for unrelated reasons, so the sender is checked too,
  // not just the body text. "baa-customer-appeal" is Amazon's own sender
  // pattern regardless of body language (covers a real Swedish example).
  else if ((/sign in to resolve|account is (?:temporarily )?(?:on hold|closed|suspended|st[äa]ngt|avst[äa]ngt)/i.test(hay) && /amazon/i.test(fromEmail)) || /baa-customer-appeal/i.test(fromEmail)) status = 'account_suspended';
  // A real "please update your payment" notice comes with an actual
  // deadline ("before 15 July 2026..."). A routine order confirmation can
  // ALSO contain nearly identical trigger phrasing though — Pokémon
  // Center's standard confirmation includes boilerplate explaining what
  // happens *if* a future charge fails ("If we're unable to charge you
  // for your preorder, you'll receive a reminder...") as routine policy
  // text, not an actual notice. A real confirmation email was
  // misclassified as action_required by this exact phrase before this
  // fix. Requiring a real deadline alongside the trigger phrase is what
  // actually distinguishes "this happened" from "here's our policy."
  else if (/before\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}/i.test(hay) && /action required|unable to (?:authorise|authorize|charge)|reauthorise|reauthorize|re-authorise|re-authorize|update your payment/i.test(hay)) status = 'action_required';
  // "Collected" covers click-and-collect pickup confirmations (Argos,
  // Sainsbury's, etc.) — functionally the same end state as a home
  // delivery, just worded completely differently.
  // Requires an actual delivery *statement*, not just the bare word
  // "delivered" — a real Amazon confirmation email has "Delivered" as a
  // static label in its order-progress-tracker widget regardless of the
  // order's real stage, and real Argos footer boilerplate about returns
  // says "...or it was delivered by a supplier," neither of which are
  // actual delivery notifications.
  else if (/(?:has been delivered|package was delivered|package has arrived|item has arrived|you.ve collected|collected your (?:order|items))/i.test(hay)) status = 'delivered';
  // Click-and-collect "ready to pick up" is its own distinct step — the
  // item isn't moving toward the person, they need to go get it, which is
  // a different action than waiting for a courier.
  else if (/ready (?:to|for) collect|ready for pick ?up/i.test(hay)) status = 'ready_for_collection';
  // Same tracker-widget issue as delivered above — Amazon's confirmation
  // emails include a static "Out for delivery" stage label regardless of
  // the order's real status, so this needs fuller phrasing to trigger.
  else if (/(?:is out for delivery|out for delivery today|now out for delivery|will arrive soon|package will arrive|arriving today|arrives today)/i.test(hay)) status = 'out_for_delivery';
  else if (/shipped|on its way|tracking number|has shipped/.test(hay)) status = 'shipped';
  // Real order confirmations often say "Thanks for your order" rather than
  // the "Thank you for your order" this used to require exactly.
  else if (/order confirmation|thanks?\s*(?:you\s*)?for\s*(?:your|placing)|order received|we.ve received your order|your order has been placed|order summary|order details/i.test(hay)) status = 'confirmed';
  if (!status) return null;

  let retailer = fromName || (fromEmail.split('@')[1] || 'Unknown');
  retailer = retailer.replace(/^(noreply|orders|no-reply|do-not-reply)[.@]/i, '').replace(/\.(com|co|net|org).*/i, '');
  retailer = retailer.trim();
  retailer = retailer ? retailer.charAt(0).toUpperCase() + retailer.slice(1) : 'Unknown';

  if (status === 'sold') {
    // eBay's real "item sold" email just says "Sold: £64.70" — confirmed
    // directly that this figure IS the net amount that lands in the
    // seller's balance already; "Buyer Protection" and "Postage" shown
    // alongside are charges paid BY THE BUYER, not deductions from this.
    // None of the "you'll receive"/"net proceeds"/"payout" phrasing this
    // used to look for appears anywhere in eBay's actual wording, so this
    // would previously have missed it entirely. Newline-tolerant gap since
    // real emails put blank lines between a label and its value.
    const netMatch =
      bodyText.match(/(?:you.ll (?:get|receive)|net (?:amount|proceeds|payout)|payout(?: amount)?|total earnings|you (?:earned|made)|\bsold)\s*:?[\s\S]{0,20}?[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i);
    const grossMatch = bodyText.match(/[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/);
    const netAmount = netMatch ? parseFloat(netMatch[1].replace(',', '')) : null;
    const grossAmount = grossMatch ? parseFloat(grossMatch[1].replace(',', '')) : null;

    const platform = /ebay/i.test(fromEmail) || /ebay/i.test(fromName) ? 'eBay' : retailer;

    const qtyMatch = bodyText.match(/quantity sold\s*:?[\s\S]{0,10}?(\d{1,3})/i);
    const quantitySold = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

    const orderNumMatch = bodyText.match(/\border\s*:?[\s\S]{0,10}?([A-Z0-9-]{6,25})/i);
    const saleOrderNumber = orderNumMatch ? orderNumMatch[1] : null;

    // eBay's subject line is literally "You made the sale for <product>..."
    // — the most reliable source of the product name for this platform,
    // used to help pre-suggest the right item in the "Match to Item" step.
    const productMatch = subject.match(/(?:sale for|sold)\s*:?\s*(.+)/i);
    const productNameHint = productMatch ? productMatch[1].replace(/\.{2,}\s*$/, '').trim() : null;

    return { status, platform, netAmount, grossAmount, quantitySold, saleOrderNumber, productNameHint, subject, date, fromEmail };
  }

  if (status === 'account_suspended') {
    // All that's actually needed here is which account this happened to —
    // matched on the renderer side against every tracked order's "sent to"
    // address, the same reliable per-account signal used for payment-issue
    // matching.
    return { status, retailer, subject, date, fromEmail, toEmail: toEmail || null };
  }

  if (status === 'action_required') {
    // These "please update your payment" emails identify the order by
    // PRODUCT NAME, not an order number — a real example had no order
    // number anywhere in it. So this gets matched on the renderer side by
    // fuzzy-comparing this name against existing tracked preorders instead
    // of the usual order-number matchKey.
    const productMatch =
      bodyText.match(/(?:preorder|order)\s*\n?\s*([A-Z][^\n]{10,120}?)\s*[.,]\s*(?:However|we\s|we've|we.ve)/i) ||
      bodyText.match(/preorder\s*\n?\s*([A-Z][^\n]{10,120})/i);
    const productNameHint = productMatch ? productMatch[1].trim().replace(/\s{2,}/g, ' ') : null;

    // "before 15 July 2026 by 11:59 p.m. GMT" — same year-less-date footgun
    // as the delivery-date parsing, so anchor to the email's own year too.
    const deadlineMatch = bodyText.match(/before\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})(?:\s+by\s+([\d:]+\s*[ap]\.?m\.?(?:\s*[A-Z]{2,5})?))?/i);
    let deadlineDate = null;
    if (deadlineMatch) {
      const d = new Date(deadlineMatch[1]);
      if (!isNaN(d)) deadlineDate = localISO(d);
    }
    const deadlineTime = deadlineMatch && deadlineMatch[2] ? deadlineMatch[2].trim() : null;

    return { status, retailer, productNameHint, deadlineDate, deadlineTime, subject, date, fromEmail, toEmail: toEmail || null };
  }

  // Try a standalone "Total" label first — the most reliable universal
  // signal — but skip past "total...includes" phrasing, which shows up in
  // VAT/fee breakdown footnotes ("your order total includes £X of product
  // costs...") and is NOT the actual order total, a real false-match this
  // exposed. "Order total" as its own phrase is a lower-priority fallback,
  // tried only if no standalone Total row was found.
  const priceMatch =
    bodyText.match(/(?<!sub)\btotal\*?(?!\s*includes)[\s\S]{0,15}?[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i) ||
    bodyText.match(/order\s+total(?!\s*includes)[\s\S]{0,30}?[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i) ||
    bodyText.match(/[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;

  // Require "order number/no./#" specifically — "order confirmation" is
  // too generic a phrase (shows up in intro sentences having nothing to do
  // with the actual number) and caused a real false match. Word boundary
  // keeps this from matching inside "preorder"/"reorder" too.
  const orderNumMatch =
    bodyText.match(/\border\s*(?:number|no\.?|#)\s*[:#]?\s*\n?\s*([A-Z0-9-]{5,20})/i) ||
    subject.match(/#\s?([A-Z0-9-]{5,20})/);
  const orderNumber = orderNumMatch ? orderNumMatch[1] : null;

  // Delivery date AND time, when the email gives one — e.g. "arriving by 8pm"
  // or "between 10am and 2pm" often appears right after the date phrase.
  const deliveryMatch = bodyText.match(/(?:estimated delivery|arriving|expected by|delivery date)[^\n]{0,40}?([A-Za-z]{3,9}\.?\s+\d{1,2}(?:,?\s+\d{4})?)/i);
  let expectedDelivery = null;
  if (deliveryMatch) {
    let dateStr = deliveryMatch[1];
    const emailDate = new Date(date);
    const emailYear = emailDate.getFullYear();
    // "July 15" with no year, parsed bare, is a well-known JS Date footgun
    // (silently defaults to 2001) — so if there's no 4-digit year in the
    // match, explicitly anchor it to the email's own year instead.
    if (!/\d{4}/.test(dateStr)) dateStr = `${dateStr}, ${emailYear}`;
    let d = new Date(dateStr);
    if (!isNaN(d)) {
      // Year-end wraparound: a "January" delivery mentioned in a
      // November/December email almost certainly means next year.
      if (d.getMonth() < emailDate.getMonth() - 6) {
        d = new Date(dateStr.replace(String(emailYear), String(emailYear + 1)));
      }
      if (!isNaN(d)) expectedDelivery = localISO(d);
    }
  }
  const timeMatch = bodyText.match(/\b(?:by|before|between)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s*(?:and|-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)))?/i);
  const expectedDeliveryTime = timeMatch ? (timeMatch[2] ? `${timeMatch[1]}\u2013${timeMatch[2]}` : timeMatch[1]) : null;

  // Carrier + tracking number — best-effort, since formats vary a lot.
  const carrierMatch = bodyText.match(/\b(UPS|USPS|FedEx|DHL|Royal Mail|Evri|Hermes|Yodel|DPD|Canada Post|Australia Post|Amazon Logistics|OnTrac|Purolator|An Post|Parcelforce)\b/i);
  const carrier = carrierMatch ? carrierMatch[1] : null;
  const trackingMatch = bodyText.match(/(?:tracking\s*(?:number|#|no\.?)|track(?:ing)? your (?:package|order|shipment))[:\s]*([A-Z0-9]{8,35})/i);
  const trackingNumber = trackingMatch ? trackingMatch[1] : null;

  const result = { status, retailer, price, orderNumber, expectedDelivery, expectedDeliveryTime, carrier, trackingNumber, subject, date, fromEmail };

  if (status === 'ready_for_collection') {
    const codeMatch = bodyText.match(/\bcode\s*:?[\s\S]{0,10}?(\d{3,8})/i);
    result.pickupCode = codeMatch ? codeMatch[1] : null;
  }

  // These used to be extracted only for Pokémon Center preorders, but the
  // person wants "what was bought / sent to which email / delivery
  // address" for every order now — so this runs on all of them. Still
  // best-effort regex parsing of email text, not a real structured API;
  // fields that can't be found are just left null rather than guessed at.
  result.toEmail = toEmail || null;

  // Address blocks in real order emails are almost always one address
  // component per line, but HTML-derived plain text puts a *blank* line
  // between each one (each was its own <div>/<p>) — a simple "N lines
  // separated by single \n" regex misses everything after the first line.
  // Grabbing a raw chunk after the label and filtering blank lines in JS
  // handles that reliably, and stops at the next section heading so it
  // doesn't run on into unrelated content.
  const addrLabelMatch = bodyText.match(/(?:shipping address|ship(?:ping)? to|delivery address|delivered to)\s*[:\n]/i);
  if (addrLabelMatch) {
    const afterLabel = bodyText.slice(addrLabelMatch.index + addrLabelMatch[0].length, addrLabelMatch.index + addrLabelMatch[0].length + 300);
    // Broad enough to catch the sign-off/next-section text that follows an
    // address block in real emails — without these, a real "delivered to"
    // email ran the address straight into "Thank you for shopping..." and
    // "Sincerely," as if they were address lines.
    const stopWords = /^(order summary|subtotal|discount|shipping\b|total|payment|customer support|billing address|thank you|sincerely|fulfillment|delivered items|order details|order number)/i;
    const addrLines = [];
    for (const rawLine of afterLabel.split('\n')) {
      // Strip a trailing comma from each line — many real address blocks
      // already end each line with one, and joining with ", " on top of
      // that produces "Terrace,, Roslin,," style double commas otherwise.
      const line = rawLine.trim().replace(/,\s*$/, '');
      if (!line) continue;
      if (stopWords.test(line)) break;
      addrLines.push(line);
      if (addrLines.length >= 6) break;
    }
    result.deliveryAddress = addrLines.length ? addrLines.join(', ') : null;
    // Not every "delivered to" / "shipping address" block starts with a
    // name — a real delivery email went straight to the street address
    // with no name line at all. Only trust the first line as a name if it
    // actually looks like one (no digits, reasonable length).
    const firstLineLooksLikeName = addrLines.length && /^[A-Za-z][A-Za-z' -]{2,40}$/.test(addrLines[0]) && !/\d/.test(addrLines[0]);
    result.recipientName = firstLineLooksLikeName ? addrLines[0] : null;
  } else {
    result.deliveryAddress = null;
    result.recipientName = null;
  }

  // Fallback recipient name: Pokémon Center (and many other retailers)
  // greet by first name even in emails with no address block at all (the
  // payment-issue email has no address anywhere) — "Hello, Brodie!" is a
  // reliable enough pattern to use when the address-based extraction above
  // came up empty.
  if (!result.recipientName) {
    const helloMatch = bodyText.match(/(?:hello|hi|hey)\s*,?\s*([A-Z][a-zA-Z'-]{1,25})\s*[!,.]/i);
    if (helloMatch) result.recipientName = helloMatch[1].trim();
  }

  // Itemized line parsing: real order emails lay out each item as its own
  // "Product Name" line, then separate "SKU #", "Qty", "Price" lines each
  // with their own blank-line spacing — nothing close enough together for
  // a single-line regex. SKU markers are the most reliable anchor per
  // item, so find those first, then look immediately before (product name)
  // and after (qty/price) each one within a small window.
  const lineItems = [];
  const skuRe = /SKU\s*#?\s*:?\s*\n?\s*[A-Za-z0-9-]{3,20}/gi;
  let skuHit;
  while ((skuHit = skuRe.exec(bodyText)) !== null && lineItems.length < 20) {
    const beforeChunk = bodyText.slice(Math.max(0, skuHit.index - 200), skuHit.index);
    const beforeLines = beforeChunk.split('\n').map(l => l.trim()).filter(Boolean);
    const name = beforeLines.length ? beforeLines[beforeLines.length - 1] : null;

    const afterChunk = bodyText.slice(skuHit.index, skuHit.index + 200);
    const qtyMatch = afterChunk.match(/Qty\s*:?\s*\n?\s*(\d{1,4})/i);
    const priceMatch2 = afterChunk.match(/Price\s*:?\s*\n?\s*[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i);

    if (name && name.length >= 4 && qtyMatch && priceMatch2) {
      lineItems.push({
        name: name.replace(/\s{2,}/g, ' '),
        quantity: parseInt(qtyMatch[1], 10) || 1,
        price: parseFloat(priceMatch2[1].replace(',', ''))
      });
    }
  }
  // Fallback for simpler single-line formats ("Item x2 $10.00") some
  // other retailers use, in case the SKU-anchored parse above found nothing.
  if (lineItems.length === 0) {
    const simpleLineRe = /([A-Za-z0-9][^\n$£€]{4,70}?)\s*(?:Qty|Quantity)[:\s]*(\d{1,3})[^\n$£€]{0,20}[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/gi;
    let lm;
    while ((lm = simpleLineRe.exec(bodyText)) !== null && lineItems.length < 20) {
      lineItems.push({
        name: lm[1].trim().replace(/\s{2,}/g, ' '),
        quantity: parseInt(lm[2], 10) || 1,
        price: parseFloat(lm[3].replace(',', ''))
      });
    }
  }
  result.lineItems = lineItems;

  // Pokémon Center preorders additionally get flagged so the app routes
  // them into PKC Orders instead of the regular Orders list.
  const isPokemonCenter = /pokemoncenter/i.test(fromEmail) || /pok[eé]mon\s*center/i.test(fromName);
  const isPreorderMention = /pre-?order/i.test(hay);
  if (isPokemonCenter) {
    // Normalized here regardless of status (confirmed, shipped, delivered,
    // cancelled all reach this same point) — otherwise the retailer name
    // stored on the order is whatever the email's own "From" name happens
    // to say verbatim (e.g. "Pokémon Center" with the accent, exactly as
    // Pokémon Center's own emails write it), while stock items always use
    // a hardcoded, consistent "Pokemon Center" — meaning the two could
    // never match each other by retailer name, for every single user,
    // regardless of when their data was created. Confirmed directly
    // against a real export: 27 real orders, all stored as "Pokémon
    // Center" with the accent, none of them ever matching the unaccented
    // string used everywhere else.
    result.retailer = "Pokemon Center";
  }
  if (isPokemonCenter && isPreorderMention && status === 'confirmed') {
    result.isPKCPreorder = true;
  }

  return result;
}
function humanizeImapError(err) {
  const msg = (err && err.message) || String(err);
  if (/auth/i.test(msg)) return 'Login failed. Check your email/app password — most providers require an app-specific password, not your normal login password.';
  if (/ENOTFOUND|ECONNREFUSED|timeout/i.test(msg)) return "Couldn't reach that server. Check the host/port and your internet connection.";
  return msg;
}
