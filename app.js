/* =========================================================
   Restock — Reseller Tracker (Desktop, dark dashboard theme)
   Vanilla JS. State lives in localStorage. Email credentials
   live encrypted in the main process (see main.js / preload.js).
   ========================================================= */

const CATEGORIES = ["Pokemon", "Sports Cards", "Sneakers", "Video Games", "Electronics", "Other"];
const EXPENSE_TAGS = ["Proxies", "Bots", "Shipping", "Packing Materials", "Petrol", "Rent", "Electricity", "Software/Subscriptions", "Other"];

const THEMES = {
  violet: { name:"Violet", violet:"#9B6BF5", violetBg:"rgba(155,107,245,0.14)", magenta:"#E869E0", magentaBg:"rgba(232,105,224,0.14)", glowRgb:"155,107,245" },
  ocean:  { name:"Ocean",  violet:"#4FA9F7", violetBg:"rgba(79,169,247,0.14)",  magenta:"#33D6C0", magentaBg:"rgba(51,214,192,0.14)",  glowRgb:"79,169,247" },
  emerald:{ name:"Emerald",violet:"#3DD68C", violetBg:"rgba(61,214,140,0.14)", magenta:"#2DD4BF", magentaBg:"rgba(45,212,191,0.14)",  glowRgb:"61,214,140" },
  sunset: { name:"Sunset", violet:"#F5A623", violetBg:"rgba(245,166,35,0.14)", magenta:"#F5576C", magentaBg:"rgba(245,87,108,0.14)",  glowRgb:"245,140,60" }
};

function applyTheme(key){
  const t = THEMES[key] || THEMES.violet;
  const root = document.documentElement.style;
  root.setProperty("--violet", t.violet);
  root.setProperty("--violet-bg", t.violetBg);
  root.setProperty("--magenta", t.magenta);
  root.setProperty("--magenta-bg", t.magentaBg);
  root.setProperty("--glow-rgb", t.glowRgb);
}
const CURRENCIES = ["USD","EUR","GBP","JPY","CAD","AUD","CHF","CNY","HKD","SGD","MXN","NZD","SEK","NOK","KRW"];

const CAT_STYLES = {
  "Pokemon":      { fg:"#E8B23D", bg:"rgba(232,178,61,0.14)",  icon:"bolt"  },
  "Sports Cards": { fg:"#4FA9F7", bg:"rgba(79,169,247,0.14)",  icon:"court" },
  "Sneakers":     { fg:"#FB923C", bg:"rgba(251,146,60,0.14)",  icon:"foot"  },
  "Video Games":  { fg:"#E869E0", bg:"rgba(232,105,224,0.14)", icon:"pad"   },
  "Electronics":  { fg:"#33D6C0", bg:"rgba(51,214,192,0.14)",  icon:"cpu"   },
  "Other":        { fg:"#9494AC", bg:"rgba(148,148,172,0.14)", icon:"box"   }
};

const PROVIDER_PRESETS = {
  gmail:   { label:"Gmail",    host:"imap.gmail.com",         port:993, secure:true, smtpHost:"smtp.gmail.com",        smtpPort:587, smtpSecure:false },
  outlook: { label:"Outlook",  host:"outlook.office365.com",  port:993, secure:true, smtpHost:"smtp.office365.com",    smtpPort:587, smtpSecure:false },
  yahoo:   { label:"Yahoo",    host:"imap.mail.yahoo.com",    port:993, secure:true, smtpHost:"smtp.mail.yahoo.com",   smtpPort:587, smtpSecure:false },
  icloud:  { label:"iCloud",   host:"imap.mail.me.com",       port:993, secure:true, smtpHost:"smtp.mail.me.com",      smtpPort:587, smtpSecure:false },
  custom:  { label:"Custom",   host:"",                        port:993, secure:true, smtpHost:"",                     smtpPort:587, smtpSecure:false }
};

const AUTO_SYNC_INTERVAL_MS = 60 * 1000;

/* ---------------- State ---------------- */

const STORAGE_KEY = "ledgerAppState.v1";

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      // Migration for people upgrading from before expenses/themes existed.
      if(!Array.isArray(parsed.expenses)) parsed.expenses = [];
      if(!Array.isArray(parsed.expenseRules)) parsed.expenseRules = [];
      if(!parsed.colorScheme || !THEMES[parsed.colorScheme]) parsed.colorScheme = "violet";
      migratePkcMultiItemOrders(parsed);
      migratePkcRetailerNaming(parsed);
      migratePkcOrderToEmail(parsed);
      migrateManualOrderMatchKeys(parsed);
      migratePkcPhantomOrders(parsed);
      migrateGenericPlaceholderStockItems(parsed);
      return parsed;
    }
  }catch(e){ console.warn("Could not read saved data", e); }
  return { displayCurrency: "USD", items: [], pendingOrders: [], pendingSales: [], expenses: [], expenseRules: [], colorScheme: "violet", emailLastSync: null, emailFilters: { blockPromotions: true, excludedSenders: [] } };
}

// One-time backfill for PKC preorders created before multi-item orders
// were tracked correctly — each affected order only ever got ONE stock
// item, discarding every other product in that order, even though the
// full line-item breakdown was still being stored (and shown in the
// order card's "Items detected" table) the whole time. Confirmed
// directly against a real export: 17 real orders, each with exactly one
// stock item, each storing a lineItems array showing 3-4 products that
// were never turned into their own tracked items. Since the full data is
// already there, this creates the missing items directly from it — no
// re-sync from email needed. Runs on every load but is a no-op once
// everything's already backfilled, since it only adds items that don't
// already exist for that order.
function migratePkcMultiItemOrders(parsed){
  if(!Array.isArray(parsed.items)) return;
  const seenOrderNumbers = new Set();
  const toAdd = [];
  parsed.items.filter(i=>i.isPreorder && i.retailer==="Pokemon Center" && i.orderNumber && Array.isArray(i.lineItems) && i.lineItems.length>1)
    .forEach(i=>{
      if(seenOrderNumbers.has(i.orderNumber)) return;
      seenOrderNumbers.add(i.orderNumber);
      const existingForOrder = parsed.items.filter(x=>x.orderNumber===i.orderNumber && x.retailer==="Pokemon Center");
      const existingNames = existingForOrder.map(x=>normalizeForMatch(x.name));
      i.lineItems.forEach(li=>{
        if(existingNames.includes(normalizeForMatch(li.name))) return;
        toAdd.push({
          id: uid(), name: li.name, category: i.category, quantityPurchased: li.quantity || 1,
          purchasePricePerUnit: li.price || 0, retailer: i.retailer, purchaseDate: i.purchaseDate,
          notes: "Backfilled from this order's stored details — was already part of the order but hadn't been added as its own tracked item yet.",
          isPreorder: true, expectedArrival: i.expectedArrival || null, orderNumber: i.orderNumber,
          deliveryAddress: i.deliveryAddress || null, recipientName: i.recipientName || null, sentToEmail: i.sentToEmail || null,
          lineItems: i.lineItems, sourceEmailDetected: !!i.sourceEmailDetected,
          needsAttention: false, attentionDeadline: null, attentionDeadlineTime: null,
          isCancelled: !!i.isCancelled, image: null, sales: []
        });
      });
    });
  if(toAdd.length){
    parsed.items.push(...toAdd);
    parsed.__pkcBackfillCount = (parsed.__pkcBackfillCount || 0) + toAdd.length;
  }
}

// Same underlying issue as the multi-item migration above, but for a
// different bug: orders' retailer name came directly from the email's own
// "From" name verbatim (e.g. "Pokémon Center" with the accent, exactly
// how their emails write it), while stock items always used a hardcoded,
// consistent "Pokemon Center" — so the two could never match each other
// by retailer name, breaking anything that needed to look up an order's
// details from its linked stock item (like the tracking number link).
// This is now fixed at the source for anything detected going forward;
// this migration repairs whatever's already stored, for every user who
// has this installed, not just one export — matches by pattern (any
// accent, any capitalization) rather than a specific known-bad string.
function migratePkcRetailerNaming(parsed){
  if(!Array.isArray(parsed.pendingOrders)) return;
  const pokemonCenterPattern = /^pok[eé]mon\s*center$/i;
  parsed.pendingOrders.forEach(p=>{
    if(p.retailer && pokemonCenterPattern.test(p.retailer) && p.retailer !== "Pokemon Center"){
      p.retailer = "Pokemon Center";
    }
  });
  if(Array.isArray(parsed.items)){
    parsed.items.forEach(i=>{
      if(i.retailer && pokemonCenterPattern.test(i.retailer) && i.retailer !== "Pokemon Center"){
        i.retailer = "Pokemon Center";
      }
    });
  }
}

// Manually-added orders with an order number were being given a random
// matchKey instead of the same "num:<orderNumber>" format email
// detection uses — meaning a later status-update email for that exact
// order (shipped, out for delivery, etc.) could never find it, and would
// create a duplicate entry instead of updating the existing one. Fixed at
// the source for new manual entries; this repairs anyone's existing ones.
function migrateManualOrderMatchKeys(parsed){
  if(!Array.isArray(parsed.pendingOrders)) return;
  parsed.pendingOrders.forEach(p=>{
    if(p.matchKey && p.matchKey.indexOf("manual:")===0 && p.orderNumber){
      p.matchKey = "num:"+p.orderNumber;
    }
  });
}

// Root cause found and fixed: mailparser's parsed.text came back as
// whitespace-only (confirmed directly: a real one was literally just a
// newline character) for these emails, not truly empty — which is
// truthy in JavaScript, so the code was using that near-blank text
// directly and never falling back to the HTML content, silently losing
// the order number despite the email having one. This created a
// "guess:"-keyed phantom order instead of matching the real one. Now
// that the actual cause is confirmed, this cleans up any phantoms it
// already created — a Pokémon Center order with no order number is
// removed if another entry shares its exact "sent to" address and does
// have a real order number, since that combination reliably identifies
// this specific bug's leftover artifact rather than a legitimate order.
function migratePkcPhantomOrders(parsed){
  if(!Array.isArray(parsed.pendingOrders)) return;
  parsed.pendingOrders = parsed.pendingOrders.filter(p=>{
    const isPhantom = p.retailer==="Pokemon Center" && !p.orderNumber && p.matchKey && p.matchKey.indexOf("guess:")===0;
    if(!isPhantom) return true;
    const hasRealMatch = p.toEmail && parsed.pendingOrders.some(other=>
      other!==p && other.retailer==="Pokemon Center" && other.orderNumber && other.toEmail===p.toEmail
    );
    return !hasRealMatch; // keep (return true) unless it's a confirmed phantom
  });
}

// Same underlying gap as the earlier PKC multi-item migration, but for
// delivered orders specifically: createStockItemFromOrder only ever ran
// once per order (right when it first became "delivered"), creating one
// generic "Order from X — tap to edit" placeholder using just the order
// total — even on orders whose real line-item breakdown was already
// available. Fixed at the source for anything delivered from now on;
// this repairs whatever's already sitting as an unfixed placeholder.
// Repurposes the existing item as the first line item (preserving its id
// and any sales already recorded against it) and creates new items for
// the rest, rather than deleting and recreating everything.
function migrateGenericPlaceholderStockItems(parsed){
  if(!Array.isArray(parsed.pendingOrders) || !Array.isArray(parsed.items)) return;
  const placeholderPattern = /^Order from .+ — tap to edit$/;
  parsed.pendingOrders.forEach(p=>{
    if(!p.addedToStockId || !Array.isArray(p.lineItems) || p.lineItems.length<2) return;
    const item = parsed.items.find(i=>i.id===p.addedToStockId);
    if(!item || !placeholderPattern.test(item.name)) return;
    const [first, ...rest] = p.lineItems;
    item.name = first.name;
    item.quantityPurchased = first.quantity || 1;
    item.purchasePricePerUnit = first.price || 0;
    rest.forEach(line=>{
      parsed.items.push({
        id: 'bf_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8),
        name: line.name, category: item.category || "Other",
        quantityPurchased: line.quantity || 1, purchasePricePerUnit: line.price || 0,
        retailer: item.retailer, purchaseDate: item.purchaseDate,
        notes: item.notes || "Auto-added from email sync — please verify item name, quantity, and price.",
        isPreorder: false, expectedArrival: null, isCancelled: false, image: null, sales: []
      });
    });
  });
}

// A PKC order's pendingOrders entry never stored the "sent to" address
// until now — needed so a shipped/delivered email that uses a different
// order-number format than the original confirmation (a different email
// template for that stage) can still be matched back to the right order
// by recipient address instead of silently creating a disconnected new
// entry. Confirmed directly against a real export: all 17 PKC orders
// were permanently stuck on "confirmed" despite genuinely having
// shipped. Without this backfill, that fallback would only help orders
// confirmed after upgrading — existing ones already have the address
// stored on their linked stock item's sentToEmail, just not copied over
// to the order record itself, so this recovers it from there.
function migratePkcOrderToEmail(parsed){
  if(!Array.isArray(parsed.pendingOrders) || !Array.isArray(parsed.items)) return;
  parsed.pendingOrders.forEach(p=>{
    if(p.isPKCPreorder && !p.toEmail){
      const linkedItem = parsed.items.find(i=>i.id===p.addedToStockId) ||
        (p.orderNumber ? parsed.items.find(i=>i.orderNumber===p.orderNumber && i.sentToEmail) : null);
      if(linkedItem && linkedItem.sentToEmail) p.toEmail = linkedItem.sentToEmail;
    }
  });
}

function saveState(){
  try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch(e){ console.warn("Could not save data", e); }
}

let state = loadState();
if(!state.pendingOrders) state.pendingOrders = [];
if(!state.pendingSales) state.pendingSales = [];
if(!state.displayCurrency) state.displayCurrency = "USD";
if(!state.emailFilters) state.emailFilters = { blockPromotions: true, excludedSenders: [] };
if(!Array.isArray(state.vccs)) state.vccs = [];
if(!Array.isArray(state.addresses)) state.addresses = [];
if(!Array.isArray(state.generatedProfiles)) state.generatedProfiles = [];
if(!state.profileBuilderSettings) state.profileBuilderSettings = { catchallDomains: [], emailList: [] };
if(!Array.isArray(state.profileBuilderSettings.catchallDomains)) state.profileBuilderSettings.catchallDomains = [];
if(!Array.isArray(state.profileBuilderSettings.emailList)) state.profileBuilderSettings.emailList = [];
if(!Array.isArray(state.invoices)) state.invoices = [];
if(!state.invoiceSettings) state.invoiceSettings = { fromName: "", defaultSendAccountId: null, nextInvoiceNumber: 1, defaultVatRate: 20, defaultLogo: null, defaultBankDetails: "" };
if(state.invoiceSettings.defaultLogo===undefined) state.invoiceSettings.defaultLogo = null;
if(state.invoiceSettings.defaultBankDetails===undefined) state.invoiceSettings.defaultBankDetails = "";

let ui = { tab: "dashboard", period: "Month", stockFilter: "In Stock", stockCategoryFilter: "All", search: "", detailItemId: null, chartType: "line" };
let licenseExpiresAt = null; // shown next to "Saved locally" in the sidebar once known

/* ---------------- Helpers ---------------- */

