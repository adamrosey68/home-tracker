import "./style.css";
import { store } from "./store.js";
import * as push from "./push.js";
import { AREAS, CATEGORIES, FREQUENCIES, category, areaOf, guessCategory } from "./categories.js";
import { FIELDS, parseTable, guessMapping, rowsToItems, toCsv } from "./csv.js";
import { billIcon } from "./billIcons.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

let session = null;
let household = null;
let items = [];
let groups = [];
let filter = { area: "all", q: "" };
let showArchive = false;
let editing = null;
let sheetOpts = {};
let deleteArmed = false;
let newGroupArea = null;
let editingGroup = null;
let groupDeleteArmed = false;
let pricing = null;
let vehicles = [];
let newGroupVehicle = null;
let editingVehicle = null;
let vehicleDeleteArmed = false;
const openVehicleDetails = new Set();
let lines = [];
let budgetMonth = null;
let budgetEdit = null;
const openHistory = new Set();
const UI_KEY = "home-tracker-ui";
const ui = (() => { try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; } })();
const openGroups = new Set(ui.openGroups || []);
const closedAreas = new Set(ui.closedAreas || []);
const saveUi = () => localStorage.setItem(UI_KEY, JSON.stringify({ openGroups: [...openGroups], closedAreas: [...closedAreas] }));
const toggle = (set, id) => { if (set.has(id)) set.delete(id); else set.add(id); saveUi(); };
let importRows = null, importMap = {};

/* ---------- Dates and money ---------- */

