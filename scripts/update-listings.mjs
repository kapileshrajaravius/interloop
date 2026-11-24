// Keeps Interloop's listings fresh. Runs in GitHub Actions before each deploy.
//
//  This is the site's only source of listings (there are no built-in ones).
//  1. USAJOBS API     - federal Pathways internships open to high schoolers.
//                       Re-fetched on every run. Secrets: USAJOBS_API_KEY, USAJOBS_EMAIL.
//  1b. Adzuna API     - internships from job boards across the web that mention high schoolers.
//                       Re-fetched on every run. Secrets: ADZUNA_APP_ID, ADZUNA_APP_KEY (free at developer.adzuna.com).
//  2. AI web search   - summer programs, internships and volunteering anywhere on the web,
//                       found by Gemini with Google Search grounding. Runs only on the weekly
//                       schedule or a manual run (RESEARCH=true), not on every push.
//                       Secret: GEMINI_API_KEY. Every result is checked against its official
//                       page before it is kept. Kept results accumulate in data/found-listings.json.
//  3. Idealist API    - planned for volunteering once partner access is approved.
//
// Output: public/data/live-listings.json (what the site loads).
// To hide a listing for good, add its id or URL on its own line in data/blocked.txt.
// With no secrets, it still writes a valid file so the site deploys.

import { mkdir, readFile, writeFile } from "node:fs/promises";

const OUT = "public/data/live-listings.json";
const FOUND = "data/found-listings.json";
const BLOCKED = "data/blocked.txt";
const env = process.env;
const RESEARCH = /^(1|true|yes)$/i.test(env.RESEARCH || "");
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-3.5-flash-lite";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const CATEGORIES = ["Science/Research","Engineering","Computer Science","Medical","Business/Finance","Government/Policy","Law","Arts/Media","Language/Culture","Leadership/Service","Mathematics","Environment","Health","Community","Education","Animals"];
const CAT_RULES = [
  ["Computer Science", /\b(it specialist|information technology|computer|software|cyber|data|programming|coding)/i],
  ["Engineering", /\b(engineer|technician|electronics|mechanical|aerospace|robotic)/i],
  ["Medical", /\b(medical|nurs|pharmac|clinic|hospital|health ?care)/i],
  ["Environment", /\b(park|forest|wildlife|fish|natural resource|conservation|environment|biolog|range|hydrolog)/i],
  ["Science/Research", /\b(science|scientist|research|laborator|chemist|physic|geolog)/i],
  ["Business/Finance", /\b(account|financ|budget|business|contract|procurement|economic)/i],
  ["Law", /\b(legal|law|paralegal|attorney)/i],
  ["Arts/Media", /\b(media|public affairs|communicat|visual|museum|design)/i],
  ["Education", /\b(education|teach|tutor|instruct)/i],
  ["Government/Policy", /.*/]
];
const guessCategory = t => CAT_RULES.find(([, re]) => re.test(t))[0];
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const short = d => `${MON[d.getMonth()]} ${d.getDate()}`;
const normUrl = u => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); } catch { return ""; } };
const normTitle = t => String(t || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const idFor = s => "a" + [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
const readJSON = async (p, d) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return d; } };

/* ---------- what's already on the site, so we don't add duplicates ---------- */
async function builtInKeys() {
  const keys = new Set();
  try {
    const html = await readFile("public/index.html", "utf8");
    const i = html.indexOf("const DATA = ");
    if (i >= 0) {
      const rest = html.slice(i + 13);
      const data = JSON.parse(rest.slice(0, rest.indexOf("};") + 1));
      for (const r of data.rows) { keys.add(normTitle(r[0])); keys.add(normUrl(r[12])); }
    }
    const v = html.indexOf("const VOL = ");
    if (v >= 0) {
      const rest = html.slice(v + 12);
      const vol = JSON.parse(rest.slice(0, rest.indexOf("]];") + 2));
      for (const r of vol) { keys.add(normTitle(r[0])); if (!String(r[7]).startsWith("G:")) keys.add(normUrl(r[7])); }
    }
  } catch (e) { console.warn("Could not read built-in listings for de-duplication:", e.message); }
  keys.delete("");
  return keys;
}

