import { category, guessCategory } from "./categories.js";

/* Reads CSV, or tab-separated text pasted straight from Google Sheets. */
export function parseTable(text) {
  text = text.replace(/^\uFEFF/, "");
  const first = text.split(/\r?\n/, 1)[0];
  const sep = [",", "\t", ";"].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
}

/* What each column in a sheet could be. `match` is tried against the header text. */
export const FIELDS = [
  { key: "title", label: "What it is", match: /^(item|name|what|policy|title|description|insurance|service)$|item|what|title|description/ },
  { key: "category", label: "Category", match: /categor|type|kind|area/ },
  { key: "provider", label: "Provider", match: /provider|company|insurer|supplier|who|with/ },
  { key: "reference", label: "Policy or account number", match: /policy\s*(no|num|#)|ref|account|number/ },
  { key: "covers", label: "Covers (car, person...)", match: /cover|vehicle|reg|for\b|person|car\b/ },
  { key: "cost", label: "Cost", match: /cost|price|premium|amount|£|annual|monthly|fee/ },
  { key: "frequency", label: "How often paid", match: /freq|how often|paid|payment|period/ },
  { key: "renewalDate", label: "Renewal or due date", match: /renew|expir|due|date|end|until/ },
  { key: "phone", label: "Phone", match: /phone|tel|contact/ },
  { key: "website", label: "Website", match: /web|url|site|login/ },
  { key: "notes", label: "Notes", match: /note|comment|info/ },
];

export function guessMapping(headers) {
  const used = new Set(), map = {};
  for (const f of FIELDS) {
    const i = headers.findIndex((h, j) => !used.has(j) && f.match.test(h.toLowerCase()));
    if (i >= 0) { map[f.key] = i; used.add(i); }
  }
  if (map.title == null) {
    const i = headers.findIndex((_h, j) => !used.has(j));
    if (i >= 0) map.title = i;
  }
  return map;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => {
  if (y < 100) y += 2000;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/* UK-style dates: 03/12/2026, 3-12-26, 2026-12-03, 3 Dec 2026, 3rd December 26, Dec 2026. */
export function parseDate(s) {
  if (!s) return null;
  s = s.trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/))) return ymd(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*,?\s+(\d{2,4})$/))) {
    const mo = MONTHS.indexOf(m[2]);
    return mo >= 0 ? ymd(+m[3], mo + 1, +m[1]) : null;
  }
  if ((m = s.match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/))) {
    const mo = MONTHS.indexOf(m[1]);
    return mo >= 0 ? ymd(+m[3], mo + 1, +m[2]) : null;
  }
  if ((m = s.match(/^([a-z]{3})[a-z]*\s+(\d{2,4})$/))) {
    const mo = MONTHS.indexOf(m[1]);
    return mo >= 0 ? ymd(+m[2], mo + 1, 1) : null;
  }
  return null;
}

export function parseCost(s) {
  if (!s) return null;
  const n = parseFloat(s.replace(/[£,\s]/g, "").replace(/[^\d.\-].*$/, ""));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function parseFreq(s) {
  s = (s || "").toLowerCase();
  if (/month|\bpm\b|p\/m|\/m\b|\bdd\b|direct debit/.test(s)) return "monthly";
  if (/quarter/.test(s)) return "quarterly";
  if (/year|annual|\bpa\b|p\/a|\/y/.test(s)) return "yearly";
  if (/one|once|single/.test(s)) return "one-off";
  return null;
}

/* Turns sheet rows into items, using `map` (field key → column index). */
export function rowsToItems(rows, map) {
  const get = (r, k) => (map[k] == null ? "" : r[map[k]] || "");
  return rows.filter((r) => Object.values(map).some((i) => r[i])).map((r) => {
    const title = get(r, "title");
    const catText = get(r, "category");
    const cat = guessCategory(catText, title);
    const costText = get(r, "cost");
    return {
      title: title || category(cat).label,
      category: cat,
      provider: get(r, "provider") || null,
      reference: get(r, "reference") || null,
      covers: get(r, "covers") || null,
      cost: parseCost(costText),
      frequency: parseFreq(get(r, "frequency")) || parseFreq(costText) || category(cat).freq,
      renewalDate: parseDate(get(r, "renewalDate")),
      phone: get(r, "phone") || null,
      website: get(r, "website") || null,
      notes: get(r, "notes") || null,
      rawDate: get(r, "renewalDate"),
    };
  });
}
