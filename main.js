const { app, BrowserWindow, Menu, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0A0A12',
    title: 'Ledger',
    icon: path.join(__dirname, 'icon.ico'),
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

  autoUpdater.autoDownload = true;
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

function accountFilePath() {
  return path.join(app.getPath('userData'), 'email-account.json');
}

function loadAccount() {
  try {
    const raw = fs.readFileSync(accountFilePath(), 'utf-8');
    const data = JSON.parse(raw);
    if (data.encryptedPassword && safeStorage.isEncryptionAvailable()) {
      data.password = safeStorage.decryptString(Buffer.from(data.encryptedPassword, 'base64'));
    }
    return data;
  } catch (e) {
    return null;
  }
}

function saveAccount({ email, host, port, secure, password, catchAllEmail }) {
  const data = { email, host, port, secure, catchAllEmail: catchAllEmail || null };
  if (safeStorage.isEncryptionAvailable()) {
    data.encryptedPassword = safeStorage.encryptString(password).toString('base64');
  } else {
    data.password = password;
    data.unencrypted = true;
  }
  fs.writeFileSync(accountFilePath(), JSON.stringify(data), 'utf-8');
}

function patchAccount(patch) {
  try {
    const raw = fs.readFileSync(accountFilePath(), 'utf-8');
    const data = JSON.parse(raw);
    Object.assign(data, patch);
    fs.writeFileSync(accountFilePath(), JSON.stringify(data), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

function clearAccount() {
  try { fs.unlinkSync(accountFilePath()); } catch (e) { /* already gone */ }
}

ipcMain.handle('email:getAccountInfo', () => {
  const acc = loadAccount();
  if (!acc) return null;
  return { email: acc.email, host: acc.host, port: acc.port, secure: acc.secure, catchAllEmail: acc.catchAllEmail || null };
});

ipcMain.handle('email:testAndSave', async (evt, { email, password, host, port, secure, catchAllEmail }) => {
  const client = new ImapFlow({
    host, port, secure,
    auth: { user: email, pass: password },
    logger: false
  });
  try {
    await client.connect();
    await client.logout();
    saveAccount({ email, host, port, secure, password, catchAllEmail });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeImapError(err) };
  }
});

ipcMain.handle('email:updateCatchAll', (evt, { catchAllEmail }) => {
  const ok = patchAccount({ catchAllEmail: catchAllEmail || null });
  return { ok };
});

ipcMain.handle('email:disconnect', () => {
  clearAccount();
  return { ok: true };
});

ipcMain.handle('email:sync', async (evt, { sinceISO, blockPromotions, excludedSenders }) => {
  const acc = loadAccount();
  if (!acc || !acc.password) return { ok: false, error: 'No email account connected.' };
  const excludeList = (excludedSenders || []).map(s => s.toLowerCase()).filter(Boolean);

  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: acc.secure,
    auth: { user: acc.email, pass: acc.password },
    logger: false
  });

  const results = [];
  const KEYWORDS = /(order|shipped|shipment|delivered|delivery|tracking|confirmation|receipt|out for delivery|sold|payout|paid|payment received)/i;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = sinceISO ? new Date(sinceISO) : new Date(Date.now() - 90 * 86400000);

      const baseUids = await client.search({ since });
      const forceProcess = new Set();

      if (acc.catchAllEmail) {
        try {
          const catchAllUids = await client.search({ since, to: acc.catchAllEmail });
          catchAllUids.forEach(u => forceProcess.add(u));
        } catch (e) {
          // Some servers don't support this search key well — skip silently.
        }
      }

      const capped = baseUids.slice(-300);
      const uidsToInspect = new Set([...capped, ...forceProcess]);

      for (const uid of uidsToInspect) {
        let envMsg;
        try { envMsg = await client.fetchOne(uid, { envelope: true }); } catch (e) { continue; }
        if (!envMsg || !envMsg.envelope) continue;
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

        if (fromEmail && excludeList.some(ex => fromEmail.includes(ex))) continue;

        const bodyText = (parsed.text || parsed.html || '').toString();

        if (blockPromotions && looksPromotional(subject, bodyText, parsed.headers)) continue;

        const toAddr = (parsed.to && parsed.to.value && parsed.to.value[0]) || {};

        const classified = classifyEmail({
          subject,
          bodyText,
          fromName: fromAddr.name || '',
          fromEmail: fromAddr.address || '',
          toEmail: toAddr.address || '',
          date: (parsed.date || envMsg.envelope.date || new Date()).toISOString()
        });
        if (classified) results.push(classified);
      }
    } finally {
      lock.release();
    }
    await client.logout();
    return { ok: true, results };
  } catch (err) {
    try { await client.logout(); } catch (e) { /* ignore */ }
    return { ok: false, error: humanizeImapError(err) };
  }
});

function looksPromotional(subject, bodyText, headers) {
  // Real order/shipping emails essentially never carry a List-Unsubscribe
  // header — that's a marketing-platform signature (Mailchimp, Klaviyo, etc).
  try {
    if (headers && typeof headers.has === 'function') {
      if (headers.has('list-unsubscribe') || headers.has('list-unsubscribe-post')) return true;
    }
  } catch (e) { /* ignore malformed headers */ }

  const hay = (subject + ' ' + bodyText).toLowerCase();
  const PROMO = /(% off|percent off|clearance|coupon|promo code|newsletter|unsubscribe|limited time|flash sale|deal of the day|weekly ad|special offer|sneak peek|new arrivals|shop now)/i;
  return PROMO.test(hay);
}

