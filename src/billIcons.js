/* Icons for budget lines, picked from the line's name. `tone` reuses the area colours. */
const I = {
  house: '<path d="M3 11.5 12 4l9 7.5"></path><path d="M5.5 9.5V20h13V9.5"></path><path d="M10 20v-5.5h4V20"></path>',
  flat: '<rect x="5" y="3" width="14" height="18" rx="1.5"></rect><path d="M9 7h1.5M13.5 7H15M9 11h1.5M13.5 11H15M10.5 21v-4h3v4"></path>',
  water: '<path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11z"></path>',
  flame: '<path d="M12 21a6 6 0 0 0 6-6c0-4-3-6-3.5-9.5C12 7 9.5 9.5 9.5 12.5 8.4 11.8 8 10.6 8 9.5 6.8 11 6 12.8 6 15a6 6 0 0 0 6 6z"></path>',
  car: '<path d="M5 16.5h14M3.5 16.5V12l2.2-5h12.6l2.2 5v4.5"></path><path d="M3.5 12h17"></path><circle cx="7.5" cy="17" r="1.8"></circle><circle cx="16.5" cy="17" r="1.8"></circle>',
  fuel: '<path d="M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3.5 21h13M5 10h10"></path><path d="M15 8h1.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 0 3 0V8l-2.5-2.5"></path>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"></rect><path d="M8 21h8M12 17v4"></path>',
  play: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m10 9 5 3-5 3z"></path>',
  health: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"></path><path d="M12 10.5v5M9.5 13h5"></path>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"></path><path d="m9 12 2 2 4-4"></path>',
  bank: '<path d="M3 9.5 12 4l9 5.5M4.5 20h15M6 10v7M10 10v7M14 10v7M18 10v7"></path>',
  council: '<path d="M4 20h16M5 20V10h14v10M3 10l9-6 9 6"></path><path d="M9 20v-5h6v5"></path>',
  oven: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M4 8h16M8 5.5h.01M11 5.5h.01"></path><rect x="7.5" y="11" width="9" height="6.5" rx="1"></rect>',
  washer: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M4 7h16M7.5 5h.01"></path><circle cx="12" cy="14" r="4"></circle>',
  dishwasher: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M4 7.5h16M8 5.2h4M7.5 12h9M7.5 15.5h9"></path>',
  fridge: '<rect x="5.5" y="2.5" width="13" height="19" rx="2"></rect><path d="M5.5 10h13M8.5 5.5v2M8.5 12.5v3"></path>',
  kitchen: '<path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 21V3c-2 1.5-3 4-3 7v3h3"></path>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M11 18.5h2"></path>',
  food: '<path d="M4 9h16l-1.6 10.2a2 2 0 0 1-2 1.8H7.6a2 2 0 0 1-2-1.8z"></path><path d="m9 9 2-5M15 9l-2-5M9.5 13v4M14.5 13v4"></path>',
  tools: '<path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L3.5 17.5a2.1 2.1 0 0 0 3 3l5.7-5.7a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"></path>',
  person: '<circle cx="12" cy="8" r="4"></circle><path d="M4.5 21a7.5 7.5 0 0 1 15 0"></path>',
  coins: '<ellipse cx="9" cy="7" rx="5" ry="2.5"></ellipse><path d="M4 7v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7"></path><path d="M10 15.5c.6 1.2 2.6 2 5 2 2.8 0 5-1.1 5-2.5v-4c0-1.4-2.2-2.5-5-2.5"></path>',
  pound: '<circle cx="12" cy="12" r="9"></circle><path d="M14.5 8.3A2.5 2.5 0 0 0 10 9.8V16M8.5 12.5h4.5M8.5 16h7"></path>',
  receipt: '<path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z"></path><path d="M9 8h6M9 12h6"></path>',
};

const RULES = [
  [/flat mortgage/i, "flat", "home"],
  [/mortgage|rent\b|loft/i, "house", "home"],
  [/water/i, "water", "home"],
  [/gas|electric|energy|boiler/i, "flame", "bills"],
  [/petrol|diesel|fuel/i, "fuel", "car"],
  [/\bcar\b|vehicle|parking/i, "car", "car"],
  [/netflix|disney|prime|spotify|apple|stream/i, "play", "bills"],
  [/\btv\b|sky|virgin|broadband|licen[cs]e/i, "tv", "bills"],
  [/health|bupa|dental|vitality/i, "health", "family"],
  [/life|insurance|cover/i, "shield", "family"],
  [/council/i, "council", "home"],
  [/account|bank|fee|card|loan/i, "bank", "bills"],
  [/oven|cooker/i, "oven", "home"],
  [/dishwasher/i, "dishwasher", "home"],
  [/washing|washer|dryer/i, "washer", "home"],
  [/fridge|freezer/i, "fridge", "home"],
  [/kitchen/i, "kitchen", "home"],
  [/phone|mobile/i, "phone", "bills"],
  [/food|milk|grocer|shop/i, "food", "family"],
];

export function billIcon(name, kind) {
  if (kind === "in") {
    if (/cash ?back|interest|refund/i.test(name)) return { icon: I.coins, tone: "in" };
    if (/wage|salary|pay|benefit|\bben\b|pension|other/i.test(name)) return { icon: I.pound, tone: "in" };
    return { icon: I.person, tone: "in" };
  }
  const hit = RULES.find(([re]) => re.test(name));
  return hit ? { icon: I[hit[1]], tone: hit[2] } : { icon: I.receipt, tone: "plain" };
}
