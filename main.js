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
    // Migrate from the old single-value catchAllEmail field to a list.
    if (!Array.isArray(data.catchAllDomains)) {
      data.catchAllDomains = data.catchAllEmail ? [data.catchAllEmail] : [];
    }
    return data;
  } catch (e) {
    return null;
  }
}

function saveAccount({ email, host, port, secure, password, catchAllDomains }) {
  const data = { email, host, port, secure, catchAllDomains: catchAllDomains || [] };
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
  return { email: acc.email, host: acc.host, port: acc.port, secure: acc.secure, catchAllDomains: acc.catchAllDomains || [] };
});

ipcMain.handle('email:testAndSave', async (evt, { email, password, host, port, secure, catchAllDomains }) => {
  const client = new ImapFlow({
    host, port, secure,
    auth: { user: email, pass: password },
    logger: false
  });
  try {
    await client.connect();
    await client.logout();
    saveAccount({ email, host, port, secure, password, catchAllDomains });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: humanizeImapError(err) };
  }
});

ipcMain.handle('email:updateCatchAll', (evt, { catchAllDomains }) => {
  const ok = patchAccount({ catchAllDomains: catchAllDomains || [] });
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
  // IMAP's SINCE search only has day-level resolution (no time-of-day), so
  // every sync re-scans the whole current day's mail, not just what's new
  // since the last check. Message-ID tracking is what actually stops the
  // same emails from being re-processed (and re-notified about) every
  // 60 seconds — the date search is just how we find candidates cheaply.
  const seenMessageIds = new Set(acc.processedMessageIds || []);

  const client = new ImapFlow({
    host: acc.host, port: acc.port, secure: acc.secure,
    auth: { user: acc.email, pass: acc.password },
    logger: false
  });

  const results = [];
  const newlySeenIds = [];
  const KEYWORDS = /(order|shipped|shipment|delivered|delivery|tracking|confirmation|receipt|out for delivery|sold|payout|paid|payment received)/i;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = sinceISO ? new Date(sinceISO) : new Date(Date.now() - 90 * 86400000);

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

        if (messageId) newlySeenIds.push(messageId);

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

    if (newlySeenIds.length) {
      const combined = [...seenMessageIds, ...newlySeenIds];
      // Cap the tracked list so this file doesn't grow forever — a
      // reseller's inbox won't realistically need more than the most
      // recent few hundred remembered at once.
      const trimmed = combined.slice(-500);
      patchAccount({ processedMessageIds: trimmed });
    }

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
  else if (/action required|unable to (?:authorise|authorize|charge)|reauthorise|reauthorize|re-authorise|re-authorize|update your payment/i.test(hay)) status = 'action_required';
  else if (/delivered|has arrived|package was delivered/.test(hay)) status = 'delivered';
  else if (/out for delivery/.test(hay)) status = 'out_for_delivery';
  else if (/shipped|on its way|tracking number|has shipped/.test(hay)) status = 'shipped';
  else if (/order confirmation|thank you for (?:your|placing)|order received|we.ve received your order|your order has been placed|order summary|order details/.test(hay)) status = 'confirmed';
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
      if (!isNaN(d)) deadlineDate = d.toISOString().slice(0, 10);
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