function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function fmtMoney(value){
  try{ return new Intl.NumberFormat(undefined, {style:"currency", currency: state.displayCurrency || "USD", maximumFractionDigits:2}).format(value || 0); }
  catch(e){ return (state.displayCurrency||"USD") + " " + (value||0).toFixed(2); }
}
function fmtPct(v){ return v.toFixed(1) + "%"; }
// Uses local date components directly rather than new Date().toISOString()
// — converting to UTC before taking the date portion silently shifts the
// date by a day for anyone in a timezone ahead of UTC (confirmed real
// bug: a UK user in BST, UTC+1, hit local midnight becoming "yesterday"
// once converted to UTC, causing a sale recorded today to not match
// today's date everywhere else in the app expected it to).
function todayISO(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function daysBetween(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
function isTypingInField(){
  const el = document.activeElement;
  return el && ["INPUT","TEXTAREA","SELECT"].includes(el.tagName);
}

// Email Sync content now lives inside the Settings modal (its own DOM
// subtree under #modalRoot), not in #view — so its handlers can't just
// call renderView() anymore, that would refresh whatever's behind the
// modal instead of the modal itself. This only rebuilds Settings if it's
// actually the open modal, so a background auto-sync tick doesn't yank
// Settings open on someone who wasn't looking at it.
function refreshSettingsIfOpen(){
  if(document.getElementById("settingsBackdrop") && !isTypingInField()){
    openSettings();
  }
}

function periodQualifier(period){
  return {
    "Day": "Today", "Week": "This Week", "Month": "This Month",
    "Year": "This Year", "All Time": "All Time"
  }[period];
}

function periodStart(period){
  const now = new Date();
  const d = new Date(now); d.setHours(0,0,0,0);
  switch(period){
    case "Day": return d;
    case "Week": d.setDate(d.getDate()-6); return d;
    case "Month": { const m=new Date(now); m.setMonth(m.getMonth()-1); return m; }
    case "Year": { const y=new Date(now); y.setFullYear(y.getFullYear()-1); return y; }
    default: return null;
  }
}

/* ---------------- Computed item stats (single currency, no conversion) ---------------- */

function qtySold(item){ return item.sales.reduce((s,r)=>s+r.quantitySold,0); }
function qtyRemaining(item){ return item.quantityPurchased - qtySold(item); }
function isSoldOut(item){ return qtyRemaining(item) <= 0; }
function totalCost(item){ return item.quantityPurchased * item.purchasePricePerUnit; }
function costOfSoldUnits(item){ return qtySold(item) * item.purchasePricePerUnit; }
function saleRevenue(sale){ return sale.salePricePerUnit * sale.quantitySold; } // gross, before fees
function saleNet(sale){ return saleRevenue(sale) - (sale.fees||0); } // what actually lands in the bank
function totalRevenue(item){ return item.sales.reduce((s,r)=>s+saleRevenue(r),0); }
function totalNet(item){ return item.sales.reduce((s,r)=>s+saleNet(r),0); }
function totalFees(item){ return item.sales.reduce((s,r)=>s+(r.fees||0),0); }
function profit(item){ return totalNet(item) - costOfSoldUnits(item); } // net of fees, this is "real" profit
function roi(item){ const c=costOfSoldUnits(item); return c>0 ? (profit(item)/c)*100 : 0; }
function avgHoldingDays(item){
  const sold = qtySold(item);
  if(sold===0) return null;
  const totalW = item.sales.reduce((s,r)=> s + daysBetween(item.purchaseDate, r.saleDate)*r.quantitySold, 0);
  return totalW/sold;
}

/* ---------------- Icons ---------------- */

const ICONS = {
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`,
  stock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 3 14h8l-1 8 10-12h-8l1-8z"/></svg>`,
  court: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20M2 12h20"/></svg>`,
  foot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18c0-5 3-8 3-11a2 2 0 0 1 4 0c0 2 1 3 3 3s4-2 6-1 2 5 2 7-2 4-6 4H8c-2 0-4-1-4-2z"/></svg>`,
  pad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="10" rx="4"/><path d="M7 11h.01M7 13h.01M17 11h.01M15 13h.01"/></svg>`,
  cpu: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  cart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>`,
  trend: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/></svg>`,
  percent: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>`,
  cash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="3"/></svg>`,
  card: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
  tools: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/></svg>`,
  chev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 11 3.83 3.83 11l9.58 9.59a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.83z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
};

function catIcon(cat, size){
  const m = CAT_STYLES[cat] || CAT_STYLES["Other"];
  return `<div class="cat-icon" style="background:${m.bg};width:${size||38}px;height:${size||38}px;">
    <span style="color:${m.fg};display:flex;width:${Math.round((size||38)*0.45)}px;">${ICONS[m.icon]}</span>
  </div>`;
}

// Shows the product's photo if one was added, otherwise falls back to the
// category icon — used everywhere an item is listed (Stock, Sold, Orders,
// PKC Orders, the dashboard's Recent Sales panel).
function itemThumb(item, size){
  const s = size || 38;
  if(item.image){
    const radius = s > 60 ? 12 : 9;
    return `<div style="width:${s}px;height:${s}px;border-radius:${radius}px;overflow:hidden;flex-shrink:0;background:var(--card-2);border:1px solid var(--border-soft);">
      <img src="${item.image}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="">
    </div>`;
  }
  return catIcon(item.category, s);
}

function recentSalesPanelHTML(){
  const allSales = [];
  state.items.forEach(item => item.sales.forEach(sale => allSales.push({item, sale})));
  allSales.sort((a,b)=> new Date(b.sale.saleDate) - new Date(a.sale.saleDate));
  const recent = allSales.slice(0, 6);

  if(recent.length===0){
    return `<div class="hint">Sales you record will show up here.</div>`;
  }

  return `
    <div style="display:flex;flex-direction:column;gap:12px;">
      ${recent.map(({item,sale})=>{
        const net = saleNet(sale);
        const profit = net - sale.quantitySold*item.purchasePricePerUnit;
        return `
        <div style="display:flex;align-items:center;gap:12px;">
          ${itemThumb(item, 38)}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(item.name)}</div>
            <div class="hint" style="margin:1px 0 0;">${escapeHTML(sale.platform||"—")} · ${formatDate(sale.saleDate)} · Qty ${sale.quantitySold}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div class="mono" style="font-weight:700;color:var(--green);">${fmtMoney(net)}</div>
            <div class="mono ${profit>=0?'pos':'neg'}" style="font-size:11.5px;font-weight:600;margin-top:1px;">${profit>=0?'+':''}${fmtMoney(profit)} profit</div>
          </div>
        </div>`;
      }).join("")}
    </div>
  `;
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function showToast(msg, iconKey){
  const el = document.getElementById("toast");
  el.innerHTML = `${ICONS[iconKey||"check"]}<span>${msg}</span>`;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove("show"), 2200);
}

/* ---------------- Root render ---------------- */

let sidebarCollapsed = localStorage.getItem("restockSidebarCollapsed") === "true";

function render(){
  const app = document.getElementById("app");
  app.classList.toggle("collapsed", sidebarCollapsed);
  app.innerHTML = `
    <aside class="sidebar">
      <div class="brand">
        <div class="mark">${ICONS.stock}</div>
        <div class="info">
          <div class="name">Restock</div>
          <div class="ver" id="verLabel">v1.0 · desktop</div>
        </div>
        <button class="collapse-toggle" id="collapseToggleBtn" title="${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar">${ICONS.chev}</button>
      </div>
      <div class="navlabel">Menu</div>
      <div class="nav">
        ${navBtn("dashboard","dashboard","Dashboard")}
        ${navBtn("analytics","trend","Analytics")}
        ${navBtn("stock","stock","Stock")}
        ${navBtn("orders","cart","Confirmed Orders")}
        ${navBtn("sold","tag","Sold", state.pendingSales.length)}
        ${navBtn("add","plus","Add Stock")}
        ${navBtn("expenses","cash","Expenses")}
      </div>
      <div class="navlabel">Tools</div>
      <div class="nav">
        ${navBtn("vcc-tracker","card","Card Tracker")}
        ${navBtn("address-tracker","pin","Address Tracker")}
        ${navBtn("profile-builder","tools","Profile Builder")}
        ${navBtn("invoices","cash","Invoice Generator")}
      </div>
      <div class="sidebar-footer">
        <div class="status-row"><span class="pulse"></span><span>Saved locally${licenseExpiresAt ? ` · Renews ${formatDate(licenseExpiresAt)}` : ""}</span></div>
        <div id="updateBannerSlot"></div>
        <button class="ghost-btn" id="settingsNavBtn">${ICONS.gear}<span>Settings</span></button>
      </div>
    </aside>
    <div class="main">
      <div class="topbar" id="topbar"></div>
      <div class="content" id="view"></div>
    </div>
  `;

  document.getElementById("collapseToggleBtn").addEventListener("click", ()=>{
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem("restockSidebarCollapsed", sidebarCollapsed);
    render();
  });

  // Nav clicks are bound here — once, on the sidebar shell — so they keep
  // working no matter what's rendered in the content pane (including the
  // item detail view, which used to strand these bindings).
  document.getElementById("settingsNavBtn").addEventListener("click", openSettings);
  document.querySelectorAll("[data-nav]").forEach(btn=>{
    btn.addEventListener("click", ()=> setTab(btn.dataset.nav));
  });

  renderTopbar();
  renderView();
  renderUpdateBanner();
}

function navBtn(id, iconKey, label, badgeCount){
  const active = ui.tab===id ? "active" : "";
  const badge = badgeCount ? `<span class="nav-badge">${badgeCount}</span>` : "";
  return `<button class="${active}" data-nav="${id}">${ICONS[iconKey]}<span>${label}</span>${badge}</button>`;
}

function setTab(tab){
  ui.tab = tab;
  ui.detailItemId = null;
  render();
}

function renderTopbar(){
  const bar = document.getElementById("topbar");
  if(!bar) return;
  const titles = { dashboard: "Dashboard", analytics: "Analytics", stock: "Stock", add: "Add Stock", sold: "Sold", orders: "Confirmed Orders", expenses: "Expenses", "vcc-tracker": "Card Tracker", "address-tracker": "Address Tracker", "profile-builder": "Profile Builder", "invoices": "Invoice Generator" };
  let heading;
  if(ui.detailItemId){
    const item = state.items.find(i=>i.id===ui.detailItemId);
    heading = `<span class="greeting">${item ? escapeHTML(item.name) : "Item"}</span>`;
  } else if(ui.tab === "dashboard"){
    const now = new Date();
    heading = `<span class="greeting">${greetingWord()} <span class="sep">/</span> <span class="sub">${now.toLocaleDateString(undefined,{day:"numeric",month:"long"})}</span> <span class="sep">/</span> <span class="sub mono" id="liveClock">${now.toLocaleTimeString()}</span></span>`;
  } else {
    heading = `<span class="greeting">${titles[ui.tab]||""}</span>`;
  }

  bar.innerHTML = `
    ${heading}
    <div class="topbar-right">
      <div class="currency-pill" id="currencyPill">${currencySymbolFor(state.displayCurrency)} ${state.displayCurrency}</div>
    </div>
  `;
  document.getElementById("currencyPill").addEventListener("click", openSettings);

  clearInterval(window.__clockTimer);
  if(ui.tab==="dashboard" && !ui.detailItemId){
    window.__clockTimer = setInterval(()=>{
      const el = document.getElementById("liveClock");
      if(el) el.textContent = new Date().toLocaleTimeString();
    }, 1000);
  }
}

function currencySymbolFor(code){
  try{ return (0).toLocaleString(undefined,{style:"currency",currency:code,minimumFractionDigits:0,maximumFractionDigits:0}).replace(/\d/g,"").trim(); }
  catch(e){ return code; }
}
function greetingWord(){
  const h = new Date().getHours();
  if(h<12) return "Good morning";
  if(h<18) return "Good afternoon";
  return "Good evening";
}

function renderView(){
  const view = document.getElementById("view");
  if(!view) return;
  const existingTooltip = document.getElementById("chartTooltip");
  if(existingTooltip) existingTooltip.style.opacity = "0";
  if(ui.detailItemId){ view.innerHTML = detailHTML(ui.detailItemId); attachDetailEvents(); return; }
  if(ui.tab==="dashboard"){ view.innerHTML = dashboardHTML(); attachDashboardEvents(); }
  else if(ui.tab==="analytics"){ view.innerHTML = analyticsHTML(); attachAnalyticsEvents(); }
  else if(ui.tab==="add"){ view.innerHTML = addFormHTML(); attachAddEvents(); }
  else if(ui.tab==="stock"){ view.innerHTML = stockListHTML(); attachStockEvents(); }
  else if(ui.tab==="orders"){ view.innerHTML = ordersHTML(); attachOrdersEvents(); }
  else if(ui.tab==="sold"){ view.innerHTML = soldHTML(); attachSoldEvents(); }
  else if(ui.tab==="expenses"){ view.innerHTML = expensesHTML(); attachExpensesEvents(); }
  else if(ui.tab==="vcc-tracker"){ view.innerHTML = vccTrackerHTML(); attachVccTrackerEvents(); }
  else if(ui.tab==="address-tracker"){ view.innerHTML = addressTrackerHTML(); attachAddressTrackerEvents(); }
  else if(ui.tab==="profile-builder"){ view.innerHTML = profileBuilderHTML(); attachProfileBuilderEvents(); }
  else if(ui.tab==="invoices"){ view.innerHTML = invoiceGeneratorHTML(); attachInvoiceGeneratorEvents(); }
}

/* ============================================================
   DASHBOARD
   ============================================================ */

function dashboardHTML(){
  const start = periodStart(ui.period);
  const inPeriod = d => !start || new Date(d) >= start;

  // Pokémon Center preorders specifically wait until they're actually
  // received — confirmed directly from their own emails that they charge
  // once the order ships, not at confirmation, so counting them as
  // "spent" immediately would overstate real money out. This is NOT true
  // of every retailer, though — confirmed directly that Arsenal Direct
  // charges preorders straight away, and there's no reliable way to know
  // a given retailer's billing timing in general, so anything other than
  // Pokémon Center is treated as charged at confirmation, which is the
  // more common default for online orders anyway.
  const purchasesInPeriod = state.items.filter(i => !(i.isPreorder && i.retailer==="Pokemon Center") && inPeriod(i.purchaseDate));
  // Confirmed orders that haven't been delivered yet don't have a stock
  // item to show up in the calculation above at all — counted here
  // instead, for anything that isn't a Pokémon Center preorder. The
  // addedToStockId check is what prevents this from double-counting
  // once an order actually arrives: at that point it has a real stock
  // entry and gets picked up by the block above instead, so it only
  // ever gets counted once, on one side or the other.
  const immediateChargeOrdersInPeriod = state.pendingOrders.filter(p =>
    p.retailer!=="Pokemon Center" && !p.addedToStockId && p.status!=="cancelled" && inPeriod(p.orderDate)
  );
  const pendingOrdersSpent = immediateChargeOrdersInPeriod.reduce((s,p)=>s+(p.price||0),0);
  const salesInPeriod = [];
  state.items.forEach(item => item.sales.forEach(s => { if(inPeriod(s.saleDate)) salesInPeriod.push({sale:s, item}); }));
  const expensesInPeriod = (state.expenses||[]).filter(e => inPeriod(e.date));

  const inventorySpent = purchasesInPeriod.reduce((s,i)=>s+totalCost(i),0) + pendingOrdersSpent;
  const totalExpenses = expensesInPeriod.reduce((s,e)=>s+(e.amount||0),0);
  // Total Spent is now the full "money out" picture — inventory purchases
  // plus running costs — not just inventory alone.
  const totalSpent = inventorySpent + totalExpenses;
  const totalRev = salesInPeriod.reduce((s,p)=>s+saleRevenue(p.sale),0);
  const salesProfitGross = salesInPeriod.reduce((s,p)=> s + (saleNet(p.sale) - p.sale.quantitySold*p.item.purchasePricePerUnit), 0);
  // Bottom-line profit: what sales actually made, minus what it cost to
  // run the business, not just what it cost to buy the stock that sold.
  const totalProfit = salesProfitGross - totalExpenses;
  const cogs = salesInPeriod.reduce((s,p)=> s + p.sale.quantitySold*p.item.purchasePricePerUnit, 0);
  const roiCostBasis = cogs + totalExpenses;
  const roiVal = roiCostBasis>0 ? (totalProfit/roiCostBasis)*100 : 0;

  // Forward-looking window (unlike periodStart, which looks backward for
  // spend/profit history) — "Day" means due today, "Week" means due in
  // the next 7 days, etc. "All Time" has no bounds at all, so it also
  // catches anything overdue, not just future-dated ones.
  function deliveryWindow(period){
    const today = new Date(); today.setHours(0,0,0,0);
    if(period==="All Time") return { from:null, to:null };
    const to = new Date(today);
    if(period==="Day") to.setHours(23,59,59,999);
    else if(period==="Week"){ to.setDate(to.getDate()+6); to.setHours(23,59,59,999); }
    else if(period==="Month"){ to.setMonth(to.getMonth()+1); to.setHours(23,59,59,999); }
    else if(period==="Year"){ to.setFullYear(to.getFullYear()+1); to.setHours(23,59,59,999); }
    return { from: today, to };
  }
  const { from: dueFrom, to: dueTo } = deliveryWindow(ui.period);
  const deliveriesDueCount = state.pendingOrders.filter(p=>{
    if(p.status==="delivered" || p.status==="cancelled") return false;
    if(!p.expectedDelivery) return false;
    const d = new Date(p.expectedDelivery);
    if(dueFrom && d < dueFrom) return false;
    if(dueTo && d > dueTo) return false;
    return true;
  }).length;
  const deliveriesDueLabel = {
    "Day": "Deliveries Today", "Week": "Deliveries This Week", "Month": "Deliveries This Month",
    "Year": "Deliveries This Year", "All Time": "Deliveries"
  }[ui.period];

  const liveItems = state.items.filter(i=>!i.isPreorder);
  const totalBought = liveItems.reduce((s,i)=>s+i.quantityPurchased,0);
  const totalSold = liveItems.reduce((s,i)=>s+qtySold(i),0);
  const sellThrough = totalBought>0 ? (totalSold/totalBought)*100 : 0;
  const activeStock = liveItems.reduce((s,i)=>s+qtyRemaining(i),0);

  const groups = {};
  state.items.filter(i=>qtySold(i)>0).forEach(i=>{ (groups[i.name] = groups[i.name]||[]).push(i); });
  const topItems = Object.entries(groups).map(([name, group])=>{
    const p = group.reduce((s,i)=>s+profit(i),0);
    const cost = group.reduce((s,i)=>s+costOfSoldUnits(i),0);
    const units = group.reduce((s,i)=>s+qtySold(i),0);
    const r = cost>0 ? (p/cost)*100 : 0;
    return {name, profit:p, roi:r, units, category: group[0].category};
  }).sort((a,b)=>b.roi-a.roi).slice(0,6);

  const pendingDeliveryCount = state.pendingOrders.filter(p=>p.status!=="delivered" && p.status!=="cancelled").length;

  const periods = ["Day","Week","Month","Year","All Time"];

  return `
    <div class="segmented">
      ${periods.map(p=>`<button class="${ui.period===p?'active':''}" data-period="${p}">${p==="All Time"?"All":p}</button>`).join("")}
    </div>

    <div class="stat-grid">
      ${statCard("cart", `Total Spent ${periodQualifier(ui.period)}`, fmtMoney(totalSpent), "var(--blue)", "var(--blue-bg)")}
      ${statCard("trend", `Total Profit ${periodQualifier(ui.period)}`, fmtMoney(totalProfit), totalProfit>=0?"var(--green)":"var(--red)", totalProfit>=0?"var(--green-bg)":"var(--red-bg)")}
      ${statCard("percent", `ROI ${periodQualifier(ui.period)}`, fmtPct(roiVal), roiVal>=0?"var(--green)":"var(--red)", roiVal>=0?"var(--green-bg)":"var(--red-bg)")}
      ${statCard("cash", `Revenue ${periodQualifier(ui.period)}`, fmtMoney(totalRev), "var(--cyan)", "var(--cyan-bg)")}
      ${statCard("cart", `Expenses ${periodQualifier(ui.period)}`, fmtMoney(totalExpenses), "var(--red)", "var(--red-bg)")}
    </div>

    <div class="dash-grid">
      <div class="card panel">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
          <div class="panel-title" style="margin-bottom:0;">Profit — ${periodQualifier(ui.period)}</div>
          <div class="segmented" style="padding:2px;">
            <button class="${ui.chartType==='line'?'active':''}" data-chart-type="line" style="padding:6px 9px;" title="Line chart"><span style="display:inline-flex;width:14px;height:14px;">${ICONS.trend}</span></button>
            <button class="${ui.chartType==='bar'?'active':''}" data-chart-type="bar" style="padding:6px 9px;" title="Bar chart"><span style="display:inline-flex;width:14px;height:14px;">${ICONS.dashboard}</span></button>
          </div>
        </div>
        ${ui.chartType==='line' ? sparklineSVG(profitSeriesForPeriod(ui.period)) : barChartSVG(profitSeriesForPeriod(ui.period))}
      </div>
      <div class="card panel">
        <div class="panel-title">Recent Sales</div>
        ${recentSalesPanelHTML()}
      </div>
    </div>

    <div class="mini-grid">
      ${miniCard("mail",deliveriesDueLabel, ""+deliveriesDueCount, "var(--violet)","var(--violet-bg)")}
      ${miniCard("percent","Sell-Through", sellThrough.toFixed(0)+"%", "var(--green)","var(--green-bg)")}
      ${miniCard("layers","Products In-Stock", ""+activeStock, "var(--gold)","var(--gold-bg)")}
      ${miniCard("mail","Confirmed Orders", ""+pendingDeliveryCount, "var(--magenta)","var(--magenta-bg)")}
    </div>

    <div class="section-title">Most Profitable Items</div>
    ${topItems.length===0 ? `
      <div class="card" style="padding:30px;text-align:center;color:var(--text-mute);font-size:13px;">Sell some stock to see your top performers here.</div>
    ` : `
      <div class="card table-wrap">
        <table class="data-table">
          <thead><tr><th>#</th><th>Item</th><th>Category</th><th>Units Sold</th><th>ROI</th><th style="text-align:right;">Profit</th></tr></thead>
          <tbody>
            ${topItems.map((t,i)=>{
              const style = CAT_STYLES[t.category]||CAT_STYLES.Other;
              const chipBg = i===0?"var(--gold)":i===1?"#A9AFA9":i===2?"#C08344":"var(--card-2)";
              const chipColor = i<3 ? "#0A0A12" : "var(--text-dim)";
              return `<tr>
                <td><span class="rank-chip" style="background:${chipBg};color:${chipColor};">${i+1}</span></td>
                <td>${escapeHTML(t.name)}</td>
                <td><span style="color:${style.fg};font-size:12px;font-weight:600;">${escapeHTML(t.category)}</span></td>
                <td class="mono dim">${t.units}</td>
                <td class="mono ${t.roi>=0?'pos':'neg'}">${fmtPct(t.roi)}</td>
                <td class="mono pos" style="text-align:right;">${fmtMoney(t.profit)}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    `}

    ${state.items.length===0 ? `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">No data yet</div>
        <div class="d">Add your first purchase, or connect your email to auto-detect orders.</div>
      </div>
    ` : ""}
    <div style="height:20px;"></div>
  `;
}

function statCard(iconKey, label, value, fg, bg, titleAttr){
  return `
    <div class="card stat-card" ${titleAttr ? `title="${escapeAttr(titleAttr)}"` : ""}>
      <div class="top-row">
        <div class="stat-icon" style="background:${bg};color:${fg};">${ICONS[iconKey]}</div>
      </div>
      <div class="stat-value" style="color:${fg}">${value}</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}
function miniCard(iconKey, label, value, fg, bg){
  return `
    <div class="mini-card">
      <div class="ic" style="background:${bg};color:${fg};">${ICONS[iconKey]}</div>
      <div>
        <div class="val">${value}</div>
        <div class="lbl">${label.toUpperCase()}</div>
      </div>
    </div>
  `;
}

function profitOnDate(iso){
  let p = 0;
  state.items.forEach(item=>{
    item.sales.forEach(s=>{
      if(s.saleDate===iso) p += saleNet(s) - s.quantitySold*item.purchasePricePerUnit;
    });
  });
  return p;
}
function profitInMonth(year, month){
  let p = 0;
  state.items.forEach(item=>{
    item.sales.forEach(s=>{
      const d = new Date(s.saleDate);
      if(d.getFullYear()===year && d.getMonth()===month) p += saleNet(s) - s.quantitySold*item.purchasePricePerUnit;
    });
  });
  return p;
}
function expensesOnDate(iso){
  return (state.expenses||[]).filter(e=>e.date===iso).reduce((s,e)=>s+(e.amount||0),0);
}
function expensesInMonth(year, month){
  return (state.expenses||[]).filter(e=>{
    const d = new Date(e.date);
    return d.getFullYear()===year && d.getMonth()===month;
  }).reduce((s,e)=>s+(e.amount||0),0);
}

// Matches the chart to whichever period is selected up top, the same way
// the stat cards do — "Day" only has one real data point (sales only
// record a date, not a time, so there's no finer granularity available),
// Week/Month show daily points, Year/All Time aggregate by month since
// hundreds of daily points wouldn't be readable.
// Same local-date logic as todayISO(), but for an arbitrary date — used
// throughout the chart's day-by-day lookups below, which had the exact
// same UTC-conversion bug todayISO() did.
function localISO(d){
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const day = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

function profitSeriesForPeriod(period){
  const today = new Date(); today.setHours(0,0,0,0);

  if(period==="Day"){
    const iso = todayISO();
    return [{date: new Date(today), value: profitOnDate(iso), expenses: expensesOnDate(iso)}];
  }
  if(period==="Week" || period==="Month"){
    const spanDays = period==="Week" ? 6 : 29;
    const days = [];
    for(let i=spanDays; i>=0; i--){ const d=new Date(today); d.setDate(d.getDate()-i); days.push(d); }
    return days.map(d=>{ const iso=localISO(d); return {date:d, value: profitOnDate(iso), expenses: expensesOnDate(iso)}; });
  }
  if(period==="Year"){
    const months = [];
    for(let i=11; i>=0; i--){ months.push(new Date(today.getFullYear(), today.getMonth()-i, 1)); }
    return months.map(d=>({date:d, value: profitInMonth(d.getFullYear(), d.getMonth()), expenses: expensesInMonth(d.getFullYear(), d.getMonth())}));
  }
  // All Time: monthly from the earliest sale OR expense on record through
  // now, capped to the most recent 36 months so a very long history stays
  // readable.
  let earliest = null;
  state.items.forEach(item=>item.sales.forEach(s=>{
    const d = new Date(s.saleDate);
    if(!earliest || d<earliest) earliest = d;
  }));
  (state.expenses||[]).forEach(e=>{
    const d = new Date(e.date);
    if(!earliest || d<earliest) earliest = d;
  });
  if(!earliest){
    return [{date: new Date(today.getFullYear(), today.getMonth(), 1), value: 0, expenses: 0}];
  }
  const months = [];
  let cursor = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth(), 1);
  while(cursor <= end){
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth()+1);
  }
  return months.slice(-36).map(d=>({date:d, value: profitInMonth(d.getFullYear(), d.getMonth()), expenses: expensesInMonth(d.getFullYear(), d.getMonth())}));
}
function sparklineSVG(series){
  // A single-point series (the "Day" period — sales only record a date,
  // not a time, so there's no finer breakdown available) needs different
  // handling before it gets duplicated below: with only one real value,
  // the normal min/max-based scaling makes that value BE the max (or
  // min), which pins the line right at the very top or bottom edge of the
  // chart — technically present but visually cramped enough that it read
  // as "missing." A symmetric range around zero keeps the point
  // comfortably in view regardless of its sign.
  const wasSinglePoint = series.length === 1;
  if(wasSinglePoint){
    series = [series[0], series[0]];
  }
  const w=520, h=150, pad=10, topPad=26, bottomPad=24;
  const values = series.map(p=>p.value);
  const expenseValues = series.map(p=>p.expenses||0);
  let min, max;
  if(wasSinglePoint){
    const range = Math.max(Math.abs(values[0]), Math.abs(expenseValues[0]), 1) * 1.6;
    min = -range; max = range;
  } else {
    // Expenses are always >= 0, but included here so the red line always
    // fits on the same vertical scale as the profit line, never clipped.
    min = Math.min(0, ...values); max = Math.max(0, ...values, ...expenseValues);
    if(min===max){ min-=1; max+=1; }
  }
  const plotTop = topPad, plotBottom = h-bottomPad;
  const stepX = (w-pad*2)/(series.length-1);
  const yFor = v => plotBottom - ((v-min)/(max-min)) * (plotBottom-plotTop);
  const pts = series.map((p,i)=>[pad+i*stepX, yFor(p.value)]);
  const expensePts = series.map((p,i)=>[pad+i*stepX, yFor(p.expenses||0)]);
  const linePath = pts.map((p,i)=> (i===0?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  const expenseLinePath = expensePts.map((p,i)=> (i===0?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  const areaPath = linePath + ` L${pts[pts.length-1][0].toFixed(1)},${plotBottom} L${pts[0][0].toFixed(1)},${plotBottom} Z`;
  const zeroY = yFor(0);

  const dateLabelIdx = series.map((_,i)=>i).filter(i=> i%3===0 || i===series.length-1);
  const dateLabels = dateLabelIdx.map(i=>({x: pad+i*stepX, text: `${series[i].date.getMonth()+1}/${series[i].date.getDate()}`}));

  // Label every day that actually had activity — most days will be $0 and
  // stay unlabeled to avoid clutter, but every real data point gets its
  // exact value shown directly on the chart, plus a hover tooltip. The
  // single point on a "Day" chart is the one exception — suppressing a
  // $0 label there left the whole chart looking completely blank, since
  // there's no other point to give it context the way a 7-day chart has.
  // Only the profit line gets these — showing labels for both lines at
  // every point would clutter the chart fast; expenses are still fully
  // visible via the red line itself and the hover tooltip.
  const valueMarkers = pts.map((pt,i)=>{
    const v = series[i].value;
    if(v===0 && !wasSinglePoint) return "";
    const above = v >= 0;
    const labelY = above ? pt[1]-9 : pt[1]+16;
    const color = v>=0 ? "#3DD68C" : "#F16565";
    return `
      <circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="3.5" fill="${color}">
        <title>${series[i].date.toLocaleDateString(undefined,{month:'short',day:'numeric'})}: ${fmtMoney(v)}</title>
      </circle>
      <text x="${pt[0].toFixed(1)}" y="${labelY.toFixed(1)}" font-size="10.5" font-weight="600" fill="${color}" font-family="IBM Plex Mono, monospace" text-anchor="middle">${fmtMoney(v)}</text>
    `;
  }).join("");

  // Exposed so a mousemove handler (bound separately, after this HTML is
  // actually in the DOM) can find the nearest point and show a proper
  // custom tooltip — the <title> attributes above only give a slow,
  // plain browser-native tooltip, not something that actually feels
  // interactive.
  window.__chartPoints = pts.map((pt,i)=>({
    x: pt[0], y: pt[1], value: series[i].value, expenses: series[i].expenses||0,
    dateLabel: series[i].date.toLocaleDateString(undefined,{month:'short',day:'numeric', year:'numeric'})
  }));
  window.__chartWidth = w;

  return `
    <div id="profitChartWrap" style="position:relative;">
      <div style="display:flex;gap:16px;justify-content:flex-end;margin-bottom:2px;">
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);"><span style="width:10px;height:2.5px;border-radius:2px;background:var(--violet);display:inline-block;"></span>Profit</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);"><span style="width:10px;height:2.5px;border-radius:2px;background:var(--red);display:inline-block;"></span>Expenses</span>
      </div>
      <svg id="profitChartSvg" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;cursor:crosshair;">
        <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" style="stop-color:var(--violet);stop-opacity:0.35"/>
          <stop offset="100%" style="stop-color:var(--violet);stop-opacity:0"/>
        </linearGradient></defs>
        <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${w-pad}" y2="${zeroY.toFixed(1)}" stroke="#232332" stroke-width="1" stroke-dasharray="3 3"/>
        <text x="${pad}" y="${(zeroY-5).toFixed(1)}" font-size="9.5" fill="#5C5C72" font-family="IBM Plex Mono, monospace">${fmtMoney(0)}</text>
        <path d="${areaPath}" fill="url(#sparkFill)" stroke="none"/>
        <path d="${expenseLinePath}" fill="none" style="stroke:var(--red);" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 3" opacity="0.85"/>
        <path d="${linePath}" fill="none" style="stroke:var(--violet);" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        ${valueMarkers}
        ${dateLabels.map(l=>`<text x="${l.x}" y="${h-6}" font-size="9.5" fill="#5C5C72" font-family="IBM Plex Mono, monospace" text-anchor="middle">${l.text}</text>`).join("")}
        <line id="chartHoverLine" x1="0" y1="${plotTop}" x2="0" y2="${plotBottom}" stroke="var(--violet)" stroke-width="1" opacity="0" pointer-events="none"/>
        <circle id="chartHoverDot" cx="0" cy="0" r="4.5" fill="var(--violet)" stroke="var(--bg)" stroke-width="2" opacity="0" pointer-events="none"/>
      </svg>
    </div>
  `;
}

// The tooltip lives permanently as a direct child of <body>, created once
// and reused — never nested inside the dashboard's own re-rendered HTML.
// This is deliberate, not just tidiness: position:fixed is only
// guaranteed to position relative to the viewport if no ancestor sets a
// transform/filter/will-change (any of those silently makes position:fixed
// behave like position:absolute relative to THAT ancestor instead). Every
// other fix attempt still left the tooltip nested somewhere inside the
// dashboard's DOM tree, relying on none of its ancestors ever having such
// a property — appending directly to body sidesteps that risk entirely,
// with certainty, regardless of anything else on the page.
// Deliberately mirrors sparklineSVG's structure closely — same width,
// height, padding, scaling approach, and critically the same element
// IDs (profitChartSvg, chartHoverLine, chartHoverDot) and
// window.__chartPoints/__chartWidth convention. That means the existing
// hover/tooltip mechanism (bindChartHoverEvents, already wired into
// attachDashboardEvents) works on this chart completely unchanged —
// no separate hover implementation needed for the bar view.
function barChartSVG(series){
  const wasSinglePoint = series.length === 1;
  if(wasSinglePoint){
    series = [series[0], series[0]];
  }
  const w=520, h=150, pad=10, topPad=26, bottomPad=24;
  const values = series.map(p=>p.value);
  const expenseValues = series.map(p=>p.expenses||0);
  let min, max;
  if(wasSinglePoint){
    const range = Math.max(Math.abs(values[0]), Math.abs(expenseValues[0]), 1) * 1.6;
    min = -range; max = range;
  } else {
    min = Math.min(0, ...values); max = Math.max(0, ...values, ...expenseValues);
    if(min===max){ min-=1; max+=1; }
  }
  const plotTop = topPad, plotBottom = h-bottomPad;
  const stepX = (w-pad*2)/series.length;
  const yFor = v => plotBottom - ((v-min)/(max-min)) * (plotBottom-plotTop);
  const zeroY = yFor(0);
  const barGap = 3;
  const barW = Math.max(2, (stepX - barGap*3) / 2);

  const bars = series.map((p,i)=>{
    const groupX = pad + i*stepX + barGap;
    const profitY = yFor(p.value);
    const profitTop = Math.min(profitY, zeroY);
    const profitH = Math.max(1, Math.abs(profitY - zeroY));
    const expenseY = yFor(p.expenses||0);
    const expenseTop = Math.min(expenseY, zeroY);
    const expenseH = Math.max(1, Math.abs(expenseY - zeroY));
    const profitColor = p.value >= 0 ? "var(--violet)" : "var(--red)";
    return `
      <rect x="${groupX.toFixed(1)}" y="${profitTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${profitH.toFixed(1)}" rx="2" fill="${profitColor}">
        <title>${p.date.toLocaleDateString(undefined,{month:'short',day:'numeric'})}: ${fmtMoney(p.value)}</title>
      </rect>
      <rect x="${(groupX+barW+barGap).toFixed(1)}" y="${expenseTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${expenseH.toFixed(1)}" rx="2" fill="var(--red)" opacity="0.55">
        <title>${p.date.toLocaleDateString(undefined,{month:'short',day:'numeric'})}: ${fmtMoney(p.expenses||0)} expenses</title>
      </rect>
    `;
  }).join("");

  const dateLabelIdx = series.map((_,i)=>i).filter(i=> i%3===0 || i===series.length-1);
  const dateLabels = dateLabelIdx.map(i=>({x: pad+i*stepX+stepX/2, text: `${series[i].date.getMonth()+1}/${series[i].date.getDate()}`}));

  // Same point convention as the line chart — centered over each bar
  // group, at the profit bar's value height — so the existing
  // nearest-point hover logic finds the right group without any changes.
  window.__chartPoints = series.map((p,i)=>({
    x: pad + i*stepX + stepX/2, y: yFor(p.value), value: p.value, expenses: p.expenses||0,
    dateLabel: p.date.toLocaleDateString(undefined,{month:'short',day:'numeric', year:'numeric'})
  }));
  window.__chartWidth = w;

  return `
    <div id="profitChartWrap" style="position:relative;">
      <div style="display:flex;gap:16px;justify-content:flex-end;margin-bottom:2px;">
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);"><span style="width:10px;height:10px;border-radius:2px;background:var(--violet);display:inline-block;"></span>Profit</span>
        <span style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);"><span style="width:10px;height:10px;border-radius:2px;background:var(--red);opacity:0.55;display:inline-block;"></span>Expenses</span>
      </div>
      <svg id="profitChartSvg" viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;cursor:crosshair;">
        <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${w-pad}" y2="${zeroY.toFixed(1)}" stroke="#232332" stroke-width="1" stroke-dasharray="3 3"/>
        <text x="${pad}" y="${(zeroY-5).toFixed(1)}" font-size="9.5" fill="#5C5C72" font-family="IBM Plex Mono, monospace">${fmtMoney(0)}</text>
        ${bars}
        ${dateLabels.map(l=>`<text x="${l.x}" y="${h-6}" font-size="9.5" fill="#5C5C72" font-family="IBM Plex Mono, monospace" text-anchor="middle">${l.text}</text>`).join("")}
        <line id="chartHoverLine" x1="0" y1="${plotTop}" x2="0" y2="${plotBottom}" stroke="var(--violet)" stroke-width="1" opacity="0" pointer-events="none"/>
        <circle id="chartHoverDot" cx="0" cy="0" r="4.5" fill="var(--violet)" stroke="var(--bg)" stroke-width="2" opacity="0" pointer-events="none"/>
      </svg>
    </div>
  `;
}

function ensureChartTooltipElement(){
  let tooltip = document.getElementById("chartTooltip");
  if(tooltip) return tooltip;
  tooltip = document.createElement("div");
  tooltip.id = "chartTooltip";
  tooltip.style.cssText = "position:fixed;pointer-events:none;opacity:0;transition:opacity .1s;background:var(--card-2);border:1px solid var(--border);border-radius:8px;padding:7px 11px;font-size:12px;white-space:nowrap;transform:translate(-50%,-115%);z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,0.35);";
  tooltip.innerHTML = `
    <div id="chartTooltipDate" class="hint" style="margin:0 0 2px;"></div>
    <div id="chartTooltipValue" class="mono" style="font-weight:700;"></div>
  `;
  document.body.appendChild(tooltip);
  return tooltip;
}
function donutSVG(entries, total){
  const r=48, cx=60, cy=60, sw=15;
  let acc = 0;
  const circles = entries.map(c=>{
    const pct = (c.value/total)*100;
    const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${c.color}" stroke-width="${sw}" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="${-acc}" pathLength="100"/>`;
    acc += pct;
    return el;
  }).join("");
  return `<svg viewBox="0 0 120 120" width="120" height="120" style="transform:rotate(-90deg);flex-shrink:0;">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1B1B28" stroke-width="${sw}"/>
    ${circles}
  </svg>`;
}

function attachDashboardEvents(){
  document.querySelectorAll("[data-period]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ ui.period = btn.dataset.period; renderView(); });
  });
  document.querySelectorAll("[data-chart-type]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ ui.chartType = btn.dataset.chartType; renderView(); });
  });
  bindChartHoverEvents();
}

/* ============================================================
   ANALYTICS
   ============================================================ */

let analyticsUI = { period: "Month" };

// Renders a sorted, proportional horizontal-bar breakdown from a plain
// {label: value} object — reused across every breakdown panel on this
// page (platform, category, retailer, expense tag) rather than building
// each one separately.
function breakdownBarsHTML(dataObj, opts){
  const entries = Object.entries(dataObj).filter(([,v])=>v!==0).sort((a,b)=>b[1]-a[1]);
  if(entries.length===0) return `<div class="hint">No data yet for this period.</div>`;
  const max = Math.max(...entries.map(([,v])=>Math.abs(v)));
  const color = (opts && opts.color) || "var(--violet)";
  return `
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${entries.map(([label,value])=>`
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;">
            <span style="color:var(--text-dim);">${escapeHTML(label)}</span>
            <span class="mono" style="font-weight:600;color:${value<0?'var(--red)':'var(--text)'};">${fmtMoney(value)}</span>
          </div>
          <div style="height:7px;background:var(--card-2);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${max>0?Math.abs(value)/max*100:0}%;background:${value<0?'var(--red)':color};border-radius:4px;"></div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function analyticsHTML(){
  const start = periodStart(analyticsUI.period);
  const inPeriod = d => !start || new Date(d) >= start;
  const nonPreorderItems = state.items.filter(i => !i.isPreorder);

  // Point-in-time inventory health — deliberately NOT period-filtered,
  // since "how much dead stock do I have right now" isn't really a
  // "this month" question.
  const totalPurchasedQty = nonPreorderItems.reduce((s,i)=>s+i.quantityPurchased,0);
  const totalSoldQty = nonPreorderItems.reduce((s,i)=>s+qtySold(i),0);
  const sellThroughRate = totalPurchasedQty>0 ? (totalSoldQty/totalPurchasedQty*100) : 0;
  const inventoryValue = nonPreorderItems.reduce((s,i)=>s+qtyRemaining(i)*i.purchasePricePerUnit,0);

  const daysToSellList = [];
  nonPreorderItems.forEach(i => i.sales.forEach(s => {
    if(!i.purchaseDate || !s.saleDate) return;
    const days = Math.round((new Date(s.saleDate)-new Date(i.purchaseDate))/86400000);
    if(days>=0) daysToSellList.push(days);
  }));
  const avgDaysToSell = daysToSellList.length ? Math.round(daysToSellList.reduce((a,b)=>a+b,0)/daysToSellList.length) : null;

  const DEAD_STOCK_DAYS = 60;
  const deadStock = nonPreorderItems.filter(i=>{
    if(qtyRemaining(i)<=0 || !i.purchaseDate) return false;
    return Math.round((new Date()-new Date(i.purchaseDate))/86400000) >= DEAD_STOCK_DAYS;
  }).sort((a,b)=>new Date(a.purchaseDate)-new Date(b.purchaseDate));

  // Everything below IS period-filtered — these are activity breakdowns,
  // where "this month" is exactly the useful lens.
  const platformStats = {}, categoryStats = {};
  nonPreorderItems.forEach(i => i.sales.forEach(s=>{
    if(!inPeriod(s.saleDate)) return;
    const profit = saleNet(s) - s.quantitySold*i.purchasePricePerUnit;
    const p = s.platform || "Unknown";
    platformStats[p] = (platformStats[p]||0) + profit;
    const c = i.category || "Other";
    categoryStats[c] = (categoryStats[c]||0) + profit;
  }));

  const itemProfits = nonPreorderItems.map(i=>{
    const periodSales = i.sales.filter(s=>inPeriod(s.saleDate));
    const profit = periodSales.reduce((s,sale)=>s+saleNet(sale)-sale.quantitySold*i.purchasePricePerUnit,0);
    const qty = periodSales.reduce((s,sale)=>s+sale.quantitySold,0);
    return {item:i, profit, qty};
  }).filter(x=>x.qty>0).sort((a,b)=>b.profit-a.profit).slice(0,5);

  // Same retailer-aware logic as the dashboard's Total Spent — Pokémon
  // Center preorders count once received, everything else counts at
  // confirmation. Reused here rather than re-derived so the two pages
  // can't quietly disagree with each other.
  const retailerSpend = {};
  state.items.filter(i=>!(i.isPreorder && i.retailer==="Pokemon Center") && inPeriod(i.purchaseDate)).forEach(i=>{
    retailerSpend[i.retailer||"Unknown"] = (retailerSpend[i.retailer||"Unknown"]||0) + totalCost(i);
  });
  state.pendingOrders.filter(p=>p.retailer!=="Pokemon Center" && !p.addedToStockId && p.status!=="cancelled" && inPeriod(p.orderDate)).forEach(p=>{
    retailerSpend[p.retailer||"Unknown"] = (retailerSpend[p.retailer||"Unknown"]||0) + (p.price||0);
  });

  const expenseByTag = {};
  (state.expenses||[]).filter(e=>inPeriod(e.date)).forEach(e=>{
    expenseByTag[e.tag||"Other"] = (expenseByTag[e.tag||"Other"]||0) + (e.amount||0);
  });

  return `
    <div class="toolbar-row" style="margin-bottom:16px;">
      <div class="segmented">
        ${["Day","Week","Month","Year","All Time"].map(p=>`<button class="${analyticsUI.period===p?"active":""}" data-analytics-period="${p}">${p==="All Time"?"All":p}</button>`).join("")}
      </div>
    </div>

    <div class="stat-grid" style="margin-bottom:16px;">
      ${statCard("percent", "Sell-Through Rate", fmtPct(sellThroughRate), "var(--violet)", "var(--violet-bg)", "Percentage of everything you've ever bought that's since sold")}
      ${statCard("trend", "Avg. Days to Sell", avgDaysToSell===null ? "—" : avgDaysToSell+"d", "var(--cyan)", "var(--cyan-bg)", "Average time between buying an item and it selling")}
      ${statCard("stock", "Inventory Value", fmtMoney(inventoryValue), "var(--blue)", "var(--blue-bg)", "What your current unsold stock cost to buy")}
      ${statCard("cart", `Dead Stock (${DEAD_STOCK_DAYS}+ days)`, ""+deadStock.length, deadStock.length>0?"var(--red)":"var(--green)", deadStock.length>0?"var(--red-bg)":"var(--green-bg)", "Unsold items sitting for two months or more")}
    </div>

    <div class="dash-grid" style="margin-bottom:16px;">
      <div class="card panel">
        <div class="panel-title">Profit by Platform — ${periodQualifier(analyticsUI.period)}</div>
        ${breakdownBarsHTML(platformStats)}
      </div>
      <div class="card panel">
        <div class="panel-title">Profit by Category — ${periodQualifier(analyticsUI.period)}</div>
        ${breakdownBarsHTML(categoryStats, {color:"var(--cyan)"})}
      </div>
    </div>

    <div class="dash-grid" style="margin-bottom:16px;">
      <div class="card panel">
        <div class="panel-title">Where the Money's Going — ${periodQualifier(analyticsUI.period)}</div>
        ${breakdownBarsHTML(retailerSpend, {color:"var(--blue)"})}
      </div>
      <div class="card panel">
        <div class="panel-title">Running Costs by Type — ${periodQualifier(analyticsUI.period)}</div>
        ${breakdownBarsHTML(expenseByTag, {color:"var(--red)"})}
      </div>
    </div>

    <div class="card panel" style="margin-bottom:16px;">
      <div class="panel-title">Most Profitable Items — ${periodQualifier(analyticsUI.period)}</div>
      ${itemProfits.length===0 ? `<div class="hint">No sales yet for this period.</div>` : `
        <div class="card table-wrap" style="box-shadow:none;">
          <table class="data-table">
            <thead><tr><th>Item</th><th>Qty Sold</th><th style="text-align:right;">Profit</th></tr></thead>
            <tbody>
              ${itemProfits.map(x=>`<tr><td>${escapeHTML(x.item.name)}</td><td class="mono dim">${x.qty}</td><td class="mono" style="text-align:right;color:${x.profit>=0?'var(--green)':'var(--red)'};">${fmtMoney(x.profit)}</td></tr>`).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>

    <div class="card panel">
      <div class="panel-title">Dead Stock <span class="hint" style="margin:0;">— unsold for ${DEAD_STOCK_DAYS}+ days</span></div>
      ${deadStock.length===0 ? `<div class="hint">Nothing's been sitting that long — nice.</div>` : `
        <div class="card table-wrap" style="box-shadow:none;">
          <table class="data-table">
            <thead><tr><th>Item</th><th>Purchased</th><th>Days sitting</th><th style="text-align:right;">Remaining</th><th style="text-align:right;">Tied-up cost</th></tr></thead>
            <tbody>
              ${deadStock.map(i=>{
                const days = Math.round((new Date()-new Date(i.purchaseDate))/86400000);
                return `<tr data-open-item="${i.id}" style="cursor:pointer;"><td>${escapeHTML(i.name)}</td><td class="mono dim">${formatDate(i.purchaseDate)}</td><td class="mono">${days}d</td><td class="mono" style="text-align:right;">${qtyRemaining(i)}</td><td class="mono" style="text-align:right;">${fmtMoney(qtyRemaining(i)*i.purchasePricePerUnit)}</td></tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>
    <div style="height:20px;"></div>
  `;
}

function attachAnalyticsEvents(){
  document.querySelectorAll("[data-analytics-period]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ analyticsUI.period = btn.dataset.analyticsPeriod; renderView(); });
  });
  document.querySelectorAll("[data-open-item]").forEach(row=>{
    row.addEventListener("click", ()=>{ ui.detailItemId = row.dataset.openItem; render(); });
  });
}

function bindChartHoverEvents(){
  const svg = document.getElementById("profitChartSvg");
  if(!svg || !window.__chartPoints || window.__chartPoints.length===0) return;
  const tooltip = ensureChartTooltipElement();
  const tooltipDate = document.getElementById("chartTooltipDate");
  const tooltipValue = document.getElementById("chartTooltipValue");
  const hoverLine = document.getElementById("chartHoverLine");
  const hoverDot = document.getElementById("chartHoverDot");
  const points = window.__chartPoints;
  const viewBoxWidth = window.__chartWidth;

  function nearestPoint(svgX){
    let best = points[0], bestDist = Infinity;
    for(const p of points){
      const d = Math.abs(p.x - svgX);
      if(d < bestDist){ bestDist = d; best = p; }
    }
    return best;
  }

  // getBoundingClientRect() forces the browser to synchronously recompute
  // layout — calling it on every single mousemove event (which can fire
  // 60+ times a second) was what actually caused the visible "bouncing":
  // real, continuous jank from redoing that work far more than needed,
  // not a genuine change in the page's layout (a snapshot-based check at
  // rest wouldn't have caught this, since it only shows up under rapid,
  // continuous movement). Cached once per hover session instead, and all
  // the actual DOM writes are batched to at most once per animation frame.
  let cachedRect = null;
  let pendingPoint = null;
  let rafScheduled = false;
  let lastShownPointX = null;

  function flush(){
    rafScheduled = false;
    const p = pendingPoint;
    if(!p || p.x === lastShownPointX) return;
    lastShownPointX = p.x;

    hoverLine.setAttribute("x1", p.x); hoverLine.setAttribute("x2", p.x); hoverLine.setAttribute("opacity", "0.5");
    hoverDot.setAttribute("cx", p.x); hoverDot.setAttribute("cy", p.y); hoverDot.setAttribute("opacity", "1");

    tooltipDate.textContent = p.dateLabel;
    tooltipValue.innerHTML = `
      <div><span style="color:var(--violet);">Profit</span> ${fmtMoney(p.value)}</div>
      ${p.expenses>0 ? `<div style="margin-top:2px;"><span style="color:var(--red);">Expenses</span> ${fmtMoney(p.expenses)}</div>` : ""}
    `;
    tooltipValue.className = "mono";

    // Fixed positioning with real viewport pixel coordinates — not
    // percentage-based position:absolute relative to a parent. A
    // position:absolute descendant still counts toward its nearest
    // scrollable ancestor's overflow calculation even though it's out of
    // normal flow, which was very likely what caused the reported
    // "only when maximized" bounce: a maximized window has more
    // borderline-available space, making it more likely for the tooltip
    // to tip that calculation over the threshold that toggles a
    // scrollbar on/off, shifting everything sideways. position:fixed
    // elements are positioned purely from the viewport and cannot affect
    // an ancestor's scrollable area at all, regardless of window size.
    if(cachedRect){
      const pixelX = cachedRect.left + (p.x / viewBoxWidth) * cachedRect.width;
      const pixelY = cachedRect.top + (p.y / 150) * cachedRect.height;
      tooltip.style.left = pixelX + "px";
      tooltip.style.top = pixelY + "px";
    }
    tooltip.style.opacity = "1";
  }

  svg.addEventListener("mouseenter", ()=>{ cachedRect = svg.getBoundingClientRect(); });

  svg.addEventListener("mousemove", (e)=>{
    if(!cachedRect) cachedRect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - cachedRect.left) / cachedRect.width) * viewBoxWidth;
    pendingPoint = nearestPoint(svgX);
    if(!rafScheduled){
      rafScheduled = true;
      requestAnimationFrame(flush);
    }
  });

  svg.addEventListener("mouseleave", ()=>{
    cachedRect = null;
    lastShownPointX = null;
    hoverLine.setAttribute("opacity", "0");
    hoverDot.setAttribute("opacity", "0");
    tooltip.style.opacity = "0";
  });
}

/* ============================================================
   ADD PURCHASE
   ============================================================ */

let addFormState = null;
function freshAddForm(){
  return {
    name:"", category: CATEGORIES[0], customCategory:"",
    quantity:1, price:"", retailer:"", date: todayISO(), notes:"",
    isPreorder:false, expectedArrival:"", image:null
  };
}

function addFormHTML(){
  if(!addFormState) addFormState = freshAddForm();
  const f = addFormState;
  const cost = (parseFloat(f.price)||0) * f.quantity;

  return `
    <div class="field">
      <label>Product Photo (optional)</label>
      <div style="display:flex;align-items:center;gap:14px;">
        ${f.image ? `
          <div style="width:64px;height:64px;border-radius:12px;overflow:hidden;flex-shrink:0;border:1px solid var(--border-soft);background:var(--card-2);">
            <img src="${f.image}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="">
          </div>
        ` : `
          <div style="width:64px;height:64px;border-radius:12px;flex-shrink:0;border:1.5px dashed var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-mute);">
            ${ICONS.box}
          </div>
        `}
        <div style="display:flex;gap:8px;">
          <label class="btn-small" style="cursor:pointer;">
            ${ICONS.plus} ${f.image ? "Change" : "Add"} Photo
            <input type="file" id="f-image" accept="image/*" style="display:none;">
          </label>
          ${f.image ? `<button class="btn-small" id="f-image-remove" style="border-color:var(--red);color:var(--red);">${ICONS.close} Remove</button>` : ""}
        </div>
      </div>
    </div>

    <div class="form-grid">
      <div class="field" style="grid-column:1/-1;">
        <label>What did you buy?</label>
        <input type="text" id="f-name" value="${escapeAttr(f.name)}" placeholder="e.g. Charizard VMAX Booster Box">
      </div>
      <div class="field">
        <label>Category</label>
        <select id="f-category">
          ${CATEGORIES.map(c=>`<option value="${c}" ${f.category===c?"selected":""}>${c}</option>`).join("")}
        </select>
      </div>
      ${f.category==="Other" ? `
      <div class="field">
        <label>Custom category</label>
        <input type="text" id="f-customCategory" value="${escapeAttr(f.customCategory)}">
      </div>` : `<div></div>`}
    </div>

    <div class="section-title">Purchase Details</div>
    <div class="form-grid">
      <div class="field">
        <label>Quantity</label>
        <div class="stepper">
          <button id="qtyMinus">−</button>
          <input type="number" class="qty-input" id="qtyInput" value="${f.quantity}" min="1" step="1">
          <button id="qtyPlus">+</button>
        </div>
      </div>
      <div class="field">
        <label>Price per unit (${state.displayCurrency})</label>
        <input type="number" inputmode="decimal" step="0.01" min="0" id="f-price" value="${f.price}" placeholder="0.00">
      </div>
      <div class="field">
        <label>Retailer</label>
        <input type="text" id="f-retailer" value="${escapeAttr(f.retailer)}" placeholder="e.g. Target, eBay">
      </div>
      <div class="field">
        <label>Purchase date</label>
        <input type="date" id="f-date" value="${f.date}" max="${todayISO()}">
      </div>
      <div class="field" style="grid-column:1/-1;">
        <label>Notes (optional)</label>
        <input type="text" id="f-notes" value="${escapeAttr(f.notes)}" placeholder="Any details worth remembering">
      </div>
    </div>

    <div class="card" style="padding:16px 18px;margin-bottom:16px;">
      <div class="filter-toggle" style="padding:0;">
        <div>
          <div class="desc">This is a preorder</div>
          <div class="sub">Not released or shipped yet — tracked separately until it arrives</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="f-preorder" ${f.isPreorder ? "checked" : ""}>
          <span class="track"></span>
        </label>
      </div>
      ${f.isPreorder ? `
      <div class="field" style="margin:14px 0 0;">
        <label>Expected arrival date (optional)</label>
        <input type="date" id="f-expectedArrival" value="${f.expectedArrival}">
      </div>` : ""}
    </div>

    <div class="card total-card">
      <div class="total-line">
        <span class="label">Total cost</span>
        <span class="value" id="addTotalValue">${fmtMoney(cost)}</span>
      </div>
    </div>

    <div style="height:18px;"></div>
    <button class="btn-primary" id="saveBtn" ${f.name.trim()===""?"disabled":""}>Save to Stock</button>
    <div style="height:30px;"></div>
  `;
}

function attachAddEvents(){
  const f = addFormState;
  const byId = id => document.getElementById(id);

  byId("f-name").addEventListener("input", e=>{ f.name = e.target.value; refreshSaveBtn(); });
  byId("f-category").addEventListener("change", e=>{ f.category = e.target.value; renderView(); });
  if(byId("f-customCategory")) byId("f-customCategory").addEventListener("input", e=>{ f.customCategory = e.target.value; });

  byId("qtyMinus").addEventListener("click", ()=>{ f.quantity = Math.max(1, f.quantity-1); renderView(); });
  byId("qtyPlus").addEventListener("click", ()=>{ f.quantity += 1; renderView(); });
  const qtyInput = byId("qtyInput");
  qtyInput.addEventListener("input", e=>{
    const n = parseInt(e.target.value, 10);
    f.quantity = isNaN(n) ? 0 : n;
    updateAddTotalDisplay();
  });
  qtyInput.addEventListener("blur", ()=>{
    const corrected = Math.max(1, f.quantity||1);
    if(corrected !== f.quantity){
      f.quantity = corrected;
      renderView();
    }
  });

  byId("f-price").addEventListener("input", e=>{ f.price = e.target.value; updateAddTotalDisplay(); });
  byId("f-retailer").addEventListener("input", e=>{ f.retailer = e.target.value; });
  byId("f-date").addEventListener("change", e=>{ f.date = e.target.value; });
  byId("f-notes").addEventListener("input", e=>{ f.notes = e.target.value; });
  byId("f-preorder").addEventListener("change", e=>{ f.isPreorder = e.target.checked; renderView(); });
  if(byId("f-expectedArrival")) byId("f-expectedArrival").addEventListener("change", e=>{ f.expectedArrival = e.target.value; });

  byId("f-image").addEventListener("change", e=>{
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    processImageFile(file, dataUrl=>{ f.image = dataUrl; renderView(); });
  });
  const removeBtn = byId("f-image-remove");
  if(removeBtn) removeBtn.addEventListener("click", ()=>{ f.image = null; renderView(); });

  byId("saveBtn").addEventListener("click", savePurchase);
}

// Resizes/compresses an uploaded photo client-side before storing it as a
// base64 data URL — full-resolution phone photos would otherwise bloat
// localStorage fast. Caps the longest side at 500px and re-encodes as JPEG.
function processImageFile(file, callback){
  const reader = new FileReader();
  reader.onload = (e)=>{
    const img = new Image();
    img.onload = ()=>{
      const maxDim = 500;
      let w = img.width, h = img.height;
      if(w > h){ if(w > maxDim){ h = Math.round(h*maxDim/w); w = maxDim; } }
      else { if(h > maxDim){ w = Math.round(w*maxDim/h); h = maxDim; } }
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = ()=>{ showToast("Couldn't read that image", "close"); };
    img.src = e.target.result;
  };
  reader.onerror = ()=>{ showToast("Couldn't read that file", "close"); };
  reader.readAsDataURL(file);
}

function refreshSaveBtn(){
  const btn = document.getElementById("saveBtn");
  if(btn) btn.disabled = addFormState.name.trim()==="";
}

function updateAddTotalDisplay(){
  const f = addFormState;
  const cost = (parseFloat(f.price)||0) * f.quantity;
  const el = document.getElementById("addTotalValue");
  if(el) el.textContent = fmtMoney(cost);
}

function savePurchase(){
  const f = addFormState;
  if(f.name.trim()==="") return;
  const effCat = f.category==="Other" && f.customCategory.trim() ? f.customCategory.trim() : f.category;
  const item = {
    id: uid(),
    name: f.name.trim(),
    category: effCat,
    quantityPurchased: f.quantity,
    purchasePricePerUnit: parseFloat(f.price)||0,
    retailer: f.retailer.trim(),
    purchaseDate: f.date,
    notes: f.notes,
    isPreorder: f.isPreorder,
    expectedArrival: f.isPreorder ? (f.expectedArrival || null) : null,
    image: f.image || null,
    orderNumber: null, deliveryAddress: null, recipientName: null, sentToEmail: null, lineItems: [], sourceEmailDetected: false,
    sales: []
  };
  state.items.unshift(item);
  saveState();
  showToast(f.isPreorder ? "Added to preorders" : "Added to stock");
  addFormState = freshAddForm();
  setTab(f.isPreorder ? "preorders" : "stock");
}

/* ============================================================
   STOCK LIST
   ============================================================ */

function stockListHTML(){
  return `
    <div class="toolbar-row">
      <div class="segmented">
        <button class="${ui.stockFilter==='In Stock'?'active':''}" data-filter="In Stock">In Stock</button>
        <button class="${ui.stockFilter==='Sold Out'?'active':''}" data-filter="Sold Out">Sold Out</button>
      </div>
      <select id="stockCategoryFilterSelect" style="width:auto;padding:9px 30px 9px 13px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius-sm);color:var(--text);">
        <option ${ui.stockCategoryFilter==="All"?"selected":""}>All</option>
        ${CATEGORIES.map(c=>`<option ${ui.stockCategoryFilter===c?"selected":""}>${c}</option>`).join("")}
      </select>
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="searchInput" placeholder="Search stock" value="${escapeAttr(ui.search)}">
      </div>
      <button class="btn-small" id="exportStockCsvBtn" style="margin-left:auto;">${ICONS.download} Export CSV</button>
    </div>
    <div id="stockResultsContainer">${stockResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function filteredStock(){
  return state.items.filter(i => !i.isPreorder)
    .filter(i => ui.stockFilter==="In Stock" ? !isSoldOut(i) : isSoldOut(i))
    .filter(i => ui.stockCategoryFilter==="All" || i.category===ui.stockCategoryFilter)
    .filter(i => !ui.search || i.name.toLowerCase().includes(ui.search.toLowerCase()));
}

function stockResultsHTML(){
  const filtered = filteredStock();

  if(filtered.length===0){
    return `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">${ui.stockFilter==="In Stock" ? "No stock yet" : "Nothing sold yet"}</div>
        <div class="d">${ui.stockFilter==="In Stock" ? "Items you add will show up here." : "Sold items will appear here."}</div>
      </div>
    `;
  }
  return `
    <div class="card table-wrap" style="margin-top:14px;">
      <table class="data-table">
        <thead><tr><th>Item</th><th>Category</th><th>Left</th><th>Cost</th><th style="text-align:right;">Profit</th></tr></thead>
        <tbody>
          ${filtered.map(i=>{
            const style = CAT_STYLES[i.category]||CAT_STYLES.Other;
            const p = profit(i);
            return `<tr data-id="${i.id}">
              <td><div style="display:flex;align-items:center;gap:10px;">${itemThumb(i,32)}<span style="font-weight:600;">${escapeHTML(i.name)}</span>${i.notes && i.notes.includes("Auto-added from email sync") ? `<span class="hint" style="margin:0;color:var(--gold);">needs review</span>` : ""}</div></td>
              <td><span style="color:${style.fg};font-size:12px;font-weight:600;">${escapeHTML(i.category)}</span></td>
              <td class="mono dim">${qtyRemaining(i)}/${i.quantityPurchased}</td>
              <td class="mono">${fmtMoney(totalCost(i))}</td>
              <td class="mono ${qtySold(i)>0?(p>=0?'pos':'neg'):'dim'}" style="text-align:right;">${qtySold(i)>0 ? (p>=0?'+':'')+fmtMoney(p) : '—'}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderStockResults(){
  const container = document.getElementById("stockResultsContainer");
  if(!container) return;
  container.innerHTML = stockResultsHTML();
  document.querySelectorAll("tr[data-id]").forEach(row=>{
    row.addEventListener("click", ()=>{ ui.detailItemId = row.dataset.id; render(); });
  });
}

function attachStockEvents(){
  document.querySelectorAll("[data-filter]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ ui.stockFilter = btn.dataset.filter; renderView(); });
  });
  document.getElementById("stockCategoryFilterSelect").addEventListener("change", e=>{
    ui.stockCategoryFilter = e.target.value; renderStockResults();
  });
  const search = document.getElementById("searchInput");
  search.addEventListener("input", e=>{ ui.search = e.target.value; renderStockResults(); });
  document.getElementById("exportStockCsvBtn").addEventListener("click", ()=>{
    const items = filteredStock();
    downloadCSV(`stock-${todayISO()}.csv`,
      ["Name","Category","Retailer","Quantity Purchased","Quantity Remaining","Purchase Price","Purchase Date","Order Number"],
      items.map(i=>[i.name, i.category, i.retailer||"", i.quantityPurchased, qtyRemaining(i), i.purchasePricePerUnit, i.purchaseDate||"", i.orderNumber||""])
    );
  });
  document.querySelectorAll("tr[data-id]").forEach(row=>{
    row.addEventListener("click", ()=>{ ui.detailItemId = row.dataset.id; render(); });
  });
}

/* ============================================================
   PREORDERS
   ============================================================ */

let ordersUI = { subTab: "all", search: "", retailerFilter: "All", statusFilter: "All" };

function ordersHTML(){
  const allCount = state.pendingOrders.length;
  // Counts distinct orders, not individual stock items — the card list
  // below is order-centric (one card per order, however many products it
  // has), so this tab label needs to match that, not the item count.
  const pkcOrderNumbers = new Set(
    state.items.filter(i=>i.isPreorder && i.retailer==="Pokemon Center" && !i.isCancelled)
      .map(i=>i.orderNumber || i.id)
  );
  const pkcCount = pkcOrderNumbers.size;
  const cancelledCount = state.pendingOrders.filter(p=>p.status==="cancelled").length;
  return `
    <div class="segmented" style="margin-bottom:4px;">
      <button class="${ordersUI.subTab==='all'?'active':''}" data-orders-subtab="all">All Orders (${allCount})</button>
      <button class="${ordersUI.subTab==='pkc'?'active':''}" data-orders-subtab="pkc">PKC Preorders (${pkcCount})</button>
      <button class="${ordersUI.subTab==='cancelled'?'active':''}" data-orders-subtab="cancelled">Cancelled (${cancelledCount})</button>
    </div>
    ${ordersUI.subTab==='all' ? allOrdersContentHTML() : ordersUI.subTab==='pkc' ? pkcOrdersContentHTML() : cancelledOrdersContentHTML()}
  `;
}

function attachOrdersEvents(){
  document.querySelectorAll("[data-orders-subtab]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      ordersUI.subTab = btn.dataset.ordersSubtab;
      renderView();
    });
  });
  if(ordersUI.subTab==='all'){
    attachAllOrdersEvents();
  } else if(ordersUI.subTab==='pkc'){
    attachPreordersEvents();
  } else {
    attachCancelledOrdersEvents();
  }
}

// Groups the finer-grained underlying statuses into filter buckets: a
// payment issue is still fundamentally a "not shipped yet" order, and
// ready-for-collection stays grouped with Shipped as "in transit" — but
// Out for Delivery gets its own distinct option, since it's a specific,
// actionable stage someone would want to filter to directly.
const ORDER_STATUS_GROUPS = {
  "Order Placed": ["confirmed", "action_required"],
  "Shipped": ["shipped", "ready_for_collection"],
  "Out for Delivery": ["out_for_delivery"],
  "Complete": ["delivered"],
  "Cancelled": ["cancelled"]
};

function allOrdersContentHTML(){
  const orders = state.pendingOrders;
  const retailers = Array.from(new Set(orders.map(p=>p.retailer).filter(Boolean))).sort();

  return `
    <div class="toolbar-row">
      <button class="btn-primary" id="addOrderBtn">${ICONS.plus} Add Order</button>
      <select id="orderStatusFilterSelect" style="width:auto;padding:9px 30px 9px 13px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius-sm);color:var(--text);">
        <option ${ordersUI.statusFilter==="All"?"selected":""}>All</option>
        ${Object.keys(ORDER_STATUS_GROUPS).map(s=>`<option ${ordersUI.statusFilter===s?"selected":""}>${s}</option>`).join("")}
      </select>
      <select id="orderRetailerFilterSelect" style="width:auto;padding:9px 30px 9px 13px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius-sm);color:var(--text);">
        <option ${ordersUI.retailerFilter==="All"?"selected":""}>All</option>
        ${retailers.map(r=>`<option ${ordersUI.retailerFilter===r?"selected":""}>${escapeHTML(r)}</option>`).join("")}
      </select>
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="orderSearchInput" placeholder="Search orders" value="${escapeAttr(ordersUI.search)}">
      </div>
      <button class="btn-small" id="exportOrdersCsvBtn" style="margin-left:auto;">${ICONS.download} Export CSV</button>
    </div>
    <div id="allOrdersResultsContainer">${allOrdersResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function filteredAllOrders(){
  const statusGroup = ordersUI.statusFilter!=="All" ? ORDER_STATUS_GROUPS[ordersUI.statusFilter] : null;
  return state.pendingOrders
    .filter(p=> !statusGroup || statusGroup.includes(p.status))
    .filter(p=> ordersUI.retailerFilter==="All" || p.retailer===ordersUI.retailerFilter)
    .filter(p=> !ordersUI.search || (p.retailer||"").toLowerCase().includes(ordersUI.search.toLowerCase()) || (p.orderNumber||"").toLowerCase().includes(ordersUI.search.toLowerCase()))
    .sort((a,b)=> new Date(b.orderDate)-new Date(a.orderDate));
}

function allOrdersResultsHTML(){
  const orders = filteredAllOrders();

  if(orders.length===0){
    return `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">No orders yet</div>
        <div class="d">Orders detected via Email Sync show up here, tracked from placed through delivery.</div>
      </div>
    `;
  }

  return `
    <div class="card table-wrap" style="margin-top:14px;">
      <table class="data-table">
        <thead><tr><th>Status</th><th>Retailer</th><th>Order #</th><th>Order Date</th><th>Carrier / Tracking</th><th>Est. Delivery</th><th>Price</th><th></th></tr></thead>
        <tbody>
          ${orders.map(p=>`
            <tr data-open-order="${p.id}">
              <td>${statusChip(p.status)}</td>
              <td>
                <div style="font-weight:600;">${escapeHTML(p.retailer)}</div>
                ${p.fromEmail ? `<button class="block-sender-btn" data-block="${escapeAttr(p.fromEmail)}">Block this sender</button>` : ""}
              </td>
              <td class="mono dim">${p.orderNumber ? escapeHTML(p.orderNumber) : "—"}</td>
              <td class="mono dim">${p.orderDate ? formatDate(p.orderDate) : "—"}</td>
              <td class="dim" style="font-size:12px;">${p.carrier || p.trackingNumber ? `${p.carrier?escapeHTML(p.carrier):"Carrier unknown"}${p.trackingNumber ? " · " + (p.retailer==="Pokemon Center" ? `<a href="#" data-track-royalmail="${escapeAttr(p.trackingNumber)}" style="color:var(--violet);text-decoration:underline;">${escapeHTML(p.trackingNumber)}</a>` : escapeHTML(p.trackingNumber)) : ""}` : "—"}</td>
              <td class="mono dim" style="font-size:12px;">${p.expectedDelivery ? formatDate(p.expectedDelivery) : "—"}${p.expectedDeliveryTime ? `<br>${escapeHTML(p.expectedDeliveryTime)}` : ""}</td>
              <td class="mono">${p.price!==null && p.price!==undefined ? fmtMoney(p.price) : "—"}</td>
              <td style="text-align:right;">
                ${p.addedToStockId && state.items.find(i=>i.id===p.addedToStockId) ? `<button class="btn-ghost" data-view="${p.addedToStockId}">View in Stock ${ICONS.chev}</button>` : `<button class="icon-btn" data-remove="${p.id}">${ICONS.close}</button>`}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:10px;">Click any order for full details — what was bought, delivery address, and which email it was sent to.</div>
  `;
}

function renderAllOrdersResults(){
  const container = document.getElementById("allOrdersResultsContainer");
  if(!container) return;
  container.innerHTML = allOrdersResultsHTML();
  bindAllOrdersResultEvents();
}

let addOrderFormState = null;
const ORDER_STATUSES = [
  ["confirmed","Order Placed"], ["shipped","Shipped"],
  ["out_for_delivery","Out for Delivery"], ["ready_for_collection","Ready for Collection"],
  ["delivered","Delivered"]
];

function openAddOrderModal(){
  addOrderFormState = { retailer:"", orderNumber:"", price:"", orderDate: todayISO(), status:"confirmed", carrier:"", trackingNumber:"", expectedDelivery:"" };
  renderAddOrderModal();
}

function renderAddOrderModal(){
  const f = addOrderFormState;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="addOrderBackdrop">
      <div class="modal" style="width:460px;">
        <div class="modal-header">
          <h2>Add Order</h2>
          <button class="icon-btn" id="closeAddOrder">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field" style="grid-column:1/-1;">
              <label>Retailer</label>
              <input type="text" id="ao-retailer" value="${escapeAttr(f.retailer)}" placeholder="e.g. Amazon">
            </div>
            <div class="field">
              <label>Price</label>
              <input type="number" id="ao-price" value="${escapeAttr(f.price)}" placeholder="0.00" step="0.01" min="0">
            </div>
            <div class="field">
              <label>Order number (optional)</label>
              <input type="text" id="ao-orderNumber" value="${escapeAttr(f.orderNumber)}">
            </div>
            <div class="field">
              <label>Order date</label>
              <input type="date" id="ao-orderDate" value="${f.orderDate}">
            </div>
            <div class="field">
              <label>Status</label>
              <select id="ao-status">
                ${ORDER_STATUSES.map(([v,l])=>`<option value="${v}" ${f.status===v?"selected":""}>${l}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Carrier (optional)</label>
              <input type="text" id="ao-carrier" value="${escapeAttr(f.carrier)}">
            </div>
            <div class="field">
              <label>Tracking number (optional)</label>
              <input type="text" id="ao-trackingNumber" value="${escapeAttr(f.trackingNumber)}">
            </div>
            <div class="field" style="grid-column:1/-1;">
              <label>Expected delivery (optional)</label>
              <input type="date" id="ao-expectedDelivery" value="${f.expectedDelivery}">
            </div>
          </div>
          ${f.status==="delivered" ? `<div class="hint" style="margin-bottom:10px;">Since this is already delivered, it'll be added straight to Stock too.</div>` : ""}
          <button class="btn-primary block" id="saveAddOrderBtn">Add Order</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeAddOrder").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("ao-retailer").addEventListener("input", e=>{ f.retailer = e.target.value; });
  document.getElementById("ao-price").addEventListener("input", e=>{ f.price = e.target.value; });
  document.getElementById("ao-orderNumber").addEventListener("input", e=>{ f.orderNumber = e.target.value; });
  document.getElementById("ao-orderDate").addEventListener("change", e=>{ f.orderDate = e.target.value; });
  document.getElementById("ao-status").addEventListener("change", e=>{ f.status = e.target.value; renderAddOrderModal(); });
  document.getElementById("ao-carrier").addEventListener("input", e=>{ f.carrier = e.target.value; });
  document.getElementById("ao-trackingNumber").addEventListener("input", e=>{ f.trackingNumber = e.target.value; });
  document.getElementById("ao-expectedDelivery").addEventListener("change", e=>{ f.expectedDelivery = e.target.value; });

  document.getElementById("saveAddOrderBtn").addEventListener("click", ()=>{
    const retailer = f.retailer.trim();
    const price = f.price.trim() ? parseFloat(f.price) : null;
    const orderNumber = f.orderNumber.trim() || null;
    if(!retailer){ showToast("Enter a retailer", "close"); return; }
    if(f.price.trim() && (isNaN(price) || price<0)){ showToast("Enter a valid price", "close"); return; }

    // Matches the same key format email-detected orders use whenever an
    // order number is given — otherwise a manually-added order can never
    // be found and updated by a later status-change email for that same
    // order (shipped, out for delivery, etc.), and would end up creating
    // a duplicate entry instead of updating this one.
    const order = {
      id: uid(), matchKey: orderNumber ? ("num:"+orderNumber) : ("manual:"+uid()), retailer, price,
      fromEmail: null, orderDate: f.orderDate || todayISO(),
      expectedDelivery: f.expectedDelivery || null, expectedDeliveryTime: null,
      carrier: f.carrier.trim() || null, trackingNumber: f.trackingNumber.trim() || null,
      orderNumber, status: f.status, addedToStockId: null, isPKCPreorder: false
    };

    if(f.status==="delivered"){
      const item = createStockItemFromOrder(order);
      order.addedToStockId = item.id;
    }
    state.pendingOrders.unshift(order);
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    showToast(`Order from ${retailer} added`);
    if(ui.tab==="orders") renderView();
  });
}

let orderStatusEditing = null;

const ALL_ORDER_STATUSES = ["confirmed", "action_required", "shipped", "out_for_delivery", "ready_for_collection", "delivered", "cancelled"];

function orderDetailModal(orderId){
  const p = state.pendingOrders.find(o=>o.id===orderId);
  if(!p) return;
  const editingStatus = orderStatusEditing === orderId;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="orderDetailBackdrop">
      <div class="modal" style="width:520px;">
        <div class="modal-header">
          <h2>${escapeHTML(p.retailer)}</h2>
          <button class="icon-btn" id="closeOrderDetail">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div style="margin-bottom:14px;display:flex;align-items:center;gap:10px;">
            ${editingStatus ? `
              <select id="orderStatusEditSelect" style="width:auto;">
                ${ALL_ORDER_STATUSES.map(s=>`<option value="${s}" ${p.status===s?"selected":""}>${statusLabel(s)}</option>`).join("")}
              </select>
              <button class="btn-small" id="saveOrderStatusBtn">Save</button>
              <button class="btn-small" id="cancelOrderStatusBtn">Cancel</button>
            ` : `
              ${statusChip(p.status)}
              <button class="btn-small" id="editOrderStatusBtn" title="Correct this manually if a detection issue set it wrong — for example, a bug (since fixed) that could apply one order's status update to a different order by mistake">Change Status</button>
            `}
          </div>
          <div class="card kv-card">
            ${kvRow("Order #", p.orderNumber ? escapeHTML(p.orderNumber) : "—")}
            ${kvRow("Order date", p.orderDate ? formatDate(p.orderDate) : "—")}
            ${kvRow("Price", p.price!=null ? fmtMoney(p.price) : "—")}
            ${kvRow("Carrier", p.carrier ? escapeHTML(p.carrier) : "—")}
            ${kvRow("Tracking number", p.trackingNumber ? escapeHTML(p.trackingNumber) : "—")}
            ${kvRow("Estimated delivery", p.expectedDelivery ? formatDate(p.expectedDelivery) + (p.expectedDeliveryTime ? " · "+escapeHTML(p.expectedDeliveryTime) : "") : "—")}
            ${kvRow("Sent to", p.toEmail ? escapeHTML(p.toEmail) : "—")}
            ${kvRow("Recipient name", p.recipientName ? escapeHTML(p.recipientName) : "—")}
            ${kvRow("Delivery address", p.deliveryAddress ? escapeHTML(p.deliveryAddress) : "—")}
          </div>

          ${p.lineItems && p.lineItems.length>0 ? `
            <div class="hint" style="margin:14px 0 6px;">What was bought:</div>
            <div class="card table-wrap" style="box-shadow:none;">
              <table class="data-table">
                <thead><tr><th>Item</th><th>Qty</th><th style="text-align:right;">Price</th></tr></thead>
                <tbody>
                  ${p.lineItems.map(li=>`<tr><td>${escapeHTML(li.name)}</td><td class="mono dim">${li.quantity}</td><td class="mono" style="text-align:right;">${fmtMoney(li.price)}</td></tr>`).join("")}
                </tbody>
              </table>
            </div>
          ` : `<div class="hint" style="margin-top:14px;">No itemized product list could be found in this order's emails.</div>`}

          ${p.addedToStockId && state.items.find(i=>i.id===p.addedToStockId) ? `
            <div style="height:16px;"></div>
            <button class="btn-primary block" id="orderDetailViewStock">View in Stock ${ICONS.chev}</button>
          ` : ""}
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeOrderDetail").addEventListener("click", ()=>{ orderStatusEditing = null; document.getElementById("modalRoot").innerHTML=""; });
  const viewStockBtn = document.getElementById("orderDetailViewStock");
  if(viewStockBtn) viewStockBtn.addEventListener("click", ()=>{
    document.getElementById("modalRoot").innerHTML = "";
    ui.detailItemId = p.addedToStockId;
    render();
  });
  const editBtn = document.getElementById("editOrderStatusBtn");
  if(editBtn) editBtn.addEventListener("click", ()=>{ orderStatusEditing = orderId; orderDetailModal(orderId); });
  const cancelBtn = document.getElementById("cancelOrderStatusBtn");
  if(cancelBtn) cancelBtn.addEventListener("click", ()=>{ orderStatusEditing = null; orderDetailModal(orderId); });
  const saveBtn = document.getElementById("saveOrderStatusBtn");
  if(saveBtn) saveBtn.addEventListener("click", ()=>{
    const newStatus = document.getElementById("orderStatusEditSelect").value;
    p.status = newStatus;
    orderStatusEditing = null;
    saveState();
    showToast(`Status updated to ${statusLabel(newStatus)}`);
    orderDetailModal(orderId);
    if(ui.tab==="orders") renderView();
  });
}

function statusLabel(status){
  const map = {
    confirmed: "Order Placed", shipped: "Shipped", out_for_delivery: "Out for Delivery",
    ready_for_collection: "Ready for Collection", delivered: "Delivered",
    action_required: "Requires Attention", cancelled: "Cancelled"
  };
  return map[status] || status;
}

function attachAllOrdersEvents(){
  document.getElementById("addOrderBtn").addEventListener("click", openAddOrderModal);
  document.getElementById("orderStatusFilterSelect").addEventListener("change", e=>{
    ordersUI.statusFilter = e.target.value; renderAllOrdersResults();
  });
  document.getElementById("orderRetailerFilterSelect").addEventListener("change", e=>{
    ordersUI.retailerFilter = e.target.value; renderAllOrdersResults();
  });
  const search = document.getElementById("orderSearchInput");
  search.addEventListener("input", e=>{ ordersUI.search = e.target.value; renderAllOrdersResults(); });
  document.getElementById("exportOrdersCsvBtn").addEventListener("click", ()=>{
    const orders = filteredAllOrders();
    downloadCSV(`orders-${todayISO()}.csv`,
      ["Status","Retailer","Order Number","Order Date","Carrier","Tracking Number","Expected Delivery","Price"],
      orders.map(p=>[p.status, p.retailer, p.orderNumber||"", p.orderDate||"", p.carrier||"", p.trackingNumber||"", p.expectedDelivery||"", p.price!=null?p.price:""])
    );
  });
  bindAllOrdersResultEvents();
}

function bindAllOrdersResultEvents(){
  document.querySelectorAll("[data-open-order]").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("button, a")) return; // let the row's own buttons/links handle their own clicks
      orderDetailModal(row.dataset.openOrder);
    });
  });
  document.querySelectorAll("[data-track-royalmail]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      e.preventDefault();
      e.stopPropagation();
      const trackingNumber = el.dataset.trackRoyalmail;
      if(window.shellAPI) window.shellAPI.openExternal(`https://www3.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(trackingNumber)}`);
    });
  });
  document.querySelectorAll("[data-block]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const email = btn.dataset.block;
      const domain = email.split("@")[1] || email;
      addExclusion(domain, true);
    });
  });
  document.querySelectorAll("[data-view]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{ e.stopPropagation(); ui.detailItemId = btn.dataset.view; render(); });
  });
  document.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      state.pendingOrders = state.pendingOrders.filter(p=>p.id!==btn.dataset.remove);
      saveState();
      renderAllOrdersResults();
    });
  });
}