const pad = (n) => String(n).padStart(2, "0");
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dayNum = (iso) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
const daysUntil = (iso) => dayNum(iso) - dayNum(todayIso());
const prettyDate = (iso, withYear = true) => new Date(dayNum(iso) * 86400000).toLocaleDateString("en-GB",
  { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
function addMonths(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(Math.min(d, last))}`;
}
const addDays = (iso, n) => new Date((dayNum(iso) + n) * 86400000).toISOString().slice(0, 10);
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const money = (n) => (Number.isInteger(n) ? gbp0 : gbp).format(n);
const PER = { monthly: "/month", quarterly: "/quarter", yearly: "/year", "one-off": "" };
const costLabel = (it) => (it.cost == null ? "" : money(it.cost) + PER[it.frequency]);
const toNum = (s) => (s.trim() === "" ? null : Math.round(parseFloat(s) * 100) / 100);

/* ---------- Groups ---------- */

const groupById = (id) => groups.find((g) => g.id === id);
const groupOf = (i) => (i.groupId ? groupById(i.groupId) : null);
const areaIdOf = (i) => groupOf(i)?.area || areaOf(i.category).id;
const areaById = (id) => AREAS.find((a) => a.id === id);
const vehicleById = (id) => vehicles.find((v) => v.id === id);
function nameOf(i) {
  const g = groupOf(i);
  if (!g) return i.title;
  const v = vehicleById(g.vehicleId);
  return v ? `${g.name} · ${v.registration}` : g.name;
}
const isPast = (i) => !!(i.groupId && i.archivedAt);
const groupItems = (g) => items.filter((i) => i.groupId === g.id);
const byNewest = (a, b) => (b.renewalDate || b.startDate || "").localeCompare(a.renewalDate || a.startDate || "");

function when(days) {
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return "1 day overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 60) return `In ${days} days`;
  return null;
}
const reminderReached = (it) => (it.remindOn ? daysUntil(it.remindOn) <= 0 : !!it.renewalDate && daysUntil(it.renewalDate) <= it.remindDays);
function dateBadge(it) {
  if (!it.renewalDate) {
    if (!it.remindOn) return '<span class="badge plain">No date</span>';
    return `<span class="badge ${reminderReached(it) ? "today" : "plain"}">Reminder ${esc(prettyDate(it.remindOn, false))}</span>`;
  }
  const days = daysUntil(it.renewalDate);
  const cls = days < 0 ? "late" : days <= 7 ? "today" : reminderReached(it) ? "" : "plain";
  return `<span class="badge ${cls}" title="${esc(prettyDate(it.renewalDate))}">${esc(cls === "plain" ? prettyDate(it.renewalDate) : when(days) || prettyDate(it.renewalDate))}</span>`;
}
const dateLabel = (cat) => ({ mot: "MOT due", tax: "Tax due", service: "Service due", mortgage: "Deal ends", carfinance: "Agreement ends" })[cat]
  || (category(cat).freq === "monthly" ? "Contract ends" : "Renewal date");

/* ---------- Views, notes and toasts ---------- */

function show(id) {
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== id;
  if (id === "settings") renderSettings();
  if (id === "home") renderHome();
  window.scrollTo(0, 0);
}
document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-nav]");
  if (nav) show(nav.dataset.nav);
});

function toast(msg, action) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
  if (action) el.querySelector("button").onclick = () => { el.remove(); action.run(); };
  $("#toasts").append(el);
  setTimeout(() => el.remove(), action ? 6000 : 3500);
}
function fail(e) {
  console.error(e);
  toast(e?.message || "Something went wrong. Please try again.");
}

/* ---------- Home ---------- */

/* Only shown to welcome a new household; once there's anything in it, Coming up takes the top spot. */
function renderTotals() {
  const live = items.filter((i) => !i.archivedAt);
  $("#totals").hidden = !!(live.length || groups.length);
  if (!live.length && !groups.length) {
    $("#totals").innerHTML = `
      <div class="welcome">
        <h2>Let's get everything in one place</h2>
        <p class="sub">Start a group for each thing you pay for, like “Buildings and contents” or “Gas and electricity”, then add who you're with now and who you've used before.</p>
        <div class="row"><button class="btn primary" type="button" data-new-group="home">+ Start a group</button>
        <button class="btn" type="button" data-nav="import">Import from Google Sheets</button></div>
      </div>`;
  }
}

function renderComing() {
  const live = items.filter((i) => !i.archivedAt);
  if (!live.length) { $("#coming").hidden = true; return; }
  $("#coming").hidden = false;
  const key = (i) => i.renewalDate || i.remindOn;
  const dated = live.filter(key).sort((a, b) => key(a).localeCompare(key(b)));
  const soon = dated.filter((i) => (i.renewalDate && daysUntil(i.renewalDate) <= 60) || (i.remindOn && daysUntil(i.remindOn) <= 0));
  const next = dated.find((i) => !soon.includes(i));
  const late = soon.filter((i) => i.renewalDate && daysUntil(i.renewalDate) < 0).length;
  $("#coming").innerHTML = `
    <div class="dhead"><h3>Coming up</h3>${late ? `<span class="badge late">${late} overdue</span>` : ""}</div>
    ${soon.length ? `<ul class="clist">${soon.map((i) => `
      <li><button type="button" data-open="${i.id}">
        <span class="aicon sm ${areaIdOf(i)}">${svg(areaById(areaIdOf(i)).icon)}</span>
        <span class="cbody"><span class="ctitle">${esc(nameOf(i))}</span><span class="csub">${esc([i.provider, i.renewalDate && prettyDate(i.renewalDate, false)].filter(Boolean).join(" · "))}</span></span>
        ${dateBadge(i)}
      </button></li>`).join("")}</ul>`
    : `<p class="empty">Nothing due in the next 60 days.${next ? ` Next up: ${esc(nameOf(next))} on ${esc(prettyDate(key(next)))}.` : ""}</p>`}`;
}

const DOC_ICON = svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path>');
function itemRow(i) {
  const sub = [i.provider, i.covers].filter(Boolean).join(" · ");
  return `<li><button type="button" class="irow" data-open="${i.id}">
    <span class="ibody"><span class="ititle">${esc(i.title)}</span>${sub ? `<span class="isub">${esc(sub)}</span>` : ""}</span>
    <span class="iright">${dateBadge(i)}${i.cost != null ? `<span class="icost">${esc(costLabel(i))}</span>` : ""}</span>
    ${i.docs.length ? `<span class="idocs" title="${i.docs.length} document${i.docs.length === 1 ? "" : "s"}">${DOC_ICON}</span>` : ""}
  </button></li>`;
}
const sortItems = (a, b) => (a.renewalDate || "9999").localeCompare(b.renewalDate || "9999") || a.title.localeCompare(b.title);

const q = () => filter.q.trim().toLowerCase();
const textMatch = (i) => [nameOf(i), i.provider, i.covers, i.reference, i.notes, category(i.category).label]
  .some((v) => v && v.toLowerCase().includes(q()));
const groupMatches = (g) => !q() || g.name.toLowerCase().includes(q()) || groupItems(g).some(textMatch);

function currentRow(i) {
  const bits = [
    i.startDate && `From ${prettyDate(i.startDate)}`,
    i.renewalDate && `Expires ${prettyDate(i.renewalDate)}`,
    i.remindOn && `Reminder ${prettyDate(i.remindOn)}`,
  ].filter(Boolean);
  return `<button type="button" class="gcur" data-open="${i.id}">
    <span class="ibody"><span class="gprov">${esc(i.provider || "Provider not set")}</span>
      ${bits.length ? `<span class="isub">${esc(bits.join(" · "))}</span>` : ""}
      ${i.reference ? `<span class="isub">Policy ${esc(i.reference)}</span>` : ""}</span>
    <span class="iright">${dateBadge(i)}${i.cost != null ? `<span class="icost">${esc(costLabel(i))}</span>` : ""}</span>
    ${i.docs.length ? `<span class="idocs">${DOC_ICON}</span>` : ""}
  </button>`;
}
function pastRow(i) {
  const span = [i.startDate && prettyDate(i.startDate), i.renewalDate && prettyDate(i.renewalDate)].filter(Boolean).join(" – ");
  return `<li><button type="button" class="hrow" data-open="${i.id}">
    <span class="hprov">${esc(i.provider || "Unknown")}</span>
    <span class="hdate">${esc(span || "No dates")}</span>
    <span class="hcost">${i.cost != null ? esc(costLabel(i)) : ""}</span>
  </button></li>`;
}

function groupCard(g) {
  const all = groupItems(g);
  const current = all.filter((i) => !i.archivedAt).sort(sortItems);
  const past = all.filter((i) => i.archivedAt).sort(byNewest);
  const now = current[0];
  const open = openHistory.has(g.id) || (q() && past.some(textMatch));
  const renaming = editingGroup === g.id;
  const pricingNow = now && pricing === now.id;
  const expanded = openGroups.has(g.id) || renaming || pricingNow || !!q();
  const summary = now ? [now.provider || "Provider not set", now.cost != null && costLabel(now)].filter(Boolean).join(" · ") : "No current provider";
  return `<section class="pcard gcard${expanded ? "" : " shut"}">
    <div class="phdr">
      <button class="gtoggle" type="button" data-group-toggle="${g.id}" aria-expanded="${expanded}">
        <span class="caret">${expanded ? "▾" : "▸"}</span>
        <span class="gtitle"><span class="pname">${esc(g.name)}</span>${expanded ? "" : `<span class="gsum">${esc(summary)}</span>`}</span>
      </button>
      ${!expanded && now ? dateBadge(now) : ""}
      ${expanded ? `<span class="pmeta">${now?.cost != null ? esc(costLabel(now)) : ""}</span>` : ""}
      <button class="gbtn" type="button" data-group-menu="${g.id}" aria-label="Rename or delete ${esc(g.name)}">⋯</button></div>
    ${expanded ? groupInner(g, all, current, past, now, open, renaming, pricingNow) : ""}
  </section>`;
}
function groupInner(g, all, current, past, now, open, renaming, pricingNow) {
  return `
    ${renaming ? `<form class="gedit" data-group-rename="${g.id}">
      <label class="sr" for="gname-${g.id}">Group name</label>
      <input type="text" id="gname-${g.id}" value="${esc(g.name)}" maxlength="60">
      ${vehicleSelect(g.area, g.vehicleId, `gveh-${g.id}`)}
      <div class="row"><button class="btn primary" type="submit">Save</button>
        <button class="btn danger${groupDeleteArmed ? " confirm" : ""}" type="button" data-group-delete="${g.id}">${groupDeleteArmed ? `Tap again to delete it and its ${all.length} entr${all.length === 1 ? "y" : "ies"}` : "Delete group"}</button>
        <button class="btn quiet" type="button" data-group-cancel>Cancel</button></div>
    </form>` : ""}
    <div class="gbody">
      <h3>Current</h3>
      ${current.length ? current.map(currentRow).join("") : `<p class="empty">No current provider yet.</p>`}
      ${pricingNow ? `<form class="pform" data-price-form="${now.id}">
        <label for="price-${now.id}">New price per month (£)</label>
        <div class="inline-form">
          <input type="number" id="price-${now.id}" inputmode="decimal" min="0" step="0.01" value="${now.cost ?? ""}">
          <button class="btn primary" type="submit">Save</button>
          <button class="btn quiet" type="button" data-price-cancel>Cancel</button>
        </div>
      </form>` : ""}
      <div class="row">
        ${now ? `<button class="btn" type="button" data-renew="${now.id}">Renew or switch</button>`
          : `<button class="btn primary" type="button" data-add-entry="${g.id}">+ Current provider</button>`}
        ${now?.frequency === "monthly" && !pricingNow ? `<button class="btn" type="button" data-price="${now.id}">Update monthly price</button>` : ""}
        <button class="btn quiet" type="button" data-add-past="${g.id}">+ Past provider</button>
      </div>
    </div>
    ${past.length ? `<div class="ghist">
      <button class="hfold" type="button" data-history="${g.id}" aria-expanded="${open}"><span class="caret">${open ? "▾" : "▸"}</span> History <span class="cnt">${past.length}</span></button>
      ${open ? `<ul class="hlist">${past.map(pastRow).join("")}</ul>` : ""}
    </div>` : ""}`;
}

/* ---------- Vehicles ---------- */

function vehicleSelect(area, selected, id) {
  if (area !== "car" || !vehicles.length) return "";
  return `<div class="field"><label for="${id}">For</label><select id="${id}" data-vehicle-pick>
    <option value="">Not for a particular vehicle</option>
    ${vehicles.map((v) => `<option value="${v.id}"${v.id === selected ? " selected" : ""}>${esc([v.registration, v.make, v.model].filter(Boolean).join(" "))}</option>`).join("")}
  </select></div>`;
}
const detail = (v, re) => v.details.find((d) => re.test(d.label))?.value;
const vehicleMatches = (v) => !q() || [v.registration, v.nickname, v.make, v.model, v.notes, ...v.details.map((d) => d.value)]
  .some((x) => x && x.toLowerCase().includes(q()));

function vehicleBlock(v, gs) {
  const open = openVehicleDetails.has(v.id);
  const title = [v.make, v.model].filter(Boolean).join(" ") || "Vehicle";
  const sub = [v.nickname, detail(v, /colou?r/i), detail(v, /fuel/i), detail(v, /year of manufacture/i)].filter(Boolean).join(" · ");
  const status = gs.map((g) => {
    const now = groupItems(g).find((i) => !i.archivedAt);
    return now?.renewalDate ? `<span class="vchip">${esc(g.name)}: ${esc(prettyDate(now.renewalDate))}</span>` : "";
  }).join("");
  return `<div class="vehicle">
    <section class="pcard vcard">
      <div class="vhead">
        <span class="plate">${esc(v.registration)}</span>
        <div class="vtitle"><span class="pname">${esc(title)}</span>${sub ? `<span class="isub">${esc(sub)}</span>` : ""}</div>
        <button class="btn quiet" type="button" data-vehicle-edit="${v.id}">Edit</button>
      </div>
      ${status ? `<div class="vstatus">${status}</div>` : ""}
      ${v.details.length ? `<div class="ghist">
        <button class="hfold" type="button" data-vdetails="${v.id}" aria-expanded="${open}"><span class="caret">${open ? "▾" : "▸"}</span> Details <span class="cnt">${v.details.length}</span></button>
        ${open ? `<dl class="vdl">${v.details.map((d) => `<div><dt>${esc(d.label)}</dt><dd>${esc(d.value)}</dd></div>`).join("")}</dl>` : ""}
      </div>` : ""}
      ${v.notes ? `<p class="vnotes">${esc(v.notes)}</p>` : ""}
      <div class="vacts"><button class="btn quiet" type="button" data-new-group="car" data-for-vehicle="${v.id}">+ Group for this vehicle</button></div>
    </section>
    ${gs.length ? `<div class="glist vgroups">${gs.map(groupCard).join("")}</div>` : ""}
  </div>`;
}

/* ---------- Monthly budget ---------- */

function focusLineForm() {
  const input = $(".lform .lname");
  input?.focus();
  input?.select();
}
const monthLabel = (m) => new Date(dayNum(m) * 86400000).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const monthLines = (m) => lines.filter((l) => l.month === m).sort((a, b) => a.position - b.position);
const sum = (ls) => Math.round(ls.reduce((s, l) => s + l.amount, 0) * 100) / 100;

function lineForm(kind, l) {
  const id = l ? l.id : `new-${kind}`;
  return `<form class="lform" data-line-form="${id}" data-kind="${kind}">
    <label class="sr" for="ln-${id}">What</label>
    <input type="text" id="ln-${id}" class="lname" maxlength="80" placeholder="${kind === "in" ? "e.g. Salary" : "e.g. Water"}" value="${esc(l?.name)}" autocomplete="off" required>
    <label class="sr" for="la-${id}">Amount (£)</label>
    <input type="number" id="la-${id}" class="lamt" inputmode="decimal" min="0" step="0.01" placeholder="£" value="${l ? l.amount : ""}" required>
    <div class="row">
      <button class="btn primary" type="submit">${l ? "Save" : "Add"}</button>
      ${l ? `<button class="btn danger" type="button" data-line-delete="${l.id}">Delete</button>` : ""}
      <button class="btn quiet" type="button" data-line-cancel>Cancel</button>
    </div>
  </form>`;
}
function lineIcon(l) {
  const { icon, tone } = billIcon(l.name, l.kind);
  return `<span class="aicon sm ${tone}">${svg(icon)}</span>`;
}
function lineList(kind, ls) {
  const rows = ls.map((l) => budgetEdit === l.id ? `<li>${lineForm(kind, l)}</li>`
    : `<li><button type="button" class="lrow" data-line="${l.id}">${lineIcon(l)}<span class="lname">${esc(l.name)}</span><span class="lamt">${esc(gbp.format(l.amount))}</span></button></li>`).join("");
  return `<ul class="llist">${rows}${budgetEdit === `new-${kind}` ? `<li>${lineForm(kind)}</li>` : ""}</ul>
    ${budgetEdit === `new-${kind}` ? "" : `<button class="btn quiet ladd" type="button" data-line-new="${kind}">+ ${kind === "in" ? "Money in" : "Bill"}</button>`}`;
}
function budgetCard() {
  const m = budgetMonth;
  const ls = monthLines(m);
  const ins = ls.filter((l) => l.kind === "in"), outs = ls.filter((l) => l.kind === "out");
  const tin = sum(ins), tout = sum(outs), left = Math.round((tin - tout) * 100) / 100;
  const prev = [...new Set(lines.map((l) => l.month))].filter((x) => x < m).sort().pop();
  const empty = !ls.length && !budgetEdit;
  return `<section class="pcard budget">
    <div class="bhead">
      <button class="gbtn" type="button" data-month="-1" aria-label="Previous month">‹</button>
      <label class="sr" for="budgetPick">Month</label>
      <select id="budgetPick" class="bmonth" data-month-pick>
        ${[...new Set([...lines.map((l) => l.month), m])].sort().reverse()
          .map((x) => `<option value="${x}"${x === m ? " selected" : ""}>${esc(monthLabel(x))}</option>`).join("")}
      </select>
      <button class="gbtn" type="button" data-month="1" aria-label="Next month">›</button>
    </div>
    ${empty ? `<div class="bempty"><p class="empty">Nothing for ${esc(monthLabel(m))} yet.</p>
      <div class="row">${prev ? `<button class="btn primary" type="button" data-month-copy="${prev}">Copy ${esc(monthLabel(prev))}</button>` : ""}
        <button class="btn" type="button" data-line-new="out">+ Bill</button>
        <button class="btn" type="button" data-line-new="in">+ Money in</button></div></div>` : `
    <div class="btotals">
      <div><span class="blabel">Coming in</span><span class="bnum in">${esc(gbp.format(tin))}</span></div>
      <div><span class="blabel">Going out</span><span class="bnum">${esc(gbp.format(tout))}</span></div>
      <div><span class="blabel">Left over</span><span class="bnum ${left < 0 ? "neg" : "in"}">${esc(gbp.format(left))}</span></div>
    </div>
    <div class="bsect"><h3>Coming in</h3>${lineList("in", ins)}</div>
    <div class="bsect"><h3>Going out <span class="cnt">${outs.length}</span></h3>${lineList("out", outs)}</div>`}
  </section>`;
}

function areaSection(a) {
  const all = groups.filter((g) => g.area === a.id);
  const vs = a.id === "car" ? vehicles : [];
  const vBlocks = vs.map((v) => {
    const mine = all.filter((g) => g.vehicleId === v.id);
    if (vehicleMatches(v)) return vehicleBlock(v, mine);
    const shown = mine.filter(groupMatches);
    return shown.length ? vehicleBlock(v, shown) : "";
  }).join("");
  const gs = all.filter((g) => !vehicleById(g.vehicleId) && groupMatches(g));
  const loose = items.filter((i) => !i.groupId && !i.archivedAt && areaIdOf(i) === a.id && (!q() || textMatch(i))).sort(sortItems);
  const adding = newGroupArea === a.id;
  if (q() && !gs.length && !loose.length && !vBlocks) return "";
  const shut = closedAreas.has(a.id) && !q() && !adding;
  const n = all.length + vs.length + (loose.length ? 1 : 0);
  return `<section class="area">
    <div class="ahead">
      <button class="atoggle" type="button" data-area-toggle="${a.id}" aria-expanded="${!shut}">
        <span class="aicon ${a.id}">${svg(a.icon)}</span><h2>${esc(a.label)}</h2>
        ${shut && n ? `<span class="cnt">${n}</span>` : ""}<span class="caret">${shut ? "▸" : "▾"}</span>
      </button>
      ${a.id === "car" ? `<button class="btn quiet" type="button" data-vehicle-new>+ Vehicle</button>` : ""}
      <button class="btn quiet" type="button" data-new-group="${a.id}">+ Group</button></div>
    ${shut ? "" : areaBody(a, adding, vBlocks, gs, loose)}
  </section>`;
}
function areaBody(a, adding, vBlocks, gs, loose) {
  return `
    ${adding ? `<form class="gnew" id="groupForm">
      <div class="inline-form">
        <label class="sr" for="groupName">Group name</label>
        <input type="text" id="groupName" maxlength="60" placeholder="${a.id === "car" ? "e.g. Insurance" : "e.g. Buildings and contents"}" autocomplete="off">
        <button class="btn primary" type="submit">Create</button>
        <button class="btn quiet" type="button" data-group-cancel>Cancel</button>
      </div>
      ${vehicleSelect(a.id, newGroupVehicle, "groupVehicle")}
    </form>` : ""}
    ${a.id === "bills" && !q() ? budgetCard() : ""}
    ${vBlocks}
    <div class="glist">
      ${gs.map(groupCard).join("")}
      ${loose.length ? `<section class="pcard">
        <div class="phdr"><span class="pname">${gs.length ? "Not in a group" : "Items"}</span>
          <button class="btn quiet addin" type="button" data-add="${a.id}">+ Add</button></div>
        <ul class="irows">${loose.map(itemRow).join("")}</ul></section>` : ""}
      ${!gs.length && !loose.length && !adding && !vBlocks && a.id !== "bills" ? `<p class="empty">No groups yet. Tap “+ Group” to start one.</p>` : ""}
    </div>`;
}

function renderHome() {
  $("#homeName").textContent = (household?.name || "Home tracker").toUpperCase();
  document.title = household?.name || "Home Tracker";
  renderTotals();
  renderComing();
  const count = (id) => groups.filter((g) => g.area === id).length + items.filter((i) => !i.groupId && !i.archivedAt && areaIdOf(i) === id).length
    + (id === "car" ? vehicles.length : 0) + (id === "bills" && monthLines(budgetMonth).length ? 1 : 0);
  $("#areaChips").innerHTML = [{ id: "all", label: "All" }, ...AREAS].map((a) => {
    const n = a.id === "all" ? AREAS.reduce((s, x) => s + count(x.id), 0) : count(a.id);
    return `<button type="button" class="chip" data-area="${a.id}" aria-pressed="${filter.area === a.id}">${esc(a.label)} <span class="cnt">${n}</span></button>`;
  }).join("");
  const anything = items.length || groups.length || vehicles.length || lines.length || newGroupArea;
  $(".filters").hidden = !anything;
  $("#list").innerHTML = anything
    ? AREAS.filter((a) => filter.area === "all" || filter.area === a.id).map(areaSection).join("") || `<p class="empty">Nothing matches that search.</p>`
    : "";
  const arch = items.filter((i) => i.archivedAt && !i.groupId);
  $("#archiveWrap").hidden = !arch.length;
  $("#toggleArchive").textContent = `${showArchive ? "Hide" : "Show"} archived (${arch.length})`;
  $("#archiveList").hidden = !showArchive;
  if (showArchive) $("#archiveList").innerHTML = `<section class="pcard"><ul class="irows">${arch.sort(sortItems).map(itemRow).join("")}</ul></section>`;
  const input = $("#groupName");
  if (input && document.activeElement !== input) input.focus();
}

$("#search").addEventListener("input", (e) => { filter.q = e.target.value; renderHome(); });
$("#list").addEventListener("change", (e) => {
  if (!e.target.matches("[data-month-pick]")) return;
  budgetMonth = e.target.value;
  budgetEdit = null;
  renderHome();
});
$("#areaChips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-area]");
  if (b) { filter.area = b.dataset.area; renderHome(); }
});
$("#toggleArchive").onclick = () => { showArchive = !showArchive; renderHome(); };
$("#addItem").onclick = () => openItem(null, { area: filter.area === "all" ? "home" : filter.area });
$("#openSettings").onclick = () => show("settings");

document.addEventListener("click", async (e) => {
  const t = (sel) => e.target.closest(sel);
  let b;
  if ((b = t("[data-open]"))) return openItem(b.dataset.open);
  if ((b = t("[data-add]"))) return openItem(null, { area: b.dataset.add || "home" });
  if ((b = t("[data-add-entry]"))) return openItem(null, { groupId: b.dataset.addEntry });
  if ((b = t("[data-add-past]"))) return openItem(null, { groupId: b.dataset.addPast, past: true });
  if ((b = t("[data-renew]"))) { openItem(b.dataset.renew); return $("#renewOpen").click(); }
  if ((b = t("[data-price]"))) {
    pricing = b.dataset.price;
    renderHome();
    const input = document.getElementById(`price-${pricing}`);
    input?.focus();
    return input?.select();
  }
  if (t("[data-price-cancel]")) { pricing = null; return renderHome(); }
  if ((b = t("[data-month]"))) { budgetMonth = addMonths(budgetMonth, Number(b.dataset.month)); budgetEdit = null; return renderHome(); }
  if ((b = t("[data-month-copy]"))) {
    const copy = monthLines(b.dataset.monthCopy).map((l, n) => ({ ...l, id: uid(), month: budgetMonth, position: Date.now() + n }));
    lines.push(...copy);
    renderHome();
    try { await store.addLines(copy); toast(`Copied ${copy.length} lines into ${monthLabel(budgetMonth)}`); } catch (err) { fail(err); await reload(); }
    return;
  }
  if ((b = t("[data-line]"))) { budgetEdit = b.dataset.line; renderHome(); return focusLineForm(); }
  if ((b = t("[data-line-new]"))) { budgetEdit = `new-${b.dataset.lineNew}`; renderHome(); return focusLineForm(); }
  if (t("[data-line-cancel]")) { budgetEdit = null; return renderHome(); }
  if ((b = t("[data-line-delete]"))) {
    const id = b.dataset.lineDelete;
    const gone = lines.find((l) => l.id === id);
    lines = lines.filter((l) => l.id !== id);
    budgetEdit = null;
    renderHome();
    try { await store.deleteLine(id); toast(`Deleted ${gone.name}`); } catch (err) { fail(err); await reload(); }
    return;
  }
  if ((b = t("[data-group-toggle]"))) { toggle(openGroups, b.dataset.groupToggle); return renderHome(); }
  if ((b = t("[data-area-toggle]"))) { toggle(closedAreas, b.dataset.areaToggle); return renderHome(); }
  if ((b = t("[data-history]"))) {
    const id = b.dataset.history;
    if (openHistory.has(id)) openHistory.delete(id); else openHistory.add(id);
    return renderHome();
  }
  if ((b = t("[data-vehicle-new]"))) return openVehicle(null);
  if ((b = t("[data-vehicle-edit]"))) return openVehicle(b.dataset.vehicleEdit);
  if ((b = t("[data-vdetails]"))) {
    const id = b.dataset.vdetails;
    if (openVehicleDetails.has(id)) openVehicleDetails.delete(id); else openVehicleDetails.add(id);
    return renderHome();
  }
  if ((b = t("[data-new-group]"))) {
    newGroupArea = b.dataset.newGroup;
    newGroupVehicle = b.dataset.forVehicle || null;
    filter.area = filter.area === "all" || filter.area === newGroupArea ? filter.area : newGroupArea;
    renderHome();
    return $("#groupForm")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  if ((b = t("[data-group-menu]"))) {
    editingGroup = editingGroup === b.dataset.groupMenu ? null : b.dataset.groupMenu;
    groupDeleteArmed = false;
    return renderHome();
  }
  if (t("[data-group-cancel]")) { newGroupArea = null; editingGroup = null; groupDeleteArmed = false; return renderHome(); }
  if ((b = t("[data-group-delete]"))) {
    if (!groupDeleteArmed) { groupDeleteArmed = true; return renderHome(); }
    const g = groupById(b.dataset.groupDelete);
    groups = groups.filter((x) => x.id !== g.id);
    items = items.filter((i) => i.groupId !== g.id);
    editingGroup = null;
    groupDeleteArmed = false;
    renderHome();
    try { await store.deleteGroup(g.id); toast(`Deleted ${g.name}`); } catch (err) { fail(err); await reload(); }
  }
});

document.addEventListener("submit", async (e) => {
  const lf = e.target.closest("[data-line-form]");
  if (lf) {
    e.preventDefault();
    const name = lf.querySelector(".lname").value.trim();
    const amount = toNum(lf.querySelector(".lamt").value);
    if (!name || amount == null) return;
    const id = lf.dataset.lineForm;
    const existing = lines.find((l) => l.id === id);
    budgetEdit = null;
    try {
      if (existing) {
        Object.assign(existing, { name, amount });
        renderHome();
        await store.updateLine(id, { name, amount });
      } else {
        const l = { id: uid(), householdId: household.id, month: budgetMonth, kind: lf.dataset.kind, name, amount, position: Date.now() };
        lines.push(l);
        budgetEdit = `new-${l.kind}`;
        renderHome();
        focusLineForm();
        await store.addLines([l]);
      }
    } catch (err) { fail(err); await reload(); }
    return;
  }
  if (e.target.id === "groupForm") {
    e.preventDefault();
    const name = $("#groupName").value.trim();
    if (!name) return;
    const g = { id: uid(), householdId: household.id, area: newGroupArea, name, position: Date.now(), vehicleId: $("#groupVehicle")?.value || null };
    groups.push(g);
    openGroups.add(g.id);
    saveUi();
    newGroupArea = null;
    renderHome();
    try {
      await store.addGroup(g);
      toast(`Created ${name}`, { label: "Add current provider", run: () => openItem(null, { groupId: g.id }) });
    } catch (err) { fail(err); await reload(); }
  }
  const priceForm = e.target.closest("[data-price-form]");
  if (priceForm) {
    e.preventDefault();
    const it = items.find((i) => i.id === priceForm.dataset.priceForm);
    const cost = toNum(priceForm.querySelector("input").value);
    if (cost == null || cost === it.cost) { pricing = null; return renderHome(); }
    const line = `${prettyDate(todayIso())}: price changed${it.cost != null ? ` from ${money(it.cost)}` : ""} to ${money(cost)} a month.`;
    const patch = { cost, frequency: "monthly", notes: it.notes ? `${line}\n${it.notes}` : line };
    Object.assign(it, patch);
    pricing = null;
    renderHome();
    try { await store.updateItem(it.id, patch); toast(`${it.provider || nameOf(it)} is now ${money(cost)} a month`); }
    catch (err) { fail(err); await reload(); }
    return;
  }
  const rename = e.target.closest("[data-group-rename]");
  if (rename) {
    e.preventDefault();
    const g = groupById(rename.dataset.groupRename);
    const name = rename.querySelector("input").value.trim();
    if (!name) return;
    const pick = rename.querySelector("[data-vehicle-pick]");
    const patch = pick ? { name, vehicleId: pick.value || null } : { name };
    Object.assign(g, patch);
    editingGroup = null;
    renderHome();
    try { await store.updateGroup(g.id, patch); } catch (err) { fail(err); await reload(); }
  }
});

/* ---------- Vehicle sheet ---------- */

function vehicleRowHtml(d = { label: "", value: "" }) {
  return `<div class="vrow">
    <input type="text" class="vl" maxlength="60" placeholder="e.g. Colour" value="${esc(d.label)}" aria-label="Detail">
    <input type="text" class="vv" maxlength="200" placeholder="e.g. Grey" value="${esc(d.value)}" aria-label="Value">
    <button type="button" class="del" data-vrow-del aria-label="Remove">×</button>
  </div>`;
}
function openVehicle(id) {
  editingVehicle = id;
  vehicleDeleteArmed = false;
  const v = id ? vehicleById(id) : null;
  $("#vSheetTitle").textContent = v ? v.registration : "Add a vehicle";
  $("#vReg").value = v?.registration || "";
  $("#vNick").value = v?.nickname || "";
  $("#vMake").value = v?.make || "";
  $("#vModel").value = v?.model || "";
  $("#vNotes").value = v?.notes || "";
  $("#vRows").innerHTML = (v?.details.length ? v.details : [{ label: "", value: "" }]).map(vehicleRowHtml).join("");
  $("#vSave").textContent = v ? "Save changes" : "Add vehicle";
  $("#vDangerSect").hidden = !v;
  $("#vDelete").textContent = "Delete vehicle";
  $("#vDelete").classList.remove("confirm");
  $("#vehicleSheet").hidden = false;
  document.body.classList.add("noscroll");
  if (!v) setTimeout(() => $("#vReg").focus(), 50);
}
function closeVehicle() {
  $("#vehicleSheet").hidden = true;
  document.body.classList.remove("noscroll");
  editingVehicle = null;
}
$("#vClose").onclick = closeVehicle;
$("#vehicleSheet").addEventListener("click", (e) => {
  if (e.target.id === "vehicleSheet") return closeVehicle();
  const del = e.target.closest("[data-vrow-del]");
  if (del) del.closest(".vrow").remove();
});
$("#vAddRow").onclick = () => {
  $("#vRows").insertAdjacentHTML("beforeend", vehicleRowHtml());
  $("#vRows .vrow:last-child .vl").focus();
};
$("#vehicleForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const registration = $("#vReg").value.trim().toUpperCase().replace(/\s+/g, " ");
  if (!registration) return;
  const t = (id) => $(id).value.trim() || null;
  const details = [...$("#vRows").querySelectorAll(".vrow")]
    .map((r) => ({ label: r.querySelector(".vl").value.trim(), value: r.querySelector(".vv").value.trim() }))
    .filter((d) => d.label || d.value);
  const patch = { registration, nickname: t("#vNick"), make: t("#vMake"), model: t("#vModel"), notes: t("#vNotes"), details };
  try {
    if (editingVehicle) {
      Object.assign(vehicleById(editingVehicle), patch);
      await store.updateVehicle(editingVehicle, patch);
      toast("Saved");
    } else {
      const v = { id: uid(), householdId: household.id, position: Date.now(), ...patch };
      vehicles.push(v);
      await store.addVehicle(v);
      toast(`Added ${registration}`);
    }
    closeVehicle();
    renderHome();
  } catch (err) { fail(err); await reload(); }
});
$("#vDelete").onclick = async () => {
  if (!vehicleDeleteArmed) {
    vehicleDeleteArmed = true;
    $("#vDelete").textContent = "Tap again to delete (its groups are kept)";
    $("#vDelete").classList.add("confirm");
    return;
  }
  const id = editingVehicle;
  vehicles = vehicles.filter((v) => v.id !== id);
  for (const g of groups) if (g.vehicleId === id) g.vehicleId = null;
  closeVehicle();
  renderHome();
  try { await store.deleteVehicle(id); toast("Vehicle deleted"); } catch (err) { fail(err); await reload(); }
};

/* ---------- Item sheet ---------- */

$("#fCategory").innerHTML = AREAS.map((a) => `<optgroup label="${esc(a.label)}">${CATEGORIES.filter((c) => c.area === a.id)
  .map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("")}</optgroup>`).join("");
$("#fFreq").innerHTML = FREQUENCIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");

const sheetItem = () => items.find((i) => i.id === editing);
const sheetGroup = () => (editing ? groupOf(sheetItem()) : groupById(sheetOpts.groupId));

function categoryForGroup(g) {
  const guess = guessCategory(g.name);
  return category(guess).area === g.area ? guess : CATEGORIES.find((c) => c.area === g.area).id;
}

function openItem(id, opts = {}) {
  editing = id;
  sheetOpts = opts;
  deleteArmed = false;
  const it = id ? sheetItem() : null;
  if (id && !it) return;
  const g = sheetGroup();
  const past = it ? isPast(it) : !!opts.past;
  const cat = it ? it.category : g ? categoryForGroup(g) : (CATEGORIES.find((c) => c.area === opts.area) || CATEGORIES[0]).id;

  $("#sheetTitle").textContent = g ? g.name : it ? it.title : "Add";
  $("#sheetSub").textContent = g
    ? (it ? (past ? "Past provider" : "Current provider") : (past ? "Add a past provider" : "Add the current provider"))
    : it ? category(it.category).label : "Insurance, a bill, MOT, tax or anything that renews";
  $("#typeField").hidden = !!g;
  $("#titleField").hidden = !!g;
  $("#remindField").hidden = past;
  $("#fAuto").closest(".tick").hidden = past;
  $("#fCategory").value = cat;
  $("#fTitle").value = it ? it.title : category(cat).label;
  $("#fTitle").dataset.auto = it ? "" : "1";
  $("#fProvider").value = it?.provider || "";
  $("#fCovers").value = it?.covers || "";
  $("#fStart").value = it?.startDate || "";
  $("#fReference").value = it?.reference || "";
  $("#fCost").value = it?.cost ?? "";
  $("#fFreq").value = it ? it.frequency : category(cat).freq;
  $("#fDate").value = it?.renewalDate || "";
  $("#fRemind").value = it?.remindOn || (it?.renewalDate ? addDays(it.renewalDate, -it.remindDays) : "");
  $("#fRemind").dataset.auto = it?.remindOn ? "" : "1";
  $("#fAuto").checked = !!it?.autoRenew;
  $("#fPhone").value = it?.phone || "";
  $("#fWebsite").value = it?.website || "";
  $("#fNotes").value = it?.notes || "";
  $("#fDateLabel").textContent = g ? (past ? "Ended" : "Expires") : dateLabel(cat);
  $("#itemSave").textContent = it ? "Save changes" : "Add";
  $("#renewSect").hidden = !it || !!it.archivedAt || (!it.groupId && !it.renewalDate);
  $("#renewHead").textContent = it?.groupId ? "Renewing or switching?" : "Renewed?";
  $("#renewOpen").textContent = it?.groupId ? "Renew or switch provider" : "Mark as renewed";
  $("#renewForm").hidden = true;
  $("#renewBtnRow").hidden = false;
  $("#docsSect").hidden = !it;
  $("#dangerSect").hidden = !it;
  if (it) {
    $("#archiveItem").textContent = it.groupId
      ? (it.archivedAt ? "Make this the current provider" : "Move to history")
      : (it.archivedAt ? "Bring back" : "Archive (no longer have it)");
    $("#deleteItem").textContent = "Delete";
    $("#deleteItem").classList.remove("confirm");
    renderDocs();
  }
  $("#itemSheet").hidden = false;
  document.body.classList.add("noscroll");
  if (!it) setTimeout(() => $("#fProvider").focus(), 50);
}
function closeItem() {
  $("#itemSheet").hidden = true;
  document.body.classList.remove("noscroll");
  editing = null;
  if (new URLSearchParams(location.search).has("item")) history.replaceState(null, "", location.pathname);
}
$("#sheetClose").onclick = closeItem;
$("#itemSheet").addEventListener("click", (e) => { if (e.target.id === "itemSheet") closeItem(); });
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#viewer").hidden) closeViewer();
  else if (!$("#itemSheet").hidden) closeItem();
  else if (!$("#vehicleSheet").hidden) closeVehicle();
});

$("#fCategory").addEventListener("change", () => {
  const cat = $("#fCategory").value;
  if ($("#fTitle").dataset.auto) $("#fTitle").value = category(cat).label;
  if (!editing) $("#fFreq").value = category(cat).freq;
  $("#fDateLabel").textContent = dateLabel(cat);
});
$("#fTitle").addEventListener("input", () => { $("#fTitle").dataset.auto = ""; });
/* The reminder follows the expiry date (a month before) until it's set by hand. */
$("#fDate").addEventListener("change", () => {
  if ($("#fRemind").dataset.auto && $("#fDate").value) $("#fRemind").value = addDays($("#fDate").value, -30);
});
$("#fRemind").addEventListener("change", () => { $("#fRemind").dataset.auto = ""; });

function formValues() {
  const t = (id) => $(id).value.trim() || null;
  const g = sheetGroup();
  return {
    category: $("#fCategory").value, title: g ? g.name : $("#fTitle").value.trim(), provider: t("#fProvider"), covers: t("#fCovers"),
    reference: t("#fReference"), cost: toNum($("#fCost").value), frequency: $("#fFreq").value,
    startDate: $("#fStart").value || null, renewalDate: $("#fDate").value || null, remindOn: $("#fRemind").value || null,
    autoRenew: $("#fAuto").checked, phone: t("#fPhone"), website: t("#fWebsite"), notes: t("#fNotes"),
  };
}

$("#itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = formValues();
  if (!v.title) { $("#fTitle").focus(); return; }
  const btn = $("#itemSave");
  btn.disabled = true;
  try {
    if (editing) {
      const it = sheetItem();
      Object.assign(it, v);
      await store.updateItem(it.id, v);
      toast("Saved");
    } else {
      const g = sheetGroup();
      const it = {
        id: uid(), householdId: household.id, groupId: g?.id || null, remindDays: 30, created: Date.now(), docs: [],
        archivedAt: sheetOpts.past ? Date.now() : null, ...v,
      };
      items.push(it);
      await store.addItem(it);
      const label = g ? `${it.provider || "Provider"} added to ${g.name}` : `Added ${it.title}`;
      toast(label, { label: "Add documents", run: () => openItem(it.id) });
    }
    closeItem();
    renderHome();
  } catch (err) {
    fail(err);
    await reload();
  } finally {
    btn.disabled = false;
  }
});

/* In a group, renewing moves the current provider into the history and starts a new entry.
   Outside a group, it rolls the date on and keeps a line of history in the notes. */
$("#renewOpen").onclick = () => {
  const it = sheetItem();
  const grouped = !!it.groupId;
  const start = it.renewalDate && daysUntil(it.renewalDate) > -60 ? it.renewalDate : todayIso();
  $("#rStartField").hidden = !grouped;
  $("#rStart").value = start;
  $("#rDate").value = addMonths(start, 12);
  $("#rDateLabel").textContent = grouped ? "Expires" : "Next renewal date";
  $("#rCost").value = it.cost ?? "";
  $("#rProvider").value = it.provider || "";
  $("#renewNote").textContent = grouped
    ? `Saving moves ${it.provider || "the current provider"} into the history and makes this the current one. Change the provider if you're switching.`
    : "The old price and provider are added to the notes, so you can compare next year.";
  $("#renewForm").hidden = false;
  $("#renewBtnRow").hidden = true;
  $("#rCost").focus();
};
$("#rStart").addEventListener("change", () => { if ($("#rStart").value) $("#rDate").value = addMonths($("#rStart").value, 12); });
$("#renewCancel").onclick = () => { $("#renewForm").hidden = true; $("#renewBtnRow").hidden = false; };
$("#renewForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const it = sheetItem();
  const cost = toNum($("#rCost").value);
  const provider = $("#rProvider").value.trim() || null;
  const renewalDate = $("#rDate").value;
  try {
    if (it.groupId) {
      const same = (provider || "").toLowerCase() === (it.provider || "").toLowerCase();
      const next = {
        id: uid(), householdId: it.householdId, groupId: it.groupId, category: it.category, title: it.title, covers: it.covers,
        frequency: it.frequency, autoRenew: it.autoRenew, remindDays: it.remindDays, provider, cost,
        startDate: $("#rStart").value || null, renewalDate, remindOn: addDays(renewalDate, -30),
        reference: same ? it.reference : null, phone: same ? it.phone : null, website: same ? it.website : null,
        notes: null, archivedAt: null, created: Date.now(), docs: [],
      };
      it.archivedAt = Date.now();
      items.push(next);
      await store.updateItem(it.id, { archivedAt: it.archivedAt });
      await store.addItem(next);
      closeItem();
      openHistory.add(it.groupId);
      openGroups.add(it.groupId);
      saveUi();
      renderHome();
      toast(`${provider || "New provider"} is now current, until ${prettyDate(renewalDate)}`, { label: "Add documents", run: () => openItem(next.id) });
      return;
    }
    const was = [it.cost != null ? costLabel(it) : null, it.provider ? `with ${it.provider}` : null].filter(Boolean).join(" ");
    const line = `Renewed ${prettyDate(todayIso())}${was ? ` (was ${was})` : ""}.`;
    const patch = { renewalDate, cost, provider, remindOn: null, notes: it.notes ? `${line}\n${it.notes}` : line };
    Object.assign(it, patch);
    await store.updateItem(it.id, patch);
    toast(`${it.title} now renews ${prettyDate(it.renewalDate)}`);
    closeItem();
    renderHome();
  } catch (err) { fail(err); await reload(); }
});

