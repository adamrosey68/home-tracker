import "./style.css";
import { store } from "./store.js";
import * as push from "./push.js";
import { AREAS, CATEGORIES, FREQUENCIES, category, areaOf, guessCategory } from "./categories.js";
import { FIELDS, parseTable, guessMapping, rowsToItems } from "./csv.js";
import { billIcon, ICON_CHOICES } from "./billIcons.js";

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
let budgetGroups = [];
let spends = [];
let accounts = [], moves = [];
let savEdit = null, savDeleteArmed = false, moveEdit = null;
const savShowAll = new Set();
let budgetMonth = null;
/* Which budget line form is open: a line id, "new-in", "new-out" or "new-<groupId>". */
let budgetEdit = null;
/* Which budget group's name form is open: a group id or "new". */
let bgroupEdit = null;
let bgroupDeleteArmed = false;
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

/* A line's slot is "in", "out" (the main Going out list) or the id of the budget group it belongs to. */
const slotKind = (slot) => (slot === "in" ? "in" : "out");
const bgroupOf = (l) => (l.groupId ? budgetGroups.find((g) => g.id === l.groupId) : null);
const isOneOff = (l) => l.frequency === "one-off";
/* A group set to "Monthly only" hides its one-off lines and leaves them out of every total. */
const shownLine = (l) => !(isOneOff(l) && bgroupOf(l)?.monthlyOnly);
const countedLine = (l) => l.kind === "out" && shownLine(l) && (!bgroupOf(l) || bgroupOf(l).inTotal);
const REPEAT = '<path d="M17 2.5 20.5 6 17 9.5"></path><path d="M3.5 11.5V10a4 4 0 0 1 4-4h13M7 21.5 3.5 18 7 14.5"></path><path d="M20.5 12.5V14a4 4 0 0 1-4 4h-13"></path>';
const freqMark = (l) => (isOneOff(l) ? `<span class="lfreq once">One-off</span>`
  : `<span class="lfreq" title="Monthly">${svg(REPEAT)}<span class="sr">Monthly</span></span>`);