let pkcUI = { search: "" };

// Deliberately NOT scoped by the search box — this should always reflect
// the true overall picture regardless of what's currently being searched
// for, and excludes cancelled preorders since those won't actually be
// fulfilled or charged.
function activePkcPreorders(){
  return state.items.filter(i=>i.isPreorder && i.retailer==="Pokemon Center" && !i.isCancelled);
}
function pkcTotalToPay(){
  return activePkcPreorders().reduce((s,i)=>s+i.quantityPurchased*i.purchasePricePerUnit, 0);
}
function pkcQuantitySummary(){
  // Exact-STRING grouping split one real product's total across multiple
  // boxes whenever extraction produced slightly different text between
  // two emails (extra whitespace, etc.) — but the fix for that (fuzzy
  // word-overlap matching) turned out to be a worse bug: genuinely
  // different products that just happen to share several common words —
  // "Tech Sticker Collection (Lucario)" vs "...({Alolan Exeggutor)" — was
  // merging one product's count into the other's, making it vanish
  // entirely rather than just showing as an extra box. Exact match after
  // normalizing whitespace/punctuation/case is the safe middle ground: it
  // still consolidates the same product written with different spacing,
  // but can never conflate two different products, since anything more
  // than a formatting difference keeps them separate.
  const groups = {};
  activePkcPreorders().forEach(i=>{
    const key = normalizeForMatch(i.name);
    if(!groups[key]) groups[key] = { name: i.name, qty: 0 };
    groups[key].qty += i.quantityPurchased;
    if(i.name.length > groups[key].name.length) groups[key].name = i.name; // keep the more descriptive of the matched names
  });
  return Object.values(groups).sort((a,b)=>b.qty-a.qty).map(g=>[g.name, g.qty]);
}

// Display-only shortening — the underlying stored name is untouched
// (still used for matching/dedup), this just saves space so genuinely
// different products are easier to tell apart at a glance instead of all
// starting with the same repeated "Pokémon TCG:" prefix.
function shortenPkcProductName(name){
  return name.replace(/^pok[eé]mon\s*tcg:\s*/i, "").trim();
}

let cancelledUI = { search: "" };

function cancelledOrdersContentHTML(){
  return `
    <div class="toolbar-row">
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="cancelledSearchInput" placeholder="Search cancelled orders" value="${escapeAttr(cancelledUI.search)}">
      </div>
    </div>
    <div id="cancelledResultsContainer">${cancelledResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function cancelledResultsHTML(){
  const orders = state.pendingOrders.filter(p=>p.status==="cancelled")
    .filter(p=> !cancelledUI.search || (p.retailer||"").toLowerCase().includes(cancelledUI.search.toLowerCase()) || (p.orderNumber||"").toLowerCase().includes(cancelledUI.search.toLowerCase()))
    .sort((a,b)=> new Date(b.orderDate)-new Date(a.orderDate));

  if(orders.length===0){
    return `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">No cancelled orders</div>
        <div class="d">Orders the retailer cancels show up here, kept separate so they don't clutter your active orders.</div>
      </div>
    `;
  }

  return `
    <div class="card table-wrap" style="margin-top:14px;">
      <table class="data-table">
        <thead><tr><th>Retailer</th><th>Order #</th><th>Order Date</th><th>Reason</th><th>Price</th></tr></thead>
        <tbody>
          ${orders.map(p=>`
            <tr data-open-order="${p.id}">
              <td style="font-weight:600;">${escapeHTML(p.retailer)}${p.isPKCPreorder ? ` <span class="status-chip" style="background:var(--violet-bg);color:var(--violet);margin-left:6px;">PKC</span>` : ""}</td>
              <td class="mono dim">${p.orderNumber ? escapeHTML(p.orderNumber) : "—"}</td>
              <td class="mono dim">${p.orderDate ? formatDate(p.orderDate) : "—"}</td>
              <td class="dim" style="font-size:12px;">${p.cancelReason ? escapeHTML(p.cancelReason) : "—"}</td>
              <td class="mono">${p.price!==null && p.price!==undefined ? fmtMoney(p.price) : "—"}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderCancelledResults(){
  const container = document.getElementById("cancelledResultsContainer");
  if(!container) return;
  container.innerHTML = cancelledResultsHTML();
  bindCancelledResultEvents();
}

function attachCancelledOrdersEvents(){
  const search = document.getElementById("cancelledSearchInput");
  search.addEventListener("input", e=>{ cancelledUI.search = e.target.value; renderCancelledResults(); });
  bindCancelledResultEvents();
}

function bindCancelledResultEvents(){
  document.querySelectorAll("#cancelledResultsContainer tr[data-open-order]").forEach(row=>{
    row.addEventListener("click", ()=>{ orderDetailModal(row.dataset.openOrder); });
  });
}

function pkcOrdersContentHTML(){
  const totalToPay = pkcTotalToPay();
  const quantitySummary = pkcQuantitySummary();

  return `
    <div class="stat-grid compact-stats">
      ${statCard("cash", "Total To Pay", fmtMoney(totalToPay), "var(--gold)", "var(--gold-bg)")}
      ${quantitySummary.map(([name, qty])=>{
        const shortName = shortenPkcProductName(name);
        return statCard("stock", shortName.length>42 ? shortName.slice(0,40)+"…" : shortName, ""+qty, "var(--violet)", "var(--violet-bg)", name);
      }).join("")}
    </div>
    <div class="hint" style="margin:8px 0 0;">Total To Pay is what Pokémon Center will actually charge once these ship — nothing here counts as a real expense until then. Quantity boxes add up how many of each product you have on order across every preorder.</div>
    <div style="height:12px;"></div>
    <div class="toolbar-row">
      <button class="btn-primary" id="addPkcPreorderBtn">${ICONS.plus} Add Preorder</button>
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="pkcSearchInput" placeholder="Search PKC preorders" value="${escapeAttr(pkcUI.search)}">
      </div>
    </div>
    <div id="pkcResultsContainer">${pkcResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

let pkcExpandedIds = new Set();

function pkcResultsHTML(){
  // Only Pokémon Center specifically — a preorder manually added via Add
  // Stock's checkbox for a different retailer was incorrectly showing up
  // here before, since the filter only checked isPreorder.
  const preorders = state.items.filter(i=>i.isPreorder && i.retailer==="Pokemon Center")
    .filter(i=> !pkcUI.search || i.name.toLowerCase().includes(pkcUI.search.toLowerCase()));

  if(preorders.length===0){
    return `
      <div class="empty-state">
        ${ICONS.clock}
        <div class="t">No PKC orders yet</div>
        <div class="d">Pokémon Center preorder confirmations are detected automatically via Email Sync, or use "Add Preorder" above.</div>
      </div>
    `;
  }

  // Grouped by order — an order with several products used to render as
  // that many separate cards, all showing the exact same order
  // number/email/total in their header, which looked exactly like
  // duplicate orders rather than what it actually was (several different
  // products within one order). Items with no order number at all get
  // their own single-item group rather than risk being merged together.
  const groups = {};
  preorders.forEach(i=>{
    const key = i.orderNumber || ("__no_order__"+i.id);
    (groups[key] = groups[key] || []).push(i);
  });
  const orderGroups = Object.entries(groups).sort((a,b)=>{
    const da = a[1][0].expectedArrival || "9999-12-31", db = b[1][0].expectedArrival || "9999-12-31";
    return new Date(da) - new Date(db);
  });

  return `
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">
      ${orderGroups.map(([orderKey, group])=>{
        const rep = group[0]; // representative item for order-level shared fields
        const linkedOrder = rep.orderNumber
          ? state.pendingOrders.find(p=>p.orderNumber===rep.orderNumber)
          : state.pendingOrders.find(p=>group.some(g=>g.id===p.addedToStockId));
        const cancelled = group.every(g=>g.isCancelled);
        const needsAttention = group.some(g=>g.needsAttention);
        const expanded = pkcExpandedIds.has(orderKey);
        const orderTotal = group.reduce((s,g)=>s+g.quantityPurchased*g.purchasePricePerUnit,0);
        const firstLineAddress = rep.deliveryAddress ? rep.deliveryAddress.split(",")[0].trim() : "—";
        const titleSummary = group.length===1 ? rep.name : `${group[0].name}${group.length>1 ? ` +${group.length-1} more` : ""}`;

        return `
        <div class="card" style="padding:13px 16px;${needsAttention && !cancelled ? "border-color:var(--red);box-shadow:0 0 0 1px var(--red);" : ""}${cancelled ? "opacity:0.6;" : ""}">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;" data-toggle-pkc="${escapeAttr(orderKey)}">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:700;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${escapeHTML(titleSummary)}
                ${cancelled ? `<span class="status-chip chip-cancelled" style="vertical-align:middle;margin-left:4px;">Cancelled</span>` : needsAttention ? `<span class="status-chip" style="vertical-align:middle;margin-left:4px;background:var(--red-bg);color:var(--red);">Requires Attention</span>` : ""}
              </div>
              <div class="hint mono" style="margin:3px 0 0;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${rep.orderNumber ? escapeHTML(rep.orderNumber) : "—"} · ${rep.sentToEmail ? escapeHTML(rep.sentToEmail) : "—"} · ${fmtMoney(orderTotal)} · ${escapeHTML(firstLineAddress)}</div>
            </div>
            <div style="flex-shrink:0;color:var(--text-mute);transform:rotate(${expanded?90:-90}deg);transition:transform .15s;">${ICONS.chev}</div>
          </div>

          ${expanded ? `
          <div style="margin-top:14px;">
            ${cancelled ? `
            <div style="display:flex;align-items:center;gap:10px;background:var(--card-2);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:14px;">
              ${ICONS.close}
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;font-size:13px;color:var(--text-dim);">Cancelled</div>
                <div class="hint" style="margin:1px 0 0;">${linkedOrder && linkedOrder.cancelReason ? escapeHTML(linkedOrder.cancelReason) : "This preorder was cancelled."}</div>
              </div>
            </div>` : needsAttention ? `
            <div style="display:flex;align-items:center;gap:10px;background:var(--red-bg);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:14px;">
              ${ICONS.close}
              <div style="flex:1;min-width:0;">
                <div style="font-weight:700;font-size:13px;color:var(--red);">Requires Attention — payment issue</div>
                <div class="hint" style="margin:1px 0 0;">${rep.attentionDeadline ? `Update payment before ${formatDate(rep.attentionDeadline)}${rep.attentionDeadlineTime ? " · "+escapeHTML(rep.attentionDeadlineTime) : ""}, or the preorder may be cancelled.` : "Check your email for details, or the preorder may be cancelled."}</div>
              </div>
            </div>` : ""}

            <div class="hint" style="margin-bottom:12px;">${escapeHTML(rep.category)} · ${escapeHTML(rep.retailer||"Unknown retailer")}${linkedOrder && !cancelled ? ` · ${statusChip(linkedOrder.status)}` : ""}${rep.sourceEmailDetected ? ` · <span class="status-chip chip-confirmed" style="vertical-align:middle;">Auto-detected</span>` : ""}</div>

            <div class="kv-card" style="border:1px solid var(--border-soft);border-radius:var(--radius-md);">
              ${kvRow("Order #", rep.orderNumber ? escapeHTML(rep.orderNumber) : "—")}
              ${kvRow("Ordered", formatDate(rep.purchaseDate))}
              ${kvRow("Expected arrival", rep.expectedArrival ? formatDate(rep.expectedArrival) : "—")}
              ${linkedOrder && linkedOrder.trackingNumber ? kvRow("Tracking", `${linkedOrder.carrier ? escapeHTML(linkedOrder.carrier)+" · " : ""}<a href="#" data-track-royalmail="${escapeAttr(linkedOrder.trackingNumber)}" style="color:var(--violet);text-decoration:underline;">${escapeHTML(linkedOrder.trackingNumber)}</a>`) : ""}
              ${kvRow("Order Total", fmtMoney(orderTotal))}
              ${kvRow("Sent to", rep.sentToEmail ? escapeHTML(rep.sentToEmail) : "—")}
              ${kvRow("Recipient name", rep.recipientName ? escapeHTML(rep.recipientName) : "—")}
              ${kvRow("Delivery address", rep.deliveryAddress ? escapeHTML(rep.deliveryAddress) : "—")}
            </div>

            <div class="hint" style="margin:12px 0 6px;">Products in this order:</div>
            <div class="card table-wrap" style="box-shadow:none;">
              <table class="data-table">
                <thead><tr><th>Item</th><th>Qty</th><th style="text-align:right;">Price</th><th></th></tr></thead>
                <tbody>
                  ${group.map(g=>`<tr><td>${escapeHTML(g.name)}</td><td class="mono dim">${g.quantityPurchased}</td><td class="mono" style="text-align:right;">${fmtMoney(g.purchasePricePerUnit)}</td><td style="text-align:right;"><button class="btn-ghost" data-open="${g.id}">View ${ICONS.chev}</button></td></tr>`).join("")}
                </tbody>
              </table>
            </div>

            ${cancelled ? "" : `<button class="btn-small" data-arrived-group="${escapeAttr(orderKey)}" style="margin-top:12px;">${ICONS.check} Mark Whole Order Arrived</button>`}
          </div>
          ` : ""}
        </div>
        `;
      }).join("")}
    </div>
    <div class="hint" style="margin-top:14px;">
      Delivery address, recipient name, and itemized products are best-effort — pulled directly out
      of the confirmation email's text, which varies a lot even within Pokémon Center's own emails.
      Double check anything here before relying on it.
    </div>
  `;
}

function renderPkcResults(){
  const container = document.getElementById("pkcResultsContainer");
  if(!container) return;
  container.innerHTML = pkcResultsHTML();
  bindPkcResultEvents();
}

function attachPreordersEvents(){
  document.getElementById("addPkcPreorderBtn").addEventListener("click", openAddPkcPreorderModal);
  const search = document.getElementById("pkcSearchInput");
  search.addEventListener("input", e=>{ pkcUI.search = e.target.value; renderPkcResults(); });
  bindPkcResultEvents();
}

function bindPkcResultEvents(){
  document.querySelectorAll("[data-toggle-pkc]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const id = el.dataset.togglePkc;
      if(pkcExpandedIds.has(id)) pkcExpandedIds.delete(id);
      else pkcExpandedIds.add(id);
      renderPkcResults();
    });
  });
  document.querySelectorAll("[data-track-royalmail]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      e.preventDefault();
      const trackingNumber = el.dataset.trackRoyalmail;
      if(window.shellAPI) window.shellAPI.openExternal(`https://www3.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(trackingNumber)}`);
    });
  });
  document.querySelectorAll("[data-open]").forEach(el=>{
    el.addEventListener("click", ()=>{ ui.detailItemId = el.dataset.open; render(); });
  });
  document.querySelectorAll("[data-arrived-group]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const orderKey = btn.dataset.arrivedGroup;
      // orderKey is either a real order number, or a synthetic
      // "__no_order__<id>" key for the rare item with no order number at
      // all — match items the same way the card grouping above did, so
      // this always affects exactly the set of items shown in this card.
      const relatedItems = orderKey.startsWith("__no_order__")
        ? state.items.filter(i=>i.id===orderKey.replace("__no_order__","") && i.isPreorder)
        : state.items.filter(i=>i.orderNumber===orderKey && i.isPreorder);
      if(!relatedItems.length) return;
      relatedItems.forEach(i=>{ i.isPreorder = false; i.needsAttention = false; });
      saveState();
      showToast(relatedItems.length>1 ? `${relatedItems.length} items from this order moved to Stock` : `${relatedItems[0].name} moved to Stock`);
      // Full refresh, not just renderPkcResults() — this changes data
      // that the aggregate boxes (Total To Pay, quantity summary) at the
      // top of the page depend on, and those live in the outer page
      // shell, not the results list below, so a surgical results-only
      // update was leaving them stale (confirmed directly: items
      // correctly stopped being preorders, but the totals above didn't
      // move until a full re-render).
      renderView();
    });
  });
}