$("#archiveItem").onclick = async () => {
  const it = sheetItem();
  const archivedAt = it.archivedAt ? null : Date.now();
  try {
    it.archivedAt = archivedAt;
    await store.updateItem(it.id, { archivedAt });
    if (it.groupId) toast(archivedAt ? `${it.provider || "Provider"} moved to history` : `${it.provider || "Provider"} is now current`);
    else toast(archivedAt ? `Archived ${it.title}` : `${it.title} is back`);
    closeItem();
    renderHome();
  } catch (err) { fail(err); await reload(); }
};
$("#deleteItem").onclick = async () => {
  if (!deleteArmed) {
    deleteArmed = true;
    $("#deleteItem").textContent = "Tap again to delete for good";
    $("#deleteItem").classList.add("confirm");
    return;
  }
  const it = sheetItem();
  try {
    items = items.filter((i) => i.id !== it.id);
    closeItem();
    renderHome();
    await store.deleteItem(it.id);
    toast(`Deleted ${it.groupId ? it.provider || "entry" : it.title}`);
  } catch (err) { fail(err); await reload(); }
};
/* ---------- Documents ---------- */

const PDF_ICON = svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path>');
const PLUS = svg('<path d="M12 5v14M5 12h14"></path>');
let uploading = 0;

async function renderDocs() {
  const it = sheetItem();
  if (!it) return;
  const imgs = it.docs.filter((d) => d.mime.startsWith("image/"));
  $("#docs").innerHTML = it.docs.map((d) => `
    <button type="button" class="ptile${d.mime.startsWith("image/") ? "" : " pdf"}" data-doc="${d.id}" title="${esc(d.name)}">
      ${d.mime.startsWith("image/") ? `<img alt="${esc(d.name)}" data-src="${esc(d.path)}">` : `${PDF_ICON}<span>${esc(d.name)}</span>`}
    </button>`).join("") +
    (uploading ? `<div class="ptile busy"><span>Uploading…</span></div>` : "") +
    `<button type="button" class="ptile add" id="docAdd">${PLUS}<span>Add</span></button>`;
  $("#docAdd").onclick = () => $("#docFile").click();
  if (imgs.length) {
    try {
      const urls = await store.docUrls(imgs.map((d) => d.path));
      for (const img of $("#docs").querySelectorAll("img[data-src]")) img.src = urls[img.dataset.src] || "";
    } catch (e) { console.warn(e); }
  }
}

