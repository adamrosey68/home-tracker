// Called every hour by pg_cron. For each current Home Tracker item it sends, to every member of its household:
//  - an early reminder on its chosen remind_on date (or remind_days before, if no date was chosen)
//  - a final reminder the day before (or on the day, or up to a week late if it was missed)
// Cruise Tracker payments get the same two reminders (early defaults to 14 days before), and
// checklist items one on their due date. Budget lines with an expiry date get one a month before and one the day before.
// Each goes only to devices signed up in that app.
// Only between 9am and 9pm UK time, so nobody gets woken up.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const TZ = "Europe/London";

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

type Sub = { endpoint: string; p256dh: string; auth: string; user_id: string };
type Item = {
  id: string; household_id: string; title: string; provider: string | null; cost: number | null;
  frequency: string; renewal_date: string | null; remind_days: number; remind_on: string | null; reminded: string | null;
  auto_renew: boolean; item_groups: { name: string } | null;
};
type Payment = {
  id: string; household_id: string; cruise_id: string; label: string; amount: number; due_date: string;
  remind_on: string | null; reminded: string | null; cruises: { name: string } | null;
};
type BudgetLine = { id: string; household_id: string; name: string; amount: number; ends_on: string; reminded: string | null };
type Task = { id: string; household_id: string; cruise_id: string; text: string; due_date: string; cruises: { name: string } | null };

async function subsFor(householdId: string, app: "home" | "cruise") {
  const { data: members } = await sb.from("household_members").select("user_id").eq("household_id", householdId);
  const userIds = (members ?? []).map((m) => m.user_id);
  if (!userIds.length) return [];
  const { data: subs } = await sb.from("push_subscriptions").select("*").in("user_id", userIds).eq("app", app);
  return (subs ?? []) as Sub[];
}

/* Mark a row as reminded before sending, so overlapping runs never send the same reminder twice. */
async function claim(table: string, id: string, from: string | null, to: string) {
  let q = sb.from(table).update({ reminded: to }).eq("id", id);
  q = from ? q.eq("reminded", from) : q.is("reminded", null);
  const { data } = await q.select("id");
  return !!data?.length;
}

function stageFor(days: number, remindDue: boolean, reminded: string | null): "early" | "final" | null {
  if (days <= 1 && days >= -7) return "final";
  if (days > 1 && remindDue && !reminded) return "early";
  return null;
}

async function sendTo(subs: Sub[], payload: object) {
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push failed", code, e);
    }
  }
  return sent;
}

const dayMs = 86400000;
const toDay = (iso: string) => Date.parse(iso + "T00:00:00Z") / dayMs;
const prettyDate = (iso: string) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const per = { monthly: "/month", quarterly: "/quarter", yearly: "/year", "one-off": "" } as Record<string, string>;

function when(days: number) {
  if (days > 1) return `in ${days} days`;
  if (days === 1) return "tomorrow";
  if (days === 0) return "today";
  return `${-days} day${days === -1 ? "" : "s"} ago`;
}