let addPkcFormState = null;

function openAddPkcPreorderModal(){
  addPkcFormState = { name:"", price:"", orderNumber:"", orderDate: todayISO(), expectedArrival:"", deliveryAddress:"", recipientName:"" };
  renderAddPkcPreorderModal();
}

function renderAddPkcPreorderModal(){
  const f = addPkcFormState;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="addPkcBackdrop">
      <div class="modal" style="width:460px;">
        <div class="modal-header">
          <h2>Add PKC Preorder</h2>
          <button class="icon-btn" id="closeAddPkc">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Item name</label>
            <input type="text" id="apk-name" value="${escapeAttr(f.name)}" placeholder="e.g. Charizard VMAX Booster Box">
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Price</label>
              <input type="number" id="apk-price" value="${escapeAttr(f.price)}" placeholder="0.00" step="0.01" min="0">
            </div>
            <div class="field">
              <label>Order number (optional)</label>
              <input type="text" id="apk-orderNumber" value="${escapeAttr(f.orderNumber)}">
            </div>
            <div class="field">
              <label>Order date</label>
              <input type="date" id="apk-orderDate" value="${f.orderDate}">
            </div>
            <div class="field">
              <label>Expected arrival (optional)</label>
              <input type="date" id="apk-expectedArrival" value="${f.expectedArrival}">
            </div>
          </div>
          <div class="field">
            <label>Recipient name (optional)</label>
            <input type="text" id="apk-recipientName" value="${escapeAttr(f.recipientName)}">
          </div>
          <div class="field">
            <label>Delivery address (optional)</label>
            <input type="text" id="apk-deliveryAddress" value="${escapeAttr(f.deliveryAddress)}">
          </div>
          <div style="height:6px;"></div>
          <button class="btn-primary block" id="saveAddPkcBtn">Add Preorder</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeAddPkc").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("apk-name").addEventListener("input", e=>{ f.name = e.target.value; });
  document.getElementById("apk-price").addEventListener("input", e=>{ f.price = e.target.value; });
  document.getElementById("apk-orderNumber").addEventListener("input", e=>{ f.orderNumber = e.target.value; });
  document.getElementById("apk-orderDate").addEventListener("change", e=>{ f.orderDate = e.target.value; });
  document.getElementById("apk-expectedArrival").addEventListener("change", e=>{ f.expectedArrival = e.target.value; });
  document.getElementById("apk-recipientName").addEventListener("input", e=>{ f.recipientName = e.target.value; });
  document.getElementById("apk-deliveryAddress").addEventListener("input", e=>{ f.deliveryAddress = e.target.value; });

  document.getElementById("saveAddPkcBtn").addEventListener("click", ()=>{
    const name = f.name.trim();
    const price = parseFloat(f.price);
    if(!name){ showToast("Enter an item name", "close"); return; }
    if(isNaN(price) || price<0){ showToast("Enter a valid price", "close"); return; }

    const item = {
      id: uid(), name, category: "Pokemon", quantityPurchased: 1, purchasePricePerUnit: price,
      retailer: "Pokemon Center", purchaseDate: f.orderDate || todayISO(), notes: "",
      isPreorder: true, expectedArrival: f.expectedArrival || null,
      orderNumber: f.orderNumber.trim() || null,
      deliveryAddress: f.deliveryAddress.trim() || null, recipientName: f.recipientName.trim() || null,
      sentToEmail: null, lineItems: [], sourceEmailDetected: false,
      needsAttention: false, attentionDeadline: null, attentionDeadlineTime: null,
      isCancelled: false, image: null, sales: []
    };
    state.items.unshift(item);
    // Same fix as manually-added regular orders — matches the same key
    // format email detection uses whenever an order number is given, so a
    // later status-change email for this order (shipped, out for
    // delivery, cancelled) finds and updates this entry instead of
    // creating a duplicate.
    const orderNumber = f.orderNumber.trim() || null;
    state.pendingOrders.unshift({
      id: uid(), matchKey: orderNumber ? ("num:"+orderNumber) : ("manual:"+item.id), retailer: "Pokemon Center", price,
      fromEmail: null, orderDate: f.orderDate || todayISO(),
      expectedDelivery: f.expectedArrival || null, expectedDeliveryTime: null,
      carrier: null, trackingNumber: null, orderNumber,
      status: "confirmed", addedToStockId: item.id, isPKCPreorder: true
    });
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    showToast(`${name} added as a preorder`);
    if(ui.tab==="orders") renderView();
  });
}

/* ============================================================
   SOLD
   ============================================================ */

const PLATFORMS = ["eBay", "Facebook Marketplace", "Mercari", "Local / Cash", "Other"];

let soldUI = { subTab: "items", platformFilter: "All", search: "" };

function soldHTML(){
  return `
    <div class="segmented" style="margin-bottom:14px;">
      <button class="${soldUI.subTab==='items'?'active':''}" data-sold-subtab="items">Sold Items</button>
      <button class="${soldUI.subTab==='detected'?'active':''}" data-sold-subtab="detected">Detected Sales${state.pendingSales.length ? ` (${state.pendingSales.length})` : ""}</button>
    </div>
    ${soldUI.subTab==='items' ? soldItemsContentHTML() : detectedSalesContentHTML()}
  `;
}

function soldItemsContentHTML(){
  return `
    <div class="toolbar-row">
      <select id="platformFilterSelect" style="width:auto;padding:9px 30px 9px 13px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius-sm);color:var(--text);">
        <option ${soldUI.platformFilter==="All"?"selected":""}>All</option>
        ${PLATFORMS.map(p=>`<option ${soldUI.platformFilter===p?"selected":""}>${p}</option>`).join("")}
      </select>
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="soldSearchInput" placeholder="Search sold items" value="${escapeAttr(soldUI.search)}">
      </div>
      <button class="btn-primary" id="markSoldBtn" style="flex-shrink:0;height:38px;padding:0 18px;font-size:13.5px;">${ICONS.check} Mark Item as Sold</button>
      <button class="btn-small" id="exportSoldCsvBtn" style="height:38px;">${ICONS.download} Export CSV</button>
    </div>
    <div id="soldResultsContainer">${soldResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function detectedSalesContentHTML(){
  return `
    ${state.pendingSales.length===0 ? `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">No sale emails detected yet</div>
        <div class="d">eBay "item sold" notifications, payout emails, and similar get picked up here automatically via Email Sync.</div>
      </div>
    ` : `
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${state.pendingSales.slice().sort((a,b)=>new Date(b.saleDate)-new Date(a.saleDate)).map(p=>`
          <div class="card" style="padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
            <div style="min-width:0;flex:1;">
              <div style="font-weight:700;font-size:13.5px;">${escapeHTML(p.platform||"Unknown")} <span class="mono dim" style="font-weight:500;">${p.netAmount!=null ? fmtMoney(p.netAmount) : "—"}</span></div>
              <div class="hint" style="margin:2px 0 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${formatDate(p.saleDate)} · Qty ${p.quantitySold || "—"}${p.productNameHint ? ` · ${escapeHTML(p.productNameHint)}` : ""}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0;">
              <button class="btn-small" data-match-sale="${p.id}">Match to Item</button>
              <button class="icon-btn" data-remove-sale="${p.id}" title="Delete this detected sale — use this for duplicates or anything detected by mistake">${ICONS.trash}</button>
            </div>
          </div>
        `).join("")}
      </div>
      <div class="hint" style="margin-top:10px;">
        Restock can tell a sale happened and roughly for how much, but can't tell which of your items
        it was — click "Match to Item" to pick the right one and finish recording the sale. When a
        likely item name was found in the email, it's suggested first.
      </div>
    `}
    <div style="height:20px;"></div>
  `;
}

function filteredSales(){
  const allSales = [];
  state.items.forEach(item => item.sales.forEach(sale => allSales.push({item, sale})));
  allSales.sort((a,b)=> new Date(b.sale.saleDate) - new Date(a.sale.saleDate));
  return allSales
    .filter(p => soldUI.platformFilter==="All" || (p.sale.platform||"Other")===soldUI.platformFilter)
    .filter(p => !soldUI.search || p.item.name.toLowerCase().includes(soldUI.search.toLowerCase()));
}

function soldResultsHTML(){
  const filtered = filteredSales();
  const totalNetAll = filtered.reduce((s,p)=>s+saleNet(p.sale),0);

  if(filtered.length===0){
    return `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">Nothing sold yet</div>
        <div class="d">Sales you record — manually or via email sync — show up here.</div>
      </div>
    `;
  }
  return `
    <div class="mini-grid" style="grid-template-columns:1fr;margin-top:14px;margin-bottom:0;">
      ${miniCard("cash", `Net Proceeds (${filtered.length} sale${filtered.length===1?"":"s"})`, fmtMoney(totalNetAll), "var(--green)","var(--green-bg)")}
    </div>
    <div class="card table-wrap" style="margin-top:14px;">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Item</th><th>Platform</th><th>Qty</th><th>Gross</th><th>Fees</th><th>Net</th><th style="text-align:right;">Profit</th><th></th></tr></thead>
        <tbody>
          ${filtered.map(({item,sale})=>{
            const net = saleNet(sale);
            const itemProfit = net - sale.quantitySold*item.purchasePricePerUnit;
            return `<tr data-open="${item.id}">
              <td class="mono dim">${formatDate(sale.saleDate)}</td>
              <td style="font-weight:600;"><div style="display:flex;align-items:center;gap:9px;">${itemThumb(item,26)}<span>${escapeHTML(item.name)}</span></div></td>
              <td class="dim">${escapeHTML(sale.platform||"—")}</td>
              <td class="mono dim">${sale.quantitySold}</td>
              <td class="mono">${fmtMoney(saleRevenue(sale))}</td>
              <td class="mono dim">${sale.fees ? "-"+fmtMoney(sale.fees) : "—"}</td>
              <td class="mono" style="font-weight:600;">${fmtMoney(net)}</td>
              <td class="mono ${itemProfit>=0?'pos':'neg'}" style="text-align:right;">${itemProfit>=0?'+':''}${fmtMoney(itemProfit)}</td>
              <td style="text-align:right;"><button class="icon-btn" data-edit-sale="${item.id}:${sale.id}" title="Edit sale">${ICONS.pencil}</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderSoldResults(){
  const container = document.getElementById("soldResultsContainer");
  if(!container) return;
  container.innerHTML = soldResultsHTML();
  bindSoldResultEvents();
}

function bindSoldResultEvents(){
  document.querySelectorAll("tr[data-open]").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("button")) return;
      ui.detailItemId = row.dataset.open; render();
    });
  });
  document.querySelectorAll("[data-edit-sale]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const [itemId, saleId] = btn.dataset.editSale.split(":");
      openEditSaleModal(itemId, saleId);
    });
  });
}

let editSaleFormState = null;

function openEditSaleModal(itemId, saleId){
  const item = state.items.find(i=>i.id===itemId);
  if(!item) return;
  const sale = item.sales.find(s=>s.id===saleId);
  if(!sale) return;
  editSaleFormState = {
    itemId, saleId,
    platform: sale.platform || PLATFORMS[0],
    customPlatform: PLATFORMS.includes(sale.platform) ? "" : (sale.platform||""),
    price: String(sale.salePricePerUnit), fees: String(sale.fees||0),
    quantity: String(sale.quantitySold), date: sale.saleDate
  };
  renderEditSaleModal();
}

function renderEditSaleModal(){
  const f = editSaleFormState;
  const item = state.items.find(i=>i.id===f.itemId);
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="editSaleBackdrop">
      <div class="modal" style="width:420px;">
        <div class="modal-header">
          <h2>Edit Sale</h2>
          <button class="icon-btn" id="closeEditSale">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:14px;">${item ? escapeHTML(item.name) : ""}</div>
          <div class="form-grid">
            <div class="field">
              <label>Platform</label>
              <select id="es-platform">
                ${PLATFORMS.map(p=>`<option value="${p}" ${f.platform===p?"selected":""}>${p}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Quantity sold</label>
              <input type="number" id="es-quantity" value="${escapeAttr(f.quantity)}" min="1" step="1">
            </div>
          </div>
          ${f.platform==="Other" ? `
          <div class="field">
            <label>Custom platform</label>
            <input type="text" id="es-customPlatform" value="${escapeAttr(f.customPlatform)}">
          </div>` : ""}
          <div class="form-grid">
            <div class="field">
              <label>Sale price (per unit)</label>
              <input type="number" id="es-price" value="${escapeAttr(f.price)}" step="0.01" min="0">
            </div>
            <div class="field">
              <label>Fees (total)</label>
              <input type="number" id="es-fees" value="${escapeAttr(f.fees)}" step="0.01" min="0">
            </div>
          </div>
          <div class="field">
            <label>Sale date</label>
            <input type="date" id="es-date" value="${f.date}">
          </div>
          <div style="height:6px;"></div>
          <button class="btn-primary block" id="saveEditSaleBtn">Save Changes</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeEditSale").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("es-platform").addEventListener("change", e=>{ f.platform = e.target.value; renderEditSaleModal(); });
  document.getElementById("es-quantity").addEventListener("input", e=>{ f.quantity = e.target.value; });
  const customInput = document.getElementById("es-customPlatform");
  if(customInput) customInput.addEventListener("input", e=>{ f.customPlatform = e.target.value; });
  document.getElementById("es-price").addEventListener("input", e=>{ f.price = e.target.value; });
  document.getElementById("es-fees").addEventListener("input", e=>{ f.fees = e.target.value; });
  document.getElementById("es-date").addEventListener("change", e=>{ f.date = e.target.value; });

  document.getElementById("saveEditSaleBtn").addEventListener("click", ()=>{
    const price = parseFloat(f.price);
    const fees = parseFloat(f.fees)||0;
    const qty = parseInt(f.quantity, 10);
    if(isNaN(price) || price<0){ showToast("Enter a valid sale price", "close"); return; }
    if(isNaN(qty) || qty<1){ showToast("Enter a valid quantity", "close"); return; }
    const targetItem = state.items.find(i=>i.id===f.itemId);
    if(!targetItem) return;
    const sale = targetItem.sales.find(s=>s.id===f.saleId);
    if(!sale) return;
    sale.platform = f.platform==="Other" && f.customPlatform.trim() ? f.customPlatform.trim() : f.platform;
    sale.salePricePerUnit = price;
    sale.fees = fees;
    sale.quantitySold = qty;
    sale.saleDate = f.date;
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    showToast("Sale updated");
    if(ui.tab==="sold") renderSoldResults();
  });
}

let pickSellUI = { search: "" };

function openPickItemToSellModal(){
  pickSellUI.search = "";
  renderPickItemToSellModalShell();
}

function pickSellResultsHTML(){
  const allInStock = state.items.filter(i=>!i.isPreorder && qtyRemaining(i)>0);
  const candidates = allInStock.filter(i => !pickSellUI.search || i.name.toLowerCase().includes(pickSellUI.search.toLowerCase()));
  if(candidates.length===0){
    return `<div class="pending-empty">${allInStock.length===0 ? "No in-stock items to sell. Add stock first." : "No items match your search."}</div>`;
  }
  return `
    <div class="card table-wrap">
      <table class="data-table">
        <thead><tr><th>Item</th><th>Left</th><th></th></tr></thead>
        <tbody>
          ${candidates.map(i=>`
            <tr>
              <td style="font-weight:600;">${escapeHTML(i.name)}</td>
              <td class="mono dim">${qtyRemaining(i)}</td>
              <td style="text-align:right;"><button class="btn-small" data-pick-sell="${i.id}">Select</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderPickItemToSellModalShell(){
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="pickSellBackdrop">
      <div class="modal">
        <div class="modal-header">
          <h2>Which item sold?</h2>
          <button class="icon-btn" id="closePickSell">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="search-bar" style="margin-bottom:14px;">
            ${ICONS.search}
            <input type="text" id="pickSellSearch" placeholder="Search your stock" value="${escapeAttr(pickSellUI.search)}">
          </div>
          <div id="pickSellResults">${pickSellResultsHTML()}</div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closePickSell").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("pickSellSearch").addEventListener("input", e=>{
    // Surgical update only — never touch the search input itself while
    // typing, same fix as the earlier Stock/Sold search backwards-typing
    // bug (rebuilding the input mid-keystroke resets the cursor).
    pickSellUI.search = e.target.value;
    document.getElementById("pickSellResults").innerHTML = pickSellResultsHTML();
    bindPickSellSelectButtons();
  });
  bindPickSellSelectButtons();
}

function bindPickSellSelectButtons(){
  document.querySelectorAll("[data-pick-sell]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const itemId = btn.dataset.pickSell;
      document.getElementById("modalRoot").innerHTML = "";
      openSellSheet(itemId);
    });
  });
}

function attachSoldEvents(){
  document.querySelectorAll("[data-sold-subtab]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      soldUI.subTab = btn.dataset.soldSubtab;
      renderView();
    });
  });

  if(soldUI.subTab==='items'){
    document.getElementById("markSoldBtn").addEventListener("click", openPickItemToSellModal);
    document.getElementById("platformFilterSelect").addEventListener("change", e=>{
      soldUI.platformFilter = e.target.value; renderSoldResults();
    });
    const search = document.getElementById("soldSearchInput");
    search.addEventListener("input", e=>{ soldUI.search = e.target.value; renderSoldResults(); });
    document.getElementById("exportSoldCsvBtn").addEventListener("click", ()=>{
      const sales = filteredSales();
      downloadCSV(`sold-${todayISO()}.csv`,
        ["Item Name","Platform","Sale Date","Quantity Sold","Sale Price Per Unit","Fees","Net Amount"],
        sales.map(({item,sale})=>[item.name, sale.platform||"", sale.saleDate||"", sale.quantitySold, sale.salePricePerUnit, sale.fees||0, saleNet(sale)])
      );
    });
    bindSoldResultEvents();
  } else {
    document.querySelectorAll("[data-match-sale]").forEach(btn=>{
      btn.addEventListener("click", ()=> openMatchSaleModal(btn.dataset.matchSale));
    });
    document.querySelectorAll("[data-remove-sale]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        state.pendingSales = state.pendingSales.filter(p=>p.id!==btn.dataset.removeSale);
        saveState();
        renderView();
      });
    });
  }
}

/* ---------------- VCC Tracker ---------------- */

let settingsUI = { emailsExpanded: false };
let vccUI = { statusFilter: "All", providerFilter: "All", networkFilter: "All", typeFilter: "All", search: "" };

// Status is computed from the expiry date, not stored/set manually —
// matches how a real card actually works (it just stops being valid
// after its printed date, nothing to track separately).
const CARD_PROVIDERS = ["Revolut","RBS","Starling","Lloyds","Crypto.com","Curve","Monese","Chase","Tide","Capital on Tap","Wise","PayPal","Monzo","Capital One","Vanquis","Zilch","Other"];

function vccStatus(card){
  if(!card.expiry) return "active";
  const [mm, yy] = card.expiry.split("/").map(s=>s.trim());
  if(!mm || !yy) return "active";
  const expiryEnd = new Date(2000+parseInt(yy,10), parseInt(mm,10), 0, 23, 59, 59); // last day of expiry month
  return new Date() > expiryEnd ? "expired" : "active";
}

function maskCardNumber(number){
  const digits = (number||"").replace(/\s/g,"");
  if(digits.length<=4) return digits;
  return "•••• ".repeat(Math.max(0,Math.ceil(digits.length/4)-1)).trim() + " " + digits.slice(-4);
}

function vccTrackerHTML(){
  const cardsWithStatus = state.vccs.map(c=>({...c, computedStatus: vccStatus(c)}));
  const cards = cardsWithStatus
    .filter(c => vccUI.statusFilter==="All" || c.computedStatus===vccUI.statusFilter)
    .filter(c => vccUI.providerFilter==="All" || c.provider===vccUI.providerFilter)
    .filter(c => vccUI.networkFilter==="All" || c.network===vccUI.networkFilter)
    .filter(c => vccUI.typeFilter==="All" || c.cardType===vccUI.typeFilter)
    .filter(c => !vccUI.search || c.nickname.toLowerCase().includes(vccUI.search.toLowerCase()) || (c.number||"").replace(/\s/g,"").endsWith(vccUI.search.replace(/\s/g,"")));

  const usedProviders = Array.from(new Set(state.vccs.map(c=>c.provider).filter(Boolean))).sort();

  return `
    <div class="stat-grid" style="margin-bottom:16px;">
      ${statCard("card", "Total Cards", ""+state.vccs.length, "var(--blue)", "var(--blue-bg)")}
      ${statCard("card", "Active", ""+cardsWithStatus.filter(c=>c.computedStatus==="active").length, "var(--green)", "var(--green-bg)")}
      ${statCard("card", "Expired", ""+cardsWithStatus.filter(c=>c.computedStatus==="expired").length, "var(--text-mute)", "var(--card-2)")}
    </div>
    <div class="toolbar-row" style="flex-wrap:wrap;">
      <button class="btn-primary" id="addVccBtn">${ICONS.plus} Add Card</button>
      <select id="vccStatusFilterSelect" style="width:auto;">
        <option ${vccUI.statusFilter==="All"?"selected":""}>All Statuses</option>
        <option value="active" ${vccUI.statusFilter==="active"?"selected":""}>Active</option>
        <option value="expired" ${vccUI.statusFilter==="expired"?"selected":""}>Expired</option>
      </select>
      <select id="vccProviderFilterSelect" style="width:auto;">
        <option value="All" ${vccUI.providerFilter==="All"?"selected":""}>All Providers</option>
        ${usedProviders.map(p=>`<option value="${escapeAttr(p)}" ${vccUI.providerFilter===p?"selected":""}>${escapeHTML(p)}</option>`).join("")}
      </select>
      <select id="vccNetworkFilterSelect" style="width:auto;">
        <option value="All" ${vccUI.networkFilter==="All"?"selected":""}>Visa &amp; Mastercard</option>
        <option value="Visa" ${vccUI.networkFilter==="Visa"?"selected":""}>Visa</option>
        <option value="Mastercard" ${vccUI.networkFilter==="Mastercard"?"selected":""}>Mastercard</option>
      </select>
      <select id="vccTypeFilterSelect" style="width:auto;">
        <option value="All" ${vccUI.typeFilter==="All"?"selected":""}>Virtual &amp; Physical</option>
        <option value="virtual" ${vccUI.typeFilter==="virtual"?"selected":""}>Virtual</option>
        <option value="physical" ${vccUI.typeFilter==="physical"?"selected":""}>Physical</option>
      </select>
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="vccSearchInput" placeholder="Search by nickname or last 4" value="${escapeAttr(vccUI.search)}">
      </div>
      <button class="btn-small" id="exportVccCsvBtn">${ICONS.download} Export CSV</button>
    </div>
    <div id="vccResultsContainer">${vccResultsHTML(cards)}</div>
    <div style="margin-top:14px;padding:6px 10px;background:var(--red-bg);border:1px solid var(--red);border-radius:var(--radius-sm);color:var(--red);font-size:11px;line-height:1.4;display:flex;align-items:flex-start;gap:6px;">
      <span style="flex-shrink:0;width:12px;height:12px;margin-top:1px;">${ICONS.warning}</span>
      <span>All data here is stored locally on your device only. Used entirely at your own risk — no responsibility taken for loss if your device is compromised.</span>
    </div>
    <div style="height:20px;"></div>
  `;
}

let vccRevealedCvv = new Set();

function vccResultsHTML(cards){
  if(cards.length===0){
    return `
      <div class="empty-state">
        ${ICONS.card}
        <div class="t">No cards yet</div>
        <div class="d">Add the virtual cards your business uses, so you can see them all in one place instead of hunting through a banking app.</div>
      </div>
    `;
  }
  const statusColor = { active: "var(--green)", expired: "var(--text-mute)" };
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));gap:16px;">
      ${cards.map(c => {
        const revealed = vccRevealedCvv.has(c.id);
        return `
        <div class="debit-card-visual" data-reveal-vcc="${c.id}" style="aspect-ratio:1.586/1;border-radius:14px;background:linear-gradient(135deg, var(--violet), var(--magenta));padding:16px 18px;color:#fff;display:flex;flex-direction:column;justify-content:space-between;cursor:pointer;position:relative;box-shadow:0 6px 18px rgba(0,0,0,0.25);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
            <div style="min-width:0;">
              <div style="font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(c.nickname)}</div>
              <div style="font-size:10.5px;opacity:0.8;margin-top:1px;">${[c.provider, c.network, c.cardType ? (c.cardType==="virtual"?"Virtual":"Physical") : null].filter(Boolean).join(" · ")}</div>
            </div>
            <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
              <span class="status-chip" style="background:rgba(255,255,255,0.18);color:#fff;font-size:9.5px;">${c.computedStatus}</span>
              <button class="icon-btn" data-edit-vcc="${c.id}" style="color:#fff;background:rgba(255,255,255,0.14);width:22px;height:22px;" title="Edit">${ICONS.pencil}</button>
            </div>
          </div>
          <div class="mono" style="font-size:15px;letter-spacing:1.5px;">${c.number ? (revealed ? escapeHTML(c.number) : maskCardNumber(c.number)) : "No card number saved"}</div>
          <div style="display:flex;justify-content:space-between;align-items:flex-end;">
            <div>
              <div style="font-size:8.5px;opacity:0.7;letter-spacing:0.05em;">EXPIRES</div>
              <div class="mono" style="font-size:12px;">${c.expiry ? escapeHTML(c.expiry) : "—"}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:8.5px;opacity:0.7;letter-spacing:0.05em;">CVV</div>
              <div class="mono" style="font-size:12px;">${revealed ? (c.cvv ? escapeHTML(c.cvv) : "—") : "•••"}</div>
            </div>
          </div>
        </div>
      `;}).join("")}
    </div>
  `;
}

function renderVccResults(){
  const container = document.getElementById("vccResultsContainer");
  if(!container) return;
  const cardsWithStatus = state.vccs.map(c=>({...c, computedStatus: vccStatus(c)}));
  const cards = cardsWithStatus
    .filter(c => vccUI.statusFilter==="All" || c.computedStatus===vccUI.statusFilter)
    .filter(c => vccUI.providerFilter==="All" || c.provider===vccUI.providerFilter)
    .filter(c => vccUI.networkFilter==="All" || c.network===vccUI.networkFilter)
    .filter(c => vccUI.typeFilter==="All" || c.cardType===vccUI.typeFilter)
    .filter(c => !vccUI.search || c.nickname.toLowerCase().includes(vccUI.search.toLowerCase()) || (c.number||"").replace(/\s/g,"").endsWith(vccUI.search.replace(/\s/g,"")));
  container.innerHTML = vccResultsHTML(cards);
  bindVccResultEvents();
}

function attachVccTrackerEvents(){
  document.getElementById("addVccBtn").addEventListener("click", ()=>openVccModal(null));
  document.getElementById("vccStatusFilterSelect").addEventListener("change", e=>{
    vccUI.statusFilter = e.target.value; renderVccResults();
  });
  document.getElementById("vccProviderFilterSelect").addEventListener("change", e=>{
    vccUI.providerFilter = e.target.value; renderVccResults();
  });
  document.getElementById("vccNetworkFilterSelect").addEventListener("change", e=>{
    vccUI.networkFilter = e.target.value; renderVccResults();
  });
  document.getElementById("vccTypeFilterSelect").addEventListener("change", e=>{
    vccUI.typeFilter = e.target.value; renderVccResults();
  });
  const search = document.getElementById("vccSearchInput");
  search.addEventListener("input", e=>{ vccUI.search = e.target.value; renderVccResults(); });
  document.getElementById("exportVccCsvBtn").addEventListener("click", ()=>{
    const cardsWithStatus = state.vccs.map(c=>({...c, computedStatus: vccStatus(c)}));
    downloadCSV(`cards-${todayISO()}.csv`,
      ["Nickname","Provider","Network","Type","Last 4","Expiry","Status"],
      cardsWithStatus.map(c=>[c.nickname, c.provider||"", c.network||"", c.cardType||"", (c.number||"").slice(-4), c.expiry||"", c.computedStatus])
    );
  });
  bindVccResultEvents();
}

function bindVccResultEvents(){
  document.querySelectorAll("[data-reveal-vcc]").forEach(card=>{
    card.addEventListener("click", (e)=>{
      if(e.target.closest("button")) return; // let the Edit button handle its own click
      const id = card.dataset.revealVcc;
      if(vccRevealedCvv.has(id)) vccRevealedCvv.delete(id);
      else vccRevealedCvv.add(id);
      renderVccResults();
    });
  });
  document.querySelectorAll("[data-edit-vcc]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      openVccModal(btn.dataset.editVcc);
    });
  });
}

let vccFormState = null;

function openVccModal(vccId){
  const existing = vccId ? state.vccs.find(c=>c.id===vccId) : null;
  // Existing cards may have free-text network values from before this was
  // a dropdown (e.g. "visa" lowercase) — normalized here so they still
  // correctly pre-select instead of silently showing blank.
  let normalizedNetwork = existing ? existing.network || "" : "";
  if(/^visa/i.test(normalizedNetwork)) normalizedNetwork = "Visa";
  else if(/^master/i.test(normalizedNetwork)) normalizedNetwork = "Mastercard";
  else if(normalizedNetwork !== "Visa" && normalizedNetwork !== "Mastercard") normalizedNetwork = "";

  vccFormState = {
    id: existing ? existing.id : null,
    nickname: existing ? existing.nickname : "",
    number: existing ? existing.number || "" : "",
    expiry: existing ? existing.expiry || "" : "",
    network: normalizedNetwork,
    cvv: existing ? existing.cvv || "" : "",
    provider: existing ? existing.provider || "" : "",
    cardType: existing ? existing.cardType || "virtual" : "virtual"
  };
  renderVccModal();
}

function renderVccModal(){
  const f = vccFormState;
  const isEdit = !!f.id;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="vccModalBackdrop">
      <div class="modal" style="width:460px;">
        <div class="modal-header">
          <h2>${isEdit ? "Edit Card" : "Add Card"}</h2>
          <button class="icon-btn" id="closeVccModal">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Nickname</label>
            <input type="text" id="vcc-nickname" value="${escapeAttr(f.nickname)}" placeholder="e.g. Marketing Card 3">
          </div>
          <div class="field">
            <label>Card number</label>
            <input type="text" id="vcc-number" value="${escapeAttr(f.number)}" inputmode="numeric" placeholder="0000 0000 0000 0000">
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Expiry (MM/YY)</label>
              <input type="text" id="vcc-expiry" value="${escapeAttr(f.expiry)}" maxlength="5" placeholder="MM/YY">
            </div>
            <div class="field" style="max-width:120px;">
              <label>Cvv</label>
              <input type="text" id="vcc-cvv" value="${escapeAttr(f.cvv)}" placeholder="What this card is usually used for">
            </div>
            <div class="field">
              <label>Network</label>
              <select id="vcc-network">
                <option value="" ${!f.network?"selected":""}>—</option>
                <option value="Visa" ${f.network==="Visa"?"selected":""}>Visa</option>
                <option value="Mastercard" ${f.network==="Mastercard"?"selected":""}>Mastercard</option>
              </select>
            </div>
            <div class="field">
              <label>Provider</label>
              <select id="vcc-provider">
                <option value="" ${!f.provider?"selected":""}>—</option>
                ${CARD_PROVIDERS.map(p=>`<option value="${escapeAttr(p)}" ${f.provider===p?"selected":""}>${escapeHTML(p)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Card type</label>
            <div class="segmented" style="max-width:280px;">
              <button type="button" class="${f.cardType==="virtual"?"active":""}" data-card-type="virtual">Virtual</button>
              <button type="button" class="${f.cardType==="physical"?"active":""}" data-card-type="physical">Physical</button>
            </div>
          </div>
          <div style="height:6px;"></div>
          <button class="btn-primary block" id="saveVccBtn">${isEdit ? "Save Changes" : "Add Card"}</button>
          ${isEdit ? `<button class="btn-secondary block" id="deleteVccBtn" style="margin-top:10px;border-color:var(--red);color:var(--red);">${ICONS.trash} Delete Card</button>` : ""}
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeVccModal").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("vcc-nickname").addEventListener("input", e=>{ f.nickname = e.target.value; });
  document.getElementById("vcc-number").addEventListener("input", e=>{
    const digits = e.target.value.replace(/\D/g,"").slice(0,19);
    f.number = digits.replace(/(.{4})/g,"$1 ").trim();
    e.target.value = f.number;
  });
  document.getElementById("vcc-expiry").addEventListener("input", e=>{
    let v = e.target.value.replace(/\D/g,"").slice(0,4);
    if(v.length>=3) v = v.slice(0,2)+"/"+v.slice(2);
    f.expiry = v;
    e.target.value = v;
  });
  document.getElementById("vcc-network").addEventListener("change", e=>{ f.network = e.target.value; });
  document.getElementById("vcc-provider").addEventListener("change", e=>{ f.provider = e.target.value; });
  document.getElementById("vcc-cvv").addEventListener("input", e=>{ f.cvv = e.target.value; });
  document.querySelectorAll("[data-card-type]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ f.cardType = btn.dataset.cardType; renderVccModal(); });
  });

  document.getElementById("saveVccBtn").addEventListener("click", ()=>{
    const nickname = f.nickname.trim();
    if(!nickname){ showToast("Enter a nickname for this card", "close"); return; }
    if(f.expiry && !/^\d{2}\/\d{2}$/.test(f.expiry)){ showToast("Expiry should be in MM/YY format", "close"); return; }
    const payload = { nickname, number: f.number.trim(), expiry: f.expiry.trim(), network: f.network.trim(), cvv: f.cvv.trim(), provider: f.provider.trim(), cardType: f.cardType };
    if(f.id){
      const card = state.vccs.find(c=>c.id===f.id);
      Object.assign(card, payload);
    } else {
      state.vccs.unshift({ id: uid(), ...payload });
    }
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    showToast(f.id ? "Card updated" : "Card added");
    if(ui.tab==="vcc-tracker") renderView();
  });

  const deleteBtn = document.getElementById("deleteVccBtn");
  if(deleteBtn) deleteBtn.addEventListener("click", ()=>{
    if(!confirm(`Delete "${f.nickname}"? This can't be undone.`)) return;
    state.vccs = state.vccs.filter(c=>c.id!==f.id);
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    showToast("Card deleted");
    if(ui.tab==="vcc-tracker") renderView();
  });
}

/* ---------------- Address Tracker ---------------- */

const ADDRESS_TYPES = ["Home","Business","Warehouse","Family/Friend","Other"];
const ADDRESS_COUNTRIES = [["GB","United Kingdom"],["US","United States"],["IE","Ireland"],["CA","Canada"],["AU","Australia"],["DE","Germany"],["FR","France"],["NL","Netherlands"],["ES","Spain"],["IT","Italy"],["Other","Other"]];
let addressUI = { typeFilter: "All", search: "" };

