// Generates static SVG charts from the GitHub GraphQL API.
// Usage: GH_TOKEN=... GH_USER=name node scripts/generate.mjs [outDir]
// No dependencies. Needs Node 18+.
import { mkdir, writeFile } from "node:fs/promises";

const TOKEN = process.env.GH_TOKEN;
const USER = process.env.GH_USER;
const OUT = process.argv[2] || "assets";
if (!TOKEN || !USER) {
  console.error("GH_TOKEN and GH_USER are required");
  process.exit(1);
}

async function gql(query, variables = {}) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (res.ok) {
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      return json.data;
    }
    if (attempt === 4)
      throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const fmt = (n) => n.toLocaleString("en-US");
const dayKey = (d) => d.toISOString().slice(0, 10);

// ---------- data ----------
async function fetchProfile() {
  const d = await gql(
    `query($u:String!){ user(login:$u){ name createdAt followers{totalCount}
      pullRequests{totalCount} issues{totalCount} } }`,
    { u: USER },
  );
  return d.user;
}

async function fetchRepos() {
  const repos = [];
  let after = null;
  for (;;) {
    const d = await gql(
      `query($u:String!,$after:String){ user(login:$u){ repositories(first:100, after:$after, ownerAffiliations:OWNER, isFork:false, orderBy:{field:PUSHED_AT,direction:DESC}){
        pageInfo{hasNextPage endCursor}
        nodes{ name stargazerCount languages(first:10, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{name color} } } } } } }`,
      { u: USER, after },
    );
    const r = d.user.repositories;
    repos.push(...r.nodes);
    if (!r.pageInfo.hasNextPage) break;
    after = r.pageInfo.endCursor;
  }
  return repos;
}

