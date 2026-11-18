export const AREAS = [
  { id: "home", label: "Home", icon: '<path d="M3 11.5 12 4l9 7.5"></path><path d="M5.5 9.5V20h13V9.5"></path><path d="M10 20v-5.5h4V20"></path>' },
  { id: "bills", label: "Bills", icon: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"></path>' },
  { id: "car", label: "Car", icon: '<path d="M5 16.5h14M3.5 16.5V12l2.2-5h12.6l2.2 5v4.5"></path><path d="M3.5 12h17"></path><circle cx="7.5" cy="17" r="1.8"></circle><circle cx="16.5" cy="17" r="1.8"></circle>' },
  { id: "family", label: "Family", icon: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"></path>' },
];

/* `freq` is the usual way it's paid, used as the default for new items. */
export const CATEGORIES = [
  { id: "home", area: "home", label: "Home insurance (buildings & contents)", freq: "yearly" },
  { id: "buildings", area: "home", label: "Buildings insurance", freq: "yearly" },
  { id: "contents", area: "home", label: "Contents insurance", freq: "yearly" },
  { id: "boiler", area: "home", label: "Boiler cover", freq: "yearly" },
  { id: "appliance", area: "home", label: "Appliance cover or warranty", freq: "yearly" },
  { id: "mortgage", area: "home", label: "Mortgage", freq: "monthly" },
  { id: "energy", area: "bills", label: "Gas and electricity", freq: "monthly" },
  { id: "water", area: "bills", label: "Water", freq: "monthly" },
  { id: "council", area: "bills", label: "Council tax", freq: "monthly" },
  { id: "broadband", area: "bills", label: "Broadband and TV", freq: "monthly" },
  { id: "tvlicence", area: "bills", label: "TV licence", freq: "yearly" },
  { id: "mobile", area: "bills", label: "Mobile phone", freq: "monthly" },
  { id: "carins", area: "car", label: "Car insurance", freq: "yearly" },
  { id: "mot", area: "car", label: "MOT", freq: "yearly" },
  { id: "tax", area: "car", label: "Road tax", freq: "yearly" },
  { id: "service", area: "car", label: "Car service", freq: "yearly" },
  { id: "breakdown", area: "car", label: "Breakdown cover", freq: "yearly" },
  { id: "carfinance", area: "car", label: "Car finance or lease", freq: "monthly" },
  { id: "life", area: "family", label: "Life insurance", freq: "monthly" },
  { id: "health", area: "family", label: "Health or dental cover", freq: "monthly" },
  { id: "pet", area: "family", label: "Pet insurance", freq: "monthly" },
  { id: "travel", area: "family", label: "Travel insurance", freq: "yearly" },
  { id: "other", area: "family", label: "Other", freq: "yearly" },
];

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));
export const category = (id) => byId.get(id) || byId.get("other");
export const areaOf = (id) => AREAS.find((a) => a.id === category(id).area);

export const FREQUENCIES = [
  ["monthly", "Monthly", 12],
  ["quarterly", "Quarterly", 4],
  ["yearly", "Yearly", 1],
  ["one-off", "One-off", 0],
];
export const perYear = (freq) => (FREQUENCIES.find((f) => f[0] === freq) || [, , 1])[2];

/* Best guess at a category from free text, for imports. Order matters: more specific first. */
const GUESSES = [
  [/\bmot\b/, "mot"],
  [/council/, "council"],
  [/(road|car|vehicle|ved)\s*tax|^tax$/, "tax"],
  [/build.*content|content.*build|home\s*insurance|house\s*insurance/, "home"],
  [/build/, "buildings"],
  [/content/, "contents"],
  [/gas|electric|energy|octopus|british gas|edf|e\.on|ovo/, "energy"],
  [/breakdown|\brac\b|\baa\b|green flag/, "breakdown"],
  [/car\s*insurance|motor|vehicle\s*insurance/, "carins"],
  [/finance|lease|\bpcp\b/, "carfinance"],
  [/service/, "service"],
  [/boiler/, "boiler"],
  [/warrant|appliance/, "appliance"],
  [/mortgage/, "mortgage"],
  [/life/, "life"],
  [/pet|dog|cat\b/, "pet"],
  [/travel|holiday/, "travel"],
  [/health|dental|bupa|vitality/, "health"],
  [/tv\s*licen/, "tvlicence"],
  [/broadband|internet|\bsky\b|virgin|\bbt\b|netflix|fibre/, "broadband"],
  [/mobile|phone|\bsim\b/, "mobile"],
  [/water/, "water"],
  [/car/, "carins"],
];
export function guessCategory(...texts) {
  const s = texts.filter(Boolean).join(" ").toLowerCase();
  for (const [re, id] of GUESSES) if (re.test(s)) return id;
  return "other";
}