function addressTrackerHTML(){
  const addresses = state.addresses.filter(a=>addressUI.typeFilter==="All"||a.type===addressUI.typeFilter).filter(a=>!addressUI.search||`${a.nickname} ${trackedAddressText(a)}`.toLowerCase().includes(addressUI.search.toLowerCase()));
  return `<div class="stat-grid" style="margin-bottom:16px;">${statCard("pin","Total Addresses",""+state.addresses.length,"var(--blue)","var(--blue-bg)")}${ADDRESS_TYPES.slice(0,3).map(t=>statCard("pin",t,""+state.addresses.filter(a=>a.type===t).length,"var(--violet)","var(--violet-bg)")).join("")}</div>
  <div class="toolbar-row" style="flex-wrap:wrap;"><button class="btn-primary" id="addAddressBtn">${ICONS.plus} Add Address</button><select id="addressTypeFilterSelect" style="width:auto;"><option value="All" ${addressUI.typeFilter==="All"?"selected":""}>All Types</option>${ADDRESS_TYPES.map(t=>`<option value="${t}" ${addressUI.typeFilter===t?"selected":""}>${t}</option>`).join("")}</select><div class="search-bar">${ICONS.search}<input type="text" id="addressSearchInput" placeholder="Search by nickname or address" value="${escapeAttr(addressUI.search)}"></div><button class="btn-small" id="exportAddressCsvBtn">${ICONS.download} Export CSV</button></div>
  <div id="addressResultsContainer">${addressResultsHTML(addresses)}</div><div style="height:20px;"></div>`;
}
function addressResultsHTML(addresses){
  if(!addresses.length) return `<div class="empty-state">${ICONS.pin}<div class="t">No addresses yet</div><div class="d">Save addresses using separate fields so every part exports correctly.</div></div>`;
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;">${addresses.map(a=>`<div class="card" style="padding:16px 18px;"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;"><div style="min-width:0;"><div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(a.nickname)}</div><div class="hint" style="margin:2px 0 0;">${escapeHTML(a.type||"Other")}</div></div><div style="display:flex;gap:6px;flex-shrink:0;"><button class="icon-btn" data-edit-address="${a.id}" title="Edit">${ICONS.pencil}</button><button class="icon-btn" data-delete-address="${a.id}" title="Delete">${ICONS.trash}</button></div></div><div class="hint" style="white-space:pre-line;line-height:1.5;">${escapeHTML(trackedAddressText(a))}</div>${a.notes?`<div class="hint" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border-soft);">${escapeHTML(a.notes)}</div>`:""}</div>`).join("")}</div>`;
}
function renderAddressResults(){ const c=document.getElementById("addressResultsContainer"); if(!c)return; const a=state.addresses.filter(x=>addressUI.typeFilter==="All"||x.type===addressUI.typeFilter).filter(x=>!addressUI.search||`${x.nickname} ${trackedAddressText(x)}`.toLowerCase().includes(addressUI.search.toLowerCase())); c.innerHTML=addressResultsHTML(a); bindAddressResultEvents(); }
function attachAddressTrackerEvents(){
  document.getElementById("addAddressBtn").addEventListener("click",()=>openAddressModal(null));
  document.getElementById("addressTypeFilterSelect").addEventListener("change",e=>{addressUI.typeFilter=e.target.value;renderAddressResults();});
  document.getElementById("addressSearchInput").addEventListener("input",e=>{addressUI.search=e.target.value;renderAddressResults();});
  document.getElementById("exportAddressCsvBtn").addEventListener("click",()=>downloadCSV(`addresses-${todayISO()}.csv`,["Nickname","Type","First Name","Last Name","Address 1","Address 2","City","Postcode / ZIP","State","Country","Notes"],state.addresses.map(a=>{const x=trackedAddressParts(a);return[a.nickname,a.type||"",x.firstName,x.lastName,x.address1,x.address2,x.city,x.zip,x.state,x.country,a.notes||""];})));
  bindAddressResultEvents();
}
function bindAddressResultEvents(){
  document.querySelectorAll("[data-edit-address]").forEach(b=>b.addEventListener("click",()=>openAddressModal(b.dataset.editAddress)));
  document.querySelectorAll("[data-delete-address]").forEach(b=>b.addEventListener("click",()=>{const a=state.addresses.find(x=>x.id===b.dataset.deleteAddress);if(!a||!confirm(`Delete "${a.nickname}"? This can't be undone.`))return;state.addresses=state.addresses.filter(x=>x.id!==a.id);saveState();renderAddressResults();showToast("Address deleted");}));
}
let addressFormState=null;
function openAddressModal(addressId){ const e=addressId?state.addresses.find(a=>a.id===addressId):null; const x=trackedAddressParts(e); addressFormState={id:e?e.id:null,nickname:e?e.nickname:"",type:e?e.type||"Home":"Home",firstName:x.firstName,lastName:x.lastName,address1:x.address1,address2:x.address2,city:x.city,zip:x.zip,state:x.state,country:x.country||"GB",notes:e?e.notes||"":""}; renderAddressModal(); }
function renderAddressModal(){
  const f=addressFormState,isEdit=!!f.id,root=document.getElementById("modalRoot");
  root.innerHTML=`<div class="modal-backdrop open"><div class="modal" style="width:620px;max-width:calc(100vw - 28px);"><div class="modal-header"><h2>${isEdit?"Edit Address":"Add Address"}</h2><button class="icon-btn" id="closeAddressModal">${ICONS.close}</button></div><div class="modal-body">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div class="field"><label>Nickname</label><input type="text" id="addr-nickname" value="${escapeAttr(f.nickname)}" placeholder="e.g. Home"></div><div class="field"><label>Type</label><select id="addr-type">${ADDRESS_TYPES.map(t=>`<option value="${t}" ${f.type===t?"selected":""}>${t}</option>`).join("")}</select></div><div class="field"><label>First name</label><input type="text" id="addr-first-name" value="${escapeAttr(f.firstName)}"></div><div class="field"><label>Last name</label><input type="text" id="addr-last-name" value="${escapeAttr(f.lastName)}"></div></div>
  <div class="field"><label>Address line 1</label><input type="text" id="addr-line1" value="${escapeAttr(f.address1)}" placeholder="House number and street"></div><div class="field"><label>Address line 2 / House name (optional)</label><input type="text" id="addr-line2" value="${escapeAttr(f.address2)}"></div>
  <div style="display:grid;grid-template-columns:1.15fr .85fr;gap:12px;"><div class="field"><label>Country</label><select id="addr-country">${ADDRESS_COUNTRIES.map(([c,l])=>`<option value="${c}" ${f.country===c?"selected":""}>${l}</option>`).join("")}</select></div><div class="field"><label>State / County (optional)</label><input type="text" id="addr-state" value="${escapeAttr(f.state)}"></div><div class="field"><label>City</label><input type="text" id="addr-city" value="${escapeAttr(f.city)}"></div><div class="field"><label>Postcode / ZIP</label><input type="text" id="addr-zip" value="${escapeAttr(f.zip)}"></div></div>
  <div class="field"><label>Notes (optional)</label><input type="text" id="addr-notes" value="${escapeAttr(f.notes)}"></div><div style="display:flex;gap:10px;margin-top:8px;"><button class="btn-primary" id="saveAddressBtn" style="flex:1;">${isEdit?"Save Changes":"Add Address"}</button>${isEdit?`<button class="btn-secondary" id="deleteAddressBtn" style="flex:1;border-color:var(--red);color:var(--red);">${ICONS.trash} Delete Address</button>`:""}</div></div></div></div>`;
  const bind=(id,key,event="input")=>document.getElementById(id).addEventListener(event,e=>{f[key]=e.target.value;});
  document.getElementById("closeAddressModal").addEventListener("click",()=>{root.innerHTML="";}); bind("addr-nickname","nickname");bind("addr-type","type","change");bind("addr-first-name","firstName");bind("addr-last-name","lastName");bind("addr-line1","address1");bind("addr-line2","address2");bind("addr-country","country","change");bind("addr-state","state");bind("addr-city","city");bind("addr-zip","zip");bind("addr-notes","notes");
  document.getElementById("saveAddressBtn").addEventListener("click",()=>{const nickname=f.nickname.trim(),address1=f.address1.trim(),city=f.city.trim(),zip=f.zip.trim();if(!nickname){showToast("Enter a nickname for this address","close");return;}if(!address1){showToast("Enter address line 1","close");return;}if(!city){showToast("Enter the city","close");return;}if(!zip){showToast("Enter the postcode or ZIP","close");return;}const payload={nickname,type:f.type,firstName:f.firstName.trim(),lastName:f.lastName.trim(),address1,address2:f.address2.trim(),city,zip:zip.toUpperCase(),state:f.state.trim(),country:f.country,notes:f.notes.trim()};payload.address=trackedAddressText(payload);if(f.id)Object.assign(state.addresses.find(a=>a.id===f.id),payload);else state.addresses.unshift({id:uid(),...payload});saveState();root.innerHTML="";showToast(f.id?"Address updated":"Address added");if(ui.tab==="address-tracker")renderView();});
  const d=document.getElementById("deleteAddressBtn");if(d)d.addEventListener("click",()=>{if(!confirm(`Delete "${f.nickname}"? This can't be undone.`))return;state.addresses=state.addresses.filter(a=>a.id!==f.id);saveState();root.innerHTML="";showToast("Address deleted");if(ui.tab==="address-tracker")renderView();});
}

/* ---------------- Profile Builder ---------------- */
// Builds complete checkout profiles from the user's saved addresses and cards.
// Addresses are distributed evenly; cards are shuffled and used at most once
// in each generation batch.

const PROFILE_FIRST_NAMES = ["James","Emma","Oliver","Amelia","Liam","Isla","Noah","Ava","Ethan","Mia","Lucas","Sophie","Jack","Grace","Harry","Ruby","George","Chloe","Charlie","Freya","Thomas","Lily","Oscar","Ella","Henry","Poppy","Leo","Evie","Jacob","Alice"];
const PROFILE_LAST_NAMES = ["Smith","Jones","Taylor","Williams","Brown","Davies","Evans","Wilson","Thomas","Roberts","Johnson","Walker","Wright","Robinson","Thompson","White","Edwards","Hughes","Green","Hall","Wood","Harris","Clarke","Patel","Turner","Cooper","Ward","Morris","Bell","Kelly"];

const PROFILE_CSV_HEADERS = [
  "PROFILE_NAME","EMAIL","PHONE","SHIPPING_FIRST_NAME","SHIPPING_LAST_NAME",
  "SHIPPING_ADDRESS","SHIPPING_ADDRESS_2","SHIPPING_CITY","SHIPPING_ZIP",
  "SHIPPING_STATE","SHIPPING_COUNTRY","BILLING_FIRST_NAME","BILLING_LAST_NAME",
  "BILLING_ADDRESS","BILLING_ADDRESS_2","BILLING_CITY","BILLING_ZIP",
  "BILLING_STATE","BILLING_COUNTRY","BILLING_SAME_AS_SHIPPING",
  "CARD_HOLDER_NAME","CARD_TYPE","CARD_NUMBER","CARD_MONTH","CARD_YEAR",
  "CARD_CVV","ONE_CHECKOUT_PER_PROFILE"
];

function randomFrom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

function shuffledCopy(arr){
  const copy = arr.slice();
  for(let i=copy.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generatePhoneNumber(){
  let digits = "";
  for(let i=0;i<9;i++) digits += Math.floor(Math.random()*10);
  return "07"+digits;
}

function generateEmail(firstName, lastName, mode, catchallDomain){
  if(mode==="list" && state.profileBuilderSettings.emailList.length){
    return randomFrom(state.profileBuilderSettings.emailList);
  }
  if(mode==="catchall" && catchallDomain){
    return `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${catchallDomain.replace(/^@/,"")}`;
  }
  return null;
}

function usableProfileCards(provider="All", cardType="All"){
  return state.vccs.filter(c=>{
    const number = (c.number||"").replace(/\D/g,"");
    const complete = number && /^\d{2}\/\d{2}$/.test(c.expiry||"") && (c.cvv||"").trim();
    return complete && (provider==="All" || c.provider===provider) && (cardType==="All" || c.cardType===cardType);
  });
}

function parseTrackedAddress(raw){
  let text = String(raw||"").trim();
  let lines = text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(lines.length===1 && lines[0].includes(",")) lines = lines[0].split(",").map(x=>x.trim()).filter(Boolean);

  let country = "";
  const countryMap = {
    "united kingdom":"GB", "uk":"GB", "great britain":"GB", "gb":"GB",
    "united states":"US", "united states of america":"US", "usa":"US", "us":"US"
  };
  if(lines.length){
    const maybeCountry = lines[lines.length-1].toLowerCase();
    if(countryMap[maybeCountry]) country = countryMap[maybeCountry], lines.pop();
  }

  let zip = "";
  const ukPostcode = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;
  const usZip = /\b(\d{5}(?:-\d{4})?)\b/;
  for(let i=lines.length-1;i>=0;i--){
    const match = lines[i].match(ukPostcode) || lines[i].match(usZip);
    if(match){
      zip = match[1].toUpperCase().replace(/\s+/g," ");
      if(ukPostcode.test(match[1])) country = country || "GB";
      else country = country || "US";
      lines[i] = lines[i].replace(match[0],"").replace(/^\s*[,\-]\s*|\s*[,\-]\s*$/g,"").trim();
      if(!lines[i]) lines.splice(i,1);
      break;
    }
  }

  let stateCode = "";
  if(country==="US" && lines.length){
    const last = lines[lines.length-1];
    const stateMatch = last.match(/(?:,|\s)\s*([A-Z]{2})$/i);
    if(stateMatch){
      stateCode = stateMatch[1].toUpperCase();
      lines[lines.length-1] = last.slice(0,stateMatch.index).replace(/,$/,"").trim();
    }
  }

  const address1 = lines[0] || text;
  let address2 = "";
  let city = "";
  if(lines.length>=3){
    address2 = lines.slice(1,-1).join(", ");
    city = lines[lines.length-1];
  } else if(lines.length===2){
    city = lines[1];
  }

  return { firstName:"", lastName:"", address1, address2, city, zip, state: stateCode, country };
}

function trackedAddressParts(address){
  if(!address) return { firstName:"", lastName:"", address1:"", address2:"", city:"", zip:"", state:"", country:"" };
  const fallback = parseTrackedAddress(address.address || "");
  return {
    firstName: address.firstName || fallback.firstName || "",
    lastName: address.lastName || fallback.lastName || "",
    address1: address.address1 || fallback.address1 || "",
    address2: address.address2 || fallback.address2 || "",
    city: address.city || fallback.city || "",
    zip: address.zip || address.postcode || fallback.zip || "",
    state: address.state || fallback.state || "",
    country: address.country || fallback.country || ""
  };
}

function trackedAddressText(address){
  const a = trackedAddressParts(address);
  return [a.address1, a.address2, [a.city, a.state, a.zip].filter(Boolean).join(" "), a.country].filter(Boolean).join("\n");
}

function profileCsvRow(p){
  const address = state.addresses.find(a=>a.id===p.addressId);
  const card = state.vccs.find(c=>c.id===p.cardId);
  const parsed = address ? trackedAddressParts(address) : parseTrackedAddress(p.addressSnapshot||"");
  const expiry = String(card ? card.expiry||"" : p.cardExpiry||"").split("/");
  const cardNumber = (card ? card.number||"" : p.cardNumber||"").replace(/\D/g,"");
  const cardType = card ? card.network||"" : p.cardNetwork||"";
  const cardCvv = card ? card.cvv||"" : p.cardCvv||"";
  const fullName = `${p.firstName} ${p.lastName}`;
  return [
    p.profileName || fullName, p.email||"", p.phone||"", parsed.firstName || p.firstName, parsed.lastName || p.lastName,
    parsed.address1, parsed.address2, parsed.city, parsed.zip, parsed.state, parsed.country,
    "","","","","","","","","true",
    fullName, cardType, cardNumber, expiry[0]||"", expiry[1]||"", cardCvv, "false"
  ];
}

let profileGenUI = { mode: "catchall", selectedCatchall: "", count: 1, selectedAddressIds: [], provider: "All", cardType: "All" };

function allImapCatchallDomains(){
  const all = (emailUI.accounts || []).flatMap(acc => acc.catchAllDomains || []);
  return Array.from(new Set(all));
}

function profileBuilderHTML(){
  const s = state.profileBuilderSettings;
  const catchallDomains = allImapCatchallDomains();
  if(!profileGenUI.selectedCatchall && catchallDomains.length) profileGenUI.selectedCatchall = catchallDomains[0];
  profileGenUI.selectedAddressIds = profileGenUI.selectedAddressIds.filter(id=>state.addresses.some(a=>a.id===id));

  return `
    <div class="card panel" style="margin-bottom:20px;">
      <div class="panel-title" style="margin-bottom:6px;">Email Source</div>
      <div class="hint" style="margin-bottom:12px;">Choose the email source for this batch.</div>
      <div class="segmented" style="margin-bottom:14px;max-width:360px;">
        <button class="${profileGenUI.mode==='catchall'?'active':''}" data-gen-mode="catchall">Catch-all domain</button>
        <button class="${profileGenUI.mode==='list'?'active':''}" data-gen-mode="list">My own addresses</button>
      </div>
      ${profileGenUI.mode==='catchall' ? (
        catchallDomains.length ? `
          <div class="field" style="max-width:360px;">
            <label>Which catch-all domain</label>
            <select id="pb-select-catchall">
              ${catchallDomains.map(d=>`<option value="${escapeAttr(d)}" ${profileGenUI.selectedCatchall===d?"selected":""}>${escapeHTML(d)}</option>`).join("")}
            </select>
          </div>
        ` : `<div class="hint">No catch-all domains set up yet — add one under Settings → Email Sync first.</div>`
      ) : (
        s.emailList.length ? `<div class="hint">Picks randomly from the ${s.emailList.length} address${s.emailList.length===1?"":"es"} saved in Settings.</div>` : `<div class="hint">No email addresses saved yet — add some in Settings first.</div>`
      )}
    </div>

    <div class="card panel" style="margin-bottom:20px;">
      <div class="panel-title" style="margin-bottom:6px;">Addresses</div>
      <div class="hint" style="margin-bottom:12px;">Select the saved addresses to distribute evenly across this batch.</div>
      ${state.addresses.length ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;">
          ${state.addresses.map(a=>`
            <label class="card" style="padding:10px 12px;display:flex;gap:9px;align-items:flex-start;cursor:pointer;">
              <input type="checkbox" data-pb-address="${a.id}" ${profileGenUI.selectedAddressIds.includes(a.id)?"checked":""}>
              <span style="min-width:0;">
                <strong style="display:block;font-size:13px;">${escapeHTML(a.nickname)}</strong>
                <span class="hint" style="display:block;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(trackedAddressText(a).replace(/\n/g,", "))}</span>
              </span>
            </label>
          `).join("")}
        </div>
      ` : `<div class="hint">No saved addresses — add at least one in Address Tracker first.</div>`}
    </div>

    <div class="card panel" style="margin-bottom:20px;">
      <div class="panel-title" style="margin-bottom:6px;">Cards</div>
      <div class="hint" style="margin-bottom:12px;">Cards are selected randomly and each card is used no more than once in the batch.</div>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(180px,280px));gap:12px;">
        <div class="field" style="margin:0;"><label>Card provider</label><select id="pb-card-provider">
          <option value="All" ${profileGenUI.provider==="All"?"selected":""}>All providers</option>
          ${Array.from(new Set(state.vccs.map(c=>c.provider).filter(Boolean))).sort().map(provider=>`<option value="${escapeAttr(provider)}" ${profileGenUI.provider===provider?"selected":""}>${escapeHTML(provider)}</option>`).join("")}
        </select></div>
        <div class="field" style="margin:0;"><label>Card type</label><select id="pb-card-type">
          <option value="All" ${profileGenUI.cardType==="All"?"selected":""}>Virtual &amp; physical</option>
          <option value="virtual" ${profileGenUI.cardType==="virtual"?"selected":""}>Virtual only</option>
          <option value="physical" ${profileGenUI.cardType==="physical"?"selected":""}>Physical only</option>
        </select></div>
      </div>
      <div class="hint" style="margin-top:10px;">${usableProfileCards(profileGenUI.provider, profileGenUI.cardType).length} matching complete card${usableProfileCards(profileGenUI.provider, profileGenUI.cardType).length===1?"":"s"} available.</div>
    </div>

    <div class="toolbar-row">
      <button class="btn-primary" id="generateProfileBtn">${ICONS.plus} Generate</button>
      <div class="field" style="margin:0;width:90px;">
        <input type="number" id="pb-genCount" value="${profileGenUI.count}" min="1" max="100" step="1">
      </div>
      <div class="hint" style="margin:0;">profile${profileGenUI.count===1?"":"s"} at once</div>
      ${state.generatedProfiles.length ? `<button class="btn-small" id="exportProfilesCsvBtn" style="margin-left:auto;">${ICONS.download} Export CSV</button>` : ""}
    </div>
    <div id="profilesResultsContainer">${profilesResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

let profileSelection = new Set();

function profilesResultsHTML(){
  if(state.generatedProfiles.length===0){
    return `
      <div class="empty-state">
        ${ICONS.tools}
        <div class="t">No profiles yet</div>
        <div class="d">Choose addresses, enter a quantity, and generate complete profiles with randomly assigned unique cards.</div>
      </div>
    `;
  }
  const allSelected = state.generatedProfiles.length>0 && state.generatedProfiles.every(p=>profileSelection.has(p.id));
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;margin-bottom:8px;">
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-dim);cursor:pointer;">
        <input type="checkbox" id="selectAllProfilesCheckbox" ${allSelected?"checked":""}>
        Select all
      </label>
      ${profileSelection.size>0 ? `<button class="btn-small" id="deleteSelectedProfilesBtn" style="border-color:var(--red);color:var(--red);">${ICONS.trash} Delete Selected (${profileSelection.size})</button>` : ""}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.generatedProfiles.map(p=>{
        const address = state.addresses.find(a=>a.id===p.addressId);
        const card = state.vccs.find(c=>c.id===p.cardId);
        return `
        <div class="card" style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:12px;min-width:0;">
            <input type="checkbox" class="profile-select-checkbox" data-select-profile="${p.id}" ${profileSelection.has(p.id)?"checked":""}>
            <div style="min-width:0;">
              <div style="font-weight:700;font-size:14px;">${escapeHTML(p.firstName)} ${escapeHTML(p.lastName)}</div>
              <div class="hint mono" style="margin:3px 0 0;">${escapeHTML(p.phone)}${p.email ? " · "+escapeHTML(p.email) : ""}</div>
              <div class="hint" style="margin:3px 0 0;">${escapeHTML(address ? address.nickname : "Address unavailable")} · ${escapeHTML(card ? card.nickname : "Card unavailable")}${card&&card.number ? " •••• "+escapeHTML(card.number.replace(/\D/g,"").slice(-4)) : ""}</div>
            </div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn-small" data-copy-profile="${p.id}">Copy</button>
            <button class="icon-btn" data-delete-profile="${p.id}">${ICONS.trash}</button>
          </div>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderProfilesResults(){
  const container = document.getElementById("profilesResultsContainer");
  if(!container) return;
  container.innerHTML = profilesResultsHTML();
  bindProfilesResultEvents();
}

function attachProfileBuilderEvents(){
  document.querySelectorAll("[data-gen-mode]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ profileGenUI.mode = btn.dataset.genMode; renderView(); });
  });
  const catchallSelect = document.getElementById("pb-select-catchall");
  if(catchallSelect) catchallSelect.addEventListener("change", e=>{ profileGenUI.selectedCatchall = e.target.value; });
  const providerSelect = document.getElementById("pb-card-provider");
  if(providerSelect) providerSelect.addEventListener("change", e=>{ profileGenUI.provider = e.target.value; renderView(); });
  const cardTypeSelect = document.getElementById("pb-card-type");
  if(cardTypeSelect) cardTypeSelect.addEventListener("change", e=>{ profileGenUI.cardType = e.target.value; renderView(); });
  document.querySelectorAll("[data-pb-address]").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const id = cb.dataset.pbAddress;
      if(cb.checked && !profileGenUI.selectedAddressIds.includes(id)) profileGenUI.selectedAddressIds.push(id);
      if(!cb.checked) profileGenUI.selectedAddressIds = profileGenUI.selectedAddressIds.filter(x=>x!==id);
    });
  });
  document.getElementById("pb-genCount").addEventListener("input", e=>{
    profileGenUI.count = Math.max(1, Math.min(100, parseInt(e.target.value,10)||1));
  });

  document.getElementById("generateProfileBtn").addEventListener("click", ()=>{
    const s = state.profileBuilderSettings;
    if(profileGenUI.mode==="catchall" && !allImapCatchallDomains().length){ showToast("Add a catch-all domain under Settings first", "close"); return; }
    if(profileGenUI.mode==="list" && !s.emailList.length){ showToast("Add some email addresses in Settings first", "close"); return; }
    const selectedAddresses = profileGenUI.selectedAddressIds.map(id=>state.addresses.find(a=>a.id===id)).filter(Boolean);
    if(!selectedAddresses.length){ showToast("Select at least one address", "close"); return; }
    const countInput = document.getElementById("pb-genCount");
    const count = Math.max(1, Math.min(100, parseInt(countInput.value,10)||1));
    const cards = shuffledCopy(usableProfileCards(profileGenUI.provider, profileGenUI.cardType));
    if(cards.length<count){
      showToast(`${count} complete cards are required; only ${cards.length} are available`, "close");
      return;
    }
    const newProfiles = [];
    for(let i=0; i<count; i++){
      const firstName = randomFrom(PROFILE_FIRST_NAMES);
      const lastName = randomFrom(PROFILE_LAST_NAMES);
      const address = selectedAddresses[i % selectedAddresses.length];
      const card = cards[i];
      newProfiles.push({
        id: uid(), profileName: `${firstName} ${lastName}`, firstName, lastName,
        phone: generatePhoneNumber(),
        email: generateEmail(firstName, lastName, profileGenUI.mode, profileGenUI.selectedCatchall),
        addressId: address.id, addressSnapshot: trackedAddressText(address),
        cardId: card.id, cardNumber: card.number||"", cardExpiry: card.expiry||"",
        cardNetwork: card.network||"", cardCvv: card.cvv||""
      });
    }
    state.generatedProfiles.unshift(...newProfiles);
    saveState();
    renderView();
    showToast(`${count} profile${count===1?"":"s"} generated`);
  });

  const exportBtn = document.getElementById("exportProfilesCsvBtn");
  if(exportBtn) exportBtn.addEventListener("click", ()=>{
    const profiles = profileSelection.size
      ? state.generatedProfiles.filter(p=>profileSelection.has(p.id))
      : state.generatedProfiles;
    downloadCSV(`profiles-${todayISO()}.csv`, PROFILE_CSV_HEADERS, profiles.map(profileCsvRow));
    showToast(`${profiles.length} profile${profiles.length===1?"":"s"} exported`);
  });
  bindProfilesResultEvents();
}

function bindProfilesResultEvents(){
  document.querySelectorAll("[data-copy-profile]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const p = state.generatedProfiles.find(x=>x.id===btn.dataset.copyProfile);
      if(!p) return;
      const address = state.addresses.find(a=>a.id===p.addressId);
      const card = state.vccs.find(c=>c.id===p.cardId);
      const text = `${p.firstName} ${p.lastName}\n${p.phone}${p.email ? "\n"+p.email : ""}${address ? "\n"+trackedAddressText(address) : ""}${card ? "\n"+card.network+" •••• "+(card.number||"").replace(/\D/g,"").slice(-4) : ""}`;
      navigator.clipboard.writeText(text).then(()=>showToast("Copied to clipboard"));
    });
  });
  document.querySelectorAll("[data-delete-profile]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.generatedProfiles = state.generatedProfiles.filter(p=>p.id!==btn.dataset.deleteProfile);
      profileSelection.delete(btn.dataset.deleteProfile);
      saveState(); renderView();
    });
  });
  const selectAllCheckbox = document.getElementById("selectAllProfilesCheckbox");
  if(selectAllCheckbox) selectAllCheckbox.addEventListener("change", e=>{
    if(e.target.checked) state.generatedProfiles.forEach(p=>profileSelection.add(p.id));
    else profileSelection.clear();
    renderProfilesResults();
  });
  document.querySelectorAll("[data-select-profile]").forEach(cb=>{
    cb.addEventListener("change", e=>{
      const id = cb.dataset.selectProfile;
      if(e.target.checked) profileSelection.add(id); else profileSelection.delete(id);
      renderProfilesResults();
    });
  });
  const deleteSelectedBtn = document.getElementById("deleteSelectedProfilesBtn");
  if(deleteSelectedBtn) deleteSelectedBtn.addEventListener("click", ()=>{
    const count = profileSelection.size;
    if(!confirm(`Delete ${count} selected profile${count===1?"":"s"}? This can't be undone.`)) return;
    state.generatedProfiles = state.generatedProfiles.filter(p=>!profileSelection.has(p.id));
    profileSelection.clear(); saveState(); renderView();
    showToast(`${count} profile${count===1?"":"s"} deleted`);
  });
}

/* ---------------- Invoice Generator ---------------- */

let invoiceUI = { subTab: "create" };
let invoiceDraft = null;

function freshInvoiceDraft(){
  return {
    fromName: state.invoiceSettings.fromName,
    logo: state.invoiceSettings.defaultLogo || null,
    buyerName: "", buyerAddress: "", buyerEmail: "",
    lineItems: [],
    vatEnabled: false,
    vatRate: state.invoiceSettings.defaultVatRate,
    shippingCost: "0",
    paymentDeadline: "",
    bankDetails: state.invoiceSettings.defaultBankDetails || "",
    notes: "",
    itemPickerSearch: ""
  };
}

function invoiceTotals(draft){
  const subtotal = draft.lineItems.reduce((s,li)=>s+li.quantity*li.unitPrice,0);
  const shipping = parseFloat(draft.shippingCost)||0;
  const vatAmount = draft.vatEnabled ? (subtotal+shipping)*(parseFloat(draft.vatRate)||0)/100 : 0;
  const total = subtotal + shipping + vatAmount;
  return { subtotal, shipping, vatAmount, total };
}

function invoiceGeneratorHTML(){
  if(!invoiceDraft) invoiceDraft = freshInvoiceDraft();
  return `
    <div class="segmented" style="margin-bottom:16px;">
      <button class="${invoiceUI.subTab==='create'?'active':''}" data-invoice-subtab="create">Create Invoice</button>
      <button class="${invoiceUI.subTab==='list'?'active':''}" data-invoice-subtab="list">Invoices (${state.invoices.length})</button>
    </div>
    ${invoiceUI.subTab==='create' ? invoiceCreateHTML() : invoicesListHTML()}
  `;
}

function invoiceTotalsCardHTML(d, totals){
  return `
    <div class="card" style="padding:16px 18px;">
      <div class="kv-row"><span class="k">Subtotal</span><span class="v">${fmtMoney(totals.subtotal)}</span></div>
      <div class="kv-row"><span class="k">Shipping</span><span class="v">${fmtMoney(totals.shipping)}</span></div>
      ${d.vatEnabled ? `<div class="kv-row"><span class="k">VAT (${d.vatRate||0}%)</span><span class="v">${fmtMoney(totals.vatAmount)}</span></div>` : ""}
      <div class="kv-row" style="border-top:1px solid var(--border-soft);margin-top:6px;padding-top:10px;"><span class="k" style="font-weight:700;color:var(--text);">Total</span><span class="v" style="font-size:17px;">${fmtMoney(totals.total)}</span></div>
    </div>
  `;
}

function bindInvoiceItemPickerEvents(){
  document.querySelectorAll("[data-add-invoice-item]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const d = invoiceDraft;
      const item = state.items.find(i=>i.id===btn.dataset.addInvoiceItem);
      if(!item) return;
      const existing = d.lineItems.find(li=>li.itemId===item.id);
      if(existing){ existing.quantity++; }
      else { d.lineItems.push({ itemId: item.id, name: item.name, quantity: 1, unitPrice: item.purchasePricePerUnit||0 }); }
      d.itemPickerSearch = "";
      renderView();
    });
  });
}

