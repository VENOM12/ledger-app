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
  gmail:   { label:"Gmail",    host:"imap.gmail.com",         port:993, secure:true },
  outlook: { label:"Outlook",  host:"outlook.office365.com",  port:993, secure:true },
  yahoo:   { label:"Yahoo",    host:"imap.mail.yahoo.com",    port:993, secure:true },
  icloud:  { label:"iCloud",   host:"imap.mail.me.com",       port:993, secure:true },
  custom:  { label:"Custom",   host:"",                        port:993, secure:true }
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
      return parsed;
    }
  }catch(e){ console.warn("Could not read saved data", e); }
  return { displayCurrency: "USD", items: [], pendingOrders: [], pendingSales: [], expenses: [], expenseRules: [], colorScheme: "violet", emailLastSync: null, emailFilters: { blockPromotions: true, excludedSenders: [] } };
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

let ui = { tab: "dashboard", period: "Month", stockFilter: "In Stock", stockCategoryFilter: "All", search: "", detailItemId: null };
let licenseExpiresAt = null; // shown next to "Saved locally" in the sidebar once known

/* ---------------- Helpers ---------------- */

function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function fmtMoney(value){
  try{ return new Intl.NumberFormat(undefined, {style:"currency", currency: state.displayCurrency || "USD", maximumFractionDigits:2}).format(value || 0); }
  catch(e){ return (state.displayCurrency||"USD") + " " + (value||0).toFixed(2); }
}
function fmtPct(v){ return v.toFixed(1) + "%"; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
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
        return `
        <div style="display:flex;align-items:center;gap:12px;">
          ${itemThumb(item, 38)}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHTML(item.name)}</div>
            <div class="hint" style="margin:1px 0 0;">${escapeHTML(sale.platform||"—")} · ${formatDate(sale.saleDate)}</div>
          </div>
          <div class="mono" style="font-weight:700;color:var(--green);flex-shrink:0;">${fmtMoney(net)}</div>
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
        ${navBtn("stock","stock","Stock")}
        ${navBtn("orders","cart","Confirmed Orders")}
        ${navBtn("sold","tag","Sold")}
        ${navBtn("add","plus","Add Stock")}
        ${navBtn("expenses","cash","Expenses")}
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

function navBtn(id, iconKey, label){
  const active = ui.tab===id ? "active" : "";
  return `<button class="${active}" data-nav="${id}">${ICONS[iconKey]}<span>${label}</span></button>`;
}

function setTab(tab){
  ui.tab = tab;
  ui.detailItemId = null;
  render();
}

function renderTopbar(){
  const bar = document.getElementById("topbar");
  if(!bar) return;
  const titles = { dashboard: "Dashboard", stock: "Stock", add: "Add Stock", sold: "Sold", orders: "Confirmed Orders", expenses: "Expenses" };
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
  if(ui.detailItemId){ view.innerHTML = detailHTML(ui.detailItemId); attachDetailEvents(); return; }
  if(ui.tab==="dashboard"){ view.innerHTML = dashboardHTML(); attachDashboardEvents(); }
  else if(ui.tab==="add"){ view.innerHTML = addFormHTML(); attachAddEvents(); }
  else if(ui.tab==="stock"){ view.innerHTML = stockListHTML(); attachStockEvents(); }
  else if(ui.tab==="orders"){ view.innerHTML = ordersHTML(); attachOrdersEvents(); }
  else if(ui.tab==="sold"){ view.innerHTML = soldHTML(); attachSoldEvents(); }
  else if(ui.tab==="expenses"){ view.innerHTML = expensesHTML(); attachExpensesEvents(); }
}

/* ============================================================
   DASHBOARD
   ============================================================ */

function dashboardHTML(){
  const start = periodStart(ui.period);
  const inPeriod = d => !start || new Date(d) >= start;

  const purchasesInPeriod = state.items.filter(i => inPeriod(i.purchaseDate));
  const salesInPeriod = [];
  state.items.forEach(item => item.sales.forEach(s => { if(inPeriod(s.saleDate)) salesInPeriod.push({sale:s, item}); }));
  const expensesInPeriod = (state.expenses||[]).filter(e => inPeriod(e.date));

  const inventorySpent = purchasesInPeriod.reduce((s,i)=>s+totalCost(i),0);
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
  }).sort((a,b)=>b.profit-a.profit).slice(0,6);

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
        <div class="panel-title">Profit — ${periodQualifier(ui.period)}</div>
        ${sparklineSVG(profitSeriesForPeriod(ui.period))}
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

function statCard(iconKey, label, value, fg, bg){
  return `
    <div class="card stat-card">
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

// Matches the chart to whichever period is selected up top, the same way
// the stat cards do — "Day" only has one real data point (sales only
// record a date, not a time, so there's no finer granularity available),
// Week/Month show daily points, Year/All Time aggregate by month since
// hundreds of daily points wouldn't be readable.
function profitSeriesForPeriod(period){
  const today = new Date(); today.setHours(0,0,0,0);

  if(period==="Day"){
    return [{date: new Date(today), value: profitOnDate(today.toISOString().slice(0,10))}];
  }
  if(period==="Week" || period==="Month"){
    const spanDays = period==="Week" ? 6 : 29;
    const days = [];
    for(let i=spanDays; i>=0; i--){ const d=new Date(today); d.setDate(d.getDate()-i); days.push(d); }
    return days.map(d=>({date:d, value: profitOnDate(d.toISOString().slice(0,10))}));
  }
  if(period==="Year"){
    const months = [];
    for(let i=11; i>=0; i--){ months.push(new Date(today.getFullYear(), today.getMonth()-i, 1)); }
    return months.map(d=>({date:d, value: profitInMonth(d.getFullYear(), d.getMonth())}));
  }
  // All Time: monthly from the earliest sale on record through now, capped
  // to the most recent 36 months so a very long history stays readable.
  let earliest = null;
  state.items.forEach(item=>item.sales.forEach(s=>{
    const d = new Date(s.saleDate);
    if(!earliest || d<earliest) earliest = d;
  }));
  if(!earliest){
    return [{date: new Date(today.getFullYear(), today.getMonth(), 1), value: 0}];
  }
  const months = [];
  let cursor = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
  const end = new Date(today.getFullYear(), today.getMonth(), 1);
  while(cursor <= end){
    months.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth()+1);
  }
  return months.slice(-36).map(d=>({date:d, value: profitInMonth(d.getFullYear(), d.getMonth())}));
}
function sparklineSVG(series){
  // A single-point series (the "Day" period — sales only record a date,
  // not a time, so there's no finer breakdown available) would divide by
  // zero in the stepX calculation below. Duplicating the point renders it
  // as a flat line instead of crashing.
  if(series.length === 1){
    series = [series[0], series[0]];
  }
  const w=520, h=150, pad=10, topPad=26, bottomPad=24;
  const values = series.map(p=>p.value);
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if(min===max){ min-=1; max+=1; }
  const plotTop = topPad, plotBottom = h-bottomPad;
  const stepX = (w-pad*2)/(series.length-1);
  const yFor = v => plotBottom - ((v-min)/(max-min)) * (plotBottom-plotTop);
  const pts = series.map((p,i)=>[pad+i*stepX, yFor(p.value)]);
  const linePath = pts.map((p,i)=> (i===0?"M":"L")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  const areaPath = linePath + ` L${pts[pts.length-1][0].toFixed(1)},${plotBottom} L${pts[0][0].toFixed(1)},${plotBottom} Z`;
  const zeroY = yFor(0);

  const dateLabelIdx = series.map((_,i)=>i).filter(i=> i%3===0 || i===series.length-1);
  const dateLabels = dateLabelIdx.map(i=>({x: pad+i*stepX, text: `${series[i].date.getMonth()+1}/${series[i].date.getDate()}`}));

  // Label every day that actually had activity — most days will be $0 and
  // stay unlabeled to avoid clutter, but every real data point gets its
  // exact value shown directly on the chart, plus a native hover tooltip.
  const valueMarkers = pts.map((pt,i)=>{
    const v = series[i].value;
    if(v===0) return "";
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

  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;">
    <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" style="stop-color:var(--violet);stop-opacity:0.35"/>
      <stop offset="100%" style="stop-color:var(--violet);stop-opacity:0"/>
    </linearGradient></defs>
    <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${w-pad}" y2="${zeroY.toFixed(1)}" stroke="#232332" stroke-width="1" stroke-dasharray="3 3"/>
    <text x="${pad}" y="${(zeroY-5).toFixed(1)}" font-size="9.5" fill="#5C5C72" font-family="IBM Plex Mono, monospace">${fmtMoney(0)}</text>
    <path d="${areaPath}" fill="url(#sparkFill)" stroke="none"/>
    <path d="${linePath}" fill="none" style="stroke:var(--violet);" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    ${valueMarkers}
    ${dateLabels.map(l=>`<text x="${l.x}" y="${h-6}" font-size="9.5" fill="#5C5C72" font-family="IBM Plex Mono, monospace" text-anchor="middle">${l.text}</text>`).join("")}
  </svg>`;
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
    </div>
    <div id="stockResultsContainer">${stockResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function stockResultsHTML(){
  const filtered = state.items.filter(i => !i.isPreorder)
    .filter(i => ui.stockFilter==="In Stock" ? !isSoldOut(i) : isSoldOut(i))
    .filter(i => ui.stockCategoryFilter==="All" || i.category===ui.stockCategoryFilter)
    .filter(i => !ui.search || i.name.toLowerCase().includes(ui.search.toLowerCase()));

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
  document.querySelectorAll("tr[data-id]").forEach(row=>{
    row.addEventListener("click", ()=>{ ui.detailItemId = row.dataset.id; render(); });
  });
}

/* ============================================================
   PREORDERS
   ============================================================ */

let ordersUI = { subTab: "all", search: "", retailerFilter: "All" };

function ordersHTML(){
  return `
    <div class="segmented" style="margin-bottom:4px;">
      <button class="${ordersUI.subTab==='all'?'active':''}" data-orders-subtab="all">All Orders</button>
      <button class="${ordersUI.subTab==='pkc'?'active':''}" data-orders-subtab="pkc">PKC Preorders</button>
    </div>
    ${ordersUI.subTab==='all' ? allOrdersContentHTML() : pkcOrdersContentHTML()}
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
  } else {
    attachPreordersEvents();
  }
}

function allOrdersContentHTML(){
  const orders = state.pendingOrders.filter(p=>!p.isPKCPreorder);
  const retailers = Array.from(new Set(orders.map(p=>p.retailer).filter(Boolean))).sort();

  return `
    <div class="toolbar-row">
      <button class="btn-primary" id="addOrderBtn">${ICONS.plus} Add Order</button>
      <select id="orderRetailerFilterSelect" style="width:auto;padding:9px 30px 9px 13px;border:1px solid var(--border);background:var(--card);border-radius:var(--radius-sm);color:var(--text);">
        <option ${ordersUI.retailerFilter==="All"?"selected":""}>All</option>
        ${retailers.map(r=>`<option ${ordersUI.retailerFilter===r?"selected":""}>${escapeHTML(r)}</option>`).join("")}
      </select>
      <div class="search-bar">
        ${ICONS.search}
        <input type="text" id="orderSearchInput" placeholder="Search orders" value="${escapeAttr(ordersUI.search)}">
      </div>
    </div>
    <div id="allOrdersResultsContainer">${allOrdersResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function allOrdersResultsHTML(){
  const orders = state.pendingOrders.filter(p=>!p.isPKCPreorder)
    .filter(p=> ordersUI.retailerFilter==="All" || p.retailer===ordersUI.retailerFilter)
    .filter(p=> !ordersUI.search || (p.retailer||"").toLowerCase().includes(ordersUI.search.toLowerCase()) || (p.orderNumber||"").toLowerCase().includes(ordersUI.search.toLowerCase()))
    .sort((a,b)=> new Date(b.orderDate)-new Date(a.orderDate));

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
              <td class="dim" style="font-size:12px;">${p.carrier || p.trackingNumber ? `${p.carrier?escapeHTML(p.carrier):"Carrier unknown"}${p.trackingNumber?" · "+escapeHTML(p.trackingNumber):""}` : "—"}</td>
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
    if(!retailer){ showToast("Enter a retailer", "close"); return; }
    if(f.price.trim() && (isNaN(price) || price<0)){ showToast("Enter a valid price", "close"); return; }

    const order = {
      id: uid(), matchKey: "manual:"+uid(), retailer, price,
      fromEmail: null, orderDate: f.orderDate || todayISO(),
      expectedDelivery: f.expectedDelivery || null, expectedDeliveryTime: null,
      carrier: f.carrier.trim() || null, trackingNumber: f.trackingNumber.trim() || null,
      orderNumber: f.orderNumber.trim() || null, status: f.status, addedToStockId: null, isPKCPreorder: false
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

function orderDetailModal(orderId){
  const p = state.pendingOrders.find(o=>o.id===orderId);
  if(!p) return;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop open" id="orderDetailBackdrop">
      <div class="modal" style="width:520px;">
        <div class="modal-header">
          <h2>${escapeHTML(p.retailer)}</h2>
          <button class="icon-btn" id="closeOrderDetail">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div style="margin-bottom:14px;">${statusChip(p.status)}</div>
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
  document.getElementById("closeOrderDetail").addEventListener("click", ()=>{ document.getElementById("modalRoot").innerHTML=""; });
  const viewStockBtn = document.getElementById("orderDetailViewStock");
  if(viewStockBtn) viewStockBtn.addEventListener("click", ()=>{
    document.getElementById("modalRoot").innerHTML = "";
    ui.detailItemId = p.addedToStockId;
    render();
  });
}

function attachAllOrdersEvents(){
  document.getElementById("addOrderBtn").addEventListener("click", openAddOrderModal);
  document.getElementById("orderRetailerFilterSelect").addEventListener("change", e=>{
    ordersUI.retailerFilter = e.target.value; renderAllOrdersResults();
  });
  const search = document.getElementById("orderSearchInput");
  search.addEventListener("input", e=>{ ordersUI.search = e.target.value; renderAllOrdersResults(); });
  bindAllOrdersResultEvents();
}

function bindAllOrdersResultEvents(){
  document.querySelectorAll("[data-open-order]").forEach(row=>{
    row.addEventListener("click", (e)=>{
      if(e.target.closest("button")) return; // let the row's own buttons handle their own clicks
      orderDetailModal(row.dataset.openOrder);
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

function pkcOrdersContentHTML(){
  return `
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

function pkcResultsHTML(){
  const preorders = state.items.filter(i=>i.isPreorder)
    .filter(i=> !pkcUI.search || i.name.toLowerCase().includes(pkcUI.search.toLowerCase()))
    .sort((a,b)=> new Date(a.expectedArrival||"9999-12-31") - new Date(b.expectedArrival||"9999-12-31"));

  if(preorders.length===0){
    return `
      <div class="empty-state">
        ${ICONS.clock}
        <div class="t">No PKC orders yet</div>
        <div class="d">Pokémon Center preorder confirmations are detected automatically via Email Sync, or use "Add Preorder" above.</div>
      </div>
    `;
  }

  return `
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:14px;">
      ${preorders.map(i=>{
        const style = CAT_STYLES[i.category]||CAT_STYLES.Other;
        const linkedOrder = state.pendingOrders.find(p=>p.addedToStockId===i.id);
        const cancelled = i.isCancelled;
        return `
        <div class="card" style="padding:18px 20px;${i.needsAttention && !cancelled ? "border-color:var(--red);box-shadow:0 0 0 1px var(--red);" : ""}${cancelled ? "opacity:0.6;" : ""}">
          ${cancelled ? `
          <div style="display:flex;align-items:center;gap:10px;background:var(--card-2);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:14px;">
            ${ICONS.close}
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;font-size:13px;color:var(--text-dim);">Cancelled</div>
              <div class="hint" style="margin:1px 0 0;">${linkedOrder && linkedOrder.cancelReason ? escapeHTML(linkedOrder.cancelReason) : "This preorder was cancelled."}</div>
            </div>
          </div>` : i.needsAttention ? `
          <div style="display:flex;align-items:center;gap:10px;background:var(--red-bg);border-radius:var(--radius-sm);padding:10px 14px;margin-bottom:14px;">
            ${ICONS.close}
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;font-size:13px;color:var(--red);">Requires Attention — payment issue</div>
              <div class="hint" style="margin:1px 0 0;">${i.attentionDeadline ? `Update payment before ${formatDate(i.attentionDeadline)}${i.attentionDeadlineTime ? " · "+escapeHTML(i.attentionDeadlineTime) : ""}, or the preorder may be cancelled.` : "Check your email for details, or the preorder may be cancelled."}</div>
            </div>
          </div>` : ""}
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;">
            <div style="display:flex;align-items:center;gap:12px;cursor:pointer;flex:1;min-width:0;" data-open="${i.id}">
              ${itemThumb(i,38)}
              <div style="min-width:0;">
                <div style="font-weight:700;font-size:14.5px;">${escapeHTML(i.name)} ${i.sourceEmailDetected ? `<span class="status-chip chip-confirmed" style="vertical-align:middle;">Auto-detected</span>` : ""} ${cancelled ? `<span class="status-chip chip-cancelled" style="vertical-align:middle;">Cancelled</span>` : i.needsAttention ? `<span class="status-chip" style="vertical-align:middle;background:var(--red-bg);color:var(--red);">Requires Attention</span>` : ""}</div>
                <div class="hint" style="margin:2px 0 0;">${escapeHTML(i.category)} · ${escapeHTML(i.retailer||"Unknown retailer")}${linkedOrder && !cancelled ? ` · ${statusChip(linkedOrder.status)}` : ""}</div>
              </div>
            </div>
            ${cancelled ? "" : `<button class="btn-small" data-arrived="${i.id}" style="flex-shrink:0;">${ICONS.check} Mark Arrived</button>`}
          </div>

          <div class="kv-card" style="margin-top:14px;border:1px solid var(--border-soft);border-radius:var(--radius-md);">
            ${kvRow("Order #", i.orderNumber ? escapeHTML(i.orderNumber) : "—")}
            ${kvRow("Ordered", formatDate(i.purchaseDate))}
            ${kvRow("Expected arrival", i.expectedArrival ? formatDate(i.expectedArrival) : "—")}
            ${linkedOrder && linkedOrder.trackingNumber ? kvRow("Tracking", `${linkedOrder.carrier ? escapeHTML(linkedOrder.carrier)+" · " : ""}${escapeHTML(linkedOrder.trackingNumber)}`) : ""}
            ${kvRow("Cost", fmtMoney(totalCost(i)))}
            ${kvRow("Sent to", i.sentToEmail ? escapeHTML(i.sentToEmail) : "—")}
            ${kvRow("Recipient name", i.recipientName ? escapeHTML(i.recipientName) : "—")}
            ${kvRow("Delivery address", i.deliveryAddress ? escapeHTML(i.deliveryAddress) : "—")}
          </div>

          ${i.lineItems && i.lineItems.length>0 ? `
            <div class="hint" style="margin:12px 0 6px;">Items detected in this order:</div>
            <div class="card table-wrap" style="box-shadow:none;">
              <table class="data-table">
                <thead><tr><th>Item</th><th>Qty</th><th style="text-align:right;">Price</th></tr></thead>
                <tbody>
                  ${i.lineItems.map(li=>`<tr><td>${escapeHTML(li.name)}</td><td class="mono dim">${li.quantity}</td><td class="mono" style="text-align:right;">${fmtMoney(li.price)}</td></tr>`).join("")}
                </tbody>
              </table>
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
  document.querySelectorAll("[data-open]").forEach(el=>{
    el.addEventListener("click", ()=>{ ui.detailItemId = el.dataset.open; render(); });
  });
  document.querySelectorAll("[data-arrived]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const item = state.items.find(i=>i.id===btn.dataset.arrived);
      if(!item) return;
      item.isPreorder = false;
      saveState();
      showToast(`${item.name} moved to Stock`);
      renderPkcResults();
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
    state.pendingOrders.unshift({
      id: uid(), matchKey: "manual:"+item.id, retailer: "Pokemon Center", price,
      fromEmail: null, orderDate: f.orderDate || todayISO(),
      expectedDelivery: f.expectedArrival || null, expectedDeliveryTime: null,
      carrier: null, trackingNumber: null, orderNumber: f.orderNumber.trim() || null,
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

let soldUI = { platformFilter: "All", search: "" };

function soldHTML(){
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
    </div>
    <div id="soldResultsContainer">${soldResultsHTML()}</div>
    <div style="height:20px;"></div>
  `;
}

function soldResultsHTML(){
  const allSales = [];
  state.items.forEach(item => item.sales.forEach(sale => allSales.push({item, sale})));
  allSales.sort((a,b)=> new Date(b.sale.saleDate) - new Date(a.sale.saleDate));

  const filtered = allSales
    .filter(p => soldUI.platformFilter==="All" || (p.sale.platform||"Other")===soldUI.platformFilter)
    .filter(p => !soldUI.search || p.item.name.toLowerCase().includes(soldUI.search.toLowerCase()));

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
  document.getElementById("markSoldBtn").addEventListener("click", openPickItemToSellModal);
  document.getElementById("platformFilterSelect").addEventListener("change", e=>{
    soldUI.platformFilter = e.target.value; renderSoldResults();
  });
  const search = document.getElementById("soldSearchInput");
  search.addEventListener("input", e=>{ soldUI.search = e.target.value; renderSoldResults(); });
  bindSoldResultEvents();
}

/* ---------------- Expenses ---------------- */

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
    prefillNote: prefill ? true : false
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
  saveState();
  closeSellSheet();
  showToast("Sale recorded");
  render();
}

/* ============================================================
   EMAIL SYNC
   ============================================================ */

let emailUI = {
  accountInfo: undefined, // undefined = not yet loaded, null = not connected
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
  editingCatchAll: false,
  editCatchAllList: [],
  editCatchAllInput: ""
};

async function refreshAccountInfo(){
  try{
    emailUI.accountInfo = await window.emailAPI.getAccountInfo();
  }catch(e){
    emailUI.accountInfo = null;
  }
  if(ui.tab==="email") renderView();
  startAutoSync();
}

function emailSyncHTML(){
  if(emailUI.accountInfo === undefined){
    return `<div class="hint">Loading account info…</div>`;
  }
  if(!emailUI.accountInfo){
    return emailConnectFormHTML();
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
        <label>App Password ${ICONS.lock}</label>
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

function emailConnectedHTML(){
  const acc = emailUI.accountInfo;

  return `
    <div class="card account-banner">
      <div class="who">
        <div class="account-avatar">${ICONS.mail}</div>
        <div>
          <div style="font-weight:700;font-size:14px;">${escapeHTML(acc.email)}</div>
          <div class="hint" style="margin:0;">${escapeHTML(acc.host)} · ${state.emailLastSync ? "Last synced " + new Date(state.emailLastSync).toLocaleTimeString() : "Never synced"} · auto-syncs every 60s</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" id="syncNowBtn" ${emailUI.syncing?"disabled":""}>${ICONS.refresh} ${emailUI.syncing ? "Syncing…" : "Sync Now"}</button>
        <button class="btn-secondary" id="disconnectBtn" style="border-color:var(--red);color:var(--red);">Disconnect</button>
      </div>
    </div>

    <div class="card panel" style="margin-bottom:20px;">
      <div class="panel-title" style="margin-bottom:10px;">Catch-All Domains</div>
      ${emailUI.editingCatchAll ? `
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
          <button class="btn-small" id="saveCatchAllBtn">Save</button>
          <button class="btn-small" id="cancelCatchAllBtn">Cancel</button>
        </div>
      ` : `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
          <div class="hint" style="margin:0;">${(acc.catchAllDomains && acc.catchAllDomains.length) ? `Routing: ${acc.catchAllDomains.map(d=>`<strong style="color:var(--text);">${escapeHTML(d)}</strong>`).join(", ")}` : "No catch-all domains set — using keyword detection on your inbox only."}</div>
          <button class="btn-small" id="editCatchAllBtn" style="flex-shrink:0;">${(acc.catchAllDomains && acc.catchAllDomains.length) ? "Edit" : "Add"}</button>
        </div>
      `}
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

    <div class="section-title">Detected Sales</div>
    ${state.pendingSales.length===0 ? `
      <div class="card pending-empty">No sale emails detected yet (eBay "item sold" / payout notifications, etc.).</div>
    ` : `
      <div class="card table-wrap">
        <table class="data-table">
          <thead><tr><th>Platform</th><th>Likely Item</th><th>Date</th><th>Qty</th><th>Amount</th><th></th></tr></thead>
          <tbody>
            ${state.pendingSales.slice().sort((a,b)=>new Date(b.saleDate)-new Date(a.saleDate)).map(p=>`
              <tr>
                <td style="font-weight:600;">${escapeHTML(p.platform||"Unknown")}</td>
                <td class="dim" style="font-size:12.5px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.productNameHint ? escapeHTML(p.productNameHint) : "—"}</td>
                <td class="mono dim">${formatDate(p.saleDate)}</td>
                <td class="mono dim">${p.quantitySold || "—"}</td>
                <td class="mono">${p.netAmount!=null ? fmtMoney(p.netAmount) : "—"}</td>
                <td style="text-align:right;display:flex;gap:6px;justify-content:flex-end;">
                  <button class="btn-small" data-match-sale="${p.id}">Match to Item</button>
                  <button class="icon-btn" data-remove-sale="${p.id}">${ICONS.close}</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
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

  if(!emailUI.accountInfo){
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
    const disconnectBtn = document.getElementById("disconnectBtn");
    if(disconnectBtn) disconnectBtn.addEventListener("click", disconnectEmail);
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
    const editCatchAllBtn = document.getElementById("editCatchAllBtn");
    if(editCatchAllBtn) editCatchAllBtn.addEventListener("click", ()=>{
      emailUI.editingCatchAll = true;
      emailUI.editCatchAllList = (emailUI.accountInfo.catchAllDomains || []).slice();
      emailUI.editCatchAllInput = "";
      refreshSettingsIfOpen();
    });
    const cancelCatchAllBtn = document.getElementById("cancelCatchAllBtn");
    if(cancelCatchAllBtn) cancelCatchAllBtn.addEventListener("click", ()=>{ emailUI.editingCatchAll = false; refreshSettingsIfOpen(); });
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
    const saveCatchAllBtn = document.getElementById("saveCatchAllBtn");
    if(saveCatchAllBtn) saveCatchAllBtn.addEventListener("click", async ()=>{
      const list = emailUI.editCatchAllList;
      await window.emailAPI.updateCatchAll({ catchAllDomains: list });
      emailUI.editingCatchAll = false;
      showToast(list.length ? `${list.length} catch-all domain${list.length===1?"":"s"} saved` : "Catch-all domains cleared");
      await refreshAccountInfo();
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
    document.querySelectorAll("[data-match-sale]").forEach(btn=>{
      btn.addEventListener("click", ()=> openMatchSaleModal(btn.dataset.matchSale));
    });
    document.querySelectorAll("[data-remove-sale]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        state.pendingSales = state.pendingSales.filter(p=>p.id!==btn.dataset.removeSale);
        saveState();
        refreshSettingsIfOpen();
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
            <div class="pending-empty">No in-stock items to match against. Add stock first, or dismiss this detected sale.</div>
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
        </div>
      </div>
    </div>
  `;
  document.getElementById("closeMatch").addEventListener("click", ()=>{ openSettings(); });
  document.querySelectorAll("[data-pick]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const itemId = btn.dataset.pick;
      state.pendingSales = state.pendingSales.filter(p=>p.id!==pendingSaleId);
      saveState();
      document.getElementById("modalRoot").innerHTML = "";
      ui.detailItemId = itemId;
      render();
      openSellSheet(itemId, { platform: sale.platform, price: sale.netAmount, date: sale.saleDate, quantity: sale.quantitySold || null });
    });
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
    const res = await window.emailAPI.testAndSave({
      email: f.formEmail.trim(),
      password: f.formPassword,
      host: f.formHost,
      port: f.formPort,
      secure: f.formSecure,
      catchAllDomains: f.formCatchAllList
    });
    f.connecting = false;
    if(res.ok){
      f.formPassword = "";
      showToast("Email connected");
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

async function disconnectEmail(){
  if(!confirm("Disconnect this email account? Your existing stock and detected orders stay put — you just won't sync anymore until you reconnect.")) return;
  await window.emailAPI.disconnect();
  emailUI = { ...emailUI, accountInfo: null, formEmail:"", formPassword:"", formCatchAllList:[], formCatchAllInput:"" };
  stopAutoSync();
  refreshSettingsIfOpen();
}

async function syncNow(silent){
  if(!emailUI.accountInfo || emailUI.syncing) return;
  emailUI.syncing = true;
  if(!silent) refreshSettingsIfOpen();
  try{
    const res = await window.emailAPI.sync({
      sinceISO: state.emailLastSync,
      blockPromotions: state.emailFilters.blockPromotions,
      excludedSenders: state.emailFilters.excludedSenders,
      expenseRules: state.expenseRules || []
    });
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
      showToast(`Synced — ${totalFound} email(s) found${extras.length ? `, ${extras.join(", ")}` : ""}`, cancelledCount ? "close" : "check");
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
  if(!emailUI.accountInfo) return;
  autoSyncTimer = setInterval(()=>{
    if(emailUI.accountInfo && !emailUI.syncing) syncNow(true);
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
      // there's no usable email match at all.
      const candidates = state.items.filter(i=>i.isPreorder && i.sourceEmailDetected);
      let matchedItem = null;

      if(r.toEmail){
        const emailMatches = candidates.filter(i => i.sentToEmail && i.sentToEmail.toLowerCase()===r.toEmail.toLowerCase());
        if(emailMatches.length === 1){
          matchedItem = emailMatches[0];
        } else if(emailMatches.length > 1 && r.productNameHint){
          matchedItem = emailMatches.find(i => namesLikelyMatch(i.name, r.productNameHint)) || null;
        }
      }
      if(!matchedItem && r.productNameHint){
        matchedItem = candidates.find(i => namesLikelyMatch(i.name, r.productNameHint)) || null;
      }

      if(matchedItem){
        matchedItem.needsAttention = true;
        matchedItem.attentionDeadline = r.deadlineDate || null;
        matchedItem.attentionDeadlineTime = r.deadlineTime || null;
        const linkedOrder = state.pendingOrders.find(p=>p.addedToStockId===matchedItem.id);
        if(linkedOrder){
          linkedOrder.status = "action_required";
          linkedOrder.actionDeadline = r.deadlineDate || null;
          linkedOrder.actionDeadlineTime = r.deadlineTime || null;
        }
      }
      return;
    }

    const key = r.orderNumber ? ("num:"+r.orderNumber) : ("guess:"+r.retailer.toLowerCase()+"|"+(r.price||0));
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
          // do automatically what the "Mark Arrived" button does.
          const linkedItem = state.items.find(i=>i.id===existing.addedToStockId);
          if(linkedItem && linkedItem.isPreorder){
            linkedItem.isPreorder = false;
            linkedItem.needsAttention = false;
            addedCount++;
          }
        }
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
  // Best-effort: if we found itemized line items in the email, use the
  // first one as the primary item name/price (most PKC preorder emails
  // are for a single product anyway); otherwise fall back to a generic
  // "tap to edit" placeholder like other auto-added items.
  const firstLine = (order.lineItems && order.lineItems[0]) || null;
  const item = {
    id: uid(),
    name: firstLine ? firstLine.name : "Pokémon Center Preorder — tap to edit",
    category: "Pokemon",
    quantityPurchased: firstLine ? firstLine.quantity : 1,
    purchasePricePerUnit: firstLine ? firstLine.price : (order.price || 0),
    retailer: "Pokemon Center",
    purchaseDate: order.date ? order.date.slice(0,10) : todayISO(),
    notes: "Auto-detected Pokémon Center preorder from email sync — please verify item name, quantity, and price.",
    isPreorder: true,
    expectedArrival: order.expectedDelivery || null,
    orderNumber: order.orderNumber || null,
    deliveryAddress: order.deliveryAddress || null,
    recipientName: order.recipientName || null,
    sentToEmail: order.toEmail || null,
    lineItems: order.lineItems || [],
    sourceEmailDetected: true,
    needsAttention: false,
    attentionDeadline: null,
    attentionDeadlineTime: null,
    isCancelled: false,
    image: null,
    sales: []
  };
  state.items.unshift(item);
  return item;
}

function createStockItemFromOrder(order){
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

          <div style="height:24px;"></div>
          <div class="panel-title" style="margin-bottom:10px;">Color Theme</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;">
            ${Object.entries(THEMES).map(([key,t])=>`
              <button class="theme-swatch-btn ${state.colorScheme===key?'active':''}" data-theme="${key}" title="${t.name}">
                <span class="theme-swatch" style="background:linear-gradient(135deg,${t.violet},${t.magenta});"></span>
                <span>${t.name}</span>
              </button>
            `).join("")}
          </div>

          <div style="height:20px;"></div>
          <div class="panel-title" style="margin-bottom:10px;">Email Sync</div>
          ${emailSyncHTML()}

          <div style="height:20px;"></div>
          <div class="panel-title" style="margin-bottom:10px;">Updates</div>
          <div class="hint" id="updateStatusText" style="margin-bottom:10px;">${updateStatusMessage()}</div>
          <div class="settings-row">
            <button class="btn-small" id="checkUpdateBtn">${ICONS.refresh} Check for Updates</button>
            ${updateState.status==="downloaded" ? `<button class="btn-small" id="installUpdateBtnSettings">${ICONS.sparkle} Restart & Install</button>` : ""}
          </div>

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

/* ---------------- Utility ---------------- */

function escapeHTML(str){
  return (str||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function escapeAttr(str){ return escapeHTML(str); }

function bootApp(){
  render();
  initUpdater();
  refreshAccountInfo(); // loads email account status regardless of active tab, so auto-sync can start
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