function message(it: Item, days: number | null) {
  const name = it.item_groups?.name ?? it.title;
  const verb = it.auto_renew ? "renews" : "due";
  const title = days == null ? `Reminder: ${name}` : days < 0 ? `${name} was due ${when(days)}` : `${name}: ${verb} ${when(days)}`;
  const bits = [it.provider, it.cost != null ? `£${Number(it.cost).toFixed(2)}${per[it.frequency] ?? ""}` : null,
    it.renewal_date ? prettyDate(it.renewal_date) : null];
  const tail = it.auto_renew ? "Set to auto-renew. Worth checking for a better price." : "Tap to review, renew or switch.";
  return { title, body: `${bits.filter(Boolean).join(" · ")}\n${tail}`, tag: `${it.id}-${it.reminded ?? ""}`, url: `/?item=${it.id}` };
}

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const now = new Date();
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(now));
    if (hour < 9 || hour >= 21) return Response.json({ skipped: "outside 9am-9pm" });
    const today = toDay(new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(now));

    const { data: items, error } = await sb
      .from("items")
      .select("id, household_id, title, provider, cost, frequency, renewal_date, remind_days, remind_on, reminded, auto_renew, item_groups(name)")
      .is("archived_at", null)
      .or("reminded.is.null,reminded.eq.early");
    if (error) throw error;

    let sent = 0;
    for (const it of (items ?? []) as unknown as Item[]) {
      const days = it.renewal_date ? toDay(it.renewal_date) - today : null;
      const remindDue = it.remind_on ? toDay(it.remind_on) <= today : days != null && days <= it.remind_days;
      const stage = days == null ? (it.remind_on && remindDue ? "final" : null) : stageFor(days, remindDue, it.reminded);
      if (!stage || !(await claim("items", it.id, it.reminded, stage))) continue;
      sent += await sendTo(await subsFor(it.household_id, "home"), message({ ...it, reminded: stage }, days));
    }

    // A budget line copied into later months keeps its dates, so copies sharing a name and expiry date are one reminder.
    const { data: blines, error: bErr } = await sb
      .from("budget_lines")
      .select("id, household_id, name, amount, ends_on, reminded")
      .eq("remind", true)
      .gte("ends_on", new Date((today - 7) * dayMs).toISOString().slice(0, 10))
      .order("month", { ascending: false });
    if (bErr) throw bErr;
    const expiring = new Map<string, BudgetLine[]>();
    for (const l of (blines ?? []) as BudgetLine[]) {
      const key = `${l.household_id}|${l.name.trim().toLowerCase()}|${l.ends_on}`;
      expiring.set(key, [...(expiring.get(key) ?? []), l]);
    }
    for (const copies of expiring.values()) {
      const l = copies[0];
      const reminded = copies.some((c) => c.reminded === "final") ? "final" : copies.some((c) => c.reminded === "early") ? "early" : null;
      if (reminded === "final") continue;
      const days = toDay(l.ends_on) - today;
      const stage = stageFor(days, days <= 30, reminded);
      if (!stage) continue;
      const { data: claimed } = await sb.from("budget_lines").update({ reminded: stage })
        .in("id", copies.map((c) => c.id)).or(reminded ? `reminded.is.null,reminded.eq.${reminded}` : "reminded.is.null").select("id");
      if (!claimed?.length) continue;
      sent += await sendTo(await subsFor(l.household_id, "home"), {
        title: days < 0 ? `${l.name} expired ${when(days)}` : `${l.name} expires ${when(days)}`,
        body: `£${Number(l.amount).toFixed(2)} · ${prettyDate(l.ends_on)}\nTap to renew it or update the dates.`,
        tag: `${l.id}-${stage}`, url: `/?line=${l.id}`,
      });
    }

    const { data: payments, error: pErr } = await sb
      .from("cruise_payments")
      .select("id, household_id, cruise_id, label, amount, due_date, remind_on, reminded, cruises(name)")
      .is("paid_on", null)
      .not("due_date", "is", null)
      .or("reminded.is.null,reminded.eq.early");
    if (pErr) throw pErr;
    for (const p of (payments ?? []) as unknown as Payment[]) {
      const days = toDay(p.due_date) - today;
      const remindDue = p.remind_on ? toDay(p.remind_on) <= today : days <= 14;
      const stage = stageFor(days, remindDue, p.reminded);
      if (!stage || !(await claim("cruise_payments", p.id, p.reminded, stage))) continue;
      const name = p.cruises?.name ?? "Holiday";
      sent += await sendTo(await subsFor(p.household_id, "cruise"), {
        title: days < 0 ? `${name}: ${p.label} was due ${when(days)}` : `${name}: ${p.label} due ${when(days)}`,
        body: `£${Number(p.amount).toFixed(2)} · ${prettyDate(p.due_date)}\nTap to mark it paid.`,
        tag: `${p.id}-${stage}`, url: `/?cruise=${p.cruise_id}`,
      });
    }

    const { data: tasks, error: tErr } = await sb
      .from("cruise_tasks")
      .select("id, household_id, cruise_id, text, due_date, cruises(name)")
      .eq("done", false)
      .not("due_date", "is", null)
      .is("reminded", null);
    if (tErr) throw tErr;
    for (const t of (tasks ?? []) as unknown as Task[]) {
      const days = toDay(t.due_date) - today;
      if (days > 0 || days < -7 || !(await claim("cruise_tasks", t.id, null, "final"))) continue;
      sent += await sendTo(await subsFor(t.household_id, "cruise"), {
        title: `${t.cruises?.name ?? "Holiday"}: ${t.text}`,
        body: `On your checklist, due ${when(days)}.\nTap to tick it off.`,
        tag: `${t.id}-task`, url: `/?cruise=${t.cruise_id}`,
      });
    }
    return Response.json({ sent });
  } catch (e) {
    console.error(e);
    return new Response(String((e as Error).message ?? e), { status: 500 });
  }
});