function shrinkImage(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const max = 2000, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read that photo."))), "image/jpeg", 0.85);
    };
    img.onerror = () => rej(new Error("Couldn't read that photo."));
    img.src = URL.createObjectURL(file);
  });
}

$("#docFile").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  const it = sheetItem();
  if (!it) return;
  for (const f of files) {
    uploading++;
    renderDocs();
    try {
      let blob = f;
      if (f.type.startsWith("image/")) blob = await shrinkImage(f);
      else if (f.type !== "application/pdf") throw new Error(`${f.name} isn't a photo or PDF.`);
      if (blob.size > 10 * 1024 * 1024) throw new Error(`${f.name} is over 10 MB.`);
      const name = f.name.replace(/\.(heic|heif|png|jpe?g|webp)$/i, ".jpg");
      const doc = await store.addDoc(it, blob, f.type === "application/pdf" ? f.name : name);
      it.docs.push(doc);
    } catch (err) { fail(err); }
    uploading--;
    renderDocs();
  }
  renderHome();
});

let viewing = null;
$("#docs").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-doc]");
  if (!b) return;
  const doc = sheetItem().docs.find((d) => d.id === b.dataset.doc);
  /* Opened before the await, or Safari treats it as a pop-up and blocks it. */
  const tab = doc.mime === "application/pdf" ? window.open("", "_blank") : null;
  try {
    const url = (await store.docUrls([doc.path]))[doc.path];
    if (tab) {
      tab.location.href = url.startsWith("data:") ? URL.createObjectURL(await (await fetch(url)).blob()) : url;
      return;
    }
    viewing = doc;
    $("#viewerImg").src = url;
    $("#viewerDel").textContent = "Delete";
    $("#viewer").hidden = false;
  } catch (err) { tab?.close(); fail(err); }
});
function closeViewer() { $("#viewer").hidden = true; $("#viewerImg").src = ""; viewing = null; }
$("#viewerClose").onclick = closeViewer;
$("#viewerDel").onclick = async () => {
  if ($("#viewerDel").textContent === "Delete") { $("#viewerDel").textContent = "Tap again to delete"; return; }
  const it = sheetItem(), doc = viewing;
  closeViewer();
  try {
    it.docs = it.docs.filter((d) => d.id !== doc.id);
    renderDocs();
    renderHome();
    await store.deleteDoc(doc);
  } catch (err) { fail(err); await reload(); }
};
/* PDFs open in a new tab, so deleting one is a long-press (or right-click) on its tile. */
$("#docs").addEventListener("contextmenu", async (e) => {
  const b = e.target.closest(".ptile.pdf");
  if (!b) return;
  e.preventDefault();
  const it = sheetItem(), doc = it.docs.find((d) => d.id === b.dataset.doc);
  if (!confirm(`Delete ${doc.name}?`)) return;
  try {
    it.docs = it.docs.filter((d) => d.id !== doc.id);
    renderDocs();
    renderHome();
    await store.deleteDoc(doc);
  } catch (err) { fail(err); await reload(); }
});