function invoiceItemPickerHTML(d){
  const matchingItems = state.items.filter(i=>!i.isPreorder && qtyRemaining(i)>0 &&
    (!d.itemPickerSearch || i.name.toLowerCase().includes(d.itemPickerSearch.toLowerCase())));
  const availableItems = d.itemPickerSearch ? matchingItems : matchingItems.slice(0, 15);
  return `
    <div class="card table-wrap" style="margin-bottom:14px;max-height:260px;overflow-y:auto;">
      <table class="data-table">
        <thead><tr><th>Item</th><th>In stock</th><th></th></tr></thead>
        <tbody>
          ${availableItems.length===0 ? `<tr><td colspan="3" class="hint">${d.itemPickerSearch ? "No matching in-stock items." : "Nothing in stock yet."}</td></tr>` : availableItems.map(i=>`
            <tr>
              <td>${escapeHTML(i.name)}</td>
              <td class="mono dim">${qtyRemaining(i)}</td>
              <td style="text-align:right;"><button class="btn-small" data-add-invoice-item="${i.id}">Add</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      ${!d.itemPickerSearch && matchingItems.length>availableItems.length ? `<div class="hint" style="padding:8px 12px;">Showing ${availableItems.length} of ${matchingItems.length} in-stock items — search above to find more.</div>` : ""}
    </div>
  `;
}

function invoiceCreateHTML(){
  const d = invoiceDraft;
  const totals = invoiceTotals(d);

  return `
    <div class="card panel" style="margin-bottom:16px;">
      <div class="panel-title" style="margin-bottom:10px;">From</div>
      <div class="field" style="max-width:400px;">
        <label>Your business or personal name</label>
        <input type="text" id="inv-fromname" value="${escapeAttr(d.fromName)}" placeholder="e.g. Restock Reselling, or your name">
      </div>
      <div style="height:14px;"></div>
      <div style="font-size:12.5px;font-weight:700;color:var(--text-dim);margin-bottom:8px;">Logo</div>
      <div style="display:flex;align-items:center;gap:14px;">
        ${d.logo ? `<img src="${d.logo}" style="height:56px;max-width:160px;object-fit:contain;border-radius:6px;background:#fff;padding:4px;">` : `<div class="hint" style="margin:0;">No logo set — it'll appear on every invoice once added, no need to add it again.</div>`}
        <div style="display:flex;gap:8px;flex-shrink:0;">
          <label class="btn-small" style="cursor:pointer;margin:0;">
            ${ICONS.plus} ${d.logo ? "Replace" : "Add Logo"}
            <input type="file" id="inv-logo-upload" accept="image/*" style="display:none;">
          </label>
          ${d.logo ? `<button class="btn-small" id="inv-logo-remove" style="border-color:var(--red);color:var(--red);">Remove</button>` : ""}
        </div>
      </div>
    </div>

    <div class="card panel" style="margin-bottom:16px;">
      <div class="panel-title" style="margin-bottom:10px;">Bill To</div>
      <div class="form-grid" style="margin-top:0;">
        <div class="field">
          <label>Buyer name</label>
          <input type="text" id="inv-buyername" value="${escapeAttr(d.buyerName)}">
        </div>
        <div class="field">
          <label>Buyer email</label>
          <input type="text" id="inv-buyeremail" value="${escapeAttr(d.buyerEmail)}">
        </div>
      </div>
      <div class="field">
        <label>Buyer address</label>
        <textarea id="inv-buyeraddress" rows="2">${escapeHTML(d.buyerAddress)}</textarea>
      </div>
    </div>

    <div class="card panel" style="margin-bottom:16px;">
      <div class="panel-title" style="margin-bottom:10px;">Items</div>
      <div class="search-bar" style="margin-bottom:10px;max-width:400px;">
        ${ICONS.search}
        <input type="text" id="inv-itemsearch" placeholder="Search in-stock items, or just pick from the list below" value="${escapeAttr(d.itemPickerSearch)}">
      </div>
      <div id="invoiceItemPicker">${invoiceItemPickerHTML(d)}</div>
    </div>

      ${d.lineItems.length===0 ? `<div class="hint">No items added yet — search above to add some.</div>` : `
        <div class="card table-wrap">
          <table class="data-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Price each</th><th style="text-align:right;">Line total</th><th></th></tr></thead>
            <tbody>
              ${d.lineItems.map((li,idx)=>`
                <tr>
                  <td>${escapeHTML(li.name)}</td>
                  <td><div class="field" style="margin:0;width:70px;"><input type="number" class="inv-line-qty" data-line-idx="${idx}" value="${li.quantity}" min="1" style="padding:6px 8px;"></div></td>
                  <td><div class="field" style="margin:0;width:100px;"><input type="number" class="inv-line-price" data-line-idx="${idx}" value="${li.unitPrice}" step="0.01" min="0" style="padding:6px 8px;"></div></td>
                  <td style="text-align:right;" class="mono" id="inv-line-total-${idx}">${fmtMoney(li.quantity*li.unitPrice)}</td>
                  <td style="text-align:right;"><button class="icon-btn" data-remove-invoice-line="${idx}">${ICONS.trash}</button></td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `}
    </div>

    <div class="card panel" style="margin-bottom:16px;">
      <div class="panel-title" style="margin-bottom:10px;">Charges</div>
      <div class="form-grid" style="margin-top:0;">
        <div class="field">
          <label>Shipping cost</label>
          <input type="number" id="inv-shipping" value="${escapeAttr(d.shippingCost)}" step="0.01" min="0">
        </div>
        <div class="field">
          <label style="display:flex;align-items:center;gap:8px;">
            <input type="checkbox" id="inv-vat-toggle" ${d.vatEnabled?"checked":""} style="width:auto;">
            Charge VAT
          </label>
          <input type="number" id="inv-vat-rate" value="${escapeAttr(d.vatRate)}" step="0.1" min="0" max="100" ${d.vatEnabled?"":"disabled"} style="margin-top:8px;">
        </div>
      </div>
      <div class="form-grid" style="margin-top:14px;">
        <div class="field">
          <label>Payment due by (optional)</label>
          <input type="date" id="inv-payment-deadline" value="${escapeAttr(d.paymentDeadline)}">
        </div>
        <div class="field">
          <label>Bank details for payment (optional)</label>
          <input type="text" id="inv-bank-details" value="${escapeAttr(d.bankDetails)}" placeholder="Sort code, account number, or payment link">
        </div>
      </div>
      <div class="field">
        <label>Notes (optional)</label>
        <input type="text" id="inv-notes" value="${escapeAttr(d.notes)}" placeholder="Payment terms, thank-you note, etc.">
      </div>
    </div>

    <div id="invoiceTotalsCard">${invoiceTotalsCardHTML(d, totals)}</div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn-primary" id="saveInvoiceBtn">${ICONS.check} Save Invoice</button>
      <button class="btn-secondary" id="exportInvoicePdfBtn">${ICONS.download} Export PDF</button>
      <button class="btn-secondary" id="sendInvoiceEmailBtn">${ICONS.mail} Send by Email</button>
    </div>
    <div style="height:20px;"></div>
  `;
}

// The actual printable document — deliberately plain inline-styled HTML
// (no external stylesheet or JS) so it renders identically whether it's
// exported straight to PDF or emailed as an attachment.
function formatAddressHTML(address){
  if(!address) return "";
  // Handles however it was actually typed — one line per line already
  // (from pressing enter in the textarea), one long comma-separated
  // line, or a mix of both — and renders it as a clean, properly spaced
  // address block either way, rather than relying on the raw text's own
  // whitespace to look right.
  const lines = address
    .replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .split("\n")
    .flatMap(line => line.split(","))
    .map(line => line.trim())
    .filter(Boolean);
  return lines.map(line => `<div>${escapeHTML(line)}</div>`).join("");
}

function buildInvoiceHTML(invoice){
  const totals = invoiceTotals(invoice);
  return `
    <html><head><meta charset="utf-8"><style>
      body{font-family:Arial,Helvetica,sans-serif;color:#111;padding:40px;font-size:13px;}
      h1{font-size:22px;margin:0 0 4px;}
      .muted{color:#666;}
      table{width:100%;border-collapse:collapse;margin-top:24px;}
      th{text-align:left;border-bottom:2px solid #333;padding:8px 6px;font-size:11px;text-transform:uppercase;color:#555;}
      td{padding:8px 6px;border-bottom:1px solid #ddd;}
      .totals{margin-top:16px;width:280px;margin-left:auto;}
      .totals div{display:flex;justify-content:space-between;padding:4px 0;}
      .totals .grand{font-weight:bold;font-size:16px;border-top:2px solid #333;margin-top:6px;padding-top:8px;}
      .row{display:flex;justify-content:space-between;margin-bottom:30px;}
      .box{max-width:45%;}
      .label{font-size:11px;text-transform:uppercase;color:#888;margin-bottom:4px;}
    </style></head><body>
      <div class="row">
        <div class="box">
          ${invoice.logo ? `<img src="${invoice.logo}" style="max-height:60px;max-width:220px;object-fit:contain;margin-bottom:10px;display:block;">` : ""}
          <h1>${escapeHTML(invoice.fromName||"")}</h1>
        </div>
        <div class="box" style="text-align:right;">
          <div class="label">Invoice</div>
          <div style="font-weight:bold;">${escapeHTML(invoice.invoiceNumber)}</div>
          <div class="muted">${formatDate(invoice.date)}</div>
        </div>
      </div>
      <div class="row">
        <div class="box">
          <div class="label">Bill To</div>
          <div style="font-weight:bold;">${escapeHTML(invoice.buyer.name||"")}</div>
          <div class="muted" style="line-height:1.5;margin-top:2px;">${formatAddressHTML(invoice.buyer.address)}</div>
          <div class="muted">${escapeHTML(invoice.buyer.email||"")}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th style="text-align:right;">Total</th></tr></thead>
        <tbody>
          ${invoice.lineItems.map(li=>`<tr><td>${escapeHTML(li.name)}</td><td>${li.quantity}</td><td>${fmtMoney(li.unitPrice)}</td><td style="text-align:right;">${fmtMoney(li.quantity*li.unitPrice)}</td></tr>`).join("")}
        </tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><span>${fmtMoney(totals.subtotal)}</span></div>
        <div><span>Shipping</span><span>${fmtMoney(totals.shipping)}</span></div>
        ${invoice.vatEnabled ? `<div><span>VAT (${invoice.vatRate||0}%)</span><span>${fmtMoney(totals.vatAmount)}</span></div>` : ""}
        <div class="grand"><span>Total</span><span>${fmtMoney(totals.total)}</span></div>
      </div>
      ${invoice.paymentDeadline || invoice.bankDetails ? `
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #ddd;">
          ${invoice.paymentDeadline ? `<div><strong>Payment due by:</strong> ${formatDate(invoice.paymentDeadline)}</div>` : ""}
          ${invoice.bankDetails ? `<div style="margin-top:4px;"><strong>Payment details:</strong> ${escapeHTML(invoice.bankDetails)}</div>` : ""}
        </div>
      ` : ""}
      ${invoice.notes ? `<div style="margin-top:16px;" class="muted">${escapeHTML(invoice.notes)}</div>` : ""}
    </body></html>
  `;
}

function draftToInvoiceObject(existingId){
  const d = invoiceDraft;
  return {
    id: existingId || uid(),
    invoiceNumber: existingId ? state.invoices.find(i=>i.id===existingId).invoiceNumber : `INV-${String(state.invoiceSettings.nextInvoiceNumber).padStart(4,"0")}`,
    date: existingId ? state.invoices.find(i=>i.id===existingId).date : todayISO(),
    status: existingId ? state.invoices.find(i=>i.id===existingId).status : "awaiting_payment",
    fromName: d.fromName.trim(),
    logo: d.logo || null,
    buyer: { name: d.buyerName.trim(), address: d.buyerAddress.trim(), email: d.buyerEmail.trim() },
    lineItems: d.lineItems,
    vatEnabled: d.vatEnabled,
    vatRate: parseFloat(d.vatRate)||0,
    shippingCost: parseFloat(d.shippingCost)||0,
    paymentDeadline: d.paymentDeadline || null,
    bankDetails: d.bankDetails.trim(),
    notes: d.notes.trim()
  };
}

function saveInvoiceDraft(){
  if(invoiceDraft.lineItems.length===0){ showToast("Add at least one item first", "close"); return null; }
  const invoice = draftToInvoiceObject(invoiceDraft.editingId);
  if(invoiceDraft.editingId){
    const idx = state.invoices.findIndex(i=>i.id===invoiceDraft.editingId);
    state.invoices[idx] = invoice;
  } else {
    state.invoices.unshift(invoice);
    state.invoiceSettings.nextInvoiceNumber++;
  }
  state.invoiceSettings.fromName = invoice.fromName; // carries forward as the default for next time
  saveState();
  return invoice;
}

function invoicesListHTML(){
  if(state.invoices.length===0){
    return `
      <div class="empty-state">
        ${ICONS.cash}
        <div class="t">No invoices yet</div>
        <div class="d">Invoices you create show up here, so you can track which are still awaiting payment.</div>
      </div>
    `;
  }
  const statusColor = { awaiting_payment: "var(--gold)", paid: "var(--green)", cancelled: "var(--text-mute)" };
  const statusLbl = { awaiting_payment: "Awaiting Payment", paid: "Paid", cancelled: "Cancelled" };
  return `
    <div class="card table-wrap">
      <table class="data-table">
        <thead><tr><th>Invoice #</th><th>Buyer</th><th>Date</th><th>Total</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${state.invoices.map(inv=>{
            const totals = invoiceTotals(inv);
            return `
            <tr data-open-invoice="${inv.id}" style="cursor:pointer;">
              <td class="mono" style="font-weight:600;">${escapeHTML(inv.invoiceNumber)}</td>
              <td>${escapeHTML(inv.buyer.name||"—")}</td>
              <td class="mono dim">${formatDate(inv.date)}</td>
              <td class="mono">${fmtMoney(totals.total)}</td>
              <td><span class="status-chip" style="background:${statusColor[inv.status]}22;color:${statusColor[inv.status]};">${statusLbl[inv.status]}</span></td>
              <td style="text-align:right;white-space:nowrap;">
                ${inv.status!=="paid" ? `<button class="btn-small" data-mark-paid="${inv.id}" style="margin-right:6px;">Mark Paid</button>` : ""}
                <button class="icon-btn" data-delete-invoice="${inv.id}" title="Delete this invoice">${ICONS.trash}</button>
              </td>
            </tr>
          `;}).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function loadInvoiceIntoDraft(invoice){
  invoiceDraft = {
    editingId: invoice.id,
    fromName: invoice.fromName,
    logo: invoice.logo || null,
    buyerName: invoice.buyer.name, buyerAddress: invoice.buyer.address, buyerEmail: invoice.buyer.email,
    lineItems: invoice.lineItems.map(li=>({...li})),
    vatEnabled: invoice.vatEnabled,
    vatRate: invoice.vatRate,
    shippingCost: String(invoice.shippingCost),
    paymentDeadline: invoice.paymentDeadline || "",
    bankDetails: invoice.bankDetails || "",
    notes: invoice.notes,
    itemPickerSearch: ""
  };
  invoiceUI.subTab = "create";
}

function attachInvoiceGeneratorEvents(){
  document.querySelectorAll("[data-invoice-subtab]").forEach(btn=>{
    btn.addEventListener("click", ()=>{ invoiceUI.subTab = btn.dataset.invoiceSubtab; renderView(); });
  });

  if(invoiceUI.subTab==="create"){
    const d = invoiceDraft;
    document.getElementById("inv-fromname").addEventListener("input", e=>{ d.fromName = e.target.value; });
    document.getElementById("inv-logo-upload").addEventListener("change", e=>{
      const file = e.target.files[0];
      if(!file) return;
      if(file.size > 2*1024*1024){ showToast("Logo image is too large — please use something under 2MB", "close"); return; }
      const reader = new FileReader();
      reader.onload = ()=>{
        d.logo = reader.result;
        state.invoiceSettings.defaultLogo = reader.result; // saved once, defaults from here on
        saveState();
        renderView();
        showToast("Logo saved — it'll be used on every invoice from now on");
      };
      reader.readAsDataURL(file);
    });
    const removeLogoBtn = document.getElementById("inv-logo-remove");
    if(removeLogoBtn) removeLogoBtn.addEventListener("click", ()=>{
      d.logo = null;
      state.invoiceSettings.defaultLogo = null;
      saveState();
      renderView();
      showToast("Logo removed");
    });
    document.getElementById("inv-buyername").addEventListener("input", e=>{ d.buyerName = e.target.value; });
    document.getElementById("inv-buyeremail").addEventListener("input", e=>{ d.buyerEmail = e.target.value; });
    document.getElementById("inv-buyeraddress").addEventListener("input", e=>{ d.buyerAddress = e.target.value; });
    document.getElementById("inv-itemsearch").addEventListener("input", e=>{
      d.itemPickerSearch = e.target.value;
      const picker = document.getElementById("invoiceItemPicker");
      if(picker){ picker.innerHTML = invoiceItemPickerHTML(d); bindInvoiceItemPickerEvents(); }
    });
    document.getElementById("inv-shipping").addEventListener("input", e=>{ d.shippingCost = e.target.value; updateInvoiceTotalsCard(); });
    document.getElementById("inv-vat-toggle").addEventListener("change", e=>{ d.vatEnabled = e.target.checked; renderView(); });
    document.getElementById("inv-vat-rate").addEventListener("input", e=>{ d.vatRate = e.target.value; updateInvoiceTotalsCard(); });
    document.getElementById("inv-notes").addEventListener("input", e=>{ d.notes = e.target.value; });
    document.getElementById("inv-payment-deadline").addEventListener("change", e=>{ d.paymentDeadline = e.target.value; });
    document.getElementById("inv-bank-details").addEventListener("input", e=>{ d.bankDetails = e.target.value; });

    bindInvoiceItemPickerEvents();
    document.querySelectorAll(".inv-line-qty").forEach(input=>{
      input.addEventListener("input", e=>{
        const idx = parseInt(e.target.dataset.lineIdx,10);
        // Not clamping to a minimum here — forcing a value back into the
        // field while someone is still typing is exactly what caused the
        // "only one digit at a time" bug in the first place. Blank/zero
        // is corrected on blur instead, once they're actually done typing.
        const raw = parseInt(e.target.value,10);
        d.lineItems[idx].quantity = isNaN(raw) ? 0 : raw;
        updateInvoiceLineTotal(idx);
      });
      input.addEventListener("blur", e=>{
        const idx = parseInt(e.target.dataset.lineIdx,10);
        if(!d.lineItems[idx].quantity || d.lineItems[idx].quantity<1){
          d.lineItems[idx].quantity = 1;
          e.target.value = 1;
          updateInvoiceLineTotal(idx);
        }
      });
    });
    document.querySelectorAll(".inv-line-price").forEach(input=>{
      input.addEventListener("input", e=>{
        const idx = parseInt(e.target.dataset.lineIdx,10);
        d.lineItems[idx].unitPrice = parseFloat(e.target.value)||0;
        updateInvoiceLineTotal(idx);
      });
    });
    document.querySelectorAll("[data-remove-invoice-line]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        d.lineItems.splice(parseInt(btn.dataset.removeInvoiceLine,10),1);
        renderView();
      });
    });

    document.getElementById("saveInvoiceBtn").addEventListener("click", ()=>{
      const invoice = saveInvoiceDraft();
      if(invoice){
        showToast(`Invoice ${invoice.invoiceNumber} saved`);
        invoiceDraft = freshInvoiceDraft();
        invoiceUI.subTab = "list";
        renderView();
      }
    });
    document.getElementById("exportInvoicePdfBtn").addEventListener("click", async ()=>{
      if(d.lineItems.length===0){ showToast("Add at least one item first", "close"); return; }
      const invoice = draftToInvoiceObject(d.editingId);
      const html = buildInvoiceHTML(invoice);
      const res = await window.invoiceAPI.exportPdf(html, `${invoice.invoiceNumber}.pdf`);
      if(res.ok) showToast("PDF saved");
      else if(!res.cancelled) showToast(res.error || "Could not export PDF", "close");
    });
    document.getElementById("sendInvoiceEmailBtn").addEventListener("click", ()=>{
      if(d.lineItems.length===0){ showToast("Add at least one item first", "close"); return; }
      if(!d.buyerEmail.trim()){ showToast("Enter the buyer's email first", "close"); return; }
      openSendInvoiceModal();
    });
  } else {
    document.querySelectorAll("[data-open-invoice]").forEach(row=>{
      row.addEventListener("click", (e)=>{
        if(e.target.closest("button")) return;
        const invoice = state.invoices.find(i=>i.id===row.dataset.openInvoice);
        if(invoice){ loadInvoiceIntoDraft(invoice); renderView(); }
      });
    });
    document.querySelectorAll("[data-mark-paid]").forEach(btn=>{
      btn.addEventListener("click", (e)=>{
        e.stopPropagation();
        const invoice = state.invoices.find(i=>i.id===btn.dataset.markPaid);
        if(invoice){ invoice.status = "paid"; saveState(); renderView(); showToast("Marked as paid"); }
      });
    });
    document.querySelectorAll("[data-delete-invoice]").forEach(btn=>{
      btn.addEventListener("click", (e)=>{
        e.stopPropagation();
        const invoice = state.invoices.find(i=>i.id===btn.dataset.deleteInvoice);
        if(!invoice) return;
        if(!confirm(`Delete invoice ${invoice.invoiceNumber}? This can't be undone.`)) return;
        state.invoices = state.invoices.filter(i=>i.id!==invoice.id);
        saveState();
        renderView();
        showToast("Invoice deleted");
      });
    });
  }
}

function updateInvoiceLineTotal(idx){
  const li = invoiceDraft.lineItems[idx];
  const cell = document.getElementById(`inv-line-total-${idx}`);
  if(cell) cell.textContent = fmtMoney(li.quantity*li.unitPrice);
  updateInvoiceTotalsCard();
}

function updateInvoiceTotalsCard(){
  const container = document.getElementById("invoiceTotalsCard");
  if(!container) return;
  container.innerHTML = invoiceTotalsCardHTML(invoiceDraft, invoiceTotals(invoiceDraft));
}

function openSendInvoiceModal(){
  const accounts = emailUI.accounts || [];
  const accountsWithSmtp = accounts.filter(a=>a.smtpHost);
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open">
      <div class="modal" style="width:440px;">
        <div class="modal-header">
          <h2>Send Invoice</h2>
          <button class="icon-btn" id="closeSendInvoice">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          ${accountsWithSmtp.length===0 ? `
            <div class="hint">No connected email account has sending set up. Reconnect an account under Settings → Email Sync to enable this.</div>
          ` : `
            <div class="field">
              <label>Send from</label>
              <select id="send-from-account">
                ${accountsWithSmtp.map(a=>`<option value="${a.id}" ${state.invoiceSettings.defaultSendAccountId===a.id?"selected":""}>${escapeHTML(a.email)}</option>`).join("")}
              </select>
            </div>
            <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text-dim);margin-bottom:14px;">
              <input type="checkbox" id="send-set-default" style="width:auto;"> Make this my default sending account
            </label>
            <button class="btn-primary block" id="confirmSendInvoiceBtn">${ICONS.mail} Send</button>
          `}
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeSendInvoice").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  const confirmBtn = document.getElementById("confirmSendInvoiceBtn");
  if(confirmBtn) confirmBtn.addEventListener("click", async ()=>{
    const accountId = document.getElementById("send-from-account").value;
    if(document.getElementById("send-set-default").checked){
      state.invoiceSettings.defaultSendAccountId = accountId;
      saveState();
    }
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sending…";
    const invoice = draftToInvoiceObject(invoiceDraft.editingId);
    const html = buildInvoiceHTML(invoice);
    const res = await window.invoiceAPI.sendEmail({
      accountId, toEmail: invoiceDraft.buyerEmail.trim(),
      subject: `Invoice ${invoice.invoiceNumber} from ${invoice.fromName}`,
      bodyText: `Please find attached invoice ${invoice.invoiceNumber}.${invoice.notes ? "\n\n"+invoice.notes : ""}`,
      invoiceHtml: html, pdfFileName: `${invoice.invoiceNumber}.pdf`
    });
    if(res.ok){
      saveInvoiceDraft();
      showToast("Invoice sent");
      document.getElementById("modalRoot").innerHTML = "";
      invoiceDraft = freshInvoiceDraft();
      invoiceUI.subTab = "list";
      renderView();
    } else {
      showToast(res.error || "Could not send the email", "close");
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Send";
    }
  });
}

let expensesUI = { tagFilter: "All" };


function expensesHTML(){
  return `
    <div class="toolbar-row">
      <select id="expenseTagFilterSelect" style="width:auto;padding:9px 30px 9px 13px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius-sm);color:var(--text);">
        <option ${expensesUI.tagFilter==="All"?"selected":""}>All</option>
        ${EXPENSE_TAGS.map(t=>`<option ${expensesUI.tagFilter===t?"selected":""}>${t}</option>`).join("")}
      </select>
      <button class="btn-primary" id="addExpenseBtn">${ICONS.plus} Add Expense</button>
    </div>
    <div id="expensesResultsContainer">${expensesResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function expensesResultsHTML(){
  const filtered = state.expenses
    .filter(e => expensesUI.tagFilter==="All" || e.tag===expensesUI.tagFilter)
    .slice()
    .sort((a,b)=> new Date(b.date) - new Date(a.date));

  const total = filtered.reduce((s,e)=>s+(e.amount||0),0);

  if(filtered.length===0){
    return `
      <div class="empty-state">
        ${ICONS.empty}
        <div class="t">No expenses yet</div>
        <div class="d">Add one manually, or set up email rules under Email Sync to catch them automatically.</div>
      </div>
    `;
  }
  return `
    <div class="mini-grid" style="grid-template-columns:1fr;margin-top:14px;margin-bottom:0;">
      ${miniCard("cash", `Total (${filtered.length} expense${filtered.length===1?"":"s"})`, fmtMoney(total), "var(--red)","var(--red-bg)")}
    </div>
    <div class="card table-wrap" style="margin-top:14px;">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Tag</th><th>Description</th><th>Source</th><th style="text-align:right;">Amount</th><th></th></tr></thead>
        <tbody>
          ${filtered.map(e=>`
            <tr>
              <td class="mono dim">${formatDate(e.date)}</td>
              <td><span style="font-size:12px;font-weight:600;color:var(--text-dim);">${escapeHTML(e.tag)}</span></td>
              <td>${escapeHTML(e.description||"—")}</td>
              <td class="dim" style="font-size:12px;">${e.source==="email" ? "Auto (email)" : "Manual"}</td>
              <td class="mono" style="text-align:right;font-weight:600;">${fmtMoney(e.amount||0)}</td>
              <td style="text-align:right;"><button class="icon-btn" data-remove-expense="${e.id}">${ICONS.close}</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderExpensesResults(){
  const container = document.getElementById("expensesResultsContainer");
  if(!container) return;
  container.innerHTML = expensesResultsHTML();
  document.querySelectorAll("[data-remove-expense]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.expenses = state.expenses.filter(e=>e.id!==btn.dataset.removeExpense);
      saveState();
      renderExpensesResults();
    });
  });
}

function attachExpensesEvents(){
  document.getElementById("expenseTagFilterSelect").addEventListener("change", e=>{
    expensesUI.tagFilter = e.target.value; renderExpensesResults();
  });
  document.getElementById("addExpenseBtn").addEventListener("click", openAddExpenseModal);
  document.querySelectorAll("[data-remove-expense]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.expenses = state.expenses.filter(e=>e.id!==btn.dataset.removeExpense);
      saveState();
      renderExpensesResults();
    });
  });
}

let addExpenseFormState = null;

function openAddExpenseModal(){
  addExpenseFormState = { amount:"", date: todayISO(), tag: EXPENSE_TAGS[0], customTag:"", description:"" };
  renderAddExpenseModal();
}

function renderAddExpenseModal(){
  const f = addExpenseFormState;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="addExpenseBackdrop">
      <div class="modal" style="width:420px;">
        <div class="modal-header">
          <h2>Add Expense</h2>
          <button class="icon-btn" id="closeAddExpense">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Amount</label>
            <input type="number" id="ae-amount" value="${escapeAttr(f.amount)}" placeholder="0.00" step="0.01" min="0">
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Tag</label>
              <select id="ae-tag">
                ${EXPENSE_TAGS.map(t=>`<option value="${t}" ${f.tag===t?"selected":""}>${t}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Date</label>
              <input type="date" id="ae-date" value="${f.date}">
            </div>
          </div>
          ${f.tag==="Other" ? `
          <div class="field">
            <label>Custom tag</label>
            <input type="text" id="ae-customTag" value="${escapeAttr(f.customTag)}">
          </div>` : ""}
          <div class="field">
            <label>Description (optional)</label>
            <input type="text" id="ae-description" value="${escapeAttr(f.description)}" placeholder="e.g. Monthly proxy subscription">
          </div>
          <div style="height:6px;"></div>
          <button class="btn-primary block" id="saveExpenseBtn">Save Expense</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeAddExpense").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("ae-amount").addEventListener("input", e=>{ f.amount = e.target.value; });
  document.getElementById("ae-tag").addEventListener("change", e=>{ f.tag = e.target.value; renderAddExpenseModal(); });
  document.getElementById("ae-date").addEventListener("change", e=>{ f.date = e.target.value; });
  document.getElementById("ae-description").addEventListener("input", e=>{ f.description = e.target.value; });
  const customTagInput = document.getElementById("ae-customTag");
  if(customTagInput) customTagInput.addEventListener("input", e=>{ f.customTag = e.target.value; });
  document.getElementById("saveExpenseBtn").addEventListener("click", ()=>{
    const amount = parseFloat(f.amount);
    if(isNaN(amount) || amount<=0){ showToast("Enter a valid amount", "close"); return; }
    const tag = f.tag==="Other" && f.customTag.trim() ? f.customTag.trim() : f.tag;
    state.expenses.unshift({
      id: uid(), amount, date: f.date, tag, description: f.description.trim() || null,
      source: "manual", fromEmail: null
    });
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    if(ui.tab==="expenses") renderExpensesResults();
    showToast("Expense added");
  });
}

/* ============================================================
   ITEM DETAIL — full edit + delete
   ============================================================ */

let editState = null;
function ensureEditState(item){
  if(!editState || editState.id !== item.id){
    editState = {
      id: item.id,
      name: item.name,
      category: CATEGORIES.includes(item.category) ? item.category : "Other",
      customCategory: CATEGORIES.includes(item.category) ? "" : item.category,
      quantityPurchased: item.quantityPurchased,
      purchasePricePerUnit: item.purchasePricePerUnit,
      retailer: item.retailer,
      purchaseDate: item.purchaseDate,
      notes: item.notes,
      image: item.image || null
    };
  }
}

function detailHTML(itemId){
  const item = state.items.find(i=>i.id===itemId);
  if(!item) return `<div class="hint">Item not found.</div><button class="btn-ghost" id="backBtn">${ICONS.chev} Back</button>`;
  ensureEditState(item);
  const e = editState;
  const remaining = qtyRemaining(item);
  const minQty = qtySold(item);
  const editedCost = (parseFloat(e.purchasePricePerUnit)||0) * (parseInt(e.quantityPurchased,10)||0);

  return `
    <button class="btn-ghost" id="backBtn">${ICONS.chev} Back</button>
    <div class="detail-hero">
      <div style="display:flex;align-items:center;gap:14px;min-width:0;">
        ${itemThumb(item, 52)}
        <div style="min-width:0;">
          <h2>${escapeHTML(item.name)} ${item.isPreorder ? `<span class="status-chip chip-shipped" style="vertical-align:middle;">Preorder</span>` : ""}</h2>
          <div class="meta">${escapeHTML(item.category)} · ${escapeHTML(item.retailer||"Unknown retailer")}${item.isPreorder && item.expectedArrival ? ` · Expected ${formatDate(item.expectedArrival)}` : ""}</div>
        </div>
      </div>
      ${item.isPreorder ? `<button class="btn-primary" id="markArrivedBtn">${ICONS.check} Mark Arrived</button>` : (remaining>0 ? `<button class="btn-primary" id="sellBtn">${ICONS.check} Mark as Sold</button>` : "")}
    </div>

    <div class="two-col" style="margin-top:18px;">
      <div>
        <div class="section-title" style="margin-top:0;">Status</div>
        <div class="card kv-card">
          ${kvRow("Remaining", remaining)}
          ${kvRow("Sold", qtySold(item))}
          ${qtySold(item)>0 ? kvRow("Profit", fmtMoney(profit(item)), profit(item)>=0?"var(--green)":"var(--red)") : ""}
          ${qtySold(item)>0 ? kvRow("ROI", fmtPct(roi(item)), roi(item)>=0?"var(--green)":"var(--red)") : ""}
          ${avgHoldingDays(item)!==null ? kvRow("Avg. days held", avgHoldingDays(item).toFixed(1)) : ""}
        </div>
      </div>
      <div>
        <div class="section-title" style="margin-top:0;">Total Cost</div>
        <div class="card total-card">
          <div class="total-line">
            <span class="label">Purchase total</span>
            <span class="value" id="editTotalValue">${fmtMoney(editedCost)}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="section-title">Edit Purchase</div>
    <div class="card" style="padding:18px;">
      <div class="field">
        <label>Product Photo</label>
        <div style="display:flex;align-items:center;gap:14px;">
          ${e.image ? `
            <div style="width:64px;height:64px;border-radius:12px;overflow:hidden;flex-shrink:0;border:1px solid var(--border-soft);background:var(--card-2);">
              <img src="${e.image}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="">
            </div>
          ` : `
            <div style="width:64px;height:64px;border-radius:12px;flex-shrink:0;border:1.5px dashed var(--border);display:flex;align-items:center;justify-content:center;color:var(--text-mute);">
              ${ICONS.box}
            </div>
          `}
          <div style="display:flex;gap:8px;">
            <label class="btn-small" style="cursor:pointer;">
              ${ICONS.plus} ${e.image ? "Change" : "Add"} Photo
              <input type="file" id="e-image" accept="image/*" style="display:none;">
            </label>
            ${e.image ? `<button class="btn-small" id="e-image-remove" style="border-color:var(--red);color:var(--red);">${ICONS.close} Remove</button>` : ""}
          </div>
        </div>
      </div>
      <div class="form-grid">
        <div class="field" style="grid-column:1/-1;">
          <label>Item name</label>
          <input type="text" id="e-name" value="${escapeAttr(e.name)}">
        </div>
        <div class="field">
          <label>Category</label>
          <select id="e-category">
            ${CATEGORIES.map(c=>`<option value="${c}" ${e.category===c?"selected":""}>${c}</option>`).join("")}
          </select>
        </div>
        ${e.category==="Other" ? `
        <div class="field">
          <label>Custom category</label>
          <input type="text" id="e-customCategory" value="${escapeAttr(e.customCategory)}">
        </div>` : `<div></div>`}
        <div class="field">
          <label>Quantity purchased ${minQty>0 ? `(min ${minQty} — already sold)` : ""}</label>
          <input type="number" id="e-qty" value="${e.quantityPurchased}" min="${minQty}" step="1">
        </div>
        <div class="field">
          <label>Price per unit (${state.displayCurrency})</label>
          <input type="number" id="e-price" value="${e.purchasePricePerUnit}" step="0.01" min="0">
        </div>
        <div class="field">
          <label>Retailer</label>
          <input type="text" id="e-retailer" value="${escapeAttr(e.retailer)}">
        </div>
        <div class="field">
          <label>Purchase date</label>
          <input type="date" id="e-date" value="${e.purchaseDate}" max="${todayISO()}">
        </div>
        <div class="field" style="grid-column:1/-1;">
          <label>Notes</label>
          <input type="text" id="e-notes" value="${escapeAttr(e.notes)}">
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:6px;">
        <button class="btn-primary" id="saveEditsBtn">Save Changes</button>
        <button class="btn-secondary" id="deleteItemBtn" style="border-color:var(--red);color:var(--red);">${ICONS.trash} Delete Item</button>
      </div>
    </div>

    ${item.sales.length>0 ? `
      <div class="section-title">Sale History</div>
      <div class="card kv-card">
        ${item.sales.slice().sort((a,b)=>new Date(b.saleDate)-new Date(a.saleDate)).map(s=>`
          <div class="sale-row">
            <div>
              <div class="top">${s.quantitySold} sold @ ${fmtMoney(s.salePricePerUnit)}${s.platform ? ` · ${escapeHTML(s.platform)}` : ""}</div>
              <div class="date">${formatDate(s.saleDate)}${s.fees ? ` · fees ${fmtMoney(s.fees)}` : ""}</div>
            </div>
            <div class="r">
              <span>${fmtMoney(saleNet(s))}</span>
              <button class="icon-btn" data-delete-sale="${s.id}" title="Delete sale">${ICONS.trash}</button>
            </div>
          </div>
        `).join("")}
      </div>
    ` : ""}
    <div style="height:24px;"></div>
  `;
}

function kvRow(k,v,color){
  return `<div class="kv-row"><span class="k">${k}</span><span class="v" ${color?`style="color:${color}"`:""}>${v}</span></div>`;
}
function formatDate(iso){
  const d = new Date(iso+"T00:00:00");
  return d.toLocaleDateString(undefined, {month:"short", day:"numeric", year:"numeric"});
}

function updateEditTotalDisplay(){
  if(!editState) return;
  const cost = (parseFloat(editState.purchasePricePerUnit)||0) * (parseInt(editState.quantityPurchased,10)||0);
  const el = document.getElementById("editTotalValue");
  if(el) el.textContent = fmtMoney(cost);
}

function attachDetailEvents(){
  const backBtn = document.getElementById("backBtn");
  if(backBtn) backBtn.addEventListener("click", ()=>{ ui.detailItemId=null; editState=null; render(); });

  const item = state.items.find(i=>i.id===ui.detailItemId);
  if(!item) return;

  const sellBtn = document.getElementById("sellBtn");
  if(sellBtn) sellBtn.addEventListener("click", ()=>openSellSheet(ui.detailItemId));

  const markArrivedBtn = document.getElementById("markArrivedBtn");
  if(markArrivedBtn) markArrivedBtn.addEventListener("click", ()=>{
    item.isPreorder = false;
    saveState();
    showToast(`${item.name} moved to Stock`);
    render();
  });

  const byId = id => document.getElementById(id);
  byId("e-name").addEventListener("input", e=>{ editState.name = e.target.value; });
  byId("e-category").addEventListener("change", e=>{ editState.category = e.target.value; renderView(); });
  if(byId("e-customCategory")) byId("e-customCategory").addEventListener("input", e=>{ editState.customCategory = e.target.value; });
  byId("e-qty").addEventListener("input", e=>{ editState.quantityPurchased = e.target.value; updateEditTotalDisplay(); });
  byId("e-price").addEventListener("input", e=>{ editState.purchasePricePerUnit = e.target.value; updateEditTotalDisplay(); });
  byId("e-retailer").addEventListener("input", e=>{ editState.retailer = e.target.value; });
  byId("e-date").addEventListener("change", e=>{ editState.purchaseDate = e.target.value; });
  byId("e-notes").addEventListener("input", e=>{ editState.notes = e.target.value; });

  byId("e-image").addEventListener("change", e=>{
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    processImageFile(file, dataUrl=>{ editState.image = dataUrl; renderView(); });
  });
  const eImageRemove = byId("e-image-remove");
  if(eImageRemove) eImageRemove.addEventListener("click", ()=>{ editState.image = null; renderView(); });

  byId("saveEditsBtn").addEventListener("click", ()=>{
    const minQty = qtySold(item);
    const qty = parseInt(editState.quantityPurchased, 10);
    const price = parseFloat(editState.purchasePricePerUnit);
    if(!editState.name.trim()){ showToast("Item needs a name", "close"); return; }
    if(isNaN(qty) || qty < minQty){ showToast(`Quantity can't be less than ${minQty} already sold`, "close"); return; }
    if(isNaN(price) || price < 0){ showToast("Enter a valid price", "close"); return; }

    item.name = editState.name.trim();
    item.category = editState.category==="Other" && editState.customCategory.trim() ? editState.customCategory.trim() : editState.category;
    item.quantityPurchased = qty;
    item.purchasePricePerUnit = price;
    item.retailer = editState.retailer.trim();
    item.purchaseDate = editState.purchaseDate;
    item.notes = editState.notes;
    item.image = editState.image || null;
    saveState();
    showToast("Item updated");
    render();
  });

  const deleteBtn = byId("deleteItemBtn");
  if(deleteBtn) deleteBtn.addEventListener("click", ()=>{
    if(!confirm(`Delete "${item.name}"? This removes it and its sale history. This can't be undone.`)) return;
    state.items = state.items.filter(i=>i.id!==item.id);
    // If this item came from email sync, free up the pending order so it's not pointing at nothing.
    state.pendingOrders.forEach(p=>{ if(p.addedToStockId===item.id) p.addedToStockId = null; });
    saveState();
    editState = null;
    ui.detailItemId = null;
    showToast("Item deleted");
    render();
  });

  document.querySelectorAll("[data-delete-sale]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      if(!confirm("Delete this sale record? The quantity goes back into stock.")) return;
      item.sales = item.sales.filter(s=>s.id!==btn.dataset.deleteSale);
      saveState();
      render();
    });
  });
}

/* ---- Mark as sold modal ---- */

let sellFormState = null;

function openSellSheet(itemId, prefill){
  const item = state.items.find(i=>i.id===itemId);
  const remaining = item ? qtyRemaining(item) : 1;
  const prefillQty = prefill && prefill.quantity ? Math.min(Math.max(1, prefill.quantity), Math.max(remaining,1)) : 1;
  sellFormState = {
    itemId, quantity: prefillQty,
    price: prefill && prefill.price!=null ? String(prefill.price) : "",
    fees: "",
    platform: (prefill && prefill.platform) || "eBay",
    date: (prefill && prefill.date) || todayISO(),
    prefillNote: prefill ? true : false,
    pendingSaleId: (prefill && prefill.pendingSaleId) || null
  };
  renderSellSheet();
}

function renderSellSheet(){
  const root = document.getElementById("modalRoot");
  const item = state.items.find(i=>i.id===sellFormState.itemId);
  const f = sellFormState;
  const remaining = qtyRemaining(item);
  const revenue = (parseFloat(f.price)||0) * f.quantity;
  const fees = parseFloat(f.fees)||0;
  const net = revenue - fees;
  const cost = f.quantity * item.purchasePricePerUnit;
  const p = net - cost;

  root.innerHTML = `
    <div class="modal-backdrop open" id="sellBackdrop">
      <div class="modal">
        <div class="modal-header">
          <h2>Mark as Sold</h2>
          <button class="icon-btn" id="closeSell">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          ${f.prefillNote ? `<div class="hint" style="color:var(--gold);margin-bottom:14px;">Prefilled from a detected sale email — double check the amount, quantity, and fees before confirming.</div>` : ""}
          <div class="field">
            <label>Quantity sold (${remaining} available)</label>
            <div class="stepper">
              <button id="sellQtyMinus">−</button>
              <input type="number" class="qty-input" id="sellQtyInput" value="${f.quantity}" min="1" max="${remaining}" step="1">
              <button id="sellQtyPlus">+</button>
              <button class="max-btn" id="sellQtyMax">Max</button>
            </div>
          </div>
          <div class="field">
            <label>Platform</label>
            <select id="s-platform">
              ${PLATFORMS.map(p=>`<option ${f.platform===p?"selected":""}>${p}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label>Sale price per unit (${state.displayCurrency}) — gross, before fees</label>
            <input type="number" inputmode="decimal" step="0.01" min="0" id="s-price" value="${f.price}" placeholder="0.00">
          </div>
          <div class="field">
            <label>Fees &amp; shipping deducted (optional, total for this sale)</label>
            <input type="number" inputmode="decimal" step="0.01" min="0" id="s-fees" value="${f.fees}" placeholder="0.00">
          </div>
          <div class="field">
            <label>Sale date</label>
            <input type="date" id="s-date" value="${f.date}" min="${item.purchaseDate}" max="${todayISO()}">
          </div>

          <div class="card total-card">
            <div class="total-line">
              <span class="label">Gross revenue</span>
              <span class="value" id="sellGrossValue">${fmtMoney(revenue)}</span>
            </div>
            <div class="total-line sub">
              <span class="label">Net (after fees)</span>
              <span class="value" id="sellNetValue">${fmtMoney(net)}</span>
            </div>
            <div class="total-line sub">
              <span class="label">Profit</span>
              <span class="value" id="sellProfitValue" style="color:${p>=0?'var(--green)':'var(--red)'}">${fmtMoney(p)}</span>
            </div>
          </div>

          <div style="height:16px;"></div>
          <button class="btn-primary block" id="confirmSellBtn" ${f.quantity<1||f.quantity>remaining?"disabled":""}>Confirm Sale</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("closeSell").addEventListener("click", closeSellSheet);
  document.getElementById("sellQtyMinus").addEventListener("click", ()=>{ f.quantity = Math.max(1,f.quantity-1); renderSellSheet(); });
  document.getElementById("sellQtyPlus").addEventListener("click", ()=>{ f.quantity = Math.min(remaining, f.quantity+1); renderSellSheet(); });
  document.getElementById("sellQtyMax").addEventListener("click", ()=>{ f.quantity = remaining; renderSellSheet(); });
  const sellQtyInput = document.getElementById("sellQtyInput");
  sellQtyInput.addEventListener("input", e=>{
    // Don't rewrite the input's own value while the person is mid-keystroke —
    // that resets the cursor and causes the exact "backwards typing" bug
    // fixed earlier. Just track the raw number and update totals live;
    // out-of-range values get corrected on blur instead, once they're done typing.
    const n = parseInt(e.target.value, 10);
    f.quantity = isNaN(n) ? 0 : n;
    updateSellTotals();
    const confirmBtn = document.getElementById("confirmSellBtn");
    if(confirmBtn) confirmBtn.disabled = !(f.quantity>=1 && f.quantity<=remaining);
  });
  sellQtyInput.addEventListener("blur", ()=>{
    const corrected = Math.min(remaining, Math.max(1, f.quantity||1));
    if(corrected !== f.quantity){
      f.quantity = corrected;
      renderSellSheet();
    }
  });
  document.getElementById("s-platform").addEventListener("change", e=>{ f.platform = e.target.value; });
  document.getElementById("s-price").addEventListener("input", e=>{ f.price = e.target.value; updateSellTotals(); });
  document.getElementById("s-fees").addEventListener("input", e=>{ f.fees = e.target.value; updateSellTotals(); });
  document.getElementById("s-date").addEventListener("change", e=>{ f.date = e.target.value; });
  document.getElementById("confirmSellBtn").addEventListener("click", confirmSale);
}