function iconPicker(id, l, kind) {
  const auto = billIcon(l?.name || "", kind);
  const opt = (key, label, icon, tone) => `<label class="ipick-opt" title="${esc(label)}">
      <input type="radio" name="ic-${id}" value="${key}"${(l?.icon || "") === key ? " checked" : ""}>
      <span class="aicon sm ${tone}">${svg(icon)}</span><span class="sr">${esc(label)}</span></label>`;
  return `<details class="ipick"><summary>Icon: ${l?.icon ? esc(ICON_CHOICES.find((c) => c.key === l.icon)?.label || "Chosen") : "Automatic"}</summary>
    <div class="ipick-grid">${opt("", "Automatic, from the name", auto.icon, "plain auto")}${ICON_CHOICES.map((c) => opt(c.key, c.label, c.icon, c.tone)).join("")}</div>
  </details>`;
}
const LENGTHS = [1, 3, 6, 12, 24, 36];
/* Whole months from one date to another, or null if they don't line up on the same day of the month. */
function wholeMonths(a, b) {
  const n = (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
  return n > 0 && addMonths(a, n) === b ? n : null;
}
function lengthText(a, b) {
  const n = wholeMonths(a, b);
  if (n == null) { const d = dayNum(b) - dayNum(a); return `${d} day${d === 1 ? "" : "s"}`; }
  return n % 12 ? `${n} month${n === 1 ? "" : "s"}` : `${n / 12} year${n === 12 ? "" : "s"}`;
}
function datesLine(l) {
  if (!l.startedOn && !l.endsOn) return "";
  const bits = [], d = l.endsOn ? daysUntil(l.endsOn) : null;
  if (l.plan?.length && l.endsOn === l.plan.at(-1).to && d > 30) return "";
  if (l.startedOn) bits.push(`${l.startedOn > todayIso() ? "Starts" : "Started"} ${prettyDate(l.startedOn)}`);
  if (l.endsOn) {
    bits.push(d < 0 ? `Expired ${prettyDate(l.endsOn)}` : d === 0 ? "Expires today"
      : `Expires ${prettyDate(l.endsOn)}${d <= 30 ? ` (in ${d} day${d === 1 ? "" : "s"})` : ""}`);
  }
  if (l.startedOn && l.endsOn) bits.push(lengthText(l.startedOn, l.endsOn));
  const bell = l.endsOn && l.remind && d > 30 ? ` <span class="lbell" title="We'll remind you a month before">${svg(BELL)}<span class="sr">Reminder on</span></span>` : "";
  return `<span class="lsub${d == null ? "" : d < 0 ? " late" : d <= 30 ? " soon" : ""}">${bits.join(" · ")}${bell}</span>`;
}
const BELL = '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path>';
function datesPicker(id, l) {
  const n = l?.startedOn && l?.endsOn ? wholeMonths(l.startedOn, l.endsOn) : null;
  return `<details class="ldates"${l?.startedOn || l?.endsOn ? " open" : ""}>
    <summary>Start and expiry dates</summary>
    <div class="ldgrid">
      <label>Started<input type="date" class="lstart" value="${esc(l?.startedOn)}"></label>
      <label>Length<select class="llen"><option value="">Choose…</option>${LENGTHS.map((m) =>
        `<option value="${m}"${n === m ? " selected" : ""}>${m % 12 ? `${m} month${m === 1 ? "" : "s"}` : `${m / 12} year${m === 12 ? "" : "s"}`}</option>`).join("")}</select></label>
      <label>Expires<input type="date" class="lend" value="${esc(l?.endsOn)}"></label>
    </div>
    <label class="tick"><input type="checkbox" class="lremind"${l?.remind === false ? "" : " checked"}> Remind us a month before it expires</label>
  </details>`;
}
/* Payments in a plan stage fall on the start date's day each month, up to and including the end date. */
function stagePayments(s) {
  const out = [];
  for (let i = 0; i < 600; i++) {
    const d = addMonths(s.from, i);
    if (d > s.to) break;
    out.push(d);
  }
  return out;
}
function planInfo(plan) {
  const today = todayIso();
  const stages = (plan || []).map((s) => {
    const pays = stagePayments(s), left = pays.filter((d) => d >= today);
    return { ...s, count: pays.length, left: left.length, leftAmount: left.length * s.amount, next: left[0] };
  });
  const left = stages.reduce((n, s) => n + s.left, 0);
  const leftAmount = Math.round(stages.reduce((n, s) => n + s.leftAmount, 0) * 100) / 100;
  const current = stages.find((s) => s.next);
  return { stages, left, leftAmount, current, total: stages.reduce((n, s) => n + s.count * s.amount, 0) };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
function planLine(l) {
  if (!l.plan?.length) return "";
  const p = planInfo(l.plan);
  if (!p.left) return `<span class="lsub">Plan paid off · ${esc(gbp.format(p.total))} in total</span>`;
  const now = p.current;
  return `<span class="lsub plan">${esc(gbp.format(now.amount))} a month until ${prettyDate(now.to)} · <b>${esc(gbp.format(p.leftAmount))} left</b> over ${plural(p.left, "payment")}</span>`;
}
function planStage(s = {}) {
  return `<div class="pstage">
    <label>From<input type="date" class="pfrom" value="${esc(s.from)}"></label>
    <label>To<input type="date" class="pto" value="${esc(s.to)}"></label>
    <label>£ a month<input type="number" class="pamt" inputmode="decimal" min="0" step="0.01" value="${s.amount ?? ""}"></label>
    <button class="gbtn" type="button" data-plan-remove aria-label="Remove this stage">×</button>
  </div>`;
}
function planSummary(plan) {
  if (!plan.length) return "";
  const p = planInfo(plan);
  return `<ul class="psum">${p.stages.map((s) => `<li>${prettyDate(s.from)} to ${prettyDate(s.to)}: ${plural(s.count, "payment")} of ${esc(gbp.format(s.amount))}, ${s.left
    ? `${s.left} left (${esc(gbp.format(s.leftAmount))})` : "all paid"}</li>`).join("")}
    <li class="ptot">Total left to pay: <b>${esc(gbp.format(p.leftAmount))}</b> over ${plural(p.left, "month")}</li></ul>`;
}
function planPicker(l) {
  const plan = l?.plan || [];
  return `<details class="lplan"${plan.length ? " open" : ""}>
    <summary>Payment plan</summary>
    <p class="hint">For agreements like a phone contract: add each stage with its dates and monthly amount.</p>
    <div class="pstages">${plan.map(planStage).join("")}</div>
    <button class="btn quiet" type="button" data-plan-add>+ Add a stage</button>
    <div class="psumwrap">${planSummary(plan)}</div>
  </details>`;
}
function readPlan(form) {
  return [...form.querySelectorAll(".pstage")].map((r) => ({
    from: r.querySelector(".pfrom").value, to: r.querySelector(".pto").value, amount: toNum(r.querySelector(".pamt").value),
  })).filter((s) => s.from && s.to && s.amount != null && s.to >= s.from).sort((a, b) => a.from.localeCompare(b.from));
}
const spendsOf = (l) => spends.filter((s) => s.lineId === l.id).sort((a, b) => a.position - b.position);
function spendTally(l) {
  const ss = spendsOf(l);
  if (!ss.length) return null;
  const spent = sum(ss), pending = sum(ss.filter((s) => s.pending));
  return { ss, spent, pending, diff: Math.round((spent - l.amount) * 100) / 100 };
}
function spendLine(l) {
  const t = spendTally(l);
  if (!t) return "";
  const pct = l.amount > 0 ? Math.min(100, (t.spent / l.amount) * 100) : 100;
  return `<span class="lsub spend${t.diff > 0 ? " over" : ""}">${esc(gbp.format(t.spent))} spent of ${esc(gbp.format(l.amount))} · <b>${t.diff > 0
    ? `${esc(gbp.format(t.diff))} over` : `${esc(gbp.format(-t.diff))} left`}</b>${t.pending ? ` (incl. ${esc(gbp.format(t.pending))} pending)` : ""}
    <span class="spbar"><span style="width:${pct.toFixed(1)}%"></span></span></span>`;
}
function spendBody(l) {
  const t = spendTally(l);
  const rows = (t?.ss || []).map((s) => `<li class="sprow${s.pending ? " pending" : ""}">
      <span class="spplace">${esc(s.place)}</span>
      ${s.pending ? `<button class="chip" type="button" data-spend-clear="${s.id}" title="Tap when it has gone through">Pending</button>` : ""}
      <span class="spamt">${esc(gbp.format(s.amount))}</span>
      <button class="gbtn" type="button" data-spend-del="${s.id}" aria-label="Remove ${esc(s.place)}">×</button>
    </li>`).join("");
  const total = t ? `<p class="sptot${t.diff > 0 ? " over" : ""}">Spent <b>${esc(gbp.format(t.spent))}</b> of ${esc(gbp.format(l.amount))} budgeted: <b>${t.diff > 0
    ? `${esc(gbp.format(t.diff))} over budget` : t.diff < 0 ? `${esc(gbp.format(-t.diff))} under budget` : "exactly on budget"}</b>${t.pending
    ? `<br>Includes ${esc(gbp.format(t.pending))} still pending` : ""}</p>` : `<p class="hint">Add each shop as you spend, to see if it fits the budget.</p>`;
  return `${total}<ul class="splist">${rows}</ul>
    <div class="spadd">
      <label class="sr" for="sp-place-${l.id}">Where</label>
      <input type="text" id="sp-place-${l.id}" class="spin-place" maxlength="80" placeholder="Where, e.g. Tesco" autocomplete="off">
      <label class="sr" for="sp-amt-${l.id}">Amount (£)</label>
      <input type="number" id="sp-amt-${l.id}" class="spin-amt" inputmode="decimal" min="0" step="0.01" placeholder="£">
      <label class="tick sppend"><input type="checkbox" id="sp-pend-${l.id}" class="spin-pend"> Pending</label>
      <button class="btn" type="button" data-spend-add="${l.id}">Add</button>
    </div>`;
}
function spendPicker(l) {
  if (!l || l.kind !== "out") return "";
  return `<details class="lspend"${spendsOf(l).length ? " open" : ""}>
    <summary>What we've spent</summary>
    <div class="spbody">${spendBody(l)}</div>
  </details>`;
}
function refreshSpends(lineId) {
  const box = $(`[data-line-form="${lineId}"] .spbody`), l = lines.find((x) => x.id === lineId);
  if (box && l) box.innerHTML = spendBody(l);
}
async function addSpend(lineId) {
  const box = $(`[data-line-form="${lineId}"] .spadd`);
  const place = box.querySelector(".spin-place").value.trim(), amount = toNum(box.querySelector(".spin-amt").value);
  if (!place || amount == null) { box.querySelector(place ? ".spin-amt" : ".spin-place").focus(); return; }
  const s = { id: uid(), householdId: household.id, lineId, place, amount, pending: box.querySelector(".spin-pend").checked, position: Date.now() };
  spends.push(s);
  refreshSpends(lineId);
  $(`#sp-place-${lineId}`)?.focus();
  try { await store.addSpend(s); } catch (err) { fail(err); await reload(); }
}
function lineForm(slot, l) {
  const kind = slotKind(slot);
  const id = l ? l.id : `new-${slot}`;
  return `<form class="lform" data-line-form="${id}" data-slot="${slot}">
    <label class="sr" for="ln-${id}">What</label>
    <input type="text" id="ln-${id}" class="lname" maxlength="80" placeholder="${kind === "in" ? "e.g. Salary" : "e.g. Water"}" value="${esc(l?.name)}" autocomplete="off" required>
    <label class="sr" for="la-${id}">Amount (£)</label>
    <input type="number" id="la-${id}" class="lamt" inputmode="decimal" min="0" step="0.01" placeholder="£" value="${l ? l.amount : ""}" required>
    <div class="lfq" role="radiogroup" aria-label="How often">
      <label><input type="radio" name="fq-${id}" value="monthly"${isOneOff(l || {}) ? "" : " checked"}> Monthly</label>
      <label><input type="radio" name="fq-${id}" value="one-off"${isOneOff(l || {}) ? " checked" : ""}> One-off</label>
    </div>
    <label class="sr" for="lnote-${id}">Note</label>
    <input type="text" id="lnote-${id}" class="lnote" maxlength="200" placeholder="Note, e.g. renews 30 Nov at £7.00" value="${esc(l?.note)}" autocomplete="off">
    ${spendPicker(l)}
    ${datesPicker(id, l)}
    ${planPicker(l)}
    ${iconPicker(id, l, kind)}
    <div class="row">
      <button class="btn primary" type="submit">${l ? "Save" : "Add"}</button>
      ${l ? `<button class="btn danger" type="button" data-line-delete="${l.id}">Delete</button>` : ""}
      <button class="btn quiet" type="button" data-line-cancel>Cancel</button>
    </div>
  </form>`;
}
function lineIcon(l) {
  const { icon, tone } = billIcon(l.name, l.kind, l.icon);
  return `<span class="aicon sm ${tone}">${svg(icon)}</span>`;
}
function lineList(slot, ls) {
  const rows = ls.map((l) => budgetEdit === l.id ? `<li>${lineForm(slot, l)}</li>`
    : `<li><button type="button" class="lrow${isOneOff(l) ? " once" : ""}" data-line="${l.id}">${lineIcon(l)}<span class="lname">${esc(l.name)}${l.note ? `<span class="lsub lnotes">${esc(l.note)}</span>` : ""}${spendLine(l)}${datesLine(l)}${planLine(l)}</span>${freqMark(l)}<span class="lamt">${esc(gbp.format(l.amount))}</span></button></li>`).join("");
  const label = slot === "in" ? "Money in" : slot === "out" ? "Bill" : "Item";
  return `<ul class="llist">${rows}${budgetEdit === `new-${slot}` ? `<li>${lineForm(slot)}</li>` : ""}</ul>
    ${budgetEdit === `new-${slot}` ? "" : `<button class="btn quiet ladd" type="button" data-line-new="${slot}">+ ${label}</button>`}`;
}
function bgroupForm(g) {
  const id = g ? g.id : "new";
  return `<form class="bgform" data-bgroup-form="${id}">
    <label class="sr" for="bg-${id}">Group name</label>
    <input type="text" id="bg-${id}" class="bgname" maxlength="60" placeholder="e.g. Vikki's outgoings" value="${esc(g?.name)}" autocomplete="off" required>
    ${g ? "" : `<label class="tick"><input type="checkbox" class="bgtotal" checked> Count it in the totals</label>`}
    <div class="row">
      <button class="btn primary" type="submit">${g ? "Save" : "Add group"}</button>
      ${g ? `<button class="btn danger${bgroupDeleteArmed ? " confirm" : ""}" type="button" data-bgroup-delete="${g.id}">${bgroupDeleteArmed
        ? `Tap again to delete it and its ${lines.filter((l) => l.groupId === g.id).length} items in every month` : "Delete group"}</button>` : ""}
      <button class="btn quiet" type="button" data-bgroup-cancel>Cancel</button>
    </div>
  </form>`;
}
function bgroupSect(g, all) {
  const gl = all.filter(shownLine), hidden = all.filter((l) => !shownLine(l));
  return `<div class="bsect bgroup${g.inTotal ? "" : " off"}">
    <div class="bghead">
      <h3>${esc(g.name)} <span class="cnt">${gl.length}</span></h3>
      <span class="bgsum">${esc(gbp.format(sum(gl)))}</span>
      <button class="gbtn" type="button" data-bgroup-edit="${g.id}" aria-label="Rename or delete ${esc(g.name)}">⋯</button>
    </div>
    ${bgroupEdit === g.id ? bgroupForm(g) : ""}
    <div class="bgticks">
      <label class="tick bgtick"><input type="checkbox" data-bgroup-total="${g.id}"${g.inTotal ? " checked" : ""}> Count in the totals</label>
      <label class="tick bgtick"><input type="checkbox" data-bgroup-monthly="${g.id}"${g.monthlyOnly ? " checked" : ""}> Monthly only</label>
    </div>
    ${hidden.length ? `<div class="bghidden"><p>${hidden.length} one-off${hidden.length === 1 ? "" : "s"} hidden (${esc(gbp.format(sum(hidden)))}), not in the totals:</p><ul>${hidden.map((l) => `<li><span>${esc(l.name)}</span><span>${esc(gbp.format(l.amount))}</span></li>`).join("")}</ul></div>` : ""}
    ${lineList(g.id, gl)}
  </div>`;
}
function budgetCard() {
  const m = budgetMonth;
  const ls = monthLines(m);
  const ins = ls.filter((l) => l.kind === "in");
  const outs = ls.filter((l) => l.kind === "out" && !bgroupOf(l));
  const inGroup = (g) => ls.filter((l) => l.kind === "out" && l.groupId === g.id);
  const counted = ls.filter(countedLine);
  const skipped = budgetGroups.filter((g) => !g.inTotal && inGroup(g).filter(shownLine).length);
  const tin = sum(ins), tout = sum(counted), left = Math.round((tin - tout) * 100) / 100;
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
    ${skipped.length ? `<p class="bskip">Not in these totals: ${skipped.map((g) => `${esc(g.name)} ${esc(gbp.format(sum(inGroup(g).filter(shownLine))))}`).join(" · ")}</p>` : ""}
    <div class="bsect"><div class="bghead"><h3>Coming in <span class="cnt">${ins.length}</span></h3><span class="bgsum in">${esc(gbp.format(tin))}</span></div>${lineList("in", ins)}</div>
    ${outs.length || !budgetGroups.length || budgetEdit === "new-out" ? `<div class="bsect"><div class="bghead"><h3>Going out <span class="cnt">${outs.length}</span></h3><span class="bgsum">${esc(gbp.format(sum(outs)))}</span></div>${lineList("out", outs)}</div>` : ""}
    ${budgetGroups.map((g) => bgroupSect(g, inGroup(g))).join("")}
    <div class="bsect bgnew">${bgroupEdit === "new" ? bgroupForm(null)
      : `<button class="btn quiet ladd" type="button" data-bgroup-new>+ New group of outgoings</button>`}</div>`}
  </section>`;
}

/* ---------- Savings ---------- */

const pounds = (n) => esc(gbp.format(n));
const signed = (m) => (m.kind === "in" ? m.amount : -m.amount);
const movesOf = (acc) => moves.filter((m) => m.accountId === acc.id)
  .sort((a, b) => a.on.localeCompare(b.on) || (a.created || 0) - (b.created || 0));
const balanceOf = (acc) => Math.round(movesOf(acc).reduce((s, m) => s + signed(m), 0) * 100) / 100;

function accountForm(acc) {
  const id = acc ? acc.id : "new";
  return `<form class="savform" data-sav-form="${id}">
    <label class="sr" for="sv-name-${id}">Account name</label>
    <input type="text" id="sv-name-${id}" class="svname" maxlength="60" placeholder="e.g. Nationwide ISA" value="${esc(acc?.name)}" autocomplete="off" required>
    ${acc ? "" : `<div class="svstart">
      <label>Money in it now (£)<input type="number" class="svamt" inputmode="decimal" min="0" step="0.01" placeholder="0.00"></label>
      <label>As of<input type="date" class="svdate" value="${todayIso()}"></label>
    </div>`}
    <div class="row">
      <button class="btn primary" type="submit">${acc ? "Save" : "Add account"}</button>
      ${acc ? `<button class="btn danger${savDeleteArmed ? " confirm" : ""}" type="button" data-sav-delete="${acc.id}">${savDeleteArmed
        ? `Tap again to delete it and its ${movesOf(acc).length} entries` : "Delete account"}</button>` : ""}
      <button class="btn quiet" type="button" data-sav-cancel>Cancel</button>
    </div>
  </form>`;
}
function moveForm(acc, m, kind) {
  const id = m ? m.id : `new-${kind}-${acc.id}`;
  const k = m ? m.kind : kind;
  return `<form class="mform" data-move-form="${id}" data-acc="${acc.id}">
    <div class="lfq" role="radiogroup" aria-label="In or out">
      <label><input type="radio" name="mk-${id}" value="in"${k === "in" ? " checked" : ""}> Paid in</label>
      <label><input type="radio" name="mk-${id}" value="out"${k === "out" ? " checked" : ""}> Taken out</label>
    </div>
    <label>What for<input type="text" class="mwhat" maxlength="120" placeholder="${k === "in" ? "e.g. Monthly saving" : "e.g. Holiday deposit"}" value="${esc(m?.what)}" autocomplete="off"></label>
    <label>Amount (£)<input type="number" class="mamt" inputmode="decimal" min="0" step="0.01" value="${m ? m.amount : ""}" required></label>
    <label>When<input type="date" class="mdate" value="${m ? m.on : todayIso()}" required></label>
    <div class="row">
      <button class="btn primary" type="submit">${m ? "Save" : "Add"}</button>
      ${m ? `<button class="btn danger" type="button" data-move-delete="${m.id}">Delete</button>` : ""}
      <button class="btn quiet" type="button" data-move-cancel>Cancel</button>
    </div>
  </form>`;
}
function balanceForm(acc, bal) {
  return `<form class="mform" data-bal-form="${acc.id}">
    <p class="note full">The app thinks there's ${pounds(bal)} in it. Enter what's really in it now and the difference is recorded, for example as interest.</p>
    <label>Money in it now (£)<input type="number" class="bamt" inputmode="decimal" min="0" step="0.01" value="${bal.toFixed(2)}" required></label>
    <label>As of<input type="date" class="bdate" value="${todayIso()}" required></label>
    <label class="full">What was the difference?<input type="text" class="bwhat" maxlength="120" placeholder="e.g. Interest" autocomplete="off"></label>
    <div class="row">
      <button class="btn primary" type="submit">Update</button>
      <button class="btn quiet" type="button" data-move-cancel>Cancel</button>
    </div>
  </form>`;
}
function accountCard(acc) {
  const ms = movesOf(acc);
  let run = 0;
  const rows = ms.map((m) => ({ m, bal: (run = Math.round((run + signed(m)) * 100) / 100) })).reverse();
  const all = savShowAll.has(acc.id), shown = all ? rows : rows.slice(0, 8);
  const bal = balanceOf(acc);
  const newKind = moveEdit?.startsWith("new-") && moveEdit.endsWith(acc.id) ? moveEdit.split("-")[1] : null;
  const month = todayIso().slice(0, 7);
  const tm = ms.filter((m) => m.on.startsWith(month) && m.what !== "Starting balance");
  const net = Math.round(tm.reduce((s, m) => s + signed(m), 0) * 100) / 100;
  return `<section class="pcard savacc">
    <div class="phdr">
      <span class="pname">${esc(acc.name)}</span>
      <span class="savbal${bal < 0 ? " neg" : ""}">${pounds(bal)}</span>
      <button class="gbtn" type="button" data-sav-edit="${acc.id}" aria-label="Rename or delete ${esc(acc.name)}">⋯</button>
    </div>
    ${savEdit === acc.id ? `<div class="savbody">${accountForm(acc)}</div>` : ""}
    <div class="savbody">
      ${tm.length ? `<p class="note">This month: ${net >= 0 ? "+" : "−"}${pounds(Math.abs(net))} (${tm.length} entr${tm.length === 1 ? "y" : "ies"})</p>` : ""}
      <div class="row savacts">
        <button class="btn" type="button" data-move-new="in" data-acc="${acc.id}">+ Paid in</button>
        <button class="btn" type="button" data-move-new="out" data-acc="${acc.id}">− Taken out</button>
        <button class="btn quiet" type="button" data-move-new="bal" data-acc="${acc.id}">Update balance</button>
      </div>
      ${newKind === "bal" ? balanceForm(acc, bal) : newKind ? moveForm(acc, null, newKind) : ""}
      ${rows.length ? `<ul class="mlist">${shown.map(({ m, bal: b }) => moveEdit === m.id ? `<li>${moveForm(acc, m)}</li>`
        : `<li><button type="button" class="mrow" data-move="${m.id}">
            <span class="mdate">${prettyDate(m.on, m.on.slice(0, 4) !== todayIso().slice(0, 4))}</span>
            <span class="mwhat">${esc(m.what || (m.kind === "in" ? "Paid in" : "Taken out"))}</span>
            <span class="mamt ${m.kind}">${m.kind === "in" ? "+" : "−"}${pounds(m.amount)}</span>
            <span class="mbal">${pounds(b)}</span>
          </button></li>`).join("")}</ul>
        ${rows.length > 8 ? `<button class="btn quiet" type="button" data-sav-all="${acc.id}">${all ? "Show fewer" : `Show all ${rows.length}`}</button>` : ""}`
        : `<p class="empty">Nothing recorded yet.</p>`}
    </div>
  </section>`;
}
function savingsSection(a) {
  const shown = q() ? accounts.filter((x) => x.name.toLowerCase().includes(q().toLowerCase())) : accounts;
  if (q() && !shown.length) return "";
  const shut = closedAreas.has(a.id) && !q() && savEdit !== "new";
  const total = Math.round(accounts.reduce((s, x) => s + balanceOf(x), 0) * 100) / 100;
  return `<section class="area">
    <div class="ahead">
      <button class="atoggle" type="button" data-area-toggle="${a.id}" aria-expanded="${!shut}">
        <span class="aicon ${a.id}">${svg(a.icon)}</span><h2>${esc(a.label)}</h2>
        ${accounts.length ? `<span class="savtotal">${pounds(total)}</span>` : ""}<span class="caret">${shut ? "▸" : "▾"}</span>
      </button>
      <button class="btn quiet" type="button" data-sav-new>+ Account</button></div>
    ${shut ? "" : `<div class="savlist">
      ${savEdit === "new" ? `<section class="pcard savnew"><div class="savbody">${accountForm(null)}</div></section>` : ""}
      ${shown.map(accountCard).join("")}
      ${!accounts.length && savEdit !== "new" ? `<p class="empty">No savings yet. Tap “+ Account” to add one, with how much is in it now.</p>` : ""}
    </div>`}
  </section>`;
}

function areaSection(a) {
  if (a.id === "savings") return savingsSection(a);
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
    + (id === "car" ? vehicles.length : 0) + (id === "bills" && monthLines(budgetMonth).length ? 1 : 0) + (id === "savings" ? accounts.length : 0);
  $("#areaChips").innerHTML = [{ id: "all", label: "All" }, ...AREAS].map((a) => {
    const n = a.id === "all" ? AREAS.reduce((s, x) => s + count(x.id), 0) : count(a.id);
    return `<button type="button" class="chip" data-area="${a.id}" aria-pressed="${filter.area === a.id}">${esc(a.label)} <span class="cnt">${n}</span></button>`;
  }).join("");
  const anything = items.length || groups.length || vehicles.length || lines.length || accounts.length || newGroupArea || savEdit;
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
$("#list").addEventListener("keydown", (e) => {
  const add = e.key === "Enter" && e.target.closest(".spadd");
  if (!add) return;
  e.preventDefault();
  addSpend(add.querySelector("[data-spend-add]").dataset.spendAdd);
});
$("#list").addEventListener("input", (e) => {
  const plan = e.target.closest(".lplan");
  if (plan) plan.querySelector(".psumwrap").innerHTML = planSummary(readPlan(plan));
});
$("#list").addEventListener("change", async (e) => {
  if (e.target.closest(".lplan")) return;
  const dates = e.target.closest(".ldates");
  if (dates) {
    const start = dates.querySelector(".lstart"), len = dates.querySelector(".llen"), end = dates.querySelector(".lend");
    if (e.target === end) {
      len.value = start.value && end.value && LENGTHS.includes(wholeMonths(start.value, end.value)) ? wholeMonths(start.value, end.value) : "";
    } else if (len.value && (e.target === len || start.value)) {
      if (!start.value) start.value = todayIso();
      end.value = addMonths(start.value, Number(len.value));
    }
    return;
  }
  const tot = e.target.closest("[data-bgroup-total], [data-bgroup-monthly]");
  if (tot) {
    const g = budgetGroups.find((x) => x.id === (tot.dataset.bgroupTotal || tot.dataset.bgroupMonthly));
    const patch = tot.dataset.bgroupTotal ? { inTotal: tot.checked } : { monthlyOnly: tot.checked };
    Object.assign(g, patch);
    renderHome();
    try { await store.updateBudgetGroup(g.id, patch); } catch (err) { fail(err); await reload(); }
    return;
  }
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
  if ((b = t("[data-plan-add]"))) {
    const box = b.closest(".lplan"), last = readPlan(box).at(-1);
    const from = last ? addMonths(last.to, 1) : b.closest("form").querySelector(".lstart").value || todayIso();
    box.querySelector(".pstages").insertAdjacentHTML("beforeend", planStage({ from }));
    box.querySelector(".pstage:last-child .pto").focus();
    return;
  }
  if ((b = t("[data-sav-new]"))) { savEdit = "new"; savDeleteArmed = false; renderHome(); $(".savform .svname")?.focus(); return; }
  if ((b = t("[data-sav-edit]"))) { savEdit = savEdit === b.dataset.savEdit ? null : b.dataset.savEdit; savDeleteArmed = false; return renderHome(); }
  if ((b = t("[data-sav-cancel]"))) { savEdit = null; savDeleteArmed = false; return renderHome(); }
  if ((b = t("[data-sav-all]"))) { toggle(savShowAll, b.dataset.savAll); return renderHome(); }
  if ((b = t("[data-sav-delete]"))) {
    if (!savDeleteArmed) { savDeleteArmed = true; return renderHome(); }
    const id = b.dataset.savDelete;
    accounts = accounts.filter((a) => a.id !== id);
    moves = moves.filter((m) => m.accountId !== id);
    savEdit = null; savDeleteArmed = false;
    renderHome();
    try { await store.deleteAccount(id); } catch (err) { fail(err); await reload(); }
    return;
  }
  if ((b = t("[data-move-new]"))) {
    moveEdit = `new-${b.dataset.moveNew}-${b.dataset.acc}`;
    renderHome();
    $(`[data-move-form="${moveEdit}"] .mwhat`)?.focus();
    $(`[data-bal-form="${b.dataset.acc}"] .bamt`)?.select();
    return;
  }
  if ((b = t("[data-move]"))) { moveEdit = b.dataset.move; return renderHome(); }
  if ((b = t("[data-move-cancel]"))) { moveEdit = null; return renderHome(); }
  if ((b = t("[data-move-delete]"))) {
    const m = moves.find((x) => x.id === b.dataset.moveDelete);
    moves = moves.filter((x) => x !== m);
    moveEdit = null;
    renderHome();
    try {
      await store.deleteMove(m.id);
      toast("Entry deleted", { label: "Undo", run: async () => {
        moves.push(m); renderHome();
        try { await store.addMove(m); } catch (err) { fail(err); await reload(); }
      } });
    } catch (err) { fail(err); await reload(); }
    return;
  }
  if ((b = t("[data-spend-add]"))) return addSpend(b.dataset.spendAdd);
  if ((b = t("[data-spend-del]")) || (b = t("[data-spend-clear]"))) {
    const s = spends.find((x) => x.id === (b.dataset.spendDel || b.dataset.spendClear));
    if (!s) return;
    if (b.dataset.spendDel) spends = spends.filter((x) => x !== s); else s.pending = false;
    refreshSpends(s.lineId);
    try {
      if (b.dataset.spendDel) {
        await store.deleteSpend(s.id);
        toast(`Removed ${s.place}`, { label: "Undo", run: async () => {
          spends.push(s); refreshSpends(s.lineId);
          try { await store.addSpend(s); } catch (err) { fail(err); await reload(); }
        } });
      } else await store.updateSpend(s.id, { pending: false });
    } catch (err) { fail(err); await reload(); }
    return;
  }
  if ((b = t("[data-plan-remove]"))) {
    const box = b.closest(".lplan");
    b.closest(".pstage").remove();
    box.querySelector(".psumwrap").innerHTML = planSummary(readPlan(box));
    return;
  }
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
    const copy = monthLines(b.dataset.monthCopy).filter((l) => !isOneOff(l)).map((l, n) => ({ ...l, id: uid(), month: budgetMonth, position: Date.now() + n }));
    lines.push(...copy);
    renderHome();
    try { await store.addLines(copy); toast(`Copied ${copy.length} lines into ${monthLabel(budgetMonth)}`); } catch (err) { fail(err); await reload(); }
    return;
  }
  if ((b = t("[data-line]"))) { budgetEdit = b.dataset.line; renderHome(); return focusLineForm(); }
  if ((b = t("[data-line-new]"))) { budgetEdit = `new-${b.dataset.lineNew}`; renderHome(); return focusLineForm(); }
  if (t("[data-line-cancel]")) { budgetEdit = null; return renderHome(); }
  if (t("[data-bgroup-new]")) { bgroupEdit = "new"; renderHome(); return $(".bgname")?.focus(); }
  if ((b = t("[data-bgroup-edit]"))) {
    bgroupEdit = bgroupEdit === b.dataset.bgroupEdit ? null : b.dataset.bgroupEdit;
    bgroupDeleteArmed = false;
    return renderHome();
  }
  if (t("[data-bgroup-cancel]")) { bgroupEdit = null; bgroupDeleteArmed = false; return renderHome(); }
  if ((b = t("[data-bgroup-delete]"))) {
    if (!bgroupDeleteArmed) { bgroupDeleteArmed = true; return renderHome(); }
    const g = budgetGroups.find((x) => x.id === b.dataset.bgroupDelete);
    budgetGroups = budgetGroups.filter((x) => x.id !== g.id);
    lines = lines.filter((l) => l.groupId !== g.id);
    bgroupEdit = null;
    bgroupDeleteArmed = false;
    renderHome();
    try { await store.deleteBudgetGroup(g.id); toast(`Deleted ${g.name}`); } catch (err) { fail(err); await reload(); }
    return;
  }
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
  const sf = e.target.closest("[data-sav-form]");
  if (sf) {
    e.preventDefault();
    const name = sf.querySelector(".svname").value.trim();
    if (!name) return;
    const id = sf.dataset.savForm;
    savEdit = null;
    savDeleteArmed = false;
    try {
      if (id === "new") {
        const acc = { id: uid(), householdId: household.id, name, position: Date.now() };
        const start = toNum(sf.querySelector(".svamt").value);
        accounts.push(acc);
        closedAreas.delete("savings"); saveUi();
        const m = start ? { id: uid(), householdId: household.id, accountId: acc.id, on: sf.querySelector(".svdate").value || todayIso(), kind: "in",
          amount: start, what: "Starting balance", created: Date.now() } : null;
        if (m) moves.push(m);
        renderHome();
        await store.addAccount(acc);
        if (m) await store.addMove(m);
      } else {
        accounts.find((a) => a.id === id).name = name;
        renderHome();
        await store.updateAccount(id, { name });
      }
    } catch (err) { fail(err); await reload(); }
    return;
  }
  const bf2 = e.target.closest("[data-bal-form]");
  if (bf2) {
    e.preventDefault();
    const acc = accounts.find((a) => a.id === bf2.dataset.balForm), now = toNum(bf2.querySelector(".bamt").value);
    if (!acc || now == null) return;
    const diff = Math.round((now - balanceOf(acc)) * 100) / 100;
    moveEdit = null;
    if (!diff) { renderHome(); toast("That's already the balance"); return; }
    const m = { id: uid(), householdId: household.id, accountId: acc.id, created: Date.now(), on: bf2.querySelector(".bdate").value || todayIso(),
      kind: diff > 0 ? "in" : "out", amount: Math.abs(diff), what: bf2.querySelector(".bwhat").value.trim() || "Balance updated" };
    moves.push(m);
    renderHome();
    toast(`${acc.name} is now ${gbp.format(now)}`);
    try { await store.addMove(m); } catch (err) { fail(err); await reload(); }
    return;
  }
  const mf = e.target.closest("[data-move-form]");
  if (mf) {
    e.preventDefault();
    const id = mf.dataset.moveForm, amount = toNum(mf.querySelector(".mamt").value);
    if (amount == null) return;
    const patch = {
      kind: mf.querySelector(`input[name="mk-${id}"]:checked`).value, amount,
      what: mf.querySelector(".mwhat").value.trim() || null, on: mf.querySelector(".mdate").value || todayIso(),
    };
    moveEdit = null;
    try {
      const existing = moves.find((m) => m.id === id);
      if (existing) {
        Object.assign(existing, patch);
        renderHome();
        await store.updateMove(id, patch);
      } else {
        const m = { id: uid(), householdId: household.id, accountId: mf.dataset.acc, created: Date.now(), ...patch };
        moves.push(m);
        renderHome();
        toast(`${patch.kind === "in" ? "Paid in" : "Taken out"} ${gbp.format(amount)}`);
        await store.addMove(m);
      }
    } catch (err) { fail(err); await reload(); }
    return;
  }
  const lf = e.target.closest("[data-line-form]");
  if (lf) {
    e.preventDefault();
    const name = lf.querySelector(".lname").value.trim();
    const amount = toNum(lf.querySelector(".lamt").value);
    if (!name || amount == null) return;
    const id = lf.dataset.lineForm, slot = lf.dataset.slot;
    const icon = lf.querySelector(`input[name="ic-${id}"]:checked`)?.value || null;
    const frequency = lf.querySelector(`input[name="fq-${id}"]:checked`)?.value || "monthly";
    const plan = readPlan(lf);
    const startedOn = lf.querySelector(".lstart").value || plan[0]?.from || null;
    const endsOn = lf.querySelector(".lend").value || plan.at(-1)?.to || null;
    const remind = lf.querySelector(".lremind").checked;
    const note = lf.querySelector(".lnote").value.trim() || null;
    if (startedOn && endsOn && endsOn < startedOn) { toast("The expiry date is before the start date"); return; }
    const existing = lines.find((l) => l.id === id);
    budgetEdit = null;
    try {
      if (existing) {
        const patch = { name, amount, icon, frequency, startedOn, remind, plan, note };
        if (endsOn !== (existing.endsOn || null)) patch.endsOn = endsOn;
        Object.assign(existing, patch);
        renderHome();
        if (!shownLine(existing)) toast(`${name} is hidden because ${bgroupOf(existing).name} is set to Monthly only`);
        await store.updateLine(id, patch);
      } else {
        const groupId = slot === "in" || slot === "out" ? null : slot;
        const l = { id: uid(), householdId: household.id, month: budgetMonth, kind: slotKind(slot), name, amount, position: Date.now(),
          groupId, icon, frequency, startedOn, endsOn, remind, plan, note };
        lines.push(l);
        budgetEdit = `new-${slot}`;
        renderHome();
        if (!shownLine(l)) toast(`${name} is hidden because ${bgroupOf(l).name} is set to Monthly only`);
        focusLineForm();
        await store.addLines([l]);
      }
    } catch (err) { fail(err); await reload(); }
    return;
  }
  const bf = e.target.closest("[data-bgroup-form]");
  if (bf) {
    e.preventDefault();
    const name = bf.querySelector(".bgname").value.trim();
    if (!name) return;
    const id = bf.dataset.bgroupForm;
    bgroupEdit = null;
    bgroupDeleteArmed = false;
    try {
      if (id === "new") {
        const g = { id: uid(), householdId: household.id, name, inTotal: bf.querySelector(".bgtotal").checked, position: Date.now() };
        budgetGroups.push(g);
        budgetEdit = `new-${g.id}`;
        renderHome();
        focusLineForm();
        await store.addBudgetGroup(g);
      } else {
        const g = budgetGroups.find((x) => x.id === id);
        g.name = name;
        renderHome();
        await store.updateBudgetGroup(id, { name });
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

$("#fCategory").innerHTML = AREAS.filter((a) => CATEGORIES.some((c) => c.area === a.id)).map((a) => `<optgroup label="${esc(a.label)}">${CATEGORIES.filter((c) => c.area === a.id)
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
  if (household?.shareCode) {
    $("#shareCode").textContent = household.shareCode;
    $("#inviteLink").textContent = inviteUrl();
    $("#sharebox").hidden = false;
  }
  if (!store.demo && household) {
    store.people(household.id).then((ps) => {
      $("#people").innerHTML = ps.map((p) => `<li><span class="aicon sm plain">${esc((p.email || "?")[0].toUpperCase())}</span>
        <span>${esc(p.email)}${p.is_me ? " <span class=\"cnt\">(you)</span>" : ""}<br><span class="note">Joined ${prettyDate(p.joined_at.slice(0, 10))}</span></span></li>`).join("");
    }).catch(console.warn);
  }
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
const inviteUrl = () => `${location.origin}/?join=${household.shareCode}`;
$("#shareMake").onclick = async () => {
  try {
    household.shareCode = await store.shareCode(household.id);
    renderSettings();
  } catch (err) { fail(err); }
};
$("#inviteSend").onclick = async () => {
  try {
    household.shareCode ||= await store.shareCode(household.id);
    renderSettings();
    const text = `Join our Home Tracker so we can both see and update the house stuff, bills and budget. Open the link, tap "New here? Create an account", then say yes to joining. Code if asked: ${household.shareCode}`;
    if (navigator.share) {
      try { await navigator.share({ title: "Join our Home Tracker", text, url: inviteUrl() }); } catch (err) { if (err.name !== "AbortError") throw err; }
    } else {
      await navigator.clipboard.writeText(`${text}\n${inviteUrl()}`);
      toast("Invite copied. Paste it into a text or WhatsApp");
    }
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

$("#exportBackup").onclick = async () => {
  const btn = $("#exportBackup");
  btn.disabled = true;
  try {
    const X = await import("xlsx");
    const uk = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
    const sheet = (rows, widths) => { const ws = X.utils.aoa_to_sheet(rows); ws["!cols"] = widths.map((wch) => ({ wch })); return ws; };
    const wb = X.utils.book_new();

    const head = ["Area", "Group", "Vehicle", "Type", "Name", "Status", "Provider", "Covers", "Policy or account number", "Cost (£)", "Paid",
      "Started", "Renewal or expiry date", "Remind on", "Auto-renews", "Phone", "Website", "Notes", "Documents"];
    const rows = items.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || byNewest(a, b)).map((i) => [
      areaById(areaIdOf(i)).label, groupOf(i)?.name || "", vehicleById(groupOf(i)?.vehicleId)?.registration || "",
      category(i.category).label, i.title,
      i.groupId ? (i.archivedAt ? "Past" : "Current") : (i.archivedAt ? "Archived" : ""),
      i.provider || "", i.covers || "", i.reference || "", i.cost ?? "", i.frequency, uk(i.startDate), uk(i.renewalDate), uk(i.remindOn),
      i.autoRenew ? "Yes" : "No", i.phone || "", i.website || "", i.notes || "", i.docs.map((d) => d.name).join(", "),
    ]);
    X.utils.book_append_sheet(wb, sheet([head, ...rows], [10, 22, 10, 22, 22, 9, 20, 30, 22, 9, 9, 11, 11, 11, 6, 14, 20, 60, 30]), "Renewals");

    const months = [...new Set(lines.map((l) => l.month))].sort().reverse();
    const summary = months.map((m) => {
      const ls = monthLines(m), tin = sum(ls.filter((l) => l.kind === "in"));
      const tout = sum(ls.filter(countedLine));
      return [monthLabel(m), tin, tout, Math.round((tin - tout) * 100) / 100];
    });
    X.utils.book_append_sheet(wb, sheet([["Month", "Coming in (£)", "Going out (£)", "Left over (£)"], ...summary], [16, 14, 14, 14]), "Budget by month");
    const budget = months.flatMap((m) => monthLines(m).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "in" ? -1 : 1))
      .map((l) => [monthLabel(m), l.kind === "in" ? "Coming in" : "Going out", bgroupOf(l)?.name || "", l.name, l.amount,
        isOneOff(l) ? "One-off" : "Monthly", l.kind === "in" || countedLine(l) ? "Yes" : "No",
        l.startedOn ? prettyDate(l.startedOn) : "", l.endsOn ? prettyDate(l.endsOn) : "", l.note || ""]));
    X.utils.book_append_sheet(wb, sheet([["Month", "In or out", "Group", "What", "Amount (£)", "How often", "In the totals", "Started", "Expires", "Note"], ...budget],
      [16, 11, 22, 24, 11, 11, 12, 13, 13, 40]), "Budget lines");
    const spent = [...lines].sort((a, b) => a.month.localeCompare(b.month) || a.position - b.position)
      .flatMap((l) => spendsOf(l).map((s) => [monthLabel(l.month), l.name, s.place, s.amount, s.pending ? "Yes" : ""]));
    if (spent.length) X.utils.book_append_sheet(wb, sheet([["Month", "Budget", "Where", "Amount (£)", "Pending"], ...spent], [16, 22, 24, 11, 9]), "Spending");
    const saved = accounts.flatMap((acc) => { let run = 0; return movesOf(acc).map((m) => [acc.name, uk(m.on), m.kind === "in" ? "Paid in" : "Taken out",
      m.what || "", signed(m), (run = Math.round((run + signed(m)) * 100) / 100)]); });
    if (saved.length) X.utils.book_append_sheet(wb, sheet([["Account", "Date", "In or out", "What for", "Amount (£)", "Balance (£)"], ...saved], [22, 12, 11, 30, 11, 12]), "Savings");

    const vrows = vehicles.flatMap((v) => [
      ...[["Registration", v.registration], ["Make", v.make], ["Model", v.model], ["Nickname", v.nickname]].filter(([, x]) => x),
      ...v.details.map((d) => [d.label, d.value]),
      ...(v.notes ? [["Notes", v.notes]] : []),
      ["", ""],
    ].map(([k, x]) => [k ? v.registration : "", k, x]));
    if (vrows.length) X.utils.book_append_sheet(wb, sheet([["Vehicle", "Detail", "Value"], ...vrows], [12, 32, 50]), "Vehicles");

    X.writeFile(wb, `home-tracker-backup-${todayIso()}.xlsx`, { compression: true });
    toast("Backup downloaded");
  } catch (err) { fail(err); }
  btn.disabled = false;
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
  ({ items, groups, vehicles, lines, budgetGroups, spends, accounts, moves } = await store.load(household.id));
  budgetMonth ??= todayIso().slice(0, 8) + "01";
  if (!$("#home").hidden) {
    /* Syncing redraws the list, so keep anything half-typed in a spending row and where the cursor was. */
    const typed = [...document.querySelectorAll(".spadd input")].map((i) => [i.id, i.type === "checkbox" ? i.checked : i.value]);
    const focused = document.activeElement?.id;
    renderHome();
    for (const [id, v] of typed) { const i = document.getElementById(id); if (i) i[i.type === "checkbox" ? "checked" : "value"] = v; }
    if (focused) document.getElementById(focused)?.focus();
  }
  if (editing && !$("#itemSheet").hidden) { if (sheetItem()) renderDocs(); else closeItem(); }
}

/* An invite link (?join=CODE) is kept until they've signed in, which may be after confirming their email. */
const JOIN_KEY = "home-tracker-join";
{
  const code = new URLSearchParams(location.search).get("join");
  if (code) { localStorage.setItem(JOIN_KEY, code.trim().toUpperCase()); history.replaceState(null, "", location.pathname); }
}
function inviteWelcome() {
  if (!localStorage.getItem(JOIN_KEY)) return;
  $("#authInvite").hidden = false;
  if (!signingUp) $("#authToggle").click();
}
async function acceptInvite() {
  const code = localStorage.getItem(JOIN_KEY);
  if (!code) return;
  localStorage.removeItem(JOIN_KEY);
  if (household.shareCode === code) return;
  if (!confirm("You've been invited to share a Home Tracker. Join it now? You'll both see and edit the same renewals, bills, budget and holidays.")) return;
  try {
    await store.join(code);
    await reload();
    toast(`You've joined ${household.name}`);
  } catch (err) { fail(err); }
}

let syncTimer = null;
async function start(s) {
  session = s;
  if (!s) { show("auth"); inviteWelcome(); return; }
  try {
    await reload();
  } catch (err) {
    fail(err);
    return;
  }
  show("home");
  await acceptInvite();
  store.subscribe(() => { clearTimeout(syncTimer); syncTimer = setTimeout(() => reload().catch(console.warn), 400); });
  push.resync(store);
  const want = new URLSearchParams(location.search).get("item");
  if (want) openItem(want);
  const line = new URLSearchParams(location.search).get("line");
  if (line) openLine(line);
}
function openLine(id) {
  history.replaceState(null, "", location.pathname);
  const l = lines.find((x) => x.id === id);
  if (!l) return;
  budgetMonth = l.month;
  budgetEdit = l.id;
  if (closedAreas.has("bills")) toggle(closedAreas, "bills");
  renderHome();
  $(`[data-line-form="${id}"]`)?.scrollIntoView({ block: "center" });
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
    const line = url?.searchParams.get("line");
    if (line) openLine(line);
  });
}
/* Dates like "In 3 days" go stale overnight. */
document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("#home").hidden) renderHome(); });