/* ---------- Settings ---------- */

function renderSettings() {
  $("#demoNote").hidden = !store.demo;
  $("#acctSect").hidden = store.demo;
  $("#shareSect").hidden = store.demo;
  $("#acctEmail").textContent = session?.user?.email ? `Signed in as ${session.user.email}` : "";
  $("#hhName").value = household?.name || "";
  $("#hhMembers").textContent = household?.members > 1 ? `Shared between ${household.members} people.` : "Only you can see this at the moment.";
  if (household?.shareCode) { $("#shareCode").textContent = household.shareCode; $("#sharebox").hidden = false; }
  const p = push.status(store.demo);
  $("#pushStatus").textContent = p.text;
  $("#pushOn").hidden = p.state !== "ask";
  $("#pushTest").hidden = p.state !== "on";
}
$("#signOut").onclick = async () => { await store.signOut(); location.reload(); };
$("#hhForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#hhName").value.trim();
  if (!name) return;
  try { await store.renameHousehold(household.id, name); household.name = name; toast("Renamed"); } catch (err) { fail(err); }
});
$("#shareMake").onclick = async () => {
  try {
    household.shareCode = await store.shareCode(household.id);
    renderSettings();
  } catch (err) { fail(err); }
};
$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("#joinCode").value.trim();
  if (!code) return;
  try {
    await store.join(code);
    $("#joinCode").value = "";
    await reload();
    toast(`You've joined ${household.name}`);
    show("home");
  } catch (err) { fail(err); }
});
$("#pushOn").onclick = async () => { try { await push.enable(store); renderSettings(); toast("Notifications are on"); } catch (err) { fail(err); } };
$("#pushTest").onclick = () => push.test().catch(fail);

