// Called every hour by pg_cron. For each item with a renewal date it sends, to every member of its household:
//  - an early reminder once the date is within the item's remind_days
//  - a final reminder the day before (or on the day, or up to a week late if it was missed)
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
  frequency: string; renewal_date: string; remind_days: number; reminded: string | null; auto_renew: boolean;
};

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

function message(it: Item, days: number) {
  const verb = it.auto_renew ? "Renews" : "Due";
  const title = days < 0 ? `${it.title} was due ${when(days)}` : `${it.title}: ${verb.toLowerCase()} ${when(days)}`;
  const bits = [it.provider, it.cost != null ? `£${Number(it.cost).toFixed(2)}${per[it.frequency] ?? ""}` : null, prettyDate(it.renewal_date)];
  const tail = it.auto_renew ? "Set to auto-renew. Worth checking for a better price." : "Tap to review and mark it renewed.";
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
      .select("id, household_id, title, provider, cost, frequency, renewal_date, remind_days, reminded, auto_renew")
      .is("archived_at", null)
      .not("renewal_date", "is", null)
      .or("reminded.is.null,reminded.eq.early");
    if (error) throw error;

    let sent = 0;
    for (const it of (items ?? []) as Item[]) {
      const days = toDay(it.renewal_date) - today;
      let stage: "early" | "final" | null = null;
      if (days <= 1 && days >= -7) stage = "final";
      else if (days <= it.remind_days && days > 1 && !it.reminded) stage = "early";
      if (!stage) continue;

      // Claim it first so overlapping runs never send the same reminder twice.
      let claim = sb.from("items").update({ reminded: stage }).eq("id", it.id).eq("renewal_date", it.renewal_date);
      claim = it.reminded ? claim.eq("reminded", it.reminded) : claim.is("reminded", null);
      const { data: claimed } = await claim.select("id");
      if (!claimed?.length) continue;

      const { data: members } = await sb.from("household_members").select("user_id").eq("household_id", it.household_id);
      const userIds = (members ?? []).map((m) => m.user_id);
      if (!userIds.length) continue;
      const { data: subs } = await sb.from("push_subscriptions").select("*").in("user_id", userIds);
      sent += await sendTo(subs ?? [], message({ ...it, reminded: stage }, days));
    }
    return Response.json({ sent });
  } catch (e) {
    console.error(e);
    return new Response(String((e as Error).message ?? e), { status: 500 });
  }
});
