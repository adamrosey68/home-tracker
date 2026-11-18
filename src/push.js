const VAPID = import.meta.env.VITE_VAPID_PUBLIC_KEY;

export const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function status(demo) {
  if (demo || !VAPID) return { state: "off", text: "Reminder notifications need the online version. Until then, check the Coming up list when you open the app." };
  if (!supported()) {
    if (isIos() && !isStandalone()) {
      return { state: "install", text: "On iPhone, add this app to your Home Screen first: tap Share, then Add to Home Screen. Open it from there and come back here." };
    }
    return { state: "off", text: "This browser can't show notifications." };
  }
  if (Notification.permission === "denied") {
    return {
      state: "denied",
      text: isIos() ? "Notifications are blocked. Turn them on in your iPhone's Settings › Notifications › Home." : "Notifications are blocked. Allow them in your browser's settings for this site.",
    };
  }
  if (Notification.permission === "granted") return { state: "on", text: "Notifications are on for this device." };
  return { state: "ask", text: "Get a notification before anything is due for renewal, even when the app is closed." };
}

function keyBytes(b64) {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function subscribe(store) {
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID) }));
  await store.savePush(sub.toJSON());
}

export async function enable(store) {
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications weren't allowed.");
  await subscribe(store);
}

/* Re-register on each sign-in so the server always has this device's current address. */
export async function resync(store) {
  if (status(store.demo).state !== "on") return;
  try { await subscribe(store); } catch (e) { console.warn("push resync failed", e); }
}

export async function test() {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification("Car insurance: renews in 30 days", { body: "Reminders appear like this. Notifications are working on this device.", icon: "/icons/icon-192.png", tag: "test" });
}