$("#exportCsv").onclick = () => {
  const uk = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
  const head = ["Area", "Group", "Type", "Name", "Status", "Provider", "Covers", "Policy or account number", "Cost", "Paid",
    "Started", "Renewal or expiry date", "Remind on", "Auto-renews", "Phone", "Website", "Notes"];
  const rows = items.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || byNewest(a, b)).map((i) => [
    areaById(areaIdOf(i)).label, groupOf(i)?.name || "", category(i.category).label, i.title,
    i.groupId ? (i.archivedAt ? "Past" : "Current") : (i.archivedAt ? "Archived" : ""),
    i.provider, i.covers, i.reference, i.cost, i.frequency, uk(i.startDate), uk(i.renewalDate), uk(i.remindOn),
    i.autoRenew ? "Yes" : "No", i.phone, i.website, i.notes,
  ]);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\uFEFF" + toCsv([head, ...rows])], { type: "text/csv" }));
  a.download = `home-tracker-${todayIso()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

/* ---------- Import ---------- */

function readImport(text) {
  const rows = parseTable(text);
  if (rows.length < 2) return toast("That needs a heading row and at least one row underneath.");
  importRows = rows;
  importMap = guessMapping(rows[0]);
  $("#mapSect").hidden = false;
  renderImport();
  $("#mapSect").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderImport() {
  const [head, ...body] = importRows;
  const sample = (i) => body.find((r) => r[i])?.[i] || "";
  $("#mapGrid").innerHTML = FIELDS.map((f) => `
    <div class="field"><label for="map-${f.key}">${esc(f.label)}</label>
      <select id="map-${f.key}" data-map="${f.key}">
        <option value="">Not in my sheet</option>
        ${head.map((h, i) => `<option value="${i}"${importMap[f.key] === i ? " selected" : ""}>${esc(h || `Column ${i + 1}`)}${sample(i) ? ` (e.g. ${esc(sample(i).slice(0, 24))})` : ""}</option>`).join("")}
      </select></div>`).join("");
  const parsed = rowsToItems(body, importMap);
  const badDates = parsed.filter((p) => p.rawDate && !p.renewalDate).length;
  $("#previewHead").textContent = `Preview (${parsed.length} row${parsed.length === 1 ? "" : "s"})`;
  $("#preview").innerHTML = `<thead><tr><th>Name</th><th>Type</th><th>Provider</th><th>Cost</th><th>Date</th></tr></thead><tbody>${
    parsed.slice(0, 50).map((p) => `<tr><td>${esc(p.title)}</td><td>${esc(category(p.category).label)}</td><td>${esc(p.provider)}</td>
      <td>${p.cost != null ? esc(money(p.cost) + PER[p.frequency]) : ""}</td>
      <td class="${p.rawDate && !p.renewalDate ? "bad" : ""}">${p.renewalDate ? esc(prettyDate(p.renewalDate)) : esc(p.rawDate)}</td></tr>`).join("")}</tbody>`;
  $("#previewNote").textContent = [
    "Types are guessed from the name; you can change any of them afterwards.",
    badDates ? `${badDates} date${badDates === 1 ? "" : "s"} (in red) couldn't be read and will be left blank.` : "",
  ].filter(Boolean).join(" ");
  $("#csvImport").textContent = `Import ${parsed.length} item${parsed.length === 1 ? "" : "s"}`;
  $("#csvImport").disabled = !parsed.length || importMap.title == null;
}
$("#csvChoose").onclick = () => $("#csvFile").click();
$("#csvFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  /* Google Sheets and Excel downloads aren't always UTF-8; the older Windows encoding keeps £ signs intact. */
  const bytes = await f.arrayBuffer();
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = new TextDecoder("windows-1252").decode(bytes); }
  readImport(text);
});
$("#csvRead").onclick = () => readImport($("#csvText").value);
$("#mapGrid").addEventListener("change", (e) => {
  const s = e.target.closest("[data-map]");
  if (!s) return;
  if (s.value === "") delete importMap[s.dataset.map];
  else importMap[s.dataset.map] = Number(s.value);
  renderImport();
});
$("#csvImport").onclick = async () => {
  const list = rowsToItems(importRows.slice(1), importMap).map(({ rawDate, ...p }) => ({
    ...p, id: uid(), householdId: household.id, remindDays: 30, autoRenew: false, archivedAt: null, created: Date.now(), docs: [],
  }));
  $("#csvImport").disabled = true;
  try {
    await store.importItems(list);
    await reload();
    importRows = null;
    $("#mapSect").hidden = true;
    $("#csvText").value = "";
    show("home");
    toast(`Imported ${list.length} item${list.length === 1 ? "" : "s"}`);
  } catch (err) { fail(err); $("#csvImport").disabled = false; }
};

