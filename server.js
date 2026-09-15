const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const store = require("./storage");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.VERCEL
  ? path.join("/tmp", "foodwise")
  : path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "entries.json");
const FEEDBACK_FILE = path.join(DATA_DIR, "feedback.json");
const ACTIONS_FILE = path.join(DATA_DIR, "actions.json");
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, "[]\n", "utf8");
  }
  try {
    await fs.access(FEEDBACK_FILE);
  } catch {
    await fs.writeFile(FEEDBACK_FILE, "[]\n", "utf8");
  }
  try {
    await fs.access(ACTIONS_FILE);
  } catch {
    await fs.writeFile(ACTIONS_FILE, "[]\n", "utf8");
  }
}

async function readFeedback() {
  await ensureDataFile();
  const saved = store.list("feedback");
  if (saved.length) return saved;
  const legacy = JSON.parse(await fs.readFile(FEEDBACK_FILE, "utf8"));
  if (legacy.length) store.replace("feedback", legacy);
  return legacy;
}

async function writeFeedback(items) {
  store.replace("feedback", items);
}

async function readActions() {
  await ensureDataFile();
  const saved = store.list("actions");
  if (saved.length) return saved;
  const legacy = JSON.parse(await fs.readFile(ACTIONS_FILE, "utf8"));
  if (legacy.length) store.replace("actions", legacy);
  return legacy;
}

async function writeActions(items) {
  store.replace("actions", items);
}

async function readEntries() {
  await ensureDataFile();
  const saved = store.list("entries");
  if (saved.length) return saved;
  const legacy = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
  if (legacy.length) store.replace("entries", legacy);
  return legacy;
}

async function writeEntries(entries) {
  store.replace("entries", entries);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Image or request is too large."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON request."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function validateEntry(input) {
  const required = ["foodItem", "category", "source", "quantity", "unit", "action"];
  const missing = required.filter(key => String(input[key] ?? "").trim() === "");
  if (missing.length) return `Missing required fields: ${missing.join(", ")}`;
  if (!Number.isFinite(Number(input.quantity)) || Number(input.quantity) <= 0) {
    return "Quantity must be a positive number.";
  }
  return null;
}

function recommendAction(category, source) {
  if (category === "Non-food contamination") {
    return "Separate packaging and other contaminants from food waste, then place each material in its approved collection stream.";
  }
  if (category === "Untouched surplus" || source === "Untouched surplus") {
    return "Hold separately for staff food-safety assessment. Redistribute only when storage, handling and local food-safety requirements are satisfied.";
  }
  if (category === "Fruit & vegetable waste") {
    return "Keep free from packaging and send to the approved composting or organic-waste processing stream.";
  }
  if (category === "Spoiled food") {
    return "Keep separate from usable food and send to the approved organic-waste stream; do not redistribute.";
  }
  return "Keep packaging separate and send the food to the approved organic-waste or composting stream.";
}

function toKg(entry) {
  const amount = Number(entry.quantity) || 0;
  if (entry.unit === "g") return amount / 1000;
  if (entry.unit === "kg") return amount;
  return 0;
}

function getSummary(entries) {
  const totalKg = entries.reduce((sum, entry) => sum + toKg(entry), 0);

  const counts = entries.reduce((result, entry) => {
    result[entry.category] = (result[entry.category] || 0) + 1;
    return result;
  }, {});

  const foodTotals = entries.reduce((result, entry) => {
    const amount = toKg(entry);
    result[entry.foodItem] = (result[entry.foodItem] || 0) + amount;
    return result;
  }, {});

  const topFood = Object.entries(foodTotals).sort((a, b) => b[1] - a[1])[0];
  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const inWindow = (entry, start, end) => {
    const age = now - new Date(entry.createdAt).getTime();
    return Number.isFinite(age) && age >= start && age < end;
  };
  const weeklyKg = entries.filter(entry => inWindow(entry, 0, weekMs)).reduce((sum, entry) => sum + toKg(entry), 0);
  const previousWeekKg = entries.filter(entry => inWindow(entry, weekMs, weekMs * 2)).reduce((sum, entry) => sum + toKg(entry), 0);
  const monthMs = 30 * 24 * 60 * 60 * 1000;
  const monthlyKg = entries.filter(entry => inWindow(entry, 0, monthMs)).reduce((sum, entry) => sum + toKg(entry), 0);
  const previousMonthKg = entries.filter(entry => inWindow(entry, monthMs, monthMs * 2)).reduce((sum, entry) => sum + toKg(entry), 0);
  const sourceCounts = entries.reduce((result, entry) => {
    result[entry.source] = (result[entry.source] || 0) + 1;
    return result;
  }, {});
  const topSource = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])[0];
  const groupKg = key => Object.entries(entries.reduce((result, entry) => {
    const name = entry[key] || "Not specified";
    result[name] = (result[name] || 0) + toKg(entry);
    return result;
  }, {})).map(([name, kg]) => ({ name, kg: Number(kg.toFixed(2)) })).sort((a, b) => b.kg - a.kg);
  const byDay = Object.entries(entries.reduce((result, entry) => {
    const day = new Date(entry.createdAt).toLocaleDateString("en-US", { weekday: "short", timeZone: "Asia/Kolkata" });
    result[day] = (result[day] || 0) + toKg(entry);
    return result;
  }, {})).map(([name, kg]) => ({ name, kg: Number(kg.toFixed(2)) }));
  const unavoidableKg = entries.filter(entry => entry.reason === "Preparation scraps").reduce((sum, entry) => sum + toKg(entry), 0);
  const avoidableKg = Math.max(0, totalKg - unavoidableKg);
  const mealsServed = entries.reduce((sum, entry) => sum + (Number(entry.mealsServed) || 0), 0);
  const correctActions = entries.filter(entry => entry.actionTaken && entry.actionTaken === entry.action).length;
  const measured = entries.filter(entry => toKg(entry) > 0);
  const averageKg = measured.length ? totalKg / measured.length : 0;
  const unusual = measured.filter(entry => measured.length >= 3 && toKg(entry) > averageKg * 1.5).slice(-3);
  const trendPercent = previousWeekKg ? ((weeklyKg - previousWeekKg) / previousWeekKg) * 100 : null;
  const insights = [];
  if (topFood) insights.push(`${topFood[0]} is the largest measured waste item at ${topFood[1].toFixed(1)} kg.`);
  if (topSource) insights.push(`Most recorded batches come from ${topSource[0].toLowerCase()}.`);
  const topMeal = groupKg("meal")[0];
  if (topMeal?.kg) insights.push(`${topMeal.name} has the highest measured waste at ${topMeal.kg} kg.`);
  if (trendPercent !== null) insights.push(`Waste is ${Math.abs(trendPercent).toFixed(0)}% ${trendPercent <= 0 ? "lower" : "higher"} than the previous week.`);
  return {
    totalEntries: entries.length,
    totalKg: Number(totalKg.toFixed(2)),
    divertedEntries: entries.filter(entry => /compost|redistribution|organic/i.test(entry.action)).length,
    categoryCounts: counts,
    topFood: topFood ? { name: topFood[0], kg: Number(topFood[1].toFixed(2)) } : null,
    weeklyKg: Number(weeklyKg.toFixed(2)),
    previousWeekKg: Number(previousWeekKg.toFixed(2)),
    monthlyKg: Number(monthlyKg.toFixed(2)),
    previousMonthKg: Number(previousMonthKg.toFixed(2)),
    trendPercent: trendPercent === null ? null : Number(trendPercent.toFixed(1)),
    topSource: topSource ? { name: topSource[0], count: topSource[1] } : null,
    mealsServed,
    wastePer100Meals: mealsServed ? Number((totalKg / mealsServed * 100).toFixed(2)) : 0,
    avoidableKg: Number(avoidableKg.toFixed(2)),
    unavoidableKg: Number(unavoidableKg.toFixed(2)),
    correctSegregationRate: entries.length ? Math.round(correctActions / entries.length * 100) : 0,
    bySource: groupKg("source"),
    byMeal: groupKg("meal"),
    byDay,
    insights,
    alerts: unusual.map(entry => ({ id: entry.id, message: `Unusual batch: ${entry.foodItem} was ${toKg(entry).toFixed(1)} kg.` }))
  };
}