/* ---------- 1. USAJOBS ---------- */
async function usajobs() {
  if (!env.USAJOBS_API_KEY || !env.USAJOBS_EMAIL) { console.log("USAJOBS: no API key set, skipping."); return []; }
  const items = [];
  for (let page = 1; page <= 4; page++) {
    const q = new URLSearchParams({ HiringPath: "student", ResultsPerPage: "250", Page: String(page), WhoMayApply: "Public" });
    const res = await fetch("https://data.usajobs.gov/api/search?" + q, {
      headers: { Host: "data.usajobs.gov", "User-Agent": env.USAJOBS_EMAIL, "Authorization-Key": env.USAJOBS_API_KEY }
    });
    if (!res.ok) throw new Error(`USAJOBS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const batch = (await res.json())?.SearchResult?.SearchResultItems || [];
    items.push(...batch);
    if (batch.length < 250) break;
  }
  const money = r => {
    if (!r) return "Paid (see posting)";
    const f = v => { const n = Number(v); return "$" + n.toLocaleString("en-US", Number.isInteger(n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    const per = { PH: "/hr", PA: "/yr", BW: "/2 wks", PM: "/mo", PW: "/wk", PD: "/day" }[r.RateIntervalCode] || "";
    return r.MinimumRange && r.MaximumRange && r.MinimumRange !== r.MaximumRange ? `${f(r.MinimumRange)}–${f(r.MaximumRange)}${per}` : `${f(r.MinimumRange || r.MaximumRange)}${per}`;
  };
  const seen = new Set(), out = [];
  for (const it of items) {
    const m = it.MatchedObjectDescriptor || {}, d = m.UserArea?.Details || {};
    const text = [m.PositionTitle, d.JobSummary, m.QualificationSummary, d.Education].join(" ");
    if (!/high school/i.test(text)) continue;
    const close = m.ApplicationCloseDate ? new Date(m.ApplicationCloseDate) : null;
    if (close && close < today()) continue;
    const id = "u" + (it.MatchedObjectId || m.PositionID);
    if (seen.has(id)) continue; seen.add(id);
    const remote = /true/i.test(String(d.RemoteIndicator ?? m.RemoteIndicator ?? "")), tele = /true/i.test(String(d.TeleworkEligible ?? ""));
    out.push({
      id, title: clip(m.PositionTitle, 120),
      company: clip([m.OrganizationName, m.DepartmentName].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · "), 120),
      location: clip(m.PositionLocationDisplay || "See posting", 90), type: "Internship", category: guessCategory(text),
      grades: [10, 11, 12], cost: "paid", stipend: money((m.PositionRemuneration || [])[0]), comp: "Competitive",
      format: remote ? "Remote" : tele ? "Hybrid" : "In-Person",
      duration: clip((m.PositionSchedule || []).map(x => x.Name).join(", ") || "Federal Pathways internship", 60),
      deadline: close ? short(close) : "", deadlineISO: close ? ymd(close) : "",
      url: m.PositionURI || "https://www.usajobs.gov/",
      desc: clip(d.JobSummary || m.QualificationSummary || "Paid federal internship for current students.", 260) + " Federal internships usually require you to be at least 16 and a U.S. citizen.",
      equity: [], materials: ["resume", "transcript"], source: "USAJOBS"
    });
  }
  console.log(`USAJOBS: ${items.length} student postings, ${out.length} open to high schoolers.`);
  return out;
}

/* ---------- 1b. Adzuna ---------- */
async function adzuna() {
  if (!env.ADZUNA_APP_ID || !env.ADZUNA_APP_KEY) { console.log("Adzuna: no API key set, skipping."); return []; }
  const queries = ["high school intern", "high school internship", "summer internship high school students", "high school summer program", "teen internship", "student intern high school"];
  const raw = [];
  for (const what of queries) {
    const q = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, results_per_page: "50", what, max_days_old: "60", "content-type": "application/json" });
    const res = await fetch("https://api.adzuna.com/v1/api/jobs/us/search/1?" + q);
    if (!res.ok) { console.error(`Adzuna "${what}": HTTP ${res.status}`); continue; }
    raw.push(...((await res.json()).results || []));
  }
  const seen = new Set(), out = [];
  for (const r of raw) {
    const text = `${r.title} ${r.description}`;
    if (!/high[- ]school/i.test(text)) continue;                                  // must mention high schoolers
    if (!/intern|summer|apprentic|trainee|program|fellow|camp/i.test(text)) continue; // internship-like, not a regular job
    if (/\b(college|undergraduate|university) (students?|juniors?|seniors?) only\b|must be (enrolled in|pursuing) (a )?(bachelor|college|university)/i.test(text)) continue;
    const id = "z" + r.id;
    const key = normTitle(r.title) + "|" + normTitle(r.company?.display_name);
    if (seen.has(id) || seen.has(key)) continue; seen.add(id); seen.add(key);
    const lo = Number(r.salary_min) || 0, hi = Number(r.salary_max) || 0;
    const pay = lo || hi ? (lo > 1000 || hi > 1000 ? `$${Math.round((lo || hi) / 1000)}k${hi && hi !== lo ? "–$" + Math.round(hi / 1000) + "k" : ""}/yr` : `$${lo || hi}${hi && hi !== lo ? "–$" + hi : ""}/hr`) : "See posting";
    out.push({
      id, title: clip(r.title, 120), company: clip(r.company?.display_name || "See posting", 120),
      location: clip(r.location?.display_name || "See posting", 90), type: "Internship",
      category: guessCategory(text), grades: [10, 11, 12], cost: lo || hi ? "paid" : "free", stipend: pay,
      comp: "Competitive", format: /\bremote\b/i.test(text) ? "Remote" : /\bhybrid\b/i.test(text) ? "Hybrid" : "In-Person",
      duration: r.contract_time === "part_time" ? "Part-time" : r.contract_time === "full_time" ? "Full-time" : "",
      deadline: "", deadlineISO: "", url: r.redirect_url,
      desc: clip(r.description, 240), equity: [], materials: ["resume"], source: "Adzuna", foundAt: (r.created || "").slice(0, 10)
    });
  }
  console.log(`Adzuna: ${raw.length} results, ${out.length} internship-style postings open to high schoolers.`);
  return out;
}

/* ---------- 2. AI web search (Gemini + Google Search grounding) ---------- */
const SEARCHES = [
  // Summer programs
  ["Summer Program", "STEM and research summer programs at universities and labs, nationwide"],
  ["Summer Program", "free or fully funded summer programs and summer programs with need-based scholarships"],
  ["Summer Program", "medicine, health and pre-med summer programs"],
  ["Summer Program", "business, entrepreneurship, finance and leadership summer programs"],
  ["Summer Program", "writing, journalism, debate, law, government and humanities summer programs"],
  ["Summer Program", "art, music, theater, film and design summer programs"],
  ["Summer Program", "summer programs and pre-college programs held in Texas"],
  ["Summer Program", "online and virtual summer programs"],
  ["Summer Program", "summer programs in the Northeast, Midwest, South and West Coast at colleges and universities"],
  // Internships
  ["Internship", "research and STEM internships at universities, national labs and science institutes"],
  ["Internship", "hospital, healthcare and biomedical internships"],
  ["Internship", "internships at companies in technology, finance and engineering"],
  ["Internship", "internships at museums, nonprofits, city and state governments and libraries"],
  ["Internship", "internships and job-shadow programs in Texas (Dallas–Fort Worth, Houston, Austin, San Antonio)"],
  ["Internship", "remote or virtual internships"],
  // Volunteering
  ["Volunteering", "teen volunteer programs (ages 13–18) run by national nonprofits"],
  ["Volunteering", "hospital and healthcare teen volunteer programs (junior volunteers)"],
  ["Volunteering", "teen volunteer programs at libraries, museums, zoos, aquariums and parks"],
  ["Volunteering", "teen volunteer opportunities in Dallas–Fort Worth"],
  ["Volunteering", "teen volunteer opportunities in Houston, Austin and San Antonio"],
  ["Volunteering", "teen volunteer opportunities in large US cities like New York, Los Angeles, Chicago, Atlanta, Phoenix and Seattle"],
  ["Volunteering", "virtual and remote volunteer opportunities that accept high school students"]
];

function prompt(type, scope) {
  return `Today is ${new Date().toDateString()}. Use Google Search to find up to 10 real ${type === "Volunteering" ? "volunteer opportunities" : type === "Internship" ? "internships" : "summer programs"} for US high school students (grades 9-12): ${scope}.

Rules:
- Only include opportunities you found on the organization's own official website. Use that official page as "url" (not a blog, list article or aggregator).
- Only include ones where applications are open now, open in the next 5 months, or rolling.
- Skip anything that requires college enrollment or is only for adults.
- Do not invent details. If you don't know a field, use an empty string.

Reply with only a JSON array. Each item:
{"title": "", "organization": "", "location": "City, ST or Remote", "format": "In-Person|Hybrid|Remote",
 "category": one of ${JSON.stringify(CATEGORIES)},
 "grades": [9,10,11,12 as applicable], "cost": "free|paid|pay_to_join",
 "costNote": "e.g. Free, $15/hr stipend, $4,500 tuition with aid", "deadline": "YYYY-MM-DD or rolling or empty",
 "duration": "e.g. 6 weeks in June-July", "url": "official page", "description": "one or two plain sentences, under 40 words"}`;
}

async function askGemini(text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0.2 } })
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const out = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  const m = out.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const a = JSON.parse(m[0]); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Opens the official page and checks it's real and aimed at teens.
async function verify(item) {
  let u; try { u = new URL(item.url); } catch { return { ok: false, why: "bad url" }; }
  if (u.protocol !== "https:") return { ok: false, why: "not https" };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(u, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; InterloopListingCheck/1.0; +https://github.com)" } });
    clearTimeout(t);
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    if (!/html/i.test(res.headers.get("content-type") || "")) return { ok: false, why: "not a web page" };
    const page = (await res.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").toLowerCase();
    const words = normTitle(item.title + " " + item.organization).split(" ").filter(w => w.length >= 5 && !/^(program|summer|students|student|school|internship|volunteer|opportunit\w*|youth|teens?)$/.test(w));
    const hits = words.filter(w => page.includes(w)).length;
    if (words.length && hits < Math.min(2, words.length)) return { ok: false, why: "page doesn't mention it" };
    if (!/high school|high-school|teen|grades? (9|10|11|12)|ages? 1[3-8]|1[4-8] years|rising (sophomore|junior|senior)/.test(page)) return { ok: false, why: "page doesn't mention high schoolers" };
    return { ok: true, finalUrl: res.url || item.url };
  } catch (e) { return { ok: false, why: e.name === "AbortError" ? "timed out" : "unreachable" }; }
}

function toListing(type, x, url, foundAt) {
  const dl = /^\d{4}-\d{2}-\d{2}$/.test(x.deadline || "") ? new Date(x.deadline + "T12:00:00") : null;
  const grades = (Array.isArray(x.grades) ? x.grades : []).map(Number).filter(g => g >= 9 && g <= 12);
  const cost = ["free", "paid", "pay_to_join"].includes(x.cost) ? x.cost : "free";
  return {
    id: idFor(normUrl(url) + "|" + normTitle(x.title)),
    title: clip(x.title, 120), company: clip(x.organization, 120), location: clip(x.location || "See website", 90),
    type, category: CATEGORIES.includes(x.category) ? x.category : guessCategory(`${x.title} ${x.description}`),
    grades: grades.length ? [...new Set(grades)].sort() : [9, 10, 11, 12], cost,
    stipend: clip(x.costNote || (cost === "paid" ? "Paid" : cost === "free" ? "Free" : "Tuition (see website)"), 60),
    comp: "Competitive", format: ["In-Person", "Hybrid", "Remote"].includes(x.format) ? x.format : "In-Person",
    duration: clip(x.duration, 60),
    deadline: dl ? short(dl) : /rolling/i.test(x.deadline || "") ? "Rolling" : "",
    deadlineISO: dl ? ymd(dl) : "",
    url, desc: clip(x.description, 240) + " Found by an automated search, so confirm the details on the official site.",
    equity: [], materials: [], source: "AI search", foundAt
  };
}

async function research(existing, blocked) {
  if (!RESEARCH) { console.log("AI search: runs only on the weekly schedule or a manual run, skipping."); return existing; }
  if (!env.GEMINI_API_KEY) { console.log("AI search: no GEMINI_API_KEY set, skipping."); return existing; }
  const seen = await builtInKeys();
  for (const x of existing) { seen.add(normTitle(x.title)); seen.add(normUrl(x.url)); }
  const now = new Date().toISOString().slice(0, 10);
  const added = [], rejected = [];
  for (const [type, scope] of SEARCHES) {
    let found = [];
    try { found = await askGemini(prompt(type, scope)); } catch (e) { console.error(`AI search failed for "${scope}":`, e.message); continue; }
    for (const x of found) {
      if (!x || !x.title || !x.url) continue;
      if (seen.has(normTitle(x.title)) || seen.has(normUrl(x.url)) || blocked.has(x.url)) continue;
      const v = await verify(x);
      if (!v.ok) { rejected.push(`${x.title} (${v.why})`); continue; }
      const l = toListing(type, x, v.finalUrl, now);
      if (blocked.has(l.id) || seen.has(normUrl(l.url))) continue;
      seen.add(normTitle(l.title)); seen.add(normUrl(l.url));
      added.push(l);
    }
  }
  console.log(`AI search: added ${added.length}, rejected ${rejected.length}.`);
  added.forEach(l => console.log(`  + ${l.type}: ${l.title} — ${l.url}`));
  rejected.slice(0, 40).forEach(r => console.log(`  - ${r}`));
  return [...existing, ...added];
}

// Weekly re-check of earlier finds: drop closed ones, dead pages, and anything 9+ months old.
async function recheck(list) {
  if (!RESEARCH) return list;
  const keep = [];
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 9);
  for (const l of list) {
    if (l.deadlineISO && new Date(l.deadlineISO + "T23:59:59") < today()) { console.log(`  closed: ${l.title}`); continue; }
    if (l.foundAt && new Date(l.foundAt) < cutoff) { console.log(`  stale: ${l.title}`); continue; }
    const v = await verify({ url: l.url, title: l.title, organization: l.company });
    if (!v.ok && !/timed out|unreachable/.test(v.why)) { console.log(`  removed (${v.why}): ${l.title}`); continue; }
    keep.push(l);
  }
  return keep;
}

/* ---------- run ---------- */
const blocked = new Set((await readFile(BLOCKED, "utf8").catch(() => "")).split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#")));
const sources = {};
const listings = [];

try { const u = await usajobs(); listings.push(...u); sources.USAJOBS = u.length; }
catch (e) { console.error("USAJOBS failed, continuing without it:", e.message); }
try { const z = await adzuna(); listings.push(...z); sources.Adzuna = z.length; }
catch (e) { console.error("Adzuna failed, continuing without it:", e.message); }

let found = (await readJSON(FOUND, { listings: [] })).listings || [];
found = await recheck(found);
found = await research(found, blocked);
found = found.filter(l => !blocked.has(l.id) && !blocked.has(l.url) && !(l.deadlineISO && new Date(l.deadlineISO + "T23:59:59") < today()));
if (RESEARCH) { await mkdir("data", { recursive: true }); await writeFile(FOUND, JSON.stringify({ updated: new Date().toISOString(), listings: found }, null, 1) + "\n"); }
listings.push(...found);
sources["AI search"] = found.length;

const final = listings.filter(l => !blocked.has(l.id) && !blocked.has(l.url));
await mkdir("public/data", { recursive: true });
await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), sources, listings: final }, null, 1));
console.log(`Wrote ${final.length} live listings to ${OUT}:`, sources);