function classifyEmail({ subject, bodyText, fromName, fromEmail, toEmail, date }) {
  const hay = (subject + '\n' + bodyText).toLowerCase();

  let status = null;
  if (/(you sold|item sold|has sold|your listing sold|congratulations.*sold|payment received|you.ve been paid|payout (of|is|available)|funds available)/i.test(hay)) status = 'sold';
  else if (/delivered|has arrived|package was delivered/.test(hay)) status = 'delivered';
  else if (/out for delivery/.test(hay)) status = 'out_for_delivery';
  else if (/shipped|on its way|tracking number|has shipped/.test(hay)) status = 'shipped';
  else if (/order confirmation|thank you for your order|order received|we.ve received your order|your order has been placed|order summary/.test(hay)) status = 'confirmed';
  if (!status) return null;

  let retailer = fromName || (fromEmail.split('@')[1] || 'Unknown');
  retailer = retailer.replace(/^(noreply|orders|no-reply|do-not-reply)[.@]/i, '').replace(/\.(com|co|net|org).*/i, '');
  retailer = retailer.trim();
  retailer = retailer ? retailer.charAt(0).toUpperCase() + retailer.slice(1) : 'Unknown';

  if (status === 'sold') {
    // For sold notifications we care about the NET amount (after platform
    // fees), since that's what actually lands in the bank — not the gross
    // sale price, which most "item sold" emails lead with instead.
    const netMatch =
      bodyText.match(/(?:you.ll (?:get|receive)|net (?:amount|proceeds|payout)|payout(?: amount)?|total earnings|you (?:earned|made))[^\n$£€]{0,25}[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i);
    const grossMatch = bodyText.match(/[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/);
    const netAmount = netMatch ? parseFloat(netMatch[1].replace(',', '')) : null;
    const grossAmount = grossMatch ? parseFloat(grossMatch[1].replace(',', '')) : null;

    const platform = /ebay/i.test(fromEmail) || /ebay/i.test(fromName) ? 'eBay' : retailer;

    return { status, platform, netAmount, grossAmount, subject, date, fromEmail };
  }

  const priceMatch =
    bodyText.match(/(?:total|order total)[^\n$£€]{0,20}[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/i) ||
    bodyText.match(/[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/);
  const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '')) : null;

  const orderNumMatch =
    bodyText.match(/order\s*(?:#|number|no\.?|confirmation)\s*[:#]?\s*([A-Z0-9-]{5,20})/i) ||
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
      if (!isNaN(d)) expectedDelivery = d.toISOString().slice(0, 10);
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

  // Pokémon Center preorders get a much richer parse, since the person
  // specifically wants order number, shipping address, recipient name, the
  // address it was sent to, and itemized line items for these. This is
  // still best-effort regex parsing of email text, not a real API — it
  // will not be perfect on every email format.
  const isPokemonCenter = /pokemoncenter/i.test(fromEmail) || /pok[eé]mon\s*center/i.test(fromName);
  const isPreorderMention = /pre-?order/i.test(hay);
  if (isPokemonCenter && isPreorderMention && status === 'confirmed') {
    result.isPKCPreorder = true;
    result.toEmail = toEmail || null;

    const addrMatch = bodyText.match(/(?:shipping address|ship(?:ping)? to|delivery address)[:\s]*\n?([^\n]{3,80}(?:\n[^\n]{3,80}){0,4})/i);
    if (addrMatch) {
      const block = addrMatch[1].trim();
      result.deliveryAddress = block.replace(/\n+/g, ', ');
      result.recipientName = block.split('\n')[0].trim();
    } else {
      result.deliveryAddress = null;
      result.recipientName = null;
    }

    // Best-effort itemized line parsing: "<product name> ... Qty: N ... $XX.XX"
    // appearing anywhere near each other. Falls back gracefully if nothing matches.
    const lineItems = [];
    const lineRe = /([A-Za-z0-9][^\n$£€]{4,70}?)\s*(?:Qty|Quantity)[:\s]*(\d{1,3})[^\n$£€]{0,20}[$£€]\s?([0-9]+(?:[.,][0-9]{2})?)/gi;
    let m;
    while ((m = lineRe.exec(bodyText)) !== null && lineItems.length < 20) {
      lineItems.push({
        name: m[1].trim().replace(/\s{2,}/g, ' '),
        quantity: parseInt(m[2], 10) || 1,
        price: parseFloat(m[3].replace(',', ''))
      });
    }
    result.lineItems = lineItems;
  }

  return result;
}
function humanizeImapError(err) {
  const msg = (err && err.message) || String(err);
  if (/auth/i.test(msg)) return 'Login failed. Check your email/app password — most providers require an app-specific password, not your normal login password.';
  if (/ENOTFOUND|ECONNREFUSED|timeout/i.test(msg)) return "Couldn't reach that server. Check the host/port and your internet connection.";
  return msg;
}