function getFeedbackSummary(items) {
  const average = key => items.length ? items.reduce((sum, item) => sum + (Number(item[key]) || 0), 0) / items.length : 0;
  const reasons = items.reduce((result, item) => {
    if (item.leftoverReason && item.leftoverReason !== "No leftovers") result[item.leftoverReason] = (result[item.leftoverReason] || 0) + 1;
    return result;
  }, {});
  const topReason = Object.entries(reasons).sort((a, b) => b[1] - a[1])[0];
  const mealTypes = items.reduce((result, item) => {
    const type = item.mealType || "Not specified";
    result[type] = (result[type] || 0) + 1;
    return result;
  }, {});
  const topMealType = Object.entries(mealTypes).sort((a, b) => b[1] - a[1])[0];
  const menuVotes = items.reduce((result, item) => {
    if (item.menuVote) result[item.menuVote] = (result[item.menuVote] || 0) + 1;
    return result;
  }, {});
  const topMenuVote = Object.entries(menuVotes).sort((a, b) => b[1] - a[1])[0];
  const patterns = items.reduce((result, item) => {
    if (item.portionAssessment !== "Over portion") return result;
    const day = item.serviceDate ? new Date(`${item.serviceDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" }) : "Unknown day";
    const key = `${day} ${item.mealType || "meal"}`;
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
  const topOverPortionPattern = Object.entries(patterns).sort((a, b) => b[1] - a[1])[0];
  return {
    totalResponses: items.length,
    averageFoodRating: Number(average("foodRating").toFixed(1)),
    averagePortionRating: Number(average("portionRating").toFixed(1)),
    wouldChooseSmallerPortion: items.filter(item => item.smallerPortion === "Yes").length,
    overPortionResponses: items.filter(item => item.portionAssessment === "Over portion").length,
    topLeftoverReason: topReason ? { name: topReason[0], count: topReason[1] } : null,
    topMealType: topMealType ? { name: topMealType[0], count: topMealType[1] } : null,
    mealTypeCounts: mealTypes,
    topMenuVote: topMenuVote ? { name: topMenuVote[0], count: topMenuVote[1] } : null,
    topOverPortionPattern: topOverPortionPattern ? { name: topOverPortionPattern[0], count: topOverPortionPattern[1] } : null
  };
}

function filterFeedback(items, searchParams) {
  const from = searchParams?.get("from");
  const to = searchParams?.get("to");
  const mealType = searchParams?.get("mealType");
  const status = searchParams?.get("status");
  return items.filter(item => {
    const date = item.serviceDate || String(item.createdAt || "").slice(0, 10);
    return (!from || date >= from) && (!to || date <= to) && (!mealType || item.mealType === mealType) && (!status || (item.reviewStatus || "New") === status);
  });
}

function getDishComparison(entries, feedback) {
  const dishes = new Map();
  for (const item of feedback) {
    const name = String(item.meal || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const current = dishes.get(key) || { name, ratings: [], wasteKg: 0, responses: 0 };
    current.ratings.push(Number(item.foodRating) || 0);
    current.responses += 1;
    dishes.set(key, current);
  }
  for (const entry of entries) {
    const entryName = String(entry.foodItem || "").toLowerCase();
    for (const [key, dish] of dishes) {
      if (entryName.includes(key) || key.includes(entryName)) dish.wasteKg += toKg(entry);
    }
  }
  return [...dishes.values()].map(dish => ({ name: dish.name, rating: Number((dish.ratings.reduce((a, b) => a + b, 0) / dish.ratings.length).toFixed(1)), wasteKg: Number(dish.wasteKg.toFixed(2)), responses: dish.responses })).sort((a, b) => b.wasteKg - a.wasteKg);
}

function createStyledPdf(title, sections) {
  const clean = value => String(value ?? "").replace(/[^\x20-\x7E]/g, "-").replace(/[()\\]/g, "\\$&");
  const wrap = (value, width = 82) => { const words = clean(value).split(/\s+/); const lines = []; let line = ""; for (const word of words) { if ((line + " " + word).trim().length > width) { if (line) lines.push(line); line = word; } else line = (line + " " + word).trim(); } if (line) lines.push(line); return lines.length ? lines : [""]; };
  const pages = [];
  let commands, y;
  const startPage = () => {
    commands = ["0.075 0.20 0.16 rg", "0 0 612 792 re f", "0.85 0.94 0.46 rg", "46 710 8 34 re f", "1 1 1 rg", "BT", "/F2 22 Tf", "68 744 Td", `(${clean(title)}) Tj`, "/F1 9 Tf", "0 -20 Td", `(Generated ${clean(new Date().toLocaleString("en-IN"))}) Tj`, "ET", "0.965 0.97 0.94 rg", "0 0 612 695 re f"];
    pages.push(commands); y = 670;
  };
  const footer = (page, number, total) => page.push("0.78 0.84 0.80 RG", "46 42 m 566 42 l S", "0.30 0.39 0.35 rg", "BT", "/F1 8 Tf", "46 25 Td", "(FoodWise | SDG 12 - Responsible Consumption and Production) Tj", "480 0 Td", `(Page ${number} of ${total}) Tj`, "ET");
  startPage();
  for (const section of sections) {
    const rows = (section.lines || []).flatMap(line => wrap(line));
    const needed = 45 + Math.min(rows.length, 4) * 18;
    if (y - needed < 72) startPage();
    commands.push("0.10 0.32 0.24 rg", "BT", "/F2 14 Tf", `46 ${y} Td`, `(${clean(section.heading)}) Tj`, "ET", "0.80 0.89 0.84 RG", `46 ${y - 9} m 566 ${y - 9} l S`);
    y -= 29;
    for (const row of rows) {
      if (y < 70) { startPage(); commands.push("0.10 0.32 0.24 rg", "BT", "/F2 12 Tf", `46 ${y} Td`, `(${clean(section.heading)} - continued) Tj`, "ET"); y -= 26; }
      commands.push("1 1 1 rg", `46 ${y - 5} 520 22 re f`, "0.20 0.27 0.24 rg", "BT", "/F1 9 Tf", `58 ${y + 2} Td`, `(${clean(row)}) Tj`, "ET");
      y -= 27;
    }
    y -= 12;
  }
  pages.forEach((page, index) => footer(page, index + 1, pages.length));
  const fontRegular = 3 + pages.length * 2, fontBold = fontRegular + 1;
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`];
  pages.forEach((page, index) => { const stream = page.join("\n"), contentRef = 4 + index * 2; objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentRef} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`); });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index++) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "binary");
}

function buildPdfReport(summary, feedbackSummary, entries, actions = []) {
  return createStyledPdf("FoodWise Sustainability Report", [
    { heading: "Waste performance", lines: [`Total recorded waste | ${summary.totalKg} kg`, `Waste per 100 meals | ${summary.wastePer100Meals} kg across ${summary.mealsServed} meals`, `Weekly comparison | ${summary.weeklyKg} kg this week vs ${summary.previousWeekKg} kg previously`, `30-day comparison | ${summary.monthlyKg} kg vs ${summary.previousMonthKg} kg`, `Waste type | ${summary.avoidableKg} kg avoidable | ${summary.unavoidableKg} kg unavoidable`, `Correct segregation | ${summary.correctSegregationRate}%`] },
    { heading: "Reduction insights", lines: summary.insights.length ? summary.insights : ["More waste records are needed for pattern insights."] },
    { heading: "Customer feedback", lines: [`Responses | ${feedbackSummary.totalResponses}`, `Food rating | ${feedbackSummary.averageFoodRating}/5`, `Portion rating | ${feedbackSummary.averagePortionRating}/5`, `Smaller portion preference | ${feedbackSummary.wouldChooseSmallerPortion}`, `Over-portion reports | ${feedbackSummary.overPortionResponses}`, `Most reviewed meal | ${feedbackSummary.topMealType?.name || "Not enough responses"}`, `Top menu vote | ${feedbackSummary.topMenuVote?.name || "Not enough responses"}`, `Top leftover reason | ${feedbackSummary.topLeftoverReason?.name || "Not enough responses"}`] },
    { heading: "Manager actions", lines: actions.length ? actions.slice(0, 8).map(action => `${action.title} | ${action.status} | Baseline: ${action.baseline} | Result: ${action.result ?? "Pending"}`) : ["No manager actions recorded."] },
    { heading: "Recent waste records", lines: entries.length ? entries.slice(0, 12).map(entry => `${new Date(entry.createdAt).toLocaleDateString("en-IN")} | ${entry.foodItem} | ${entry.quantity} ${entry.unit} | ${entry.source}`) : ["No waste records available."] }
  ]);
}

function buildListPdf(title, sections) {
  return createStyledPdf(title, sections.map(section => ({ heading: section.heading, lines: section.lines.length ? section.lines : ["No records available."] })));
}

function cookieToken(req) {
  const cookies = Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => part.trim().split("=")).filter(pair => pair.length === 2));
  return cookies.foodwise_session || "";
}

function authUser(req) {
  return store.getSession(cookieToken(req));
}

function deny(res, roles) {
  return sendJson(res, 403, { error: `This action requires ${roles.join(" or ")} access.` });
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === "GET" && pathname === "/api/auth/status") {
    return sendJson(res, 200, { bootstrapRequired: store.userCount() === 0, user: authUser(req) });
  }

  if (req.method === "POST" && pathname === "/api/register") {
    if (store.userCount() > 0) return sendJson(res, 403, { error: "Initial manager account already exists." });
    const input = await readJson(req);
    if (!input.name || !input.username || String(input.password || "").length < 8) return sendJson(res, 400, { error: "Name, username and a password of at least 8 characters are required." });
    const user = store.createUser({ name: String(input.name).trim(), username: String(input.username).trim(), password: String(input.password), role: "manager" });
    const session = store.createSession(user);
    store.audit(user, "create", "user", user.id, { role: user.role });
    res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": `foodwise_session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
    return res.end(JSON.stringify({ user }));
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const input = await readJson(req);
    const user = store.authenticate(input.username, input.password, input.role);
    if (!user) return sendJson(res, 401, { error: "Invalid name or password." });
    const session = store.createSession(user);
    store.audit(user, "login", "session", null);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": `foodwise_session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
    return res.end(JSON.stringify({ user }));
  }

  if (req.method === "POST" && pathname === "/api/staff/register") {
    const input = await readJson(req);
    const name = String(input.name || "").trim();
    const password = String(input.password || "");
    if (name.length < 2 || password.length < 8) return sendJson(res, 400, { error: "Enter a name and a password of at least 8 characters." });
    if (store.userNameExists(name, "staff")) return sendJson(res, 409, { error: "A staff account with this name already exists. Choose Login instead." });
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "staff";
    let username = base, suffix = 2;
    const usernames = new Set(store.listUsers().map(item => item.username));
    while (usernames.has(username)) username = `${base}${suffix++}`;
    const user = store.createUser({ name, username, password, role: "staff" });
    const session = store.createSession(user);
    store.audit(user, "register", "user", user.id, { role: "staff" });
    res.writeHead(201, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": `foodwise_session=${session.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` });
    return res.end(JSON.stringify({ user }));
  }

  if (req.method === "POST" && pathname === "/api/logout") {
    const user = authUser(req);
    store.endSession(cookieToken(req));
    store.audit(user, "logout", "session", null);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "foodwise_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    return res.end(JSON.stringify({ loggedOut: true }));
  }

  const user = authUser(req);
  if (!user && !(req.method === "POST" && pathname === "/api/feedback")) return sendJson(res, 401, { error: "Please sign in." });
  const managerOnly = ["/api/users", "/api/audit", "/api/backup", "/api/restore", "/api/settings", "/api/report.pdf", "/api/history.pdf", "/api/feedback.pdf", "/api/insights/dishes", "/api/weekly-update"];
  if (managerOnly.includes(pathname) && user.role !== "manager") return deny(res, ["manager"]);
  if (req.method === "GET" && ["/api/feedback", "/api/actions", "/api/entries", "/api/summary"].includes(pathname) && user.role !== "manager") return deny(res, ["manager"]);

  if (pathname === "/api/users" && user.role !== "manager") return deny(res, ["manager"]);
  if (req.method === "GET" && pathname === "/api/users") return sendJson(res, 200, store.listUsers());
  if (req.method === "POST" && pathname === "/api/users") {
    const input = await readJson(req);
    if (!["manager", "staff", "customer"].includes(input.role) || !input.name || !input.username || String(input.password || "").length < 8) return sendJson(res, 400, { error: "Name, username, role and an 8-character password are required." });
    try {
      const created = store.createUser({ name: String(input.name).trim(), username: String(input.username).trim(), password: String(input.password), role: input.role });
      store.audit(user, "create", "user", created.id, { role: created.role });
      return sendJson(res, 201, created);
    } catch {
      return sendJson(res, 409, { error: "That username is already in use." });
    }
  }

  if (req.method === "GET" && pathname === "/api/operations") return sendJson(res, 200, store.list("operations"));
  if (req.method === "POST" && pathname === "/api/operations") {
    if (!["manager", "staff"].includes(user.role)) return deny(res, ["manager", "staff"]);
    const input = await readJson(req);
    if (!input.date || !input.mealType || !input.menu) return sendJson(res, 400, { error: "Date, meal type and menu are required." });
    const operation = store.upsert("operations", { id: crypto.randomUUID(), date: input.date, mealType: input.mealType, menu: String(input.menu).trim(), mealsPrepared: Number(input.mealsPrepared) || 0, mealsServed: Number(input.mealsServed) || 0, attendance: Number(input.attendance) || 0, untouchedSurplusKg: Number(input.untouchedSurplusKg) || 0, createdAt: new Date().toISOString() });
    store.audit(user, "create", "operation", operation.id);
    return sendJson(res, 201, operation);
  }

  if (req.method === "GET" && pathname === "/api/inventory") return sendJson(res, 200, store.list("inventory"));
  if (req.method === "POST" && pathname === "/api/inventory") {
    if (!["manager", "staff"].includes(user.role)) return deny(res, ["manager", "staff"]);
    const input = await readJson(req);
    if (!input.name || !input.expiryDate) return sendJson(res, 400, { error: "Ingredient and expiry date are required." });
    const item = store.upsert("inventory", { id: crypto.randomUUID(), name: String(input.name).trim(), quantity: Number(input.quantity) || 0, unit: String(input.unit || "kg"), expiryDate: input.expiryDate, minStock: Number(input.minStock) || 0, createdAt: new Date().toISOString() });
    store.audit(user, "create", "inventory", item.id);
    return sendJson(res, 201, item);
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/inventory/")) {
    if (user.role !== "manager") return deny(res, ["manager"]);
    const id = pathname.slice("/api/inventory/".length);
    const removed = store.remove("inventory", id);
    if (removed) store.audit(user, "delete", "inventory", id);
    return sendJson(res, removed ? 200 : 404, removed ? { deleted: true } : { error: "Inventory item not found." });
  }

  if (req.method === "GET" && pathname === "/api/forecast") {
    const operations = store.list("operations");
    const byMeal = {};
    for (const item of operations) {
      const bucket = byMeal[item.mealType] ||= { served: [], surplus: [] };
      bucket.served.push(Number(item.mealsServed) || 0);
      bucket.surplus.push(Number(item.untouchedSurplusKg) || 0);
    }
    const forecast = Object.entries(byMeal).map(([mealType, data]) => {
      const averageServed = data.served.reduce((a, b) => a + b, 0) / data.served.length;
      const averageSurplusKg = data.surplus.reduce((a, b) => a + b, 0) / data.surplus.length;
      return { mealType, averageServed: Math.round(averageServed), recommendedPreparation: Math.ceil(averageServed * 1.05), averageSurplusKg: Number(averageSurplusKg.toFixed(2)), samples: data.served.length };
    });
    return sendJson(res, 200, forecast);
  }

  if (req.method === "GET" && pathname === "/api/impact") {
    const summary = getSummary(await readEntries());
    const divertedKg = summary.totalKg * (summary.totalEntries ? summary.divertedEntries / summary.totalEntries : 0);
    const settings = store.list("settings")[0] || { impactValuePerKg: 80, co2PerKg: 2.5 };
    return sendJson(res, 200, { estimatedValueSaved: Number((divertedKg * settings.impactValuePerKg).toFixed(0)), portionsRecovered: Math.round(divertedKg / 0.35), compostKg: Number(divertedKg.toFixed(1)), avoidedCo2Kg: Number((divertedKg * settings.co2PerKg).toFixed(1)), methodology: `Prototype estimates use INR ${settings.impactValuePerKg}/kg, 0.35 kg/portion and ${settings.co2PerKg} kg CO2e/kg diverted.` });
  }

  if (req.method === "GET" && pathname === "/api/notifications") {
    const today = new Date().toISOString().slice(0, 10);
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    const notifications = store.list("inventory").filter(item => item.expiryDate <= soon).map(item => ({ level: item.expiryDate < today ? "urgent" : "warning", message: `${item.name} ${item.expiryDate < today ? "has expired" : "expires soon"} (${item.expiryDate}).` }));
    if (!store.list("operations").some(item => item.date === today)) notifications.push({ level: "info", message: "No cafeteria operation has been recorded today." });
    return sendJson(res, 200, notifications);
  }

  if (req.method === "GET" && pathname === "/api/recommendations") {
    const summary = getSummary(await readEntries());
    const feedbackSummary = getFeedbackSummary(await readFeedback());
    const recommendations = [];
    if (summary.topFood) recommendations.push(`Review preparation and portion sizes for ${summary.topFood.name}; it leads measured waste at ${summary.topFood.kg} kg.`);
    if (feedbackSummary.overPortionResponses) recommendations.push(`Offer small portions by default or choice; ${feedbackSummary.overPortionResponses} customers reported over-portioning.`);
    if (summary.correctSegregationRate < 80) recommendations.push("Place clearer bin signage at the return station and brief staff on confirming the actual disposal action.");
    if (!recommendations.length) recommendations.push("Continue daily recording until enough evidence is available for a targeted intervention.");
    return sendJson(res, 200, recommendations);
  }

  if (req.method === "GET" && pathname === "/api/audit") {
    if (user.role !== "manager") return deny(res, ["manager"]);
    return sendJson(res, 200, store.auditList());
  }

  if (req.method === "GET" && pathname === "/api/backup") {
    if (user.role !== "manager") return deny(res, ["manager"]);
    const backup = { version: 1, exportedAt: new Date().toISOString(), entries: await readEntries(), feedback: await readFeedback(), actions: await readActions(), operations: store.list("operations"), inventory: store.list("inventory") };
    const body = Buffer.from(JSON.stringify(backup, null, 2));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="foodwise-backup.json"', "Content-Length": body.length });
    store.audit(user, "export", "backup", null);
    return res.end(body);
  }

  if (req.method === "POST" && pathname === "/api/restore") {
    if (user.role !== "manager") return deny(res, ["manager"]);
    const input = await readJson(req);
    for (const key of ["entries", "feedback", "actions", "operations", "inventory"]) if (Array.isArray(input[key])) store.replace(key, input[key]);
    store.audit(user, "restore", "backup", null);
    return sendJson(res, 200, { restored: true });
  }

  if (req.method === "GET" && pathname === "/api/settings") {
    return sendJson(res, 200, store.list("settings")[0] || { id: "privacy", feedbackRetentionDays: 365, impactValuePerKg: 80, co2PerKg: 2.5 });
  }

  if (req.method === "POST" && pathname === "/api/settings") {
    if (user.role !== "manager") return deny(res, ["manager"]);
    const input = await readJson(req);
    const settings = store.upsert("settings", { id: "privacy", feedbackRetentionDays: Math.max(30, Number(input.feedbackRetentionDays) || 365), impactValuePerKg: Number(input.impactValuePerKg) || 80, co2PerKg: Number(input.co2PerKg) || 2.5, createdAt: new Date().toISOString() });
    const cutoff = Date.now() - settings.feedbackRetentionDays * 86400000;
    const retained = (await readFeedback()).filter(item => new Date(item.createdAt).getTime() >= cutoff);
    await writeFeedback(retained);
    store.audit(user, "update", "settings", settings.id, { feedbackRetentionDays: settings.feedbackRetentionDays });
    return sendJson(res, 200, settings);
  }

  if (req.method === "GET" && pathname === "/api/feedback") {
    const feedback = filterFeedback(await readFeedback(), searchParams);
    return sendJson(res, 200, { items: feedback.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)), summary: getFeedbackSummary(feedback) });
  }

  if (req.method === "POST" && pathname === "/api/feedback") {
    const input = await readJson(req);
    if (!String(input.meal || "").trim() || !String(input.serviceDate || "").trim() || !String(input.mealType || "").trim() || !Number.isFinite(Number(input.foodRating))) return sendJson(res, 400, { error: "Date, meal type, dish and food rating are required." });
    const feedback = await readFeedback();
    const item = {
      id: crypto.randomUUID(),
      customerName: String(input.customerName || "Anonymous").trim(),
      serviceDate: String(input.serviceDate).trim(),
      mealType: String(input.mealType).trim(),
      meal: String(input.meal).trim(),
      anonymous: input.anonymous === true || input.anonymous === "on",
      foodRating: Math.min(5, Math.max(1, Number(input.foodRating))),
      portionRating: Math.min(5, Math.max(1, Number(input.portionRating) || 3)),
      portionAssessment: String(input.portionAssessment || "Right portion").trim(),
      portionChoice: String(input.portionChoice || "Regular").trim(),
      leftoverAmount: String(input.leftoverAmount || "None").trim(),
      dietaryPreference: String(input.dietaryPreference || "No preference").trim(),
      menuVote: String(input.menuVote || "").trim(),
      leftoverReason: String(input.leftoverReason || "No leftovers").trim(),
      smallerPortion: String(input.smallerPortion || "No").trim(),
      comments: String(input.comments || "").trim(),
      createdAt: new Date().toISOString()
    };
    item.reviewStatus = "New";
    item.managerReply = "";
    if (item.anonymous) item.customerName = "Anonymous";
    feedback.push(item);
    await writeFeedback(feedback);
    store.audit(user, "create", "feedback", item.id, { anonymous: item.anonymous });
    return sendJson(res, 201, item);
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/feedback/")) {
    const input = await readJson(req);
    const feedback = await readFeedback();
    const item = feedback.find(entry => entry.id === pathname.slice("/api/feedback/".length));
    if (!item) return sendJson(res, 404, { error: "Customer response not found." });
    if (input.reviewStatus) item.reviewStatus = String(input.reviewStatus);
    if (input.managerReply !== undefined) item.managerReply = String(input.managerReply).trim();
    item.reviewedAt = new Date().toISOString();
    await writeFeedback(feedback);
    store.audit(user, "update", "feedback", item.id, { reviewStatus: item.reviewStatus });
    return sendJson(res, 200, item);
  }

  if (req.method === "GET" && pathname === "/api/insights/dishes") {
    return sendJson(res, 200, getDishComparison(await readEntries(), await readFeedback()));
  }

  if (req.method === "GET" && pathname === "/api/weekly-update") {
    const summary = getSummary(await readEntries());
    const feedback = getFeedbackSummary(await readFeedback());
    const subject = `FoodWise weekly update - ${summary.weeklyKg} kg waste recorded`;
    const body = [
      "Hello cafeteria team,",
      "",
      `This week FoodWise recorded ${summary.weeklyKg} kg of food waste across ${summary.totalEntries} tracked batches.`,
      `Waste per 100 meals is ${summary.wastePer100Meals} kg and correct segregation is ${summary.correctSegregationRate}%.`,
      `Customers submitted ${feedback.totalResponses} responses with an average food rating of ${feedback.averageFoodRating}/5.`,
      feedback.topLeftoverReason ? `The most common leftover reason was ${feedback.topLeftoverReason.name.toLowerCase()}.` : "More customer responses are needed to identify a recurring leftover reason.",
      summary.insights[0] || "Continue recording daily waste to build stronger reduction insights.",
      "",
      "Recommended next step: review the highest-waste dish and the latest over-portion reports before next week's menu planning.",
      "",
      "FoodWise Sustainability Assistant"
    ].join("\n");
    return sendJson(res, 200, { subject, body });
  }

  if (req.method === "GET" && pathname === "/api/actions") {
    return sendJson(res, 200, (await readActions()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }

  if (req.method === "POST" && pathname === "/api/actions") {
    const input = await readJson(req);
    if (!String(input.title || "").trim() || !String(input.startDate || "").trim()) return sendJson(res, 400, { error: "Action title and start date are required." });
    const actions = await readActions();
    const action = {
      id: crypto.randomUUID(),
      title: String(input.title).trim(),
      startDate: String(input.startDate).trim(),
      targetMetric: String(input.targetMetric || "Reduce food waste").trim(),
      baseline: Number(input.baseline) || 0,
      result: Number(input.result) || null,
      status: String(input.status || "In progress").trim(),
      notes: String(input.notes || "").trim(),
      createdAt: new Date().toISOString()
    };
    actions.push(action);
    await writeActions(actions);
    store.audit(user, "create", "action", action.id);
    return sendJson(res, 201, action);
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/actions/")) {
    const input = await readJson(req);
    const actions = await readActions();
    const action = actions.find(item => item.id === pathname.slice("/api/actions/".length));
    if (!action) return sendJson(res, 404, { error: "Manager action not found." });
    if (input.result !== undefined) action.result = Number(input.result);
    if (input.status) action.status = String(input.status);
    if (input.notes !== undefined) action.notes = String(input.notes);
    action.updatedAt = new Date().toISOString();
    await writeActions(actions);
    store.audit(user, "update", "action", action.id, { status: action.status });
    return sendJson(res, 200, action);
  }

  if (req.method === "GET" && pathname === "/api/report.pdf") {
    const entries = (await readEntries()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const feedback = await readFeedback();
    const actions = await readActions();
    const pdf = buildPdfReport(getSummary(entries), getFeedbackSummary(feedback), entries, actions);
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="foodwise-sustainability-report.pdf"`, "Content-Length": pdf.length });
    return res.end(pdf);
  }

  if (req.method === "GET" && pathname === "/api/history.pdf") {
    const from = searchParams?.get("from"), to = searchParams?.get("to"), category = searchParams?.get("category"), query = String(searchParams?.get("q") || "").toLowerCase();
    const entries = (await readEntries()).filter(entry => {
      const date = String(entry.createdAt).slice(0, 10);
      const searchable = `${entry.foodItem} ${entry.source} ${entry.location || ""}`.toLowerCase();
      return (!from || date >= from) && (!to || date <= to) && (!category || entry.category === category) && (!query || searchable.includes(query));
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const summary = getSummary(entries);
    const pdf = buildListPdf("FoodWise Waste History", [
      { heading: "Summary", lines: [`Records: ${summary.totalEntries}`, `Total measured waste: ${summary.totalKg} kg`, `Waste per 100 meals: ${summary.wastePer100Meals} kg`] },
      { heading: "Waste records", lines: entries.map(entry => `${new Date(entry.createdAt).toLocaleDateString("en-IN")} | ${entry.foodItem} | ${entry.quantity} ${entry.unit} | ${entry.category} | ${entry.source} | ${entry.location || "Main cafeteria"}`) }
    ]);
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="foodwise-waste-history.pdf"', "Content-Length": pdf.length });
    return res.end(pdf);
  }

  if (req.method === "GET" && pathname === "/api/feedback.pdf") {
    const feedback = filterFeedback(await readFeedback(), searchParams).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const summary = getFeedbackSummary(feedback);
    const pdf = buildListPdf("FoodWise Customer Feedback", [
      { heading: "Feedback summary", lines: [`Responses: ${summary.totalResponses}`, `Food rating: ${summary.averageFoodRating}/5`, `Portion rating: ${summary.averagePortionRating}/5`, `Over-portion reports: ${summary.overPortionResponses}`, `Top meal type: ${summary.topMealType?.name || "Not enough responses"}`, `Top menu vote: ${summary.topMenuVote?.name || "Not enough responses"}`] },
      { heading: "Customer responses", lines: feedback.map(item => `${item.serviceDate || new Date(item.createdAt).toLocaleDateString("en-IN")} | ${item.mealType || "Meal"} | ${item.meal} | food ${item.foodRating}/5 | portion ${item.portionAssessment || item.portionRating} | leftovers ${item.leftoverAmount || "Not stated"} | ${item.comments || "No comment"}`) }
    ]);
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="foodwise-customer-feedback.pdf"', "Content-Length": pdf.length });
    return res.end(pdf);
  }

  if (req.method === "GET" && pathname === "/api/entries") {
    const entries = await readEntries();
    return sendJson(res, 200, entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  }

  if (req.method === "GET" && pathname === "/api/summary") {
    return sendJson(res, 200, getSummary(await readEntries()));
  }

  if (req.method === "POST" && pathname === "/api/entries") {
    const input = await readJson(req);
    const error = validateEntry(input);
    if (error) return sendJson(res, 400, { error });

    const entries = await readEntries();
    const entry = {
      id: crypto.randomUUID(),
      foodItem: String(input.foodItem).trim(),
      category: String(input.category).trim(),
      source: String(input.source).trim(),
      quantity: Number(input.quantity),
      unit: String(input.unit).trim(),
      meal: String(input.meal || "Not specified").trim(),
      location: String(input.location || "Main cafeteria").trim(),
      mealsServed: Number(input.mealsServed) || 0,
      reason: String(input.reason || "Not specified").trim(),
      notes: String(input.notes || "").trim(),
      action: String(input.action).trim(),
      actionTaken: String(input.actionTaken || input.action).trim(),
      confidence: Number(input.confidence) || null,
      aiFoodItem: String(input.aiFoodItem || input.foodItem).trim(),
      aiCategory: String(input.aiCategory || input.category).trim(),
      classificationCorrected: String(input.aiFoodItem || input.foodItem).trim() !== String(input.foodItem).trim() || String(input.aiCategory || input.category).trim() !== String(input.category).trim(),
      recommendationFeedback: "Not rated",
      image: typeof input.image === "string" && input.image.startsWith("data:image/") ? input.image : null,
      createdAt: new Date().toISOString()
    };
    entries.push(entry);
    await writeEntries(entries);
    store.audit(user, "create", "waste-entry", entry.id);
    return sendJson(res, 201, entry);
  }

  if (req.method === "DELETE" && pathname.startsWith("/api/entries/")) {
    const id = pathname.slice("/api/entries/".length);
    const entries = await readEntries();
    const remaining = entries.filter(entry => entry.id !== id);
    if (remaining.length === entries.length) return sendJson(res, 404, { error: "Waste record not found." });
    await writeEntries(remaining);
    store.audit(user, "delete", "waste-entry", id);
    return sendJson(res, 200, { deleted: true });
  }

  if (req.method === "PATCH" && pathname.startsWith("/api/entries/")) {
    const id = pathname.slice("/api/entries/".length);
    const input = await readJson(req);
    const entries = await readEntries();
    const entry = entries.find(item => item.id === id);
    if (!entry) return sendJson(res, 404, { error: "Waste record not found." });
    if (input.recommendationFeedback) entry.recommendationFeedback = String(input.recommendationFeedback);
    if (input.actionTaken) entry.actionTaken = String(input.actionTaken);
    entry.updatedAt = new Date().toISOString();
    await writeEntries(entries);
    store.audit(user, "update", "waste-entry", id);
    return sendJson(res, 200, entry);
  }

  if (req.method === "POST" && pathname === "/api/recommend") {
    const input = await readJson(req);
    return sendJson(res, 200, { action: recommendAction(String(input.category || ""), String(input.source || "")) });
  }

  return sendJson(res, 404, { error: "API route not found." });
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "Forbidden." });
  try {
    const content = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": [".html", ".js", ".css"].includes(path.extname(filePath)) ? "no-cache, no-store, must-revalidate" : "public, max-age=3600"
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") return sendJson(res, 404, { error: "Page not found." });
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname, url.searchParams);
    return await serveStatic(res, decodeURIComponent(url.pathname));
  } catch (error) {
    console.error(error);
    return sendJson(res, error.status || 500, { error: error.message || "Unexpected server error." });
  }
});

server.on("error", error => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. FoodWise may already be running at http://localhost:${PORT}`);
    console.error("Close the existing server, or start this app on another port with: $env:PORT=3001; npm start");
    process.exitCode = 1;
    return;
  }
  console.error("Could not start FoodWise:", error.message);
  process.exitCode = 1;
});

if (require.main === module) {
  ensureDataFile().then(() => {
    server.listen(PORT, () => console.log(`FoodWise is running at http://localhost:${PORT}`));
  });
}

module.exports = { getSummary, getFeedbackSummary, getDishComparison, filterFeedback, buildPdfReport, buildListPdf, validateEntry, recommendAction, server };
