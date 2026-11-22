import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

const ms = (v) => (v ? Date.parse(v) : null);
const iso = (v) => (v ? new Date(v).toISOString() : null);
const BUCKET = "home-docs";
const FIELDS = ["category", "title", "provider", "reference", "covers", "frequency", "phone", "website", "notes"];

const toDoc = (r) => ({ id: r.id, path: r.path, name: r.name, mime: r.mime, created: ms(r.created_at) });
function toItem(r) {
  return {
    id: r.id, householdId: r.household_id, category: r.category, title: r.title, provider: r.provider, reference: r.reference,
    covers: r.covers, cost: r.cost == null ? null : Number(r.cost), frequency: r.frequency, renewalDate: r.renewal_date,
    remindDays: r.remind_days, autoRenew: r.auto_renew, phone: r.phone, website: r.website, notes: r.notes,
    groupId: r.group_id, startDate: r.start_date, remindOn: r.remind_on,
    archivedAt: ms(r.archived_at), created: ms(r.created_at), docs: [],
  };
}
const toGroup = (r) => ({ id: r.id, householdId: r.household_id, area: r.area, name: r.name, position: r.position, vehicleId: r.vehicle_id });
const toVehicle = (r) => ({
  id: r.id, householdId: r.household_id, registration: r.registration, nickname: r.nickname, make: r.make, model: r.model,
  details: r.details || [], notes: r.notes, position: r.position,
});
const toLine = (r) => ({
  id: r.id, householdId: r.household_id, month: r.month, kind: r.kind, name: r.name, amount: Number(r.amount), position: r.position,
  groupId: r.group_id, icon: r.icon, frequency: r.frequency,
});
function lineRow(l) {
  const r = {};
  for (const k of ["month", "kind", "name", "amount", "position", "icon", "frequency"]) if (k in l) r[k] = l[k];
  if ("groupId" in l) r.group_id = l.groupId || null;
  return r;
}
const toBudgetGroup = (r) => ({ id: r.id, householdId: r.household_id, name: r.name, inTotal: r.in_total, monthlyOnly: r.monthly_only, position: r.position });
function budgetGroupRow(g) {
  const r = {};
  for (const k of ["name", "position"]) if (k in g) r[k] = g[k];
  if ("inTotal" in g) r.in_total = g.inTotal;
  if ("monthlyOnly" in g) r.monthly_only = g.monthlyOnly;
  return r;
}
function groupRow(g) {
  const r = {};
  for (const k of ["name", "area", "position"]) if (k in g) r[k] = g[k];
  if ("vehicleId" in g) r.vehicle_id = g.vehicleId || null;
  return r;
}
function vehicleRow(v) {
  const r = {};
  for (const k of ["registration", "nickname", "make", "model", "details", "notes", "position"]) if (k in v) r[k] = v[k] === "" ? null : v[k];
  return r;
}
function itemRow(it) {
  const r = {};
  for (const k of FIELDS) if (k in it) r[k] = it[k] === "" ? null : it[k];
  if ("cost" in it) r.cost = it.cost;
  if ("renewalDate" in it) r.renewal_date = it.renewalDate || null;
  if ("remindDays" in it) r.remind_days = it.remindDays;
  if ("autoRenew" in it) r.auto_renew = !!it.autoRenew;
  if ("groupId" in it) r.group_id = it.groupId || null;
  if ("startDate" in it) r.start_date = it.startDate || null;
  if ("remindOn" in it) r.remind_on = it.remindOn || null;
  if ("archivedAt" in it) r.archived_at = iso(it.archivedAt);
  return r;
}
const extOf = (mime) => ({ "image/jpeg": "jpg", "image/png": "png", "application/pdf": "pdf" })[mime] || "bin";