async function fetchContributions(createdAt) {
  const startYear = new Date(createdAt).getUTCFullYear();
  const nowYear = new Date().getUTCFullYear();
  let commits = 0;
  let total = 0;
  const days = new Map();
  for (let y = startYear; y <= nowYear; y++) {
    const d = await gql(
      `query($u:String!,$from:DateTime!,$to:DateTime!){ user(login:$u){ contributionsCollection(from:$from,to:$to){
        totalCommitContributions restrictedContributionsCount
        contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } } } } }`,
      { u: USER, from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` },
    );
    const c = d.user.contributionsCollection;
    commits += c.totalCommitContributions + c.restrictedContributionsCount;
    total += c.contributionCalendar.totalContributions;
    for (const w of c.contributionCalendar.weeks)
      for (const day of w.contributionDays)
        days.set(day.date, day.contributionCount);
  }
  return { commits, total, days };
}

function activity(days) {
  const dates = [...days.keys()].sort();
  let longest = 0;
  let run = 0;
  for (const date of dates) {
    run = days.get(date) > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // current streak: walk back from today; an empty today doesn't break it yet
  const now = new Date();
  const d = new Date(dayKey(now) + "T00:00:00Z");
  if (!(days.get(dayKey(d)) > 0)) d.setUTCDate(d.getUTCDate() - 1);
  let current = 0;
  while (days.get(dayKey(d)) > 0) {
    current++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  const today = new Date(dayKey(now) + "T00:00:00Z");
  const elapsed =
    Math.floor(
      (today - new Date(`${today.getUTCFullYear()}-01-01T00:00:00Z`)) /
        86400000,
    ) + 1;
  let activeYear = 0;
  let activeLast30 = 0;
  for (let i = 0; i < elapsed; i++) {
    const k = dayKey(new Date(today.getTime() - i * 86400000));
    if (days.get(k) > 0) {
      activeYear++;
      if (i < 30) activeLast30++;
    }
  }
  return {
    current,
    longest: Math.max(longest, current),
    activeYear,
    elapsed,
    activeLast30,
  };
}

// ---------- svg ----------
const STYLE = `
  :root{--text:#1f2328;--muted:#32393f;--track:#d8dee4;--line:#d1d9e0;--c1:#1a7f37;--c2:#0969da;--c3:#bc4c00}
  @media (prefers-color-scheme: dark){:root{--text:#f0f6fc;--muted:#d0d7de;--track:#2b3340;--line:#30363d;--c1:#3fb950;--c2:#58a6ff;--c3:#f0883e}}
  text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;text-rendering:geometricPrecision}
  .h{font-size:18px;font-weight:600;fill:var(--text)}
  .sub{font-size:14px;font-weight:500;fill:var(--muted)}
  .lab{font-size:15px;font-weight:600;fill:var(--text)}
  .num{font-size:30px;font-weight:700;fill:var(--text)}
  .ring{font-size:28px;font-weight:700;fill:var(--text)}
  .leg{font-size:15px;fill:var(--text)}
`;

const svg = (
  w,
  h,
  title,
  body,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>${STYLE}</style>
${body}
</svg>
`;

function ring(cx, cy, r, frac, color) {
  const c = 2 * Math.PI * r;
  const f = Math.max(0, Math.min(1, frac));
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="10"/>` +
    (f > 0
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(${color})" stroke-width="10" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
      : "")
  );
}

function activitySvg(total, since, a) {
  const cy = 140;
  const col = (cx, frac, color, big, label, sub) =>
    ring(cx, cy, 46, frac, color) +
    `<text x="${cx}" y="${cy + 10}" text-anchor="middle" class="ring">${big}</text>` +
    `<text x="${cx}" y="${cy + 80}" text-anchor="middle" class="lab">${label}</text>` +
    `<text x="${cx}" y="${cy + 100}" text-anchor="middle" class="sub">${sub}</text>`;
  const pct = a.elapsed ? Math.round((a.activeYear / a.elapsed) * 100) : 0;
  const body =
    `<text x="0" y="28" class="h">Contribution Activity</text>` +
    `<text x="0" y="50" class="sub">${fmt(total)} contributions since ${since}</text>` +
    col(
      75,
      a.longest ? a.current / a.longest : 0,
      "--c1",
      a.current,
      "Current streak",
      `Best: ${a.longest} days`,
    ) +
    col(
      205,
      a.elapsed ? a.activeYear / a.elapsed : 0,
      "--c2",
      `${pct}%`,
      "Active this year",
      `${a.activeYear} of ${a.elapsed} days`,
    ) +
    col(
      335,
      a.activeLast30 / 30,
      "--c3",
      a.activeLast30,
      "Last 30 days",
      "days active",
    );
  return svg(410, 270, `${USER} contribution activity`, body);
}

function langsSvg(langs) {
  const total = langs.reduce((a, l) => a + l.size, 0) || 1;
  const top = langs.slice(0, 6);
  const rest = total - top.reduce((a, l) => a + l.size, 0);
  const segs =
    rest > 0 ? [...top, { name: "Other", color: "#8b949e", size: rest }] : top;
  const cx = 95,
    cy = 150,
    r = 62;
  const c = 2 * Math.PI * r;
  let offset = 0;
  let donut = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--track)" stroke-width="24"/>`;
  for (const s of segs) {
    const len = (s.size / total) * c;
    const gap = len > 6 ? 2 : 0;
    donut += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="24" stroke-dasharray="${(len - gap).toFixed(2)} ${(c - len + gap).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += len;
  }
  donut +=
    `<text x="${cx}" y="${cy + 6}" text-anchor="middle" class="ring">${langs.length}</text>` +
    `<text x="${cx}" y="${cy + 26}" text-anchor="middle" class="sub">languages</text>`;
  const legend = top
    .map((l, i) => {
      const y = 86 + i * 28;
      return (
        `<circle cx="200" cy="${y - 5}" r="6" fill="${l.color}"/>` +
        `<text x="216" y="${y}" class="leg">${esc(l.name)}</text>` +
        `<text x="400" y="${y}" text-anchor="end" class="sub">${((l.size / total) * 100).toFixed(1)}%</text>`
      );
    })
    .join("");
  return svg(
    410,
    270,
    `${USER} most used languages`,
    `<text x="0" y="28" class="h">Most Used Languages</text>${donut}${legend}`,
  );
}

function statsSvg(items) {
  const w = 830,
    h = 92,
    colW = w / items.length;
  const cells = items
    .map(([label, v], i) => {
      const cx = colW * i + colW / 2;
      return `<text x="${cx}" y="45" text-anchor="middle" class="num">${fmt(v)}</text><text x="${cx}" y="70" text-anchor="middle" class="sub">${label}</text>`;
    })
    .join("");
  const lines = `<line x1="10" y1="1" x2="${w - 10}" y2="1" stroke="var(--line)"/><line x1="10" y1="${h - 1}" x2="${w - 10}" y2="${h - 1}" stroke="var(--line)"/>`;
  return svg(w, h, `${USER} GitHub stats`, lines + cells);
}

// ---------- main ----------
const profile = await fetchProfile();
const [repos, contrib] = await Promise.all([
  fetchRepos(),
  fetchContributions(profile.createdAt),
]);

const langMap = new Map();
let stars = 0;
for (const r of repos) {
  stars += r.stargazerCount;
  for (const e of r.languages.edges) {
    const cur = langMap.get(e.node.name) || {
      name: e.node.name,
      color: e.node.color || "#8b949e",
      size: 0,
    };
    cur.size += e.size;
    langMap.set(e.node.name, cur);
  }
}
const langs = [...langMap.values()].sort((a, b) => b.size - a.size);
const act = activity(contrib.days);
const since = new Date(profile.createdAt).getUTCFullYear();

await mkdir(OUT, { recursive: true });
await writeFile(
  `${OUT}/stats.svg`,
  statsSvg([
    ["Stars earned", stars],
    ["Commits", contrib.commits],
    ["Pull requests", profile.pullRequests.totalCount],
    ["Issues", profile.issues.totalCount],
    ["Repositories", repos.length],
    ["Followers", profile.followers.totalCount],
  ]),
);
await writeFile(`${OUT}/languages.svg`, langsSvg(langs));
await writeFile(`${OUT}/activity.svg`, activitySvg(contrib.total, since, act));
console.log(
  JSON.stringify({
    stars,
    commits: contrib.commits,
    repos: repos.length,
    total: contrib.total,
    act,
    top: langs.slice(0, 6).map((l) => l.name),
  }),
);
