// Generates static SVG stat cards from the GitHub GraphQL API.
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

function streaks(days) {
  const dates = [...days.keys()].sort();
  let longest = { len: 0, start: null, end: null };
  let run = { len: 0, start: null };
  for (const date of dates) {
    if (days.get(date) > 0) {
      if (run.len === 0) run.start = date;
      run.len++;
      if (run.len > longest.len)
        longest = { len: run.len, start: run.start, end: date };
    } else run = { len: 0, start: null };
  }
  // current streak: walk back from today; an empty today doesn't break it yet
  const today = new Date().toISOString().slice(0, 10);
  const d = new Date(today + "T00:00:00Z");
  if (!(days.get(today) > 0)) d.setUTCDate(d.getUTCDate() - 1);
  let cur = 0;
  let curStart = null;
  let curEnd = d.toISOString().slice(0, 10);
  while (days.get(d.toISOString().slice(0, 10)) > 0) {
    cur++;
    curStart = d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return {
    current: { len: cur, start: curStart, end: cur ? curEnd : null },
    longest,
  };
}

// ---------- svg ----------
const STYLE = `
  :root{--bg:#ffffff;--border:#d0d7de;--title:#0969da;--text:#1f2328;--muted:#656d76;--accent:#0969da}
  @media (prefers-color-scheme: dark){:root{--bg:#0d1117;--border:#30363d;--title:#58a6ff;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff}}
  text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
  .title{font-size:16px;font-weight:600;fill:var(--title)}
  .label{font-size:13px;fill:var(--text)}
  .value{font-size:13px;font-weight:600;fill:var(--text)}
  .big{font-size:28px;font-weight:700;fill:var(--text)}
  .sub{font-size:12px;fill:var(--muted)}
  .name{font-size:13px;font-weight:600;fill:var(--accent)}
`;

function card(w, h, title, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>${STYLE}</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="6" fill="var(--bg)" stroke="var(--border)"/>
${body}
</svg>
`;
}

function statsSvg(p, s) {
  const rows = [
    ["Total Stars Earned", s.stars],
    ["Total Commits", s.commits],
    ["Total PRs", p.pullRequests.totalCount],
    ["Total Issues", p.issues.totalCount],
    ["Repositories (owned)", s.repos],
    ["Followers", p.followers.totalCount],
  ];
  const body =
    `<text x="25" y="35" class="title">${esc(p.name || USER)}'s GitHub Stats</text>` +
    rows
      .map(
        ([l, v], i) =>
          `<text x="25" y="${68 + i * 25}" class="label">${l}</text><text x="270" y="${68 + i * 25}" class="value">${fmt(v)}</text>`,
      )
      .join("\n");
  return card(495, 210, `${USER} GitHub stats`, body);
}

function langsSvg(langs) {
  const total = langs.reduce((a, l) => a + l.size, 0) || 1;
  const top = langs.slice(0, 6);
  const barX = 25,
    barW = 445;
  let x = barX;
  let bar = `<clipPath id="r"><rect x="${barX}" y="52" width="${barW}" height="10" rx="5"/></clipPath><g clip-path="url(#r)">`;
  for (const l of top) {
    const w = (l.size / total) * barW;
    bar += `<rect x="${x.toFixed(2)}" y="52" width="${w.toFixed(2)}" height="10" fill="${l.color}"/>`;
    x += w;
  }
  bar += `<rect x="${x.toFixed(2)}" y="52" width="${(barX + barW - x).toFixed(2)}" height="10" fill="#8b949e"/></g>`;
  const legend = top
    .map((l, i) => {
      const cx = 25 + (i % 2) * 225;
      const cy = 90 + Math.floor(i / 2) * 26;
      return `<circle cx="${cx + 5}" cy="${cy - 4}" r="5" fill="${l.color}"/><text x="${cx + 18}" y="${cy}" class="label">${esc(l.name)}</text><text x="${cx + 150}" y="${cy}" class="sub">${((l.size / total) * 100).toFixed(1)}%</text>`;
    })
    .join("\n");
  return card(
    495,
    210,
    `${USER} most used languages`,
    `<text x="25" y="35" class="title">Most Used Languages</text>${bar}${legend}`,
  );
}

function streakSvg(total, st, createdAt) {
  const range = (a, b) =>
    a && b
      ? `${a.slice(5).replace("-", "/")} – ${b.slice(5).replace("-", "/")}`
      : "No active streak";
  const col = (cx, big, label, sub) =>
    `<text x="${cx}" y="95" text-anchor="middle" class="big">${fmt(big)}</text>
<text x="${cx}" y="125" text-anchor="middle" class="name">${label}</text>
<text x="${cx}" y="147" text-anchor="middle" class="sub">${esc(sub)}</text>`;
  const since = new Date(createdAt).toISOString().slice(0, 10);
  const body =
    `<text x="25" y="35" class="title">Contribution Streak</text>` +
    col(82, total, "Total Contributions", `${since.slice(0, 4)} – Present`) +
    col(
      247,
      st.current.len,
      "Current Streak",
      range(st.current.start, st.current.end),
    ) +
    col(
      412,
      st.longest.len,
      "Longest Streak",
      range(st.longest.start, st.longest.end),
    ) +
    `<line x1="165" y1="65" x2="165" y2="165" stroke="var(--border)"/><line x1="330" y1="65" x2="330" y2="165" stroke="var(--border)"/>` +
    `<text x="470" y="195" text-anchor="end" class="sub">Updated ${new Date().toISOString().slice(0, 10)}</text>`;
  return card(495, 210, `${USER} contribution streak`, body);
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
const st = streaks(contrib.days);

await mkdir(OUT, { recursive: true });
await writeFile(
  `${OUT}/stats.svg`,
  statsSvg(profile, { stars, commits: contrib.commits, repos: repos.length }),
);
await writeFile(`${OUT}/languages.svg`, langsSvg(langs));
await writeFile(
  `${OUT}/streak.svg`,
  streakSvg(contrib.total, st, profile.createdAt),
);
console.log(
  JSON.stringify(
    {
      stars,
      commits: contrib.commits,
      repos: repos.length,
      total: contrib.total,
      streak: st,
      top: langs.slice(0, 6).map((l) => l.name),
    },
    null,
    1,
  ),
);