function cloud() {
  const sb = createClient(url, key);
  const ok = ({ data, error }) => { if (error) throw error; return data; };
  let channel = null;
  const urlCache = new Map();

  return {
    demo: false,
    async session() { return ok(await sb.auth.getSession()).session; },
    onAuth(cb) { sb.auth.onAuthStateChange((_event, s) => setTimeout(() => cb(s), 0)); },
    async signIn(email, password) { return ok(await sb.auth.signInWithPassword({ email, password })); },
    async signUp(email, password) {
      return ok(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin } }));
    },
    async signOut() {
      if (channel) { sb.removeChannel(channel); channel = null; }
      await sb.auth.signOut();
    },

    async household() {
      const id = ok(await sb.rpc("my_household"));
      const [h] = ok(await sb.from("households").select("id, name, share_code").eq("id", id));
      const mems = ok(await sb.from("household_members").select("user_id").eq("household_id", id));
      return { id, name: h.name, shareCode: h.share_code, members: mems.length };
    },
    async renameHousehold(id, name) { ok(await sb.from("households").update({ name }).eq("id", id)); },
    async shareCode(id) { return ok(await sb.rpc("create_share_code", { hid: id })); },
    async join(code) { return ok(await sb.rpc("join_household", { code })); },

    async load(householdId) {
      const [its, docs, gs, vs, ls, bgs] = await Promise.all([
        sb.from("items").select("*").eq("household_id", householdId).order("renewal_date", { nullsFirst: false }),
        sb.from("item_docs").select("id, item_id, path, name, mime, created_at").eq("household_id", householdId).order("created_at"),
        sb.from("item_groups").select("*").eq("household_id", householdId).order("position").order("created_at"),
        sb.from("vehicles").select("*").eq("household_id", householdId).order("position").order("created_at"),
        sb.from("budget_lines").select("*").eq("household_id", householdId).order("position").order("created_at"),
        sb.from("budget_groups").select("*").eq("household_id", householdId).order("position").order("created_at"),
      ]).then((rs) => rs.map(ok));
      const items = its.map(toItem);
      const index = new Map(items.map((i) => [i.id, i]));
      for (const d of docs) index.get(d.item_id)?.docs.push(toDoc(d));
      return { items, groups: gs.map(toGroup), vehicles: vs.map(toVehicle), lines: ls.map(toLine), budgetGroups: bgs.map(toBudgetGroup) };
    },
    async addBudgetGroup(g) { ok(await sb.from("budget_groups").insert({ id: g.id, household_id: g.householdId, ...budgetGroupRow(g) })); },
    async updateBudgetGroup(id, patch) { ok(await sb.from("budget_groups").update(budgetGroupRow(patch)).eq("id", id)); },
    async deleteBudgetGroup(id) { ok(await sb.from("budget_groups").delete().eq("id", id)); },
    async addLines(list) { ok(await sb.from("budget_lines").insert(list.map((l) => ({ id: l.id, household_id: l.householdId, ...lineRow(l) })))); },
    async updateLine(id, patch) { ok(await sb.from("budget_lines").update(lineRow(patch)).eq("id", id)); },
    async deleteLine(id) { ok(await sb.from("budget_lines").delete().eq("id", id)); },
    async addGroup(g) { ok(await sb.from("item_groups").insert({ id: g.id, household_id: g.householdId, ...groupRow(g) })); },
    async updateGroup(id, patch) { ok(await sb.from("item_groups").update(groupRow(patch)).eq("id", id)); },
    async addVehicle(v) { ok(await sb.from("vehicles").insert({ id: v.id, household_id: v.householdId, ...vehicleRow(v) })); },
    async updateVehicle(id, patch) { ok(await sb.from("vehicles").update(vehicleRow(patch)).eq("id", id)); },
    async deleteVehicle(id) { ok(await sb.from("vehicles").delete().eq("id", id)); },
    async deleteGroup(id) {
      const docs = ok(await sb.from("item_docs").select("path, items!inner(group_id)").eq("items.group_id", id));
      ok(await sb.from("item_groups").delete().eq("id", id));
      if (docs.length) await sb.storage.from(BUCKET).remove(docs.map((d) => d.path));
    },
    async addItem(it) { ok(await sb.from("items").insert({ id: it.id, household_id: it.householdId, ...itemRow(it) })); },
    async updateItem(id, patch) { ok(await sb.from("items").update(itemRow(patch)).eq("id", id)); },
    async deleteItem(id) {
      const docs = ok(await sb.from("item_docs").select("path").eq("item_id", id));
      ok(await sb.from("items").delete().eq("id", id));
      if (docs.length) await sb.storage.from(BUCKET).remove(docs.map((d) => d.path));
    },
    async importItems(list) {
      for (let i = 0; i < list.length; i += 200) {
        ok(await sb.from("items").insert(list.slice(i, i + 200).map((it) => ({ id: it.id, household_id: it.householdId, ...itemRow(it) }))));
      }
    },

    async addDoc(item, blob, name) {
      const id = crypto.randomUUID(), path = `${item.householdId}/${item.id}/${id}.${extOf(blob.type)}`;
      ok(await sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type }));
      ok(await sb.from("item_docs").insert({ id, item_id: item.id, household_id: item.householdId, path, name, mime: blob.type }));
      return { id, path, name, mime: blob.type, created: Date.now() };
    },
    async deleteDoc(doc) {
      ok(await sb.from("item_docs").delete().eq("id", doc.id));
      await sb.storage.from(BUCKET).remove([doc.path]);
    },
    /* Documents are private, so they're shown through short-lived signed links, reused while valid. */
    async docUrls(paths) {
      const now = Date.now();
      const need = paths.filter((p) => !(urlCache.get(p)?.exp > now + 60000));
      if (need.length) {
        const signed = ok(await sb.storage.from(BUCKET).createSignedUrls(need, 3600));
        for (const s of signed) if (s.signedUrl) urlCache.set(s.path, { url: s.signedUrl, exp: now + 3600000 });
      }
      return Object.fromEntries(paths.map((p) => [p, urlCache.get(p)?.url]));
    },

    async savePush(sub) {
      ok(await sb.from("push_subscriptions").upsert({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }));
    },
    subscribe(onChange) {
      if (channel) return;
      channel = sb.channel("sync");
      for (const table of ["items", "item_docs", "item_groups", "vehicles", "budget_lines", "budget_groups", "household_members"]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table }, onChange);
      }
      channel.subscribe();
    },
  };
}