/* ---------- Sign in ---------- */

let signingUp = false;
$("#authToggle").onclick = () => {
  signingUp = !signingUp;
  $("#authSubmit").textContent = signingUp ? "Create account" : "Sign in";
  $("#authToggle").textContent = signingUp ? "Already have an account? Sign in" : "New here? Create an account";
  $("#authPass").autocomplete = signingUp ? "new-password" : "current-password";
};
$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#authEmail").value.trim(), pass = $("#authPass").value;
  const msg = $("#authMsg");
  msg.hidden = true;
  $("#authSubmit").disabled = true;
  try {
    if (signingUp) {
      const r = await store.signUp(email, pass);
      if (!r.session) { msg.textContent = "Check your email for a link to confirm your account, then sign in."; msg.hidden = false; }
    } else await store.signIn(email, pass);
  } catch (err) {
    msg.textContent = err.message || "Couldn't sign in.";
    msg.hidden = false;
  } finally { $("#authSubmit").disabled = false; }
});

/* ---------- Start up ---------- */

async function reload() {
  household = await store.household();
  ({ items, groups, vehicles, lines } = await store.load(household.id));
  budgetMonth ??= todayIso().slice(0, 8) + "01";
  if (!$("#home").hidden) renderHome();
  if (editing && !$("#itemSheet").hidden) { if (sheetItem()) renderDocs(); else closeItem(); }
}

let syncTimer = null;
async function start(s) {
  session = s;
  if (!s) { show("auth"); return; }
  try {
    await reload();
  } catch (err) {
    fail(err);
    return;
  }
  show("home");
  store.subscribe(() => { clearTimeout(syncTimer); syncTimer = setTimeout(() => reload().catch(console.warn), 400); });
  push.resync(store);
  const want = new URLSearchParams(location.search).get("item");
  if (want) openItem(want);
}

let started = false;
store.onAuth((s) => {
  if (!!s === !!session && started) return;
  started = true;
  start(s);
});
store.session().then((s) => { if (!started) { started = true; start(s); } }).catch(fail);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(console.warn);
  navigator.serviceWorker.addEventListener("message", (e) => {
    const url = e.data?.open && new URL(e.data.open);
    const id = url?.searchParams.get("item");
    if (id) openItem(id);
  });
}
/* Dates like "In 3 days" go stale overnight. */
document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("#home").hidden) renderHome(); });
