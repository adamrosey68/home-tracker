import "./style.css";
import { store } from "./store.js";
import * as push from "./push.js";
import { AREAS, CATEGORIES, FREQUENCIES, category, areaOf, perYear } from "./categories.js";
import { FIELDS, parseTable, guessMapping, rowsToItems, toCsv } from "./csv.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const uid = () => crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
const svg = (paths) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

let session = null;
let household = null;
let items = [];
let filter = { area: "all", q: "" };
let showArchive = false;
let editing = null;
let deleteArmed = false;
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
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const gbp0 = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const money = (n) => (Number.isInteger(n) ? gbp0 : gbp).format(n);
const PER = { monthly: "/month", quarterly: "/quarter", yearly: "/year", "one-off": "" };
const costLabel = (it) => (it.cost == null ? "" : money(it.cost) + PER[it.frequency]);
const yearly = (it) => (it.archivedAt || it.cost == null ? 0 : it.cost * perYear(it.frequency));

function when(days) {
  if (days < -1) return `${-days} days overdue`;
  if (days === -1) return "1 day overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days < 60) return `In ${days} days`;
  return null;
}
function dateBadge(it) {
  if (!it.renewalDate) return '<span class="badge plain">No date</span>';
  const days = daysUntil(it.renewalDate);
  const cls = days < 0 ? "late" : days <= 7 ? "today" : days <= it.remindDays ? "" : "plain";
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
  if (!live.length) {
    $("#totals").innerHTML = `
      <div class="welcome">
        <h2>Let's get everything in one place</h2>
        <p class="sub">Add your insurance, bills, MOT and car tax, or bring them in from your Google Sheet.</p>
        <div class="row"><button class="btn primary" type="button" data-add="">+ Add the first one</button>
        <button class="btn" type="button" data-nav="import">Import from Google Sheets</button></div>
      </div>`;
    return;
  }
  const total = live.reduce((s, i) => s + yearly(i), 0);
  const byArea = AREAS.map((a) => ({ ...a, sum: live.filter((i) => areaOf(i.category).id === a.id).reduce((s, i) => s + yearly(i), 0) }))
    .filter((a) => a.sum > 0);
  const missing = live.filter((i) => i.cost == null).length;
  $("#totals").innerHTML = `
    <p class="tlabel">Costs a year</p>
    <p class="tbig">${gbp0.format(total)}</p>
    <p class="sub">About ${gbp0.format(total / 12)} a month${missing ? ` · ${missing} without a price` : ""}</p>
    <div class="bars">${byArea.map((a) => `
      <div class="bar"><span class="aicon sm ${a.id}">${svg(a.icon)}</span><span class="blabel">${esc(a.label)}</span>
        <span class="btrack"><i class="${a.id}" style="width:${Math.max(3, (a.sum / total) * 100).toFixed(1)}%"></i></span>
        <span class="bval">${gbp0.format(a.sum)}</span></div>`).join("")}
    </div>`;
}

function renderComing() {
  const dated = items.filter((i) => !i.archivedAt && i.renewalDate).sort((a, b) => a.renewalDate.localeCompare(b.renewalDate));
  const soon = dated.filter((i) => daysUntil(i.renewalDate) <= Math.max(60, i.remindDays));
  const next = dated.find((i) => daysUntil(i.renewalDate) >= 0);
  if (!items.some((i) => !i.archivedAt)) { $("#coming").hidden = true; return; }
  $("#coming").hidden = false;
  const late = soon.filter((i) => daysUntil(i.renewalDate) < 0).length;
  $("#coming").innerHTML = `
    <div class="dhead"><h3>Coming up</h3>${late ? `<span class="badge late">${late} overdue</span>` : ""}</div>
    ${soon.length ? `<ul class="clist">${soon.map((i) => `
      <li><button type="button" data-open="${i.id}">
        <span class="aicon sm ${areaOf(i.category).id}">${svg(areaOf(i.category).icon)}</span>
        <span class="cbody"><span class="ctitle">${esc(i.title)}</span><span class="csub">${esc([i.provider, prettyDate(i.renewalDate, false)].filter(Boolean).join(" · "))}</span></span>
        ${dateBadge(i)}
      </button></li>`).join("")}</ul>`
    : `<p class="empty">Nothing due in the next 60 days.${next ? ` Next up: ${esc(next.title)} on ${esc(prettyDate(next.renewalDate))}.` : ""}</p>`}`;
}

