import "./style.css";
import { store } from "./store.js";
import * as push from "./push.js";
import { AREAS, CATEGORIES, FREQUENCIES, category, areaOf, perYear, guessCategory } from "./categories.js";
import { FIELDS, parseTable, guessMapping, rowsToItems, toCsv } from "./csv.js";

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
const openHistory = new Set();
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
const yearly = (it) => (it.archivedAt || it.cost == null ? 0 : it.cost * perYear(it.frequency));
const toNum = (s) => (s.trim() === "" ? null : Math.round(parseFloat(s) * 100) / 100);

/* ---------- Groups ---------- */

const groupById = (id) => groups.find((g) => g.id === id);
const groupOf = (i) => (i.groupId ? groupById(i.groupId) : null);
const areaIdOf = (i) => groupOf(i)?.area || areaOf(i.category).id;
const areaById = (id) => AREAS.find((a) => a.id === id);
const nameOf = (i) => groupOf(i)?.name || i.title;
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

function renderTotals() {
  const live = items.filter((i) => !i.archivedAt);
  if (!live.length && !groups.length) {
    $("#totals").innerHTML = `
      <div class="welcome">
        <h2>Let's get everything in one place</h2>
        <p class="sub">Start a group for each thing you pay for, like “Buildings and contents” or “Gas and electricity”, then add who you're with now and who you've used before.</p>
        <div class="row"><button class="btn primary" type="button" data-new-group="home">+ Start a group</button>
        <button class="btn" type="button" data-nav="import">Import from Google Sheets</button></div>
      </div>`;
    return;
  }
  const total = live.reduce((s, i) => s + yearly(i), 0);
  const byArea = AREAS.map((a) => ({ ...a, sum: live.filter((i) => areaIdOf(i) === a.id).reduce((s, i) => s + yearly(i), 0) }))
    .filter((a) => a.sum > 0);
  const missing = live.filter((i) => i.cost == null).length;
  $("#totals").innerHTML = `
    <p class="tlabel">Costs a year</p>
    <p class="tbig">${gbp0.format(total)}</p>
    <p class="sub">About ${gbp0.format(total / 12)} a month${missing ? ` · ${missing} without a price` : ""}</p>
    <div class="bars">${byArea.map((a) => `
      <div class="bar"><span class="aicon sm ${a.id}">${svg(a.icon)}</span><span class="blabel">${esc(a.label)}</span>
        <span class="btrack"><i class="${a.id}" style="width:${Math.max(3, (a.sum / (total || 1)) * 100).toFixed(1)}%"></i></span>
        <span class="bval">${gbp0.format(a.sum)}</span></div>`).join("")}
    </div>`;
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
  const sum = current.reduce((s, i) => s + yearly(i), 0);
  const open = openHistory.has(g.id) || (q() && past.some(textMatch));
  const renaming = editingGroup === g.id;
  return `<section class="pcard gcard">
    <div class="phdr"><span class="pname">${esc(g.name)}</span>
      <span class="pmeta">${sum ? `${gbp0.format(sum)} a year` : ""}</span>
      <button class="gbtn" type="button" data-group-menu="${g.id}" aria-label="Rename or delete ${esc(g.name)}">⋯</button></div>
    ${renaming ? `<form class="gedit" data-group-rename="${g.id}">
      <label class="sr" for="gname-${g.id}">Group name</label>
      <input type="text" id="gname-${g.id}" value="${esc(g.name)}" maxlength="60">
      <div class="row"><button class="btn primary" type="submit">Save</button>
        <button class="btn danger${groupDeleteArmed ? " confirm" : ""}" type="button" data-group-delete="${g.id}">${groupDeleteArmed ? `Tap again to delete it and its ${all.length} entr${all.length === 1 ? "y" : "ies"}` : "Delete group"}</button>
        <button class="btn quiet" type="button" data-group-cancel>Cancel</button></div>
    </form>` : ""}
    <div class="gbody">
      <h3>Current</h3>
      ${current.length ? current.map(currentRow).join("") : `<p class="empty">No current provider yet.</p>`}
      <div class="row">
        ${current.length ? `<button class="btn" type="button" data-renew="${current[0].id}">Renew or switch</button>`
          : `<button class="btn primary" type="button" data-add-entry="${g.id}">+ Current provider</button>`}
        <button class="btn quiet" type="button" data-add-past="${g.id}">+ Past provider</button>
      </div>
    </div>
    ${past.length ? `<div class="ghist">
      <button class="hfold" type="button" data-history="${g.id}" aria-expanded="${open}"><span class="caret">${open ? "▾" : "▸"}</span> History <span class="cnt">${past.length}</span></button>
      ${open ? `<ul class="hlist">${past.map(pastRow).join("")}</ul>` : ""}
    </div>` : ""}
  </section>`;
}