function closeSellSheet(){
  document.getElementById("modalRoot").innerHTML = "";
  sellFormState = null;
}

function updateSellTotals(){
  const item = state.items.find(i=>i.id===sellFormState.itemId);
  const f = sellFormState;
  const revenue = (parseFloat(f.price)||0) * f.quantity;
  const fees = parseFloat(f.fees)||0;
  const net = revenue - fees;
  const cost = f.quantity * item.purchasePricePerUnit;
  const p = net - cost;
  const grossEl = document.getElementById("sellGrossValue");
  if(grossEl) grossEl.textContent = fmtMoney(revenue);
  const netEl = document.getElementById("sellNetValue");
  if(netEl) netEl.textContent = fmtMoney(net);
  const profitEl = document.getElementById("sellProfitValue");
  if(profitEl){
    profitEl.textContent = fmtMoney(p);
    profitEl.style.color = p>=0 ? "var(--green)" : "var(--red)";
  }
}

function confirmSale(){
  const item = state.items.find(i=>i.id===sellFormState.itemId);
  const f = sellFormState;
  item.sales.push({
    id: uid(),
    quantitySold: f.quantity,
    salePricePerUnit: parseFloat(f.price)||0,
    fees: parseFloat(f.fees)||0,
    platform: f.platform,
    saleDate: f.date
  });
  // Only clears the detected sale now that it's actually been recorded —
  // this used to happen the moment a candidate item was picked, before
  // the sale was ever confirmed, which meant cancelling the sell sheet
  // afterward silently lost track of a real sale with nothing recorded
  // for it anywhere.
  if(f.pendingSaleId){
    state.pendingSales = state.pendingSales.filter(p=>p.id!==f.pendingSaleId);
  }
  saveState();
  closeSellSheet();
  showToast("Sale recorded");
  render();
}

/* ============================================================
   EMAIL SYNC
   ============================================================ */

let emailUI = {
  accounts: undefined, // undefined = not yet loaded, [] = none connected
  showAddForm: false,
  provider: "gmail",
  formEmail: "",
  formPassword: "",
  formHost: PROVIDER_PRESETS.gmail.host,
  formPort: PROVIDER_PRESETS.gmail.port,
  formSecure: true,
  formCatchAllList: [],
  formCatchAllInput: "",
  connecting: false,
  error: null,
  syncing: false,
  editingCatchAllAccountId: null,
  editCatchAllList: [],
  editCatchAllInput: ""
};

async function refreshAccountInfo(){
  try{
    emailUI.accounts = await window.emailAPI.getAccounts();
  }catch(e){
    emailUI.accounts = [];
  }
  if(ui.tab==="email") renderView();
  startAutoSync();
}

function emailSyncHTML(){
  if(emailUI.accounts === undefined){
    return `<div class="hint">Loading account info…</div>`;
  }
  if(emailUI.accounts.length === 0 || emailUI.showAddForm){
    return `
      ${emailUI.accounts.length > 0 ? `<button class="btn-ghost" id="cancelAddAccountBtn" style="margin-bottom:14px;">${ICONS.chev} Back to connected accounts</button>` : ""}
      ${emailConnectFormHTML()}
    `;
  }
  return emailConnectedHTML();
}

function emailConnectFormHTML(){
  const f = emailUI;
  return `
    <div class="card panel" style="max-width:560px;">
      <div class="panel-title">Connect Your Email</div>
      <div class="hint" style="margin-bottom:16px;">
        Restock scans your inbox for order confirmation, shipping, and delivery emails to
        auto-track purchases. Your credentials are encrypted and stored only on this device —
        they're never sent anywhere except directly to your email provider.
      </div>

      <div class="provider-grid">
        ${Object.entries(PROVIDER_PRESETS).map(([key,p])=>`
          <button class="provider-btn ${f.provider===key?'active':''}" data-provider="${key}">${p.label}</button>
        `).join("")}
      </div>

      <div class="field">
        <label>Email address</label>
        <input type="text" id="e-email" value="${escapeAttr(f.formEmail)}" placeholder="you@example.com">
      </div>
      <div class="field">
        <label style="display:flex;align-items:center;gap:6px;">App Password <span style="width:13px;height:13px;display:inline-flex;color:var(--text-mute);">${ICONS.lock}</span></label>
        <input type="password" id="e-password" value="${escapeAttr(f.formPassword)}" placeholder="Not your regular password">
        <div class="hint">Most providers (Gmail, Outlook, Yahoo) block regular passwords over IMAP and require a separate "app password" — generate one in your email account's security settings, then paste it here.</div>
      </div>
      ${f.provider==="custom" ? `
      <div class="form-grid">
        <div class="field">
          <label>IMAP host</label>
          <input type="text" id="e-host" value="${escapeAttr(f.formHost)}" placeholder="imap.example.com">
        </div>
        <div class="field">
          <label>Port</label>
          <input type="number" id="e-port" value="${f.formPort}">
        </div>
      </div>` : ""}

      <div class="field">
        <label>Catch-all domains (optional, you can add more than one)</label>
        <div class="chip-list" id="formCatchAllChips">
          ${f.formCatchAllList.length===0 ? `<span class="hint" style="margin:0;">None added yet.</span>` : f.formCatchAllList.map(d=>`
            <span class="excl-chip">${escapeHTML(d)}<button data-remove-form-catchall="${escapeAttr(d)}">${ICONS.close}</button></span>
          `).join("")}
        </div>
        <div class="add-exclusion-row">
          <input type="text" id="e-catchall" value="${escapeAttr(f.formCatchAllInput)}" placeholder="@yourdomain.com">
          <button class="btn-small" id="addFormCatchAllBtn">${ICONS.plus} Add</button>
        </div>
        <div class="hint">If you use a custom domain where every address routes to one inbox (e.g. anything@yourdomain.com), add it here — any order email addressed to that domain gets picked up, regardless of which specific address was used at checkout. Add as many domains as you use.</div>
      </div>

      ${f.error ? `<div class="hint" style="color:var(--red);">${escapeHTML(f.error)}</div>` : ""}

      <div style="height:6px;"></div>
      <button class="btn-primary block" id="connectBtn" ${f.connecting?"disabled":""}>${f.connecting ? "Connecting…" : "Connect"}</button>
    </div>
  `;
}

function accountBannerHTML(acc){
  const isEditingThis = emailUI.editingCatchAllAccountId === acc.id;
  return `
    <div class="card" style="margin-bottom:10px;padding:14px 16px;">
      <div class="account-banner" style="border:none;padding:0;">
        <div class="who">
          <div class="account-avatar">${ICONS.mail}</div>
          <div>
            <div style="font-weight:700;font-size:14px;">${escapeHTML(acc.email)}</div>
            <div class="hint" style="margin:0;">${escapeHTML(acc.host)} · ${acc.lastSyncISO ? "Last synced " + new Date(acc.lastSyncISO).toLocaleTimeString() : "Never synced"}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn-small" data-reset-tracking="${acc.id}" title="Does a full re-scan of the last 48 hours, not just recent mail — useful after a detection fix, so an older email that was previously missed gets a genuine fresh look.">Full Re-scan</button>
          <button class="btn-small" data-remove-account="${acc.id}" style="border-color:var(--red);color:var(--red);">Remove</button>
        </div>
      </div>

      <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border-soft);">
        <div class="hint" style="font-weight:700;color:var(--text);margin-bottom:8px;">Catch-All Domains</div>
        ${isEditingThis ? `
          <div class="chip-list" id="editCatchAllChips" style="margin-bottom:10px;">
            ${emailUI.editCatchAllList.length===0 ? `<span class="hint" style="margin:0;">None added yet.</span>` : emailUI.editCatchAllList.map(d=>`
              <span class="excl-chip">${escapeHTML(d)}<button data-remove-edit-catchall="${escapeAttr(d)}">${ICONS.close}</button></span>
            `).join("")}
          </div>
          <div class="add-exclusion-row" style="margin-bottom:10px;">
            <input type="text" id="catchAllInput" value="${escapeAttr(emailUI.editCatchAllInput)}" placeholder="@yourdomain.com">
            <button class="btn-small" id="addEditCatchAllBtn">${ICONS.plus} Add</button>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn-small" data-save-catchall="${acc.id}">Save</button>
            <button class="btn-small" id="cancelCatchAllBtn">Cancel</button>
          </div>
        ` : `
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
            <div class="hint" style="margin:0;">${(acc.catchAllDomains && acc.catchAllDomains.length) ? `Routing: ${acc.catchAllDomains.map(d=>`<strong style="color:var(--text);">${escapeHTML(d)}</strong>`).join(", ")}` : "No catch-all domains set — using keyword detection on this inbox only."}</div>
            <button class="btn-small" data-edit-catchall="${acc.id}" style="flex-shrink:0;">${(acc.catchAllDomains && acc.catchAllDomains.length) ? "Edit" : "Add"}</button>
          </div>
        `}
      </div>
    </div>
  `;
}