function itemRow(i) {
  const sub = [i.provider, i.covers].filter(Boolean).join(" · ");
  return `<li><button type="button" class="irow" data-open="${i.id}">
    <span class="ibody"><span class="ititle">${esc(i.title)}</span>${sub ? `<span class="isub">${esc(sub)}</span>` : ""}</span>
    <span class="iright">${dateBadge(i)}${i.cost != null ? `<span class="icost">${esc(costLabel(i))}</span>` : ""}</span>
    ${i.docs.length ? `<span class="idocs" title="${i.docs.length} document${i.docs.length === 1 ? "" : "s"}">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path>')}</span>` : ""}
  </button></li>`;
}
const sortItems = (a, b) => (a.renewalDate || "9999").localeCompare(b.renewalDate || "9999") || a.title.localeCompare(b.title);

function matches(i) {
  if (filter.area !== "all" && areaOf(i.category).id !== filter.area) return false;
  const q = filter.q.trim().toLowerCase();
  if (!q) return true;
  return [i.title, i.provider, i.covers, i.reference, i.notes, category(i.category).label].some((v) => v && v.toLowerCase().includes(q));
}

function areaCards(list, emptyText) {
  const cards = AREAS.map((a) => {
    const its = list.filter((i) => areaOf(i.category).id === a.id).sort(sortItems);
    if (!its.length) return "";
    const sum = its.reduce((s, i) => s + yearly(i), 0);
    return `<section class="pcard">
      <div class="phdr"><span class="aicon ${a.id}">${svg(a.icon)}</span><span class="pname">${esc(a.label)}</span>
        <span class="pmeta">${sum ? `${gbp0.format(sum)} a year` : ""}</span>
        <button class="btn quiet addin" type="button" data-add="${a.id}" aria-label="Add to ${esc(a.label)}">+ Add</button></div>
      <ul class="irows">${its.map(itemRow).join("")}</ul>
    </section>`;
  }).join("");
  return cards || `<p class="empty">${esc(emptyText)}</p>`;
}

function renderHome() {
  $("#homeName").textContent = (household?.name || "Home tracker").toUpperCase();
  document.title = household?.name || "Home Tracker";
  renderTotals();
  renderComing();
  const live = items.filter((i) => !i.archivedAt);
  $("#areaChips").innerHTML = [{ id: "all", label: "All" }, ...AREAS].map((a) => {
    const n = a.id === "all" ? live.length : live.filter((i) => areaOf(i.category).id === a.id).length;
    return `<button type="button" class="chip" data-area="${a.id}" aria-pressed="${filter.area === a.id}">${esc(a.label)} <span class="cnt">${n}</span></button>`;
  }).join("");
  $(".filters").hidden = !live.length;
  $("#list").innerHTML = live.length ? areaCards(live.filter(matches), "Nothing matches that search.") : "";
  const arch = items.filter((i) => i.archivedAt);
  $("#archiveWrap").hidden = !arch.length;
  $("#toggleArchive").textContent = `${showArchive ? "Hide" : "Show"} archived (${arch.length})`;
  $("#archiveList").hidden = !showArchive;
  if (showArchive) $("#archiveList").innerHTML = areaCards(arch.filter(matches), "Nothing archived matches that search.");
}

$("#search").addEventListener("input", (e) => { filter.q = e.target.value; renderHome(); });
$("#areaChips").addEventListener("click", (e) => {
  const b = e.target.closest("[data-area]");
  if (b) { filter.area = b.dataset.area; renderHome(); }
});
$("#toggleArchive").onclick = () => { showArchive = !showArchive; renderHome(); };
$("#addItem").onclick = () => openItem(null);
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]");
  if (open) return openItem(open.dataset.open);
  const add = e.target.closest("[data-add]");
  if (add) openItem(null, add.dataset.add);
});
$("#openSettings").onclick = () => show("settings");

/* ---------- Item sheet ---------- */

$("#fCategory").innerHTML = AREAS.map((a) => `<optgroup label="${esc(a.label)}">${CATEGORIES.filter((c) => c.area === a.id)
  .map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("")}</optgroup>`).join("");
$("#fFreq").innerHTML = FREQUENCIES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
$("#fRemind").innerHTML = [7, 14, 21, 30, 45, 60, 90].map((d) => `<option value="${d}">${d} days before</option>`).join("");

const sheetItem = () => items.find((i) => i.id === editing);

function openItem(id, area) {
  editing = id;
  deleteArmed = false;
  const it = id ? sheetItem() : null;
  if (id && !it) return;
  const cat = it ? it.category : (CATEGORIES.find((c) => c.area === area) || CATEGORIES.find((c) => c.id === "carins")).id;
  $("#sheetTitle").textContent = it ? it.title : "Add";
  $("#sheetSub").textContent = it ? category(it.category).label : "Insurance, a bill, MOT, tax or anything that renews";
  $("#fCategory").value = cat;
  $("#fTitle").value = it ? it.title : category(cat).label;
  $("#fTitle").dataset.auto = it ? "" : "1";
  $("#fProvider").value = it?.provider || "";
  $("#fCovers").value = it?.covers || "";
  $("#fReference").value = it?.reference || "";
  $("#fCost").value = it?.cost ?? "";
  $("#fFreq").value = it ? it.frequency : category(cat).freq;
  $("#fDate").value = it?.renewalDate || "";
  $("#fRemind").value = String(it?.remindDays ?? 30);
  $("#fAuto").checked = !!it?.autoRenew;
  $("#fPhone").value = it?.phone || "";
  $("#fWebsite").value = it?.website || "";
  $("#fNotes").value = it?.notes || "";
  $("#fDateLabel").textContent = dateLabel(cat);
  $("#itemSave").textContent = it ? "Save changes" : "Add";
  $("#renewSect").hidden = !it || !it.renewalDate || !!it.archivedAt;
  $("#renewForm").hidden = true;
  $("#renewBtnRow").hidden = false;
  $("#docsSect").hidden = !it;
  $("#dangerSect").hidden = !it;
  if (it) {
    $("#archiveItem").textContent = it.archivedAt ? "Bring back" : "Archive (no longer have it)";
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

function formValues() {
  const cost = $("#fCost").value.trim();
  const t = (id) => $(id).value.trim() || null;
  return {
    category: $("#fCategory").value, title: $("#fTitle").value.trim(), provider: t("#fProvider"), covers: t("#fCovers"),
    reference: t("#fReference"), cost: cost === "" ? null : Math.round(parseFloat(cost) * 100) / 100, frequency: $("#fFreq").value,
    renewalDate: $("#fDate").value || null, remindDays: Number($("#fRemind").value), autoRenew: $("#fAuto").checked,
    phone: t("#fPhone"), website: t("#fWebsite"), notes: t("#fNotes"),
  };
}

$("#itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = formValues();
  if (!v.title) return;
  const btn = $("#itemSave");
  btn.disabled = true;
  try {
    if (editing) {
      const it = sheetItem();
      Object.assign(it, v);
      await store.updateItem(it.id, v);
      toast("Saved");
    } else {
      const it = { id: uid(), householdId: household.id, archivedAt: null, created: Date.now(), docs: [], ...v };
      items.push(it);
      await store.addItem(it);
      toast(`Added ${it.title}`, { label: "Add documents", run: () => openItem(it.id) });
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

/* Renewing rolls the date on and keeps a line of history in the notes. */
$("#renewOpen").onclick = () => {
  const it = sheetItem();
  const base = it.renewalDate && daysUntil(it.renewalDate) > -60 ? it.renewalDate : todayIso();
  $("#rDate").value = addMonths(base, 12);
  $("#rCost").value = it.cost ?? "";
  $("#rProvider").value = it.provider || "";
  $("#renewForm").hidden = false;
  $("#renewBtnRow").hidden = true;
  $("#rCost").focus();
};
$("#renewCancel").onclick = () => { $("#renewForm").hidden = true; $("#renewBtnRow").hidden = false; };
$("#renewForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const it = sheetItem();
  const cost = $("#rCost").value.trim() === "" ? null : Math.round(parseFloat($("#rCost").value) * 100) / 100;
  const provider = $("#rProvider").value.trim() || null;
  const was = [it.cost != null ? costLabel(it) : null, it.provider ? `with ${it.provider}` : null].filter(Boolean).join(" ");
  const line = `Renewed ${prettyDate(todayIso())}${was ? ` (was ${was})` : ""}.`;
  const patch = { renewalDate: $("#rDate").value, cost, provider, notes: it.notes ? `${line}\n${it.notes}` : line };
  try {
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
    toast(archivedAt ? `Archived ${it.title}` : `${it.title} is back`);
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
    toast(`Deleted ${it.title}`);
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
  const head = ["Type", "Name", "Provider", "Covers", "Policy or account number", "Cost", "Paid", "Renewal or due date", "Remind days before", "Auto-renews", "Phone", "Website", "Notes", "Archived"];
  const rows = items.slice().sort(sortItems).map((i) => [
    category(i.category).label, i.title, i.provider, i.covers, i.reference, i.cost, i.frequency,
    i.renewalDate ? i.renewalDate.split("-").reverse().join("/") : "", i.remindDays, i.autoRenew ? "Yes" : "No",
    i.phone, i.website, i.notes, i.archivedAt ? "Yes" : "",
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
  if (f) readImport(await f.text());
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
  items = await store.load(household.id);
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