function areaSection(a) {
  const gs = groups.filter((g) => g.area === a.id && groupMatches(g));
  const loose = items.filter((i) => !i.groupId && !i.archivedAt && areaIdOf(i) === a.id && (!q() || textMatch(i))).sort(sortItems);
  const adding = newGroupArea === a.id;
  if (q() && !gs.length && !loose.length) return "";
  const sum = items.filter((i) => !i.archivedAt && areaIdOf(i) === a.id).reduce((s, i) => s + yearly(i), 0);
  return `<section class="area">
    <div class="ahead"><span class="aicon ${a.id}">${svg(a.icon)}</span><h2>${esc(a.label)}</h2>
      <span class="pmeta">${sum ? `${gbp0.format(sum)} a year` : ""}</span>
      <button class="btn quiet" type="button" data-new-group="${a.id}">+ Group</button></div>
    ${adding ? `<form class="inline-form" id="groupForm">
      <label class="sr" for="groupName">Group name</label>
      <input type="text" id="groupName" maxlength="60" placeholder="e.g. Buildings and contents" autocomplete="off">
      <button class="btn primary" type="submit">Create</button>
      <button class="btn quiet" type="button" data-group-cancel>Cancel</button>
    </form>` : ""}
    <div class="glist">
      ${gs.map(groupCard).join("")}
      ${loose.length ? `<section class="pcard">
        <div class="phdr"><span class="pname">${gs.length ? "Not in a group" : "Items"}</span>
          <button class="btn quiet addin" type="button" data-add="${a.id}">+ Add</button></div>
        <ul class="irows">${loose.map(itemRow).join("")}</ul></section>` : ""}
      ${!gs.length && !loose.length && !adding ? `<p class="empty">No groups yet. Tap “+ Group” to start one.</p>` : ""}
    </div>
  </section>`;
}

function renderHome() {
  $("#homeName").textContent = (household?.name || "Home tracker").toUpperCase();
  document.title = household?.name || "Home Tracker";
  renderTotals();
  renderComing();
  const count = (id) => groups.filter((g) => g.area === id).length + items.filter((i) => !i.groupId && !i.archivedAt && areaIdOf(i) === id).length;
  $("#areaChips").innerHTML = [{ id: "all", label: "All" }, ...AREAS].map((a) => {
    const n = a.id === "all" ? AREAS.reduce((s, x) => s + count(x.id), 0) : count(a.id);
    return `<button type="button" class="chip" data-area="${a.id}" aria-pressed="${filter.area === a.id}">${esc(a.label)} <span class="cnt">${n}</span></button>`;
  }).join("");
  const anything = items.length || groups.length || newGroupArea;
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
  if ((b = t("[data-history]"))) {
    const id = b.dataset.history;
    if (openHistory.has(id)) openHistory.delete(id); else openHistory.add(id);
    return renderHome();
  }
  if ((b = t("[data-new-group]"))) {
    newGroupArea = b.dataset.newGroup;
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
  if (e.target.id === "groupForm") {
    e.preventDefault();
    const name = $("#groupName").value.trim();
    if (!name) return;
    const g = { id: uid(), householdId: household.id, area: newGroupArea, name, position: Date.now() };
    groups.push(g);
    newGroupArea = null;
    renderHome();
    try {
      await store.addGroup(g);
      toast(`Created ${name}`, { label: "Add current provider", run: () => openItem(null, { groupId: g.id }) });
    } catch (err) { fail(err); await reload(); }
  }
  const rename = e.target.closest("[data-group-rename]");
  if (rename) {
    e.preventDefault();
    const g = groupById(rename.dataset.groupRename);
    const name = rename.querySelector("input").value.trim();
    if (!name) return;
    g.name = name;
    editingGroup = null;
    renderHome();
    try { await store.updateGroup(g.id, { name }); } catch (err) { fail(err); await reload(); }
  }
});

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
  ({ items, groups } = await store.load(household.id));
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