/* Demo mode: everything stays in this browser until Supabase is connected. */
function local() {
  const KEY = "home-tracker-demo";
  const read = () => {
    try { return { name: "Our home", items: [], docs: [], groups: [], vehicles: [], lines: [], budgetGroups: [], ...JSON.parse(localStorage.getItem(KEY)) }; }
    catch { return { name: "Our home", items: [], docs: [], groups: [], vehicles: [], lines: [], budgetGroups: [] }; }
  };
  const edit = (fn) => { const d = read(); fn(d); localStorage.setItem(KEY, JSON.stringify(d)); };
  const user = { id: "local", email: null };
  const fromPatch = (it) => {
    const r = { ...it };
    delete r.docs;
    return r;
  };

  return {
    demo: true,
    async session() { return { user }; },
    onAuth() {},
    async signIn() {}, async signUp() {}, async signOut() {},
    async household() { return { id: "local", name: read().name, shareCode: null, members: 1 }; },
    async renameHousehold(_id, name) { edit((d) => { d.name = name; }); },
    async shareCode() { throw new Error("Sharing needs the online version."); },
    async join() { throw new Error("Sharing needs the online version."); },
    async load() {
      const d = read();
      const items = d.items.map((it) => ({ ...it, docs: d.docs.filter((x) => x.itemId === it.id).map(({ itemId, ...x }) => x) }));
      return { items, groups: d.groups.slice().sort((a, b) => a.position - b.position), vehicles: d.vehicles.slice(), lines: d.lines.slice(), budgetGroups: d.budgetGroups.slice().sort((a, b) => a.position - b.position) };
    },
    async addBudgetGroup(g) { edit((d) => d.budgetGroups.push({ ...g })); },
    async updateBudgetGroup(id, patch) { edit((d) => Object.assign(d.budgetGroups.find((g) => g.id === id) || {}, patch)); },
    async deleteBudgetGroup(id) { edit((d) => { d.budgetGroups = d.budgetGroups.filter((g) => g.id !== id); d.lines = d.lines.filter((l) => l.groupId !== id); }); },
    async addLines(list) { edit((d) => d.lines.push(...list.map((l) => ({ ...l })))); },
    async updateLine(id, patch) { edit((d) => Object.assign(d.lines.find((l) => l.id === id) || {}, patch)); },
    async deleteLine(id) { edit((d) => { d.lines = d.lines.filter((l) => l.id !== id); }); },
    async addVehicle(v) { edit((d) => d.vehicles.push({ ...v })); },
    async updateVehicle(id, patch) { edit((d) => Object.assign(d.vehicles.find((v) => v.id === id) || {}, patch)); },
    async deleteVehicle(id) {
      edit((d) => {
        d.vehicles = d.vehicles.filter((v) => v.id !== id);
        for (const g of d.groups) if (g.vehicleId === id) g.vehicleId = null;
      });
    },
    async addGroup(g) { edit((d) => d.groups.push({ ...g })); },
    async updateGroup(id, patch) { edit((d) => Object.assign(d.groups.find((g) => g.id === id) || {}, patch)); },
    async deleteGroup(id) {
      edit((d) => {
        const gone = new Set(d.items.filter((i) => i.groupId === id).map((i) => i.id));
        d.groups = d.groups.filter((g) => g.id !== id);
        d.items = d.items.filter((i) => !gone.has(i.id));
        d.docs = d.docs.filter((x) => !gone.has(x.itemId));
      });
    },
    async addItem(it) { edit((d) => d.items.push(fromPatch(it))); },
    async updateItem(id, patch) { edit((d) => Object.assign(d.items.find((i) => i.id === id) || {}, fromPatch(patch))); },
    async deleteItem(id) {
      edit((d) => { d.items = d.items.filter((i) => i.id !== id); d.docs = d.docs.filter((x) => x.itemId !== id); });
    },
    async importItems(list) { edit((d) => d.items.push(...list.map(fromPatch))); },
    async addDoc(item, blob, name) {
      const path = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
      const doc = { id: crypto.randomUUID(), path, name, mime: blob.type, created: Date.now() };
      edit((d) => d.docs.push({ ...doc, itemId: item.id }));
      return doc;
    },
    async deleteDoc(doc) { edit((d) => { d.docs = d.docs.filter((x) => x.id !== doc.id); }); },
    async docUrls(paths) { return Object.fromEntries(paths.map((p) => [p, p])); },
    async savePush() {},
    subscribe() {},
  };
}

export const store = url && key ? cloud() : local();