function emailConnectedHTML(){
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <div class="hint" style="margin:0;">${emailUI.accounts.length} email account${emailUI.accounts.length===1?"":"s"} connected · auto-syncs every 60s</div>
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" id="syncNowBtn" ${emailUI.syncing?"disabled":""}>${ICONS.refresh} ${emailUI.syncing ? "Syncing…" : "Sync Now"}</button>
        <button class="btn-small" id="showAddAccountBtn">${ICONS.plus} Add Another Account</button>
      </div>
    </div>

    ${emailUI.accounts.map(acc => accountBannerHTML(acc)).join("")}

    <div class="hint" style="margin:6px 0 20px;display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--border-soft);border-radius:var(--radius-md);padding:14px 16px;">
      <span>Detected sales${state.pendingSales.length ? ` (${state.pendingSales.length} waiting)` : ""} now live on the <strong style="color:var(--text);">Sold</strong> tab, under its own "Detected Sales" sub-tab.</span>
      <button class="btn-small" id="goToSoldFromSettings">Go to Sold ${ICONS.chev}</button>
    </div>

    <div class="card panel" style="margin-bottom:20px;">
      <div class="panel-title" style="margin-bottom:6px;">Expense Email Rules</div>
      <div class="hint" style="margin-bottom:12px;">Emails from these senders are tracked as expenses (proxies, bots, shipping supplies, etc.) — never as orders. Add the sender's email or domain and pick which tag it should get.</div>
      <div id="expenseRulesList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">
        ${(state.expenseRules||[]).length===0 ? `<span class="hint" style="margin:0;">No expense rules yet.</span>` : state.expenseRules.map(r=>`
          <div style="display:flex;align-items:center;gap:10px;background:var(--card-2);border-radius:var(--radius-sm);padding:8px 12px;">
            <span class="mono" style="font-size:12.5px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(r.senderPattern)}</span>
            <span style="font-size:12px;font-weight:600;color:var(--text-dim);flex-shrink:0;">${escapeHTML(r.tag)}</span>
            <button class="icon-btn" data-remove-expense-rule="${r.id}" style="flex-shrink:0;">${ICONS.close}</button>
          </div>
        `).join("")}
      </div>
      <div style="display:flex;gap:8px;">
        <input type="text" id="expenseRuleSender" placeholder="proxyprovider.com or billing@proxyprovider.com" style="flex:1;">
        <select id="expenseRuleTag" style="width:auto;">
          ${EXPENSE_TAGS.map(t=>`<option>${t}</option>`).join("")}
        </select>
        <button class="btn-small" id="addExpenseRuleBtn">${ICONS.plus} Add</button>
      </div>
    </div>

    <div class="card panel" style="margin-bottom:20px;">
      <div class="panel-title" style="margin-bottom:0;">Filters</div>
      <div class="filter-toggle">
        <div>
          <div class="desc">Skip promotional &amp; newsletter emails</div>
          <div class="sub">Filters out marketing emails (sales, deals, "unsubscribe" links) that can look like orders</div>
        </div>
        <label class="switch">
          <input type="checkbox" id="blockPromoToggle" ${state.emailFilters.blockPromotions ? "checked" : ""}>
          <span class="track"></span>
        </label>
      </div>
      <div class="hint" style="margin:0 0 6px;">Blocked senders — emails from these addresses or domains are skipped entirely:</div>
      <div class="chip-list" id="exclusionChips">
        ${state.emailFilters.excludedSenders.length===0 ? `<span class="hint" style="margin:0;">None yet.</span>` : state.emailFilters.excludedSenders.map(s=>`
          <span class="excl-chip">${escapeHTML(s)}<button data-unblock="${escapeAttr(s)}">${ICONS.close}</button></span>
        `).join("")}
      </div>
      <div class="add-exclusion-row">
        <input type="text" id="newExclusionInput" placeholder="e.g. costco.com or promos@retailer.com">
        <button class="btn-small" id="addExclusionBtn">${ICONS.plus} Block</button>
      </div>
    </div>

    <div class="hint" style="margin:6px 0 20px;display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--border-soft);border-radius:var(--radius-md);padding:14px 16px;">
      <span>Detected orders live in the <strong style="color:var(--text);">Confirmed Orders</strong> tab (Pokémon Center preorders under its "PKC Preorders" sub-tab), tracked from placed through delivery.</span>
      <button class="btn-small" id="goToOrdersFromSettings">Go to Orders ${ICONS.chev}</button>
    </div>
    <div style="height:20px;"></div>
  `;
}

function statusChip(status){
  const map = {
    confirmed: ["chip-confirmed","Order Placed"],
    shipped: ["chip-shipped","Shipped"],
    out_for_delivery: ["chip-outfordelivery","Out for Delivery"],
    ready_for_collection: ["chip-outfordelivery","Ready for Collection"],
    delivered: ["chip-delivered","Delivered"],
    action_required: ["chip-action-required","Requires Attention"],
    cancelled: ["chip-cancelled","Cancelled"]
  };
  const [cls, label] = map[status] || ["chip-confirmed", status];
  return `<span class="status-chip ${cls}">${label}</span>`;
}

function attachEmailEvents(){
  const goToOrdersBtn = document.getElementById("goToOrdersFromSettings");
  if(goToOrdersBtn) goToOrdersBtn.addEventListener("click", ()=>{
    const modalRoot = document.getElementById("modalRoot");
    if(modalRoot) modalRoot.innerHTML = "";
    ordersUI.subTab = "all";
    setTab("orders");
  });
  const goToSoldBtn = document.getElementById("goToSoldFromSettings");
  if(goToSoldBtn) goToSoldBtn.addEventListener("click", ()=>{
    const modalRoot = document.getElementById("modalRoot");
    if(modalRoot) modalRoot.innerHTML = "";
    soldUI.subTab = "detected";
    setTab("sold");
  });

  if(emailUI.accounts.length === 0 || emailUI.showAddForm){
    const cancelAddBtn = document.getElementById("cancelAddAccountBtn");
    if(cancelAddBtn) cancelAddBtn.addEventListener("click", ()=>{ emailUI.showAddForm = false; emailUI.error = null; refreshSettingsIfOpen(); });

    document.querySelectorAll("[data-provider]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const key = btn.dataset.provider;
        emailUI.provider = key;
        const preset = PROVIDER_PRESETS[key];
        emailUI.formHost = preset.host;
        emailUI.formPort = preset.port;
        emailUI.formSecure = preset.secure;
        refreshSettingsIfOpen();
      });
    });
    const emailInput = document.getElementById("e-email");
    if(emailInput) emailInput.addEventListener("input", e=>{ emailUI.formEmail = e.target.value; });
    const pwInput = document.getElementById("e-password");
    if(pwInput) pwInput.addEventListener("input", e=>{ emailUI.formPassword = e.target.value; });
    const hostInput = document.getElementById("e-host");
    if(hostInput) hostInput.addEventListener("input", e=>{ emailUI.formHost = e.target.value; });
    const portInput = document.getElementById("e-port");
    if(portInput) portInput.addEventListener("input", e=>{ emailUI.formPort = parseInt(e.target.value,10)||993; });
    const catchAllInput = document.getElementById("e-catchall");
    if(catchAllInput) catchAllInput.addEventListener("input", e=>{ emailUI.formCatchAllInput = e.target.value; });
    const addFormCatchAllBtn = document.getElementById("addFormCatchAllBtn");
    if(addFormCatchAllBtn) addFormCatchAllBtn.addEventListener("click", ()=>{
      const val = normalizeCatchAllDomain(emailUI.formCatchAllInput);
      if(val && !emailUI.formCatchAllList.includes(val)) emailUI.formCatchAllList.push(val);
      emailUI.formCatchAllInput = "";
      refreshSettingsIfOpen();
    });
    document.querySelectorAll("[data-remove-form-catchall]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        emailUI.formCatchAllList = emailUI.formCatchAllList.filter(d=>d!==btn.dataset.removeFormCatchall);
        refreshSettingsIfOpen();
      });
    });

    const connectBtn = document.getElementById("connectBtn");
    if(connectBtn) connectBtn.addEventListener("click", connectEmailAccount);
  } else {
    const syncBtn = document.getElementById("syncNowBtn");
    if(syncBtn) syncBtn.addEventListener("click", ()=>syncNow(false));
    const showAddAccountBtn = document.getElementById("showAddAccountBtn");
    if(showAddAccountBtn) showAddAccountBtn.addEventListener("click", ()=>{
      emailUI.showAddForm = true;
      emailUI.formEmail = ""; emailUI.formPassword = ""; emailUI.formCatchAllList = []; emailUI.error = null;
      refreshSettingsIfOpen();
    });
    document.querySelectorAll("[data-reset-tracking]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const id = btn.dataset.resetTracking;
        btn.disabled = true;
        btn.textContent = "Resetting…";
        await window.emailAPI.resetTracking(id);
        showToast("Running a full re-scan of the last 48 hours");
        await syncNow(false);
      });
    });
    document.querySelectorAll("[data-remove-account]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        if(!confirm("Remove this email account? Restock will stop syncing it — this doesn't affect any orders or sales already recorded.")) return;
        await window.emailAPI.removeAccount(btn.dataset.removeAccount);
        showToast("Account removed");
        await refreshAccountInfo();
        refreshSettingsIfOpen();
      });
    });
    document.querySelectorAll("[data-view]").forEach(btn=>{
      btn.addEventListener("click", ()=>{ ui.detailItemId = btn.dataset.view; render(); });
    });
    document.querySelectorAll("[data-remove]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        state.pendingOrders = state.pendingOrders.filter(p=>p.id!==btn.dataset.remove);
        saveState();
        refreshSettingsIfOpen();
      });
    });
    document.querySelectorAll("[data-edit-catchall]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const id = btn.dataset.editCatchall;
        const acc = emailUI.accounts.find(a=>a.id===id);
        emailUI.editingCatchAllAccountId = id;
        emailUI.editCatchAllList = (acc && acc.catchAllDomains || []).slice();
        emailUI.editCatchAllInput = "";
        refreshSettingsIfOpen();
      });
    });
    const cancelCatchAllBtn = document.getElementById("cancelCatchAllBtn");
    if(cancelCatchAllBtn) cancelCatchAllBtn.addEventListener("click", ()=>{ emailUI.editingCatchAllAccountId = null; refreshSettingsIfOpen(); });
    const catchAllEditInput = document.getElementById("catchAllInput");
    if(catchAllEditInput) catchAllEditInput.addEventListener("input", e=>{ emailUI.editCatchAllInput = e.target.value; });
    const addEditCatchAllBtn = document.getElementById("addEditCatchAllBtn");
    if(addEditCatchAllBtn) addEditCatchAllBtn.addEventListener("click", ()=>{
      const val = normalizeCatchAllDomain(emailUI.editCatchAllInput);
      if(val && !emailUI.editCatchAllList.includes(val)) emailUI.editCatchAllList.push(val);
      emailUI.editCatchAllInput = "";
      refreshSettingsIfOpen();
    });
    document.querySelectorAll("[data-remove-edit-catchall]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        emailUI.editCatchAllList = emailUI.editCatchAllList.filter(d=>d!==btn.dataset.removeEditCatchall);
        refreshSettingsIfOpen();
      });
    });
    document.querySelectorAll("[data-save-catchall]").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const id = btn.dataset.saveCatchall;
        const list = emailUI.editCatchAllList;
        await window.emailAPI.updateAccountCatchAll(id, list);
        emailUI.editingCatchAllAccountId = null;
        showToast(list.length ? `${list.length} catch-all domain${list.length===1?"":"s"} saved` : "Catch-all domains cleared");
        await refreshAccountInfo();
        refreshSettingsIfOpen();
      });
    });

    const addExpenseRuleBtn = document.getElementById("addExpenseRuleBtn");
    if(addExpenseRuleBtn) addExpenseRuleBtn.addEventListener("click", ()=>{
      const senderInput = document.getElementById("expenseRuleSender");
      const tagSelect = document.getElementById("expenseRuleTag");
      const senderPattern = senderInput.value.trim().toLowerCase();
      if(!senderPattern){ showToast("Enter a sender email or domain first", "close"); return; }
      state.expenseRules = state.expenseRules || [];
      state.expenseRules.push({ id: uid(), senderPattern, tag: tagSelect.value });
      saveState();
      refreshSettingsIfOpen();
    });
    document.querySelectorAll("[data-remove-expense-rule]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        state.expenseRules = state.expenseRules.filter(r=>r.id!==btn.dataset.removeExpenseRule);
        saveState();
        refreshSettingsIfOpen();
      });
    });

    const blockPromoToggle = document.getElementById("blockPromoToggle");
    if(blockPromoToggle) blockPromoToggle.addEventListener("change", e=>{
      state.emailFilters.blockPromotions = e.target.checked;
      saveState();
    });
    const addExclusionBtn = document.getElementById("addExclusionBtn");
    if(addExclusionBtn) addExclusionBtn.addEventListener("click", ()=>{
      const input = document.getElementById("newExclusionInput");
      addExclusion(input.value);
    });
    const newExclusionInput = document.getElementById("newExclusionInput");
    if(newExclusionInput) newExclusionInput.addEventListener("keydown", e=>{
      if(e.key==="Enter"){ addExclusion(e.target.value); }
    });
    document.querySelectorAll("[data-unblock]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        state.emailFilters.excludedSenders = state.emailFilters.excludedSenders.filter(s=>s!==btn.dataset.unblock);
        saveState();
        refreshSettingsIfOpen();
      });
    });
    document.querySelectorAll("[data-block]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const email = btn.dataset.block;
        const domain = email.split("@")[1] || email;
        addExclusion(domain, true);
      });
    });
  }
}

function openMatchSaleModal(pendingSaleId){
  const sale = state.pendingSales.find(p=>p.id===pendingSaleId);
  if(!sale) return;
  let candidates = state.items.filter(i=>!i.isPreorder && qtyRemaining(i)>0);
  // Sort the likely match (by product name hint from the email) to the
  // top, so the person isn't hunting through a long list for it.
  if(sale.productNameHint){
    candidates = candidates.slice().sort((a,b)=>{
      const aLikely = namesLikelyMatch(a.name, sale.productNameHint) ? 0 : 1;
      const bLikely = namesLikelyMatch(b.name, sale.productNameHint) ? 0 : 1;
      return aLikely - bLikely;
    });
  }
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="matchBackdrop">
      <div class="modal">
        <div class="modal-header">
          <h2>Which item sold?</h2>
          <button class="icon-btn" id="closeMatch">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:14px;">${escapeHTML(sale.platform||"Unknown")} · ${formatDate(sale.saleDate)} · ${sale.netAmount!=null?fmtMoney(sale.netAmount):"amount unknown"}${sale.productNameHint ? ` · likely "${escapeHTML(sale.productNameHint)}"` : ""}</div>
          ${candidates.length===0 ? `
            <div class="pending-empty">No in-stock items to match against.</div>
          ` : `
            <div class="card table-wrap">
              <table class="data-table">
                <thead><tr><th>Item</th><th>Left</th><th></th></tr></thead>
                <tbody>
                  ${candidates.map(i=>{
                    const likely = sale.productNameHint && namesLikelyMatch(i.name, sale.productNameHint);
                    return `
                    <tr ${likely ? `style="background:var(--violet-bg);"` : ""}>
                      <td style="font-weight:600;">${escapeHTML(i.name)} ${likely ? `<span class="status-chip chip-confirmed" style="vertical-align:middle;">Likely match</span>` : ""}</td>
                      <td class="mono dim">${qtyRemaining(i)}</td>
                      <td style="text-align:right;"><button class="btn-small" data-pick="${i.id}">Select</button></td>
                    </tr>
                  `;}).join("")}
                </tbody>
              </table>
            </div>
          `}
          <button class="btn-secondary block" id="createItemFromSaleBtn" style="margin-top:14px;">${ICONS.plus} None of these — create a new item</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeMatch").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML = ""; });
  document.getElementById("createItemFromSaleBtn").addEventListener("click", ()=>{ openCreateItemFromSaleModal(sale); });
  document.querySelectorAll("[data-pick]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const itemId = btn.dataset.pick;
      document.getElementById("modalRoot").innerHTML = "";
      ui.detailItemId = itemId;
      render();
      // eBay's "Sold: £X" figure is the TOTAL for the whole sale, not a
      // per-unit price — the sell sheet's price field expects per-unit,
      // so this needs dividing by quantity first. Left as the raw total
      // when quantity is missing/zero, since there's nothing to safely
      // divide by in that case.
      const qty = sale.quantitySold || 1;
      const perUnitPrice = (sale.netAmount!=null && qty>0) ? sale.netAmount/qty : sale.netAmount;
      openSellSheet(itemId, { platform: sale.platform, price: perUnitPrice, date: sale.saleDate, quantity: sale.quantitySold || null, pendingSaleId: sale.id });
    });
  });
}

let createFromSaleState = null;

function openCreateItemFromSaleModal(sale){
  const qty = sale.quantitySold || 1;
  const perUnitPrice = (sale.netAmount!=null && qty>0) ? sale.netAmount/qty : (sale.netAmount || 0);
  createFromSaleState = {
    pendingSaleId: sale.id,
    name: sale.productNameHint || "",
    category: CATEGORIES[0],
    cost: "",
    quantity: qty,
    salePrice: String(perUnitPrice.toFixed(2)),
    fees: "",
    platform: sale.platform || "eBay",
    date: sale.saleDate || todayISO()
  };
  renderCreateItemFromSaleModal();
}

function renderCreateItemFromSaleModal(){
  const f = createFromSaleState;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="createFromSaleBackdrop">
      <div class="modal" style="width:460px;">
        <div class="modal-header">
          <h2>Create Item &amp; Record Sale</h2>
          <button class="icon-btn" id="closeCreateFromSale">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:14px;">This creates the item and marks it sold in one step, since it's already gone — enter what you originally paid for it below.</div>
          <div class="field">
            <label>Item name</label>
            <input type="text" id="cfs-name" value="${escapeAttr(f.name)}" placeholder="e.g. Charizard VMAX Booster Box">
          </div>
          <div class="form-grid">
            <div class="field">
              <label>Category</label>
              <select id="cfs-category">
                ${CATEGORIES.map(c=>`<option ${f.category===c?"selected":""}>${c}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Quantity sold</label>
              <input type="number" id="cfs-quantity" value="${f.quantity}" min="1" step="1">
            </div>
            <div class="field">
              <label>What you paid (per unit)</label>
              <input type="number" id="cfs-cost" value="${escapeAttr(f.cost)}" placeholder="0.00" step="0.01" min="0">
            </div>
            <div class="field">
              <label>Sale price (per unit)</label>
              <input type="number" id="cfs-saleprice" value="${escapeAttr(f.salePrice)}" step="0.01" min="0">
            </div>
            <div class="field">
              <label>Fees (total)</label>
              <input type="number" id="cfs-fees" value="${escapeAttr(f.fees)}" placeholder="0.00" step="0.01" min="0">
            </div>
            <div class="field">
              <label>Platform</label>
              <select id="cfs-platform">
                ${PLATFORMS.map(p=>`<option ${f.platform===p?"selected":""}>${p}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="field">
            <label>Sale date</label>
            <input type="date" id="cfs-date" value="${f.date}">
          </div>
          <div style="height:6px;"></div>
          <button class="btn-primary block" id="saveCreateFromSaleBtn">Create Item &amp; Record Sale</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeCreateFromSale").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  document.getElementById("cfs-name").addEventListener("input", e=>{ f.name = e.target.value; });
  document.getElementById("cfs-category").addEventListener("change", e=>{ f.category = e.target.value; });
  document.getElementById("cfs-quantity").addEventListener("input", e=>{ f.quantity = e.target.value; });
  document.getElementById("cfs-cost").addEventListener("input", e=>{ f.cost = e.target.value; });
  document.getElementById("cfs-saleprice").addEventListener("input", e=>{ f.salePrice = e.target.value; });
  document.getElementById("cfs-fees").addEventListener("input", e=>{ f.fees = e.target.value; });
  document.getElementById("cfs-platform").addEventListener("change", e=>{ f.platform = e.target.value; });
  document.getElementById("cfs-date").addEventListener("change", e=>{ f.date = e.target.value; });

  document.getElementById("saveCreateFromSaleBtn").addEventListener("click", ()=>{
    const name = f.name.trim();
    const qty = parseInt(f.quantity, 10);
    const cost = parseFloat(f.cost);
    const salePrice = parseFloat(f.salePrice);
    if(!name){ showToast("Enter an item name", "close"); return; }
    if(isNaN(qty) || qty<1){ showToast("Enter a valid quantity", "close"); return; }
    if(isNaN(cost) || cost<0){ showToast("Enter what you paid for this item", "close"); return; }
    if(isNaN(salePrice) || salePrice<0){ showToast("Enter a valid sale price", "close"); return; }

    const item = {
      id: uid(), name, category: f.category, quantityPurchased: qty, purchasePricePerUnit: cost,
      retailer: "", purchaseDate: f.date, notes: "Created from a detected sale — purchase details are a best guess, please double check.",
      isPreorder: false, expectedArrival: null, isCancelled: false, image: null,
      sales: [{
        id: uid(), quantitySold: qty, salePricePerUnit: salePrice,
        fees: parseFloat(f.fees)||0, platform: f.platform, saleDate: f.date
      }]
    };
    state.items.unshift(item);
    state.pendingSales = state.pendingSales.filter(p=>p.id!==f.pendingSaleId);
    saveState();
    document.getElementById("modalRoot").innerHTML = "";
    showToast(`${name} created and marked sold`);
    render();
  });
}

function addExclusion(raw, silent){
  const val = (raw||"").trim().toLowerCase();
  if(!val) return;
  if(!state.emailFilters.excludedSenders.includes(val)){
    state.emailFilters.excludedSenders.push(val);
  }
  // Also clear out any not-yet-converted pending orders from this sender/domain right away.
  const before = state.pendingOrders.length;
  state.pendingOrders = state.pendingOrders.filter(p => p.addedToStockId || !(p.fromEmail && p.fromEmail.toLowerCase().includes(val)));
  const removedCount = before - state.pendingOrders.length;
  saveState();
  if(!silent) showToast(`Blocked ${val}`);
  else showToast(`Blocked ${val}${removedCount ? ` — removed ${removedCount} detected order(s)` : ""}`);
  // Called from both the Orders tab ("Block this sender" on a row) and
  // from within Settings (the exclusion filter panel) — refresh both,
  // since either or neither may currently be visible.
  if(!isTypingInField()) renderView();
  refreshSettingsIfOpen();
}

function normalizeCatchAllDomain(v){
  const trimmed = (v||"").trim();
  if(!trimmed) return null;
  return trimmed.startsWith("@") ? trimmed : "@"+trimmed;
}

async function connectEmailAccount(){
  const f = emailUI;
  if(!f.formEmail.trim() || !f.formPassword.trim()){
    f.error = "Enter both your email address and app password.";
    refreshSettingsIfOpen();
    return;
  }
  f.connecting = true;
  f.error = null;
  refreshSettingsIfOpen();

  try{
    const preset = PROVIDER_PRESETS[f.provider] || PROVIDER_PRESETS.custom;
    const res = await window.emailAPI.addAccount({
      email: f.formEmail.trim(),
      password: f.formPassword,
      host: f.formHost,
      port: f.formPort,
      secure: f.formSecure,
      catchAllDomains: f.formCatchAllList,
      smtpHost: preset.smtpHost,
      smtpPort: preset.smtpPort,
      smtpSecure: preset.smtpSecure
    });
    f.connecting = false;
    if(res.ok){
      f.formPassword = "";
      f.showAddForm = false;
      showToast("Email account added");
      await refreshAccountInfo();
      syncNow(true);
    } else {
      f.error = res.error || "Couldn't connect. Check your details and try again.";
      refreshSettingsIfOpen();
    }
  }catch(e){
    f.connecting = false;
    f.error = "Something went wrong connecting to your email. Try again.";
    refreshSettingsIfOpen();
  }
}

async function syncNow(silent){
  if(!emailUI.accounts || emailUI.accounts.length===0 || emailUI.syncing) return;
  emailUI.syncing = true;
  const syncStartedAt = Date.now();
  if(!silent) refreshSettingsIfOpen();
  try{
    const res = await window.emailAPI.sync({
      blockPromotions: state.emailFilters.blockPromotions,
      excludedSenders: state.emailFilters.excludedSenders,
      expenseRules: state.expenseRules || []
    });
    const elapsedSec = ((Date.now() - syncStartedAt) / 1000).toFixed(1);
    emailUI.syncing = false;
    if(!res.ok){
      if(!silent) showToast(res.error || "Sync failed", "close");
      if(!isTypingInField()) renderView();
      refreshSettingsIfOpen();
      return;
    }
    const { addedCount, cancelledCount } = mergeSyncResults(res.results);
    const newExpenseCount = mergeExpenseResults(res.expenseResults || []);
    state.emailLastSync = new Date().toISOString();
    saveState();
    // Sync results can change data visible in two separate places at
    // once — the main page (Stock/Orders/Dashboard/Sold) and, if it's
    // open, the Settings modal (Detected Sales, connection status) —
    // so both need refreshing, not just whichever happens to be showing.
    if(!isTypingInField()) renderView();
    refreshSettingsIfOpen();
    const totalFound = res.results.length + (res.expenseResults ? res.expenseResults.length : 0);
    if(!silent || totalFound>0){
      const extras = [];
      if(addedCount) extras.push(`${addedCount} added to stock`);
      if(cancelledCount) extras.push(`${cancelledCount} order${cancelledCount===1?"":"s"} cancelled`);
      if(newExpenseCount) extras.push(`${newExpenseCount} expense${newExpenseCount===1?"":"s"} tracked`);
      showToast(`Synced in ${elapsedSec}s — ${totalFound} email(s) found${extras.length ? `, ${extras.join(", ")}` : ""}`, cancelledCount ? "close" : "check");
    }
  }catch(e){
    emailUI.syncing = false;
    if(!silent) showToast("Sync failed — check your connection", "close");
    if(!isTypingInField()) renderView();
    refreshSettingsIfOpen();
  }
}

let autoSyncTimer = null;
function startAutoSync(){
  stopAutoSync();
  if(!emailUI.accounts || emailUI.accounts.length===0) return;
  autoSyncTimer = setInterval(()=>{
    if(emailUI.accounts && emailUI.accounts.length>0 && !emailUI.syncing) syncNow(true);
  }, AUTO_SYNC_INTERVAL_MS);
}
function stopAutoSync(){
  if(autoSyncTimer){ clearInterval(autoSyncTimer); autoSyncTimer = null; }
}

// Dedup by fromEmail+date+amount (the same day's re-scan issue that
// affects orders applies here too — this stops the same expense email
// from being added twice on repeat syncs).
function mergeExpenseResults(expenseResults){
  let newCount = 0;
  expenseResults.forEach(r=>{
    if(r.amount==null) return; // couldn't find an amount — skip rather than log a $0 expense
    const matchKey = "expense:"+(r.fromEmail||"")+"|"+r.date+"|"+r.amount;
    if(state.expenses.some(e=>e.matchKey===matchKey)) return;
    state.expenses.unshift({
      id: uid(), matchKey, amount: r.amount, tag: r.tag,
      date: (r.date||new Date().toISOString()).slice(0,10),
      description: r.description || null, source: "email", fromEmail: r.fromEmail||null
    });
    newCount++;
  });
  return newCount;
}

function mergeSyncResults(results){
  let addedCount = 0;
  let cancelledCount = 0;
  results.forEach(r=>{
    if(r.status==="sold"){
      const saleKey = "sale:"+(r.fromEmail||"")+"|"+r.date+"|"+(r.netAmount||r.grossAmount||0);
      if(!state.pendingSales.find(p=>p.matchKey===saleKey)){
        state.pendingSales.unshift({
          id: uid(), matchKey: saleKey, platform: r.platform,
          netAmount: r.netAmount!=null ? r.netAmount : r.grossAmount,
          grossAmount: r.grossAmount, fromEmail: r.fromEmail||null,
          saleDate: (r.date||new Date().toISOString()).slice(0,10),
          quantitySold: r.quantitySold || null,
          saleOrderNumber: r.saleOrderNumber || null,
          productNameHint: r.productNameHint || null
        });
      }
      return;
    }

    if(r.status==="cancelled"){
      // Real cancellation emails share the retailer's own order template
      // (same "Order Details/Summary" headers as a normal confirmation),
      // which is exactly why this needed its own detection — without it,
      // a cancellation was being misread as a brand new order. The email
      // format also doesn't reliably show a price per cancelled item
      // (nothing was actually charged), so there's no solid basis for
      // matching only *some* products in a multi-item order — cancelling
      // every item tied to this order number is the reliable behavior,
      // even though a true partial cancellation (rare) would over-cancel
      // rather than precisely match just the affected products.
      if(r.orderNumber){
        state.items.forEach(item=>{
          if(item.orderNumber===r.orderNumber && item.isPreorder && !item.isCancelled){
            item.isCancelled = true;
          }
        });
        const linkedOrder = state.pendingOrders.find(p=>p.orderNumber===r.orderNumber);
        if(linkedOrder && linkedOrder.status!=="delivered"){
          linkedOrder.status = "cancelled";
          linkedOrder.cancelReason = "Retailer cancelled this order.";
        }
        cancelledCount++;
      }
      return;
    }

    if(r.status==="account_suspended"){
      // Real confirmation: "all pending orders and subscriptions have been
      // cancelled" when this happens. This is specific to Amazon — it only
      // cancels orders where the retailer is Amazon, matched by "sent to"
      // address. Someone could have an Argos or Pokémon Center order
      // landing at that same address, and those must NOT be touched, since
      // this event has nothing to do with their account there.
      if(r.toEmail){
        const affected = state.pendingOrders.filter(p =>
          p.toEmail && p.toEmail.toLowerCase()===r.toEmail.toLowerCase() &&
          p.retailer && /amazon/i.test(p.retailer) &&
          p.status!=="delivered" && p.status!=="cancelled"
        );
        affected.forEach(p=>{
          p.status = "cancelled";
          p.cancelReason = "Amazon account suspended/on hold — Amazon automatically cancels pending orders when this happens.";
          if(p.addedToStockId){
            const linkedItem = state.items.find(i=>i.id===p.addedToStockId);
            if(linkedItem) linkedItem.isCancelled = true;
          }
        });
        cancelledCount += affected.length;
      }
      return;

    }

    if(r.status==="action_required"){
      // "Please update your payment" emails identify the order by product
      // name, not an order number — a real example had no order number
      // anywhere in it. Matching by product name alone is unreliable
      // though (the same product name can easily appear across two
      // separate orders) — so the "sent to" address is the primary
      // signal instead, which is reliable specifically when each order
      // used its own alias/catch-all address. If that address matches
      // more than one tracked preorder, product name narrows down just
      // that subset. Name-only matching is a last resort, used only when
      // there's no usable email match at all. Matching happens at the
      // ORDER level (grouping items sharing an orderNumber together) since
      // a multi-product order now has several stock items — a payment
      // issue affects the whole order, not just whichever single product
      // happened to be named in the email.
      const candidates = state.items.filter(i=>i.isPreorder && i.sourceEmailDetected);
      const orderGroups = {};
      candidates.forEach(i=>{
        const key = i.orderNumber || i.id;
        (orderGroups[key] = orderGroups[key] || []).push(i);
      });
      const orderKeys = Object.keys(orderGroups);

      let matchedKey = null;
      if(r.toEmail){
        const emailMatchKeys = orderKeys.filter(k => orderGroups[k].some(i => i.sentToEmail && i.sentToEmail.toLowerCase()===r.toEmail.toLowerCase()));
        if(emailMatchKeys.length === 1){
          matchedKey = emailMatchKeys[0];
        } else if(emailMatchKeys.length > 1 && r.productNameHint){
          matchedKey = emailMatchKeys.find(k => orderGroups[k].some(i => namesLikelyMatch(i.name, r.productNameHint))) || null;
        }
      }
      if(!matchedKey && r.productNameHint){
        matchedKey = orderKeys.find(k => orderGroups[k].some(i => namesLikelyMatch(i.name, r.productNameHint))) || null;
      }

      if(matchedKey){
        const itemsInOrder = orderGroups[matchedKey];
        itemsInOrder.forEach(item=>{
          item.needsAttention = true;
          item.attentionDeadline = r.deadlineDate || null;
          item.attentionDeadlineTime = r.deadlineTime || null;
        });
        const linkedOrder = state.pendingOrders.find(p=>p.addedToStockId===itemsInOrder[0].id);
        if(linkedOrder){
          linkedOrder.status = "action_required";
          linkedOrder.actionDeadline = r.deadlineDate || null;
          linkedOrder.actionDeadlineTime = r.deadlineTime || null;
        }
      }
      return;
    }

    // Confirmed directly against a real case: when order-number
    // extraction genuinely fails, this fallback key was retailer+price
    // alone — meaning any two emails from the same retailer that BOTH
    // lack a price too (common for shipping-stage notifications, which
    // don't usually restate the price) would collide into the exact same
    // key and silently overwrite each other instead of getting their own
    // entries. Adding the email's own date narrows this significantly —
    // still not a perfect guarantee, but a real reduction, and this path
    // should be rare now that order-number extraction handles every
    // wording tested against real emails so far.
    const key = r.orderNumber ? ("num:"+r.orderNumber) : ("guess:"+r.retailer.toLowerCase()+"|"+(r.price||0)+"|"+(r.date||"").slice(0,10));
    let existing = state.pendingOrders.find(p=>p.matchKey===key);

    // Pokémon Center preorder confirmations get pulled out of the regular
    // Orders flow entirely and turned straight into a PKC Orders entry,
    // since these won't have a normal ship/deliver cycle for a long time.
    if(r.status==="confirmed" && r.isPKCPreorder){
      if(!existing){
        const item = createPKCPreorderItem(r);
        state.pendingOrders.unshift({
          id: uid(), matchKey:key, retailer:r.retailer, price:r.price, fromEmail:r.fromEmail||null,
          orderDate:(r.date||new Date().toISOString()).slice(0,10),
          expectedDelivery:r.expectedDelivery, expectedDeliveryTime:r.expectedDeliveryTime||null,
          carrier:r.carrier||null, trackingNumber:r.trackingNumber||null,
          toEmail:r.toEmail||null,
          orderNumber:r.orderNumber, status:"confirmed", addedToStockId:item.id, isPKCPreorder:true
        });
        addedCount++;
      }
      return;
    }

    if(r.status==="confirmed"){
      if(!existing){
        state.pendingOrders.unshift({
          id: uid(), matchKey:key, retailer:r.retailer, price:r.price, fromEmail:r.fromEmail||null,
          orderDate:(r.date||new Date().toISOString()).slice(0,10),
          expectedDelivery:r.expectedDelivery, expectedDeliveryTime:r.expectedDeliveryTime||null,
          carrier:r.carrier||null, trackingNumber:r.trackingNumber||null,
          toEmail:r.toEmail||null, deliveryAddress:r.deliveryAddress||null, recipientName:r.recipientName||null, lineItems:r.lineItems||[],
          orderNumber:r.orderNumber, status:"confirmed", addedToStockId:null, isPKCPreorder:false
        });
      }
    } else if(r.status==="shipped" || r.status==="out_for_delivery" || r.status==="ready_for_collection"){
      // A fallback here that matched by "sent to" address alone (removed)
      // turned out to be actively unsafe: its justification assumed PKC
      // orders use a unique per-order alias, but confirmed directly
      // against real data that's false — someone can easily have several
      // simultaneous PKC preorders all sent to the exact same address,
      // and matching by address alone means a status update for ONE of
      // those orders can silently get applied to a completely different
      // one instead. Order number matching alone has been reliable across
      // every real email tested in this app, including confirmation and
      // shipping-stage emails using the identical order-number format —
      // so this only matches by order number now, same as everything
      // else. A genuine mismatch falls through to creating a new entry
      // below, which is far safer than corrupting the wrong order.
      if(existing && existing.status!=="delivered" && existing.status!=="cancelled" && statusRank(r.status) > statusRank(existing.status)){
        existing.status = r.status;
        if(r.expectedDelivery) existing.expectedDelivery = r.expectedDelivery;
        if(r.expectedDeliveryTime) existing.expectedDeliveryTime = r.expectedDeliveryTime;
        if(r.carrier) existing.carrier = r.carrier;
        if(r.trackingNumber) existing.trackingNumber = r.trackingNumber;
        if(r.pickupCode) existing.pickupCode = r.pickupCode;
        if(r.deliveryAddress && !existing.deliveryAddress) existing.deliveryAddress = r.deliveryAddress;
        if(r.recipientName && !existing.recipientName) existing.recipientName = r.recipientName;
        if(r.lineItems && r.lineItems.length && (!existing.lineItems || !existing.lineItems.length)) existing.lineItems = r.lineItems;
      } else if(!existing){
        state.pendingOrders.unshift({
          id: uid(), matchKey:key, retailer:r.retailer, price:r.price, fromEmail:r.fromEmail||null,
          orderDate:(r.date||new Date().toISOString()).slice(0,10),
          expectedDelivery:r.expectedDelivery, expectedDeliveryTime:r.expectedDeliveryTime||null,
          carrier:r.carrier||null, trackingNumber:r.trackingNumber||null, pickupCode:r.pickupCode||null,
          toEmail:r.toEmail||null, deliveryAddress:r.deliveryAddress||null, recipientName:r.recipientName||null, lineItems:r.lineItems||[],
          orderNumber:r.orderNumber, status:r.status, addedToStockId:null, isPKCPreorder:false
        });
      }
    } else if(r.status==="delivered"){
      // Same removal as the shipped/out-for-delivery branch above — an
      // address-only fallback here is equally unsafe for the same reason.
      if(existing && existing.status!=="delivered" && existing.status!=="cancelled"){
        existing.status = "delivered";
        existing.actionDeadline = null;
        existing.actionDeadlineTime = null;
        if(!existing.addedToStockId){
          const item = createStockItemFromOrder(existing);
          existing.addedToStockId = item.id;
          addedCount++;
        } else {
          // Already-tracked item (e.g. a PKC preorder that was confirmed
          // earlier) — a delivered email for it means it's arrived, so
          // do automatically what the "Mark Arrived" button does. A
          // multi-product order has several stock items sharing this
          // same order number, not just the one addedToStockId points
          // to — all of them need to arrive together, not just the first.
          const relatedItems = existing.orderNumber
            ? state.items.filter(i=>i.orderNumber===existing.orderNumber && i.isPreorder)
            : [state.items.find(i=>i.id===existing.addedToStockId)].filter(Boolean);
          relatedItems.forEach(linkedItem=>{
            linkedItem.isPreorder = false;
            linkedItem.needsAttention = false;
          });
          if(relatedItems.length) addedCount++;
        }
      } else if(existing && existing.status==="delivered" && (!existing.addedToStockId || !state.items.find(i=>i.id===existing.addedToStockId))){
        // Already delivered, but its stock link is missing or broken —
        // most likely the linked stock item was deleted directly (e.g.
        // during cleanup) without also clearing this reference, silently
        // orphaning the order from ever having stock again, since the
        // status-transition check above only fires once, on the initial
        // delivered transition, not on every re-sync afterward.
        const item = createStockItemFromOrder(existing);
        existing.addedToStockId = item.id;
        addedCount++;
      } else if(!existing){
        const orderDate = (r.date||new Date().toISOString()).slice(0,10);
        const stub = { retailer:r.retailer, price:r.price, orderDate };
        const item = createStockItemFromOrder(stub);
        state.pendingOrders.unshift({
          id: uid(), matchKey:key, retailer:r.retailer, price:r.price, fromEmail:r.fromEmail||null,
          orderDate, expectedDelivery:null, expectedDeliveryTime:null, carrier:r.carrier||null, trackingNumber:r.trackingNumber||null,
          orderNumber:r.orderNumber, status:"delivered", addedToStockId:item.id, isPKCPreorder:false
        });
        addedCount++;
      }
    }
  });
  return { addedCount, cancelledCount };
}

function statusRank(status){
  return { confirmed:0, shipped:1, out_for_delivery:2, ready_for_collection:2, delivered:3, cancelled:4 }[status] ?? -1;
}

// Used to match a payment-issue email (which identifies the order by
// product name, not order number) against an existing tracked preorder.
function normalizeForMatch(s){
  return (s||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function namesLikelyMatch(a, b){
  const na = normalizeForMatch(a), nb = normalizeForMatch(b);
  if(!na || !nb) return false;
  if(na.includes(nb) || nb.includes(na)) return true;
  const wordsA = na.split(" ").filter(w=>w.length>3);
  const wordsB = nb.split(" ").filter(w=>w.length>3);
  if(wordsA.length===0 || wordsB.length===0) return false;
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longerSet = new Set(wordsA.length <= wordsB.length ? wordsB : wordsA);
  const overlap = shorter.filter(w=>longerSet.has(w)).length;
  return overlap / shorter.length >= 0.6;
}

function createPKCPreorderItem(order){
  // A single PKC order can contain several different products — the old
  // version only ever used the first line item's name/price/quantity and
  // silently discarded the rest, which is exactly the reported "total
  // cost shows the value of 1 item" bug. Now creates one stock item per
  // actual product, all sharing the same order-level details (address,
  // recipient, order number), so each item's own cost is accurate and
  // costs can be aggregated correctly by product across separate orders.
  const shared = {
    category: "Pokemon",
    retailer: "Pokemon Center",
    purchaseDate: order.date ? order.date.slice(0,10) : todayISO(),
    isPreorder: true,
    expectedArrival: order.expectedDelivery || null,
    orderNumber: order.orderNumber || null,
    deliveryAddress: order.deliveryAddress || null,
    recipientName: order.recipientName || null,
    sentToEmail: order.toEmail || null,
    sourceEmailDetected: true,
    needsAttention: false,
    attentionDeadline: null,
    attentionDeadlineTime: null,
    isCancelled: false,
    image: null,
    sales: []
  };

  const lines = (order.lineItems && order.lineItems.length) ? order.lineItems : null;
  const createdItems = [];

  if(lines){
    lines.forEach(line=>{
      const item = {
        id: uid(),
        name: line.name,
        quantityPurchased: line.quantity || 1,
        purchasePricePerUnit: line.price || 0,
        notes: "Auto-detected Pokémon Center preorder from email sync — please verify item name, quantity, and price.",
        lineItems: order.lineItems || [],
        ...shared
      };
      state.items.unshift(item);
      createdItems.push(item);
    });
  } else {
    // No parseable line items — best-effort single placeholder, same as
    // before, using the order's total as that one item's price.
    const item = {
      id: uid(),
      name: "Pokémon Center Preorder — tap to edit",
      quantityPurchased: 1,
      purchasePricePerUnit: order.price || 0,
      notes: "Auto-detected Pokémon Center preorder from email sync — please verify item name, quantity, and price.",
      lineItems: [],
      ...shared
    };
    state.items.unshift(item);
    createdItems.push(item);
  }

  return createdItems[0];
}

function createStockItemFromOrder(order){
  const lines = (order.lineItems && order.lineItems.length) ? order.lineItems : null;

  if(!lines){
    // No itemized breakdown available (e.g. a retailer whose emails don't
    // include one, or a manually-added order) — same placeholder fallback
    // as before, just needs manual editing afterward.
    const item = {
      id: uid(),
      name: `Order from ${order.retailer} — tap to edit`,
      category: "Other",
      quantityPurchased: 1,
      purchasePricePerUnit: order.price || 0,
      retailer: order.retailer,
      purchaseDate: order.orderDate || todayISO(),
      notes: "Auto-added from email sync — please verify item name, quantity, and price.",
      isPreorder: false,
      expectedArrival: null,
      isCancelled: false,
      image: null,
      sales: []
    };
    state.items.unshift(item);
    return item;
  }

  // One stock item per actual product — the order's own line items are
  // already sitting right there with real names, quantities, and prices,
  // so there's no reason to fall back to one generic "tap to edit"
  // placeholder using just the order total, the same core issue behind
  // the original PKC multi-item cost bug. Different orders can easily
  // contain the same product though — reselling the same restock item
  // multiple times over is completely normal — so this checks for an
  // existing, not-yet-a-preorder stock item with the same name (exact
  // match after normalizing case/whitespace/punctuation, not fuzzy —
  // fuzzy matching here previously caused genuinely different products to
  // silently merge) and retailer, and adds to it with a proper
  // weighted-average cost instead of creating a duplicate every time.
  const createdItems = [];
  lines.forEach(line=>{
    const normalizedName = normalizeForMatch(line.name);
    const existingStock = state.items.find(i=>
      !i.isPreorder && i.retailer===order.retailer && normalizeForMatch(i.name)===normalizedName
    );
    if(existingStock){
      const oldQty = existingStock.quantityPurchased;
      const oldPrice = existingStock.purchasePricePerUnit;
      const newQty = line.quantity || 1;
      const newPrice = line.price || 0;
      const combinedQty = oldQty + newQty;
      existingStock.quantityPurchased = combinedQty;
      // Weighted average, not a straight overwrite — buying the same
      // product again at a different price shouldn't blow away what the
      // earlier units actually cost, which matters for accurate profit
      // figures on whichever units end up sold.
      existingStock.purchasePricePerUnit = combinedQty>0 ? ((oldQty*oldPrice)+(newQty*newPrice))/combinedQty : newPrice;
      createdItems.push(existingStock);
    } else {
      const item = {
        id: uid(), name: line.name, category: "Other", quantityPurchased: line.quantity || 1,
        purchasePricePerUnit: line.price || 0, retailer: order.retailer, purchaseDate: order.orderDate || todayISO(),
        notes: "Auto-added from email sync — please verify item name, quantity, and price.",
        isPreorder: false, expectedArrival: null, isCancelled: false, image: null, sales: []
      };
      state.items.unshift(item);
      createdItems.push(item);
    }
  });
  return createdItems[0];
}

/* ============================================================
   AUTO-UPDATER
   ============================================================ */

let updateState = { status: "idle", data: null, appVersion: null, dismissedVersion: null };

async function initUpdater(){
  if(!window.updaterAPI) return; // not running under Electron preload (e.g. dev preview)
  try{ updateState.appVersion = await window.updaterAPI.getVersion(); }catch(e){}
  window.updaterAPI.onStatus(({status, data})=>{
    const prevStatus = updateState.status;
    updateState.status = status;
    updateState.data = data;
    renderUpdateBanner();

    if(status==="available" && data?.version !== updateState.dismissedVersion){
      showUpdateAvailableModal(data?.version);
    } else if(status==="downloading"){
      const bar = document.getElementById("updateProgressBar");
      const text = document.getElementById("updateProgressText");
      if(bar && text){
        // Modal's already open — just update the numbers, no full rebuild
        // (this fires many times per second during a download).
        bar.style.width = (data?.percent||0) + "%";
        text.textContent = (data?.percent||0) + "%";
      }
    } else if(status==="downloaded" && prevStatus!=="downloaded"){
      showUpdateReadyModal(data?.version);
    }
  });
  const verLabel = document.getElementById("verLabel");
  if(verLabel && updateState.appVersion) verLabel.textContent = `v${updateState.appVersion} · desktop`;
}

function renderUpdateBanner(){
  const slot = document.getElementById("updateBannerSlot");
  if(!slot) return;
  if(updateState.status==="downloaded"){
    slot.innerHTML = `<div class="update-banner" id="installUpdateBtn">${ICONS.sparkle} Update ready — Restart</div>`;
    document.getElementById("installUpdateBtn").addEventListener("click", ()=>{ showUpdateReadyModal(updateState.data?.version); });
  } else if(updateState.status==="downloading"){
    slot.innerHTML = `<div class="update-banner" id="downloadingBanner">${ICONS.refresh} Downloading update… ${updateState.data?.percent||0}%</div>`;
    document.getElementById("downloadingBanner").addEventListener("click", ()=>{ showUpdateProgressModal(updateState.data?.percent||0); });
  } else {
    slot.innerHTML = "";
  }
}

function showUpdateAvailableModal(version){
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="updateAvailBackdrop">
      <div class="modal" style="width:420px;">
        <div class="modal-header">
          <h2>${ICONS.sparkle} Update Available</h2>
          <button class="icon-btn" id="closeUpdateAvail">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div style="font-size:14px;margin-bottom:6px;">Restock ${version ? `v${escapeHTML(version)}` : ""} is ready to download.</div>
          <div class="hint" style="margin-bottom:18px;">You're currently on v${escapeHTML(updateState.appVersion||"")}. Downloading takes a minute or two in the background — you can keep using the app while it happens.</div>
          <div style="display:flex;gap:10px;">
            <button class="btn-primary" id="updateNowBtn" style="flex:1;">Update Now</button>
            <button class="btn-secondary" id="updateLaterBtn" style="flex:1;">Later</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const close = ()=>{ document.getElementById("modalRoot").innerHTML = ""; };
  document.getElementById("closeUpdateAvail").addEventListener("click", ()=>{ updateState.dismissedVersion = version; close(); });
  document.getElementById("updateLaterBtn").addEventListener("click", ()=>{ updateState.dismissedVersion = version; close(); });
  document.getElementById("updateNowBtn").addEventListener("click", async ()=>{
    close();
    showUpdateProgressModal(0);
    if(window.updaterAPI) await window.updaterAPI.download();
  });
}

function showUpdateProgressModal(percent){
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="updateProgressBackdrop">
      <div class="modal" style="width:420px;">
        <div class="modal-header">
          <h2>${ICONS.refresh} Downloading Update</h2>
        </div>
        <div class="modal-body">
          <div class="hint" style="margin-bottom:12px;">Downloading v${escapeHTML(updateState.data?.version||"")}… you can close this and keep working, it'll keep going in the background.</div>
          <div style="background:var(--card-2);border-radius:8px;height:10px;overflow:hidden;margin-bottom:8px;">
            <div id="updateProgressBar" style="background:linear-gradient(135deg,var(--violet),var(--magenta));height:100%;width:${percent}%;transition:width .25s;"></div>
          </div>
          <div class="mono dim" id="updateProgressText" style="font-size:12.5px;text-align:right;">${percent}%</div>
          <div style="height:14px;"></div>
          <button class="btn-secondary block" id="hideProgressBtn">Hide (keeps downloading)</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("hideProgressBtn").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML = ""; });
}

function showUpdateReadyModal(version){
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="updateReadyBackdrop">
      <div class="modal" style="width:420px;">
        <div class="modal-header">
          <h2>${ICONS.sparkle} Update Ready</h2>
          <button class="icon-btn" id="closeUpdateReady">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div style="font-size:14px;margin-bottom:6px;">v${escapeHTML(version||"")} is downloaded and ready to install.</div>
          <div class="hint" style="margin-bottom:18px;">Restarting closes the app for a few seconds while it installs, then reopens automatically. Your data isn't affected either way.</div>
          <div style="display:flex;gap:10px;">
            <button class="btn-primary" id="restartNowBtn" style="flex:1;">Restart Now</button>
            <button class="btn-secondary" id="restartLaterBtn" style="flex:1;">Later</button>
          </div>
        </div>
      </div>
    </div>
  `;
  const close = ()=>{ document.getElementById("modalRoot").innerHTML = ""; };
  document.getElementById("closeUpdateReady").addEventListener("click", close);
  document.getElementById("restartLaterBtn").addEventListener("click", close);
  document.getElementById("restartNowBtn").addEventListener("click", ()=>{ window.updaterAPI && window.updaterAPI.install(); });
}

/* ============================================================
   SETTINGS
   ============================================================ */

function openSettings(){
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="settingsBackdrop">
      <div class="modal" style="width:640px;">
        <div class="modal-header">
          <h2>Settings</h2>
          <button class="icon-btn" id="closeSettings">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Display Currency</label>
            <select id="currencySelect">
              ${CURRENCIES.map(c=>`<option value="${c}" ${state.displayCurrency===c?"selected":""}>${c}</option>`).join("")}
            </select>
          </div>
          <div class="hint">This only changes how numbers are formatted — enter all your prices in this same currency; Restock doesn't convert between currencies.</div>

          <div style="height:14px;"></div>
          <div class="panel-title" style="margin-bottom:8px;">Color Theme</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            ${Object.entries(THEMES).map(([key,t])=>`
              <button class="theme-swatch-btn ${state.colorScheme===key?'active':''}" data-theme="${key}" title="${t.name}">
                <span class="theme-swatch" style="background:linear-gradient(135deg,${t.violet},${t.magenta});"></span>
                <span>${t.name}</span>
              </button>
            `).join("")}
          </div>

          <div style="height:14px;"></div>
          <div class="panel-title" style="margin-bottom:8px;">Email Sync</div>
          ${emailSyncHTML()}

          <div style="height:14px;"></div>
          <div class="panel-title" style="margin-bottom:8px;">Updates</div>
          <div class="hint" id="updateStatusText" style="margin-bottom:10px;">${updateStatusMessage()}</div>
          <div class="settings-row">
            <button class="btn-small" id="checkUpdateBtn">${ICONS.refresh} Check for Updates</button>
            ${updateState.status==="downloaded" ? `<button class="btn-small" id="installUpdateBtnSettings">${ICONS.sparkle} Restart & Install</button>` : ""}
          </div>

          <div style="height:20px;"></div>
          <div class="panel-title" style="margin-bottom:6px;">Profile Builder</div>
          <div class="hint" style="margin-bottom:10px;">Catch-all domains for Profile Builder come from your Email Sync accounts above — add them there. Your own email addresses (for the "my own addresses" mode) are managed here.</div>

          <div style="font-weight:700;font-size:12.5px;color:var(--text-dim);margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;" id="toggleOwnedEmails">
            <span>Your own email addresses (${state.profileBuilderSettings.emailList.length})</span>
            <span style="display:inline-flex;width:14px;height:14px;transform:rotate(${settingsUI.emailsExpanded?'90deg':'-90deg'});transition:transform 0.15s;">${ICONS.chev}</span>
          </div>
          ${settingsUI.emailsExpanded ? `
          <div class="chip-list" id="ownedEmailsChips" style="margin-bottom:10px;">
            ${state.profileBuilderSettings.emailList.length===0 ? `<span class="hint" style="margin:0;">None added yet.</span>` : state.profileBuilderSettings.emailList.map(e=>`
              <span class="excl-chip">${escapeHTML(e)}<button data-remove-pb-email="${escapeAttr(e)}">${ICONS.close}</button></span>
            `).join("")}
          </div>
          <div class="field" style="margin-bottom:0;">
            <textarea id="pbNewEmailInput" rows="2" placeholder="you@example.com, you2@example.com"></textarea>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button class="btn-small" id="addPbEmailBtn">${ICONS.plus} Add</button>
            <label class="btn-small" style="cursor:pointer;margin:0;">
              ${ICONS.download} Import CSV
              <input type="file" id="pbEmailCsvInput" accept=".csv,.txt" style="display:none;">
            </label>
          </div>
          <div class="hint" style="margin-top:8px;">To import several at once, paste a comma or newline-separated list above and click Add, or import a CSV file — any column containing email addresses is picked up automatically.</div>
          ` : ""}

          <div style="height:20px;"></div>
          <div class="panel-title" style="margin-bottom:10px;">Data</div>
          <div class="settings-row">
            <button class="btn-small" id="exportBtn">${ICONS.download} Export data</button>
            <button class="btn-small" id="clearBtn" style="border-color:var(--red);color:var(--red);">${ICONS.trash} Clear all data</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeSettings").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; render(); });
  const toggleEmailsBtn = document.getElementById("toggleOwnedEmails");
  if(toggleEmailsBtn) toggleEmailsBtn.addEventListener("click", ()=>{
    settingsUI.emailsExpanded = !settingsUI.emailsExpanded;
    refreshSettingsIfOpen();
  });
  const addPbEmailBtn = document.getElementById("addPbEmailBtn");
  if(addPbEmailBtn) addPbEmailBtn.addEventListener("click", ()=>{
    const input = document.getElementById("pbNewEmailInput");
    // Supports pasting several at once, comma or newline separated, not
    // just one address per click.
    const newOnes = input.value.split(/[,\n]/).map(e=>e.trim()).filter(Boolean);
    let addedCount = 0;
    newOnes.forEach(e=>{
      if(!state.profileBuilderSettings.emailList.includes(e)){
        state.profileBuilderSettings.emailList.push(e);
        addedCount++;
      }
    });
    if(addedCount) saveState();
    input.value = "";
    refreshSettingsIfOpen();
  });
  const pbEmailCsvInput = document.getElementById("pbEmailCsvInput");
  if(pbEmailCsvInput) pbEmailCsvInput.addEventListener("change", e=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      // Doesn't assume a specific column layout — just pulls out
      // anything in the file that looks like an email address, so it
      // works whether it's a single column of addresses, a full contacts
      // export with several other columns, or a plain text list.
      const text = reader.result;
      const found = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const unique = Array.from(new Set(found));
      let addedCount = 0;
      unique.forEach(email=>{
        if(!state.profileBuilderSettings.emailList.includes(email)){
          state.profileBuilderSettings.emailList.push(email);
          addedCount++;
        }
      });
      if(addedCount) saveState();
      e.target.value = "";
      refreshSettingsIfOpen();
      showToast(addedCount ? `${addedCount} address${addedCount===1?"":"es"} imported` : "No email addresses found in that file", addedCount ? "check" : "close");
    };
    reader.readAsText(file);
  });
  document.querySelectorAll("[data-remove-pb-email]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      state.profileBuilderSettings.emailList = state.profileBuilderSettings.emailList.filter(e=>e!==btn.dataset.removePbEmail);
      saveState();
      refreshSettingsIfOpen();
    });
  });
  document.getElementById("currencySelect").addEventListener("change", e=>{
    state.displayCurrency = e.target.value; saveState(); render();
  });
  document.querySelectorAll("[data-theme]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const key = btn.dataset.theme;
      state.colorScheme = key;
      saveState();
      applyTheme(key);
      openSettings(); // rebuild so the correct swatch shows as active
    });
  });
  document.getElementById("exportBtn").addEventListener("click", exportData);
  document.getElementById("clearBtn").addEventListener("click", ()=>{
    if(confirm("This deletes all stock, sales, orders, and expense data on this device. This can't be undone. Continue?")){
      state = {
        displayCurrency: state.displayCurrency, colorScheme: state.colorScheme, items: [], pendingOrders: [], pendingSales: [],
        expenses: [], expenseRules: [], emailLastSync: null,
        emailFilters: { blockPromotions: true, excludedSenders: [] }
      };
      saveState();
      document.getElementById("modalRoot").innerHTML = "";
      render();
      showToast("All data cleared");
    }
  });
  document.getElementById("checkUpdateBtn").addEventListener("click", async ()=>{
    if(!window.updaterAPI){ showToast("Updater not available in this build", "close"); return; }
    const res = await window.updaterAPI.check();
    if(!res.ok) showToast(res.error || "Couldn't check for updates", "close");
    const txt = document.getElementById("updateStatusText");
    if(txt) txt.textContent = updateStatusMessage();
  });
  const installBtn = document.getElementById("installUpdateBtnSettings");
  if(installBtn) installBtn.addEventListener("click", ()=>{ window.updaterAPI && window.updaterAPI.install(); });

  attachEmailEvents();
}

function updateStatusMessage(){
  const v = updateState.appVersion ? `Current version: v${updateState.appVersion}. ` : "";
  switch(updateState.status){
    case "checking": return v + "Checking for updates…";
    case "available": return v + `Update v${updateState.data?.version||""} found — downloading…`;
    case "downloading": return v + `Downloading update… ${updateState.data?.percent||0}%`;
    case "downloaded": return v + `Update v${updateState.data?.version||""} ready to install.`;
    case "none": return v + "You're up to date.";
    case "error": return v + `Couldn't check for updates (${updateState.data?.message||"unknown error"}). If you haven't set up GitHub Releases yet, this is expected — see README. If you have, try "Check for Updates" again, or confirm a release exists at your repo's Releases page.`;
    default: return v + "No update check has run yet.";
  }
}

function exportData(){
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ledger-export-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadCSV(filename, headers, rows){
  const escapeCsv = v => {
    const s = String(v==null ? "" : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const lines = [headers.map(escapeCsv).join(",")];
  rows.forEach(row => lines.push(row.map(escapeCsv).join(",")));
  const csv = lines.join("\r\n");
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8;"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ---------------- Utility ---------------- */

function escapeHTML(str){
  return String(str==null ? "" : str).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(str){ return escapeHTML(str); }

function bootApp(){
  render();
  initUpdater();
  refreshAccountInfo(); // loads email account status regardless of active tab, so auto-sync can start
  if(state.__pkcBackfillCount){
    const n = state.__pkcBackfillCount;
    delete state.__pkcBackfillCount;
    saveState();
    showToast(`Added ${n} product${n===1?"":"s"} that were missing from your PKC orders — the full details were already there, just hadn't been tracked as their own items yet.`);
    if(ui.tab==="orders") renderView();
  }
}

async function bootWithLicenseGate(){
  if(!window.licenseAPI){
    // Dev/unpackaged context without the preload bridge — just boot normally.
    bootApp();
    return;
  }
  const status = await window.licenseAPI.getStatus();
  if(!status.activated){
    showActivationScreen();
    return;
  }
  licenseExpiresAt = status.expiresAt || null;
  // Already activated — boot immediately rather than blocking on a network
  // round-trip every launch. Re-checks with Whop in the background only
  // when it's actually due (once a week), and only locks the app back out
  // on an explicit "invalid" response — never just because the check
  // couldn't reach the internet, so a paying customer without wifi for a
  // few days isn't locked out of software they already own.
  bootApp();
  if(status.needsRevalidation){
    window.licenseAPI.revalidate().then(res=>{
      if(!res.ok && res.error!=="network" && res.error!=="config" && res.error!=="unexpected"){
        showActivationScreen(true);
      } else if(res.ok && res.expiresAt !== licenseExpiresAt){
        licenseExpiresAt = res.expiresAt || null;
        if(!isTypingInField()) render(); // sidebar footer needs a full rebuild to pick this up, not just renderView()
      }
    });
  }
}

function showActivationScreen(wasRevoked){
  const app = document.getElementById("app");
  app.innerHTML = `
    <div style="grid-column:1/-1;height:100vh;display:flex;align-items:center;justify-content:center;">
      <div class="card" style="width:420px;padding:32px;text-align:center;">
        <div style="width:60px;height:60px;border-radius:15px;background:linear-gradient(135deg,var(--violet),var(--magenta));display:flex;align-items:center;justify-content:center;margin:0 auto 20px;color:#fff;">
          ${ICONS.stock}
        </div>
        <h2 style="margin-bottom:8px;">Activate Restock</h2>
        <div class="hint" style="margin-bottom:20px;">${wasRevoked ? "Your license couldn't be reverified — enter your key again to keep using Restock." : "Enter the license key from your Whop purchase to get started."}</div>
        <div class="field" style="text-align:left;margin-bottom:6px;">
          <input type="text" id="licenseKeyInput" placeholder="License key" autocomplete="off">
        </div>
        <div id="activationError" style="color:var(--red);font-size:13px;margin-bottom:14px;min-height:16px;text-align:left;"></div>
        <button class="btn-primary block" id="activateBtn">Activate</button>
        <div class="hint" style="margin-top:18px;">Don't have a key yet? <a href="#" id="getKeyLink" style="color:var(--violet);text-decoration:none;">Get one on Whop</a></div>
      </div>
    </div>
  `;
  const input = document.getElementById("licenseKeyInput");
  const errorEl = document.getElementById("activationError");
  const btn = document.getElementById("activateBtn");

  async function tryActivate(){
    const key = input.value.trim();
    if(!key){ errorEl.textContent = "Enter a license key."; return; }
    btn.disabled = true;
    btn.textContent = "Activating…";
    errorEl.textContent = "";
    const res = await window.licenseAPI.activate(key);
    if(res.ok){
      bootApp();
    } else {
      errorEl.textContent = res.error || "Activation failed.";
      btn.disabled = false;
      btn.textContent = "Activate";
    }
  }

  btn.addEventListener("click", tryActivate);
  input.addEventListener("keydown", e=>{ if(e.key==="Enter") tryActivate(); });
  input.focus();

  const getKeyLink = document.getElementById("getKeyLink");
  getKeyLink.addEventListener("click", (e)=>{
    e.preventDefault();
    if(window.shellAPI) window.shellAPI.openExternal("https://whop.com/restock");
  });
}

/* ---------------- Boot ---------------- */

// Safety net: any open modal can now be dismissed by clicking the dark
// area outside it, or pressing Escape — not just its own buttons. Without
// this, a modal that opens unexpectedly (e.g. from a background update
// check) silently blocks every click behind it, including the sidebar,
// with no obvious way out.
document.getElementById("modalRoot").addEventListener("click", (e)=>{
  if(e.target.classList.contains("modal-backdrop")){
    document.getElementById("modalRoot").innerHTML = "";
  }
});
document.addEventListener("keydown", (e)=>{
  if(e.key==="Escape"){
    const root = document.getElementById("modalRoot");
    if(root.innerHTML.trim()!=="") root.innerHTML = "";
  }
});

applyTheme(state.colorScheme);
bootWithLicenseGate();
