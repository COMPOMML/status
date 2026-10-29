/*
 * COMPO Status. A static page: it holds no project data. Everything is read
 * live from GitHub with the viewer's own token, and every change it makes is
 * an ordinary issue, comment or board item in the org's private repos.
 */
'use strict';
(() => {
const CFG = {
  org: 'COMPOMML',
  project: 1,                              // the org board
  planRepo: 'docs', planPath: 'plan.md',   // read live, never copied here
  orderPath: 'architecture/README.md',     // chain order comes from its module table
  // label, group heading, one item
  problemLabels: [['bug', 'Bugs', 'bug'], ['blocked', 'Blocked', 'blocked'], ['decision', 'Decisions waiting', 'decision waiting']],
  ideaLabel: 'enhancement',
  newLabel: 'needs-refinement',            // everything added here still has to be groomed
  activityDays: 14,
  solvedDays: 30,
  refreshSeconds: 120,
};
const SEVERITY = {
  P0: 'P0 · Wrong card, lost data or a solver started unasked: fix now',
  P1: 'P1 · A module is broken, no workaround',
  P2: 'P2 · Annoying, has a workaround',
};
const API = 'https://api.github.com';
const DAY = 864e5;
const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('local');
const VIEWS = [['overview', 'Overview'], ['problems', 'Problems'], ['improvements', 'Improvements'], ['activity', 'Activity'], ['plan', 'Plan']];

const state = {
  token: null, loading: false, error: null, loadedAt: null, rate: null,
  data: null, plan: null, arch: null, runs: {}, board: null, boardError: null,
  view: 'overview', pending: {}, open: {}, filters: {repo: '', kinds: new Set(['commit', 'pr', 'issue'])},
  flash: null,
};
let M = null;   // everything derived from the last load

/* ---------------------------------------------------------------- helpers */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.style.cssText = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function safeUrl(u) {
  try { const x = new URL(u, 'https://github.com/'); return x.protocol === 'https:' && /(^|\.)github\.com$/.test(x.hostname) ? x.href : '#'; }
  catch (_) { return '#'; }
}
const link = (url, text, cls) => h('a', {href: safeUrl(url), target: '_blank', rel: 'noopener noreferrer', class: cls}, text);
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-GB', {day: 'numeric', month: 'short', year: 'numeric'});
}
const dayKey = iso => new Date(iso).toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'});
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
const store = {
  get() { try { return sessionStorage.getItem('compo.token') || localStorage.getItem('compo.token'); } catch (_) { return null; } },
  set(t, remember) { try { (remember ? localStorage : sessionStorage).setItem('compo.token', t); } catch (_) {} },
  clear() { try { sessionStorage.removeItem('compo.token'); localStorage.removeItem('compo.token'); } catch (_) {} },
};
const main = document.getElementById('app');
function isEditing() {
  const a = document.activeElement;
  return !!a && main.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a.tagName === 'INPUT' && a.type !== 'checkbox'));
}

/* ------------------------------------------------------------------- GitHub */
class AuthError extends Error {}
async function gql(query, variables) {
  const r = await fetch(API + '/graphql', {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + state.token, 'Content-Type': 'application/json'},
    body: JSON.stringify({query, variables}),
  });
  if (r.status === 401) throw new AuthError('GitHub did not accept the token. It may have expired or been revoked.');
  const rem = r.headers.get('x-ratelimit-remaining'); if (rem) state.rate = rem;
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.data) throw new Error((j.message || `GitHub answered ${r.status}`));
  if (j.errors && !j.data) throw new Error(j.errors.map(e => e.message).join('; '));
  return j;
}
async function rest(method, path, body, accept) {
  const r = await fetch(API + path, {
    method,
    headers: Object.assign({Authorization: 'Bearer ' + state.token, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
      body ? {'Content-Type': 'application/json'} : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new AuthError('GitHub did not accept the token. It may have expired or been revoked.');
  if (accept && accept.includes('raw') && r.ok) return r.text();
  const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || `GitHub answered ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}
function writeError(e, repo) {
  if (e.status === 403) return `Your token can read ${repo} but not write to it. Give it Issues: Read and write on this repository.`;
  if (e.status === 404) return `GitHub says ${repo} does not exist for your token. Check the token's repository access.`;
  if (e.status === 410) return 'Issues are switched off for this repository.';
  return e.message || 'GitHub refused the change.';
}

const Q_OVERVIEW = `query($org:String!,$since:GitTimestamp!){
  viewer{ login }
  organization(login:$org){
    repositories(first:40, orderBy:{field:NAME,direction:ASC}){ nodes{
      name url isArchived
      defaultBranchRef{ name target{ ... on Commit{
        history(first:15, since:$since){ totalCount nodes{ abbreviatedOid messageHeadline committedDate url author{ name user{ login } } } }
        tip: history(first:1){ nodes{ abbreviatedOid messageHeadline committedDate url author{ name user{ login } } } }
      } } }
      openPRs: pullRequests(states:OPEN){ totalCount }
      pullRequests(first:12, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ number title url state isDraft createdAt mergedAt closedAt author{ login } } }
      issues(first:100, states:OPEN, orderBy:{field:UPDATED_AT,direction:DESC}){ totalCount nodes{ ...I } }
      closedIssues: issues(first:30, states:CLOSED, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ...I closedAt } }
    } }
  }
}
fragment I on Issue{ id number title url createdAt updatedAt bodyText author{ login }
  labels(first:12){ nodes{ name } } comments{ totalCount } assignees(first:4){ nodes{ login } } }`;

const Q_BOARD = `query($org:String!,$num:Int!,$after:String){ organization(login:$org){ projectV2(number:$num){ id title url
  fields(first:40){ nodes{ __typename
    ... on ProjectV2FieldCommon{ id name }
    ... on ProjectV2SingleSelectField{ options{ id name } }
    ... on ProjectV2IterationField{ configuration{ iterations{ id title startDate duration } completedIterations{ id title startDate duration } } } } }
  items(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id
    content{ __typename ... on Issue{ number title url state repository{ name } assignees(first:4){ nodes{ login } } }
                       ... on PullRequest{ number title url state repository{ name } } ... on DraftIssue{ title } }
    status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
    priority: fieldValueByName(name:"Priority"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
    size: fieldValueByName(name:"Size"){ ... on ProjectV2ItemFieldNumberValue{ number } }
    sprint: fieldValueByName(name:"Sprint"){ ... on ProjectV2ItemFieldIterationValue{ title startDate duration iterationId } }
  } } } } }`;

async function loadBoard() {
  let after = null, items = [], proj = null;
  for (let page = 0; page < 10; page++) {
    const j = await gql(Q_BOARD, {org: CFG.org, num: CFG.project, after});
    const p = j.data && j.data.organization && j.data.organization.projectV2;
    if (!p) throw new Error((j.errors || []).map(e => e.message).join('; ') || 'The board could not be read.');
    proj = proj || p; items = items.concat(p.items.nodes);
    if (!p.items.pageInfo.hasNextPage) break;
    after = p.items.pageInfo.endCursor;
  }
  return {id: proj.id, title: proj.title, url: proj.url, fields: proj.fields.nodes, items};
}
async function loadRuns(repos) {
  const out = {};
  await Promise.all(repos.map(async r => {
    if (!r.defaultBranchRef) return;
    try {
      const j = await rest('GET', `/repos/${CFG.org}/${encodeURIComponent(r.name)}/actions/runs?branch=${encodeURIComponent(r.defaultBranchRef.name)}&exclude_pull_requests=true&per_page=6`);
      out[r.name] = j.workflow_runs || [];
    } catch (e) { out[r.name] = {error: e.status === 403 ? 'no permission' : 'unavailable'}; }
  }));
  return out;
}

async function load() {
  if (state.loading) return;
  state.loading = true; renderBar();
  try {
    if (LOCAL) {
      const L = window.__COMPO_LOCAL;
      if (!L) throw new Error('Local preview: .local/local-data.js was not found.');
      state.data = L.overview; state.plan = L.plan; state.arch = L.arch; state.runs = L.runs || {};
      state.board = L.board || null; state.boardError = L.boardError || null;
    } else {
      const since = new Date(Date.now() - CFG.activityDays * DAY).toISOString();
      const raw = 'application/vnd.github.raw+json';
      const [ov, plan, arch] = await Promise.all([
        gql(Q_OVERVIEW, {org: CFG.org, since}),
        rest('GET', `/repos/${CFG.org}/${CFG.planRepo}/contents/${CFG.planPath}`, null, raw).catch(() => null),
        rest('GET', `/repos/${CFG.org}/${CFG.planRepo}/contents/${CFG.orderPath}`, null, raw).catch(() => null),
      ]);
      if (!ov.data || !ov.data.organization) throw new Error(`The ${CFG.org} organization could not be read with this token.`);
      state.data = ov.data; state.plan = plan; state.arch = arch;
      const repos = ov.data.organization.repositories.nodes.filter(r => !r.isArchived);
      const [runs, board] = await Promise.all([
        loadRuns(repos),
        loadBoard().then(b => ({b}), e => ({e: e.message})),
      ]);
      state.runs = runs; state.board = board.b || null;
      state.boardError = board.e || null;
    }
    derive();
    state.loadedAt = new Date(); state.error = null;
  } catch (e) {
    if (e instanceof AuthError) { signOut(e.message); return; }
    state.error = e.message || String(e);
  } finally { state.loading = false; }
  render(true);
}

/* ------------------------------------------------------------------ derive */
function chainOrder(md) {
  if (!md) return [];
  const out = [];
  for (const m of md.matchAll(/^\|\s*[^|\n]+\|\s*`([^`]+)`\s*\|/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
function parsePlan(md) {
  if (!md) return null;
  const lines = md.split(/\r?\n/);
  const P = {milestone: null, sprint: null, items: []};
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const hm = /^##\s+(.*)$/.exec(ln);
    if (hm) {
      section = hm[1];
      if (/^Milestone/i.test(section) && !P.milestone) {
        let text = ''; for (let j = i + 1; j < lines.length && !/^#/.test(lines[j]); j++) if (lines[j].trim()) { text = lines[j].trim(); break; }
        P.milestone = {title: section, text};
      }
      if (/^Sprint/i.test(section) && !P.sprint) {
        let goal = ''; for (let j = i + 1; j < lines.length && !/^#/.test(lines[j]); j++) { const g = /\*\*Goal:\*\*\s*(.*)/.exec(lines[j]); if (g) { goal = g[1]; break; } }
        P.sprint = {title: section, goal};
      }
      continue;
    }
    if (/^Next up/i.test(section) && /^\|/.test(ln) && !/^\|\s*-/.test(ln)) {
      const cells = ln.split('|').slice(1, -1).map(c => c.trim());
      const ref = cells.find(c => /^[\w.-]+#\d+$/.test(c));
      if (ref) P.items.push({ref, item: cells[cells.indexOf(ref) + 1] || '', note: cells[cells.length - 1] || ''});
    }
  }
  return P;
}
function derive() {
  const org = state.data.organization;
  const repos = org.repositories.nodes.filter(r => !r.isArchived);
  const names = repos.map(r => r.name);
  const chain = chainOrder(state.arch).filter(n => names.includes(n));
  const others = names.filter(n => !chain.includes(n));
  const upper = others.filter(n => /^[A-Z0-9_-]+$/.test(n)), lower = others.filter(n => !/^[A-Z0-9_-]+$/.test(n));
  const order = [...upper, ...chain, ...lower];
  const byName = Object.fromEntries(repos.map(r => [r.name, r]));
  const color = {}; order.forEach(n => { const i = chain.indexOf(n); color[n] = i >= 0 && i < 5 ? `var(--m${i + 1})` : 'var(--m0)'; });

  const norm = (i, repo, open) => ({
    id: i.id, number: i.number, title: i.title, url: i.url, repo, open,
    createdAt: i.createdAt, updatedAt: i.updatedAt, closedAt: i.closedAt || null,
    body: i.bodyText || '', author: i.author ? i.author.login : 'ghost',
    labels: i.labels.nodes.map(l => l.name), comments: i.comments.totalCount,
    assignees: i.assignees.nodes.map(a => a.login),
  });
  const openIssues = [], closedIssues = [];
  repos.forEach(r => {
    r.issues.nodes.forEach(i => openIssues.push(norm(i, r.name, true)));
    r.closedIssues.nodes.forEach(i => closedIssues.push(norm(i, r.name, false)));
  });
  const complete = Object.fromEntries(repos.map(r => [r.name, r.issues.totalCount <= r.issues.nodes.length]));

  // the board
  const board = {map: {}, sprint: null, sprintItems: [], fields: {}};
  if (state.board) {
    state.board.fields.forEach(f => { if (f && f.name) board.fields[f.name] = f; });
    state.board.items.forEach(it => {
      const c = it.content; if (!c || !c.repository) return;
      board.map[`${c.repository.name}#${c.number}`] = {
        itemId: it.id, status: it.status && it.status.name, priority: it.priority && it.priority.name,
        size: it.size && it.size.number, sprint: it.sprint, title: c.title, url: c.url, state: c.state,
        repo: c.repository.name, number: c.number, assignees: c.assignees ? c.assignees.nodes.map(a => a.login) : [],
      };
    });
    const sf = board.fields.Sprint && board.fields.Sprint.configuration;
    const today = Date.now();
    if (sf) board.sprint = sf.iterations.find(i => { const s = new Date(i.startDate).getTime(); return s <= today && today < s + i.duration * DAY; }) || null;
    if (board.sprint) board.sprintItems = Object.values(board.map).filter(x => x.sprint && x.sprint.iterationId === board.sprint.id);
  }
  const prio = i => (board.map[`${i.repo}#${i.number}`] || {}).priority || null;

  // problems and ideas
  const kindOf = i => { for (const [l] of CFG.problemLabels) if (i.labels.includes(l)) return l; return null; };
  const problems = openIssues.filter(kindOf).map(i => Object.assign(i, {kind: kindOf(i), prio: prio(i)}));
  const solvedSince = Date.now() - CFG.solvedDays * DAY;
  const solved = closedIssues.filter(i => kindOf(i) && new Date(i.closedAt).getTime() >= solvedSince).map(i => Object.assign(i, {kind: kindOf(i)}));
  const ideasAll = openIssues.filter(i => i.labels.includes(CFG.ideaLabel)).map(i => Object.assign(i, {prio: prio(i)}));
  const ideas = {fresh: ideasAll.filter(i => i.labels.includes(CFG.newLabel)), planned: ideasAll.filter(i => !i.labels.includes(CFG.newLabel))};

  // CI and modules
  const ci = {};
  order.forEach(n => {
    const runs = state.runs[n];
    if (!runs || runs.error) { ci[n] = {cls: 'none', text: runs && runs.error === 'no permission' ? 'CI hidden' : 'no CI data'}; return; }
    if (!runs.length) { ci[n] = {cls: 'none', text: 'no runs'}; return; }
    const done = runs.find(x => x.status === 'completed'), live = runs.find(x => x.status !== 'completed');
    if (live && (!done || new Date(live.created_at) > new Date(done.created_at))) { ci[n] = {cls: 'warn', text: 'running', url: live.html_url}; return; }
    const ok = done.conclusion === 'success';
    ci[n] = {cls: ok ? 'good' : (done.conclusion === 'cancelled' || done.conclusion === 'skipped' ? 'none' : 'crit'),
      text: ok ? 'passing' : (done.conclusion || 'unknown'), url: done.html_url, when: done.updated_at};
  });
  const modules = order.map(n => {
    const r = byName[n], t = r.defaultBranchRef && r.defaultBranchRef.target;
    const tip = t && t.tip && t.tip.nodes[0];
    return {name: n, url: r.url, tip, commits: t && t.history ? t.history.totalCount : 0, prs: r.openPRs.totalCount,
      issues: r.issues.totalCount, problems: problems.filter(p => p.repo === n).length, ideas: ideasAll.filter(p => p.repo === n).length, ci: ci[n]};
  });

  // activity
  const since = Date.now() - CFG.activityDays * DAY, inWin = iso => iso && new Date(iso).getTime() >= since;
  const ev = [];
  repos.forEach(r => {
    const t = r.defaultBranchRef && r.defaultBranchRef.target;
    if (t && t.history) t.history.nodes.forEach(c => ev.push({kind: 'commit', cls: 'commit', repo: r.name, when: c.committedDate, title: c.messageHeadline,
      who: c.author && (c.author.user ? c.author.user.login : c.author.name), url: c.url, ref: c.abbreviatedOid}));
    r.pullRequests.nodes.forEach(p => {
      if (p.mergedAt && inWin(p.mergedAt)) ev.push({kind: 'pr', cls: 'merged', verb: 'merged', repo: r.name, when: p.mergedAt, title: p.title, who: p.author && p.author.login, url: p.url, ref: '#' + p.number});
      if (inWin(p.createdAt)) ev.push({kind: 'pr', cls: 'pr opened', verb: p.isDraft ? 'draft opened' : 'opened', repo: r.name, when: p.createdAt, title: p.title, who: p.author && p.author.login, url: p.url, ref: '#' + p.number});
      if (!p.mergedAt && p.closedAt && inWin(p.closedAt)) ev.push({kind: 'pr', cls: 'pr', verb: 'closed', repo: r.name, when: p.closedAt, title: p.title, who: p.author && p.author.login, url: p.url, ref: '#' + p.number});
    });
  });
  openIssues.concat(closedIssues).forEach(i => {
    if (inWin(i.createdAt)) ev.push({kind: 'issue', cls: 'opened', verb: 'issue opened', repo: i.repo, when: i.createdAt, title: i.title, who: i.author, url: i.url, ref: '#' + i.number});
    if (i.closedAt && inWin(i.closedAt)) ev.push({kind: 'issue', cls: 'closed', verb: 'issue closed', repo: i.repo, when: i.closedAt, title: i.title, url: i.url, ref: '#' + i.number});
  });
  ev.sort((a, b) => new Date(b.when) - new Date(a.when));

  // the plan, with each referenced issue's state
  const plan = parsePlan(state.plan);
  const refState = ref => {
    const [repo, n] = ref.split('#'); const num = +n;
    if (!byName[repo]) return {state: 'unknown'};
    const o = openIssues.find(i => i.repo === repo && i.number === num);
    if (o) return {state: 'open', issue: o};
    const c = closedIssues.find(i => i.repo === repo && i.number === num);
    if (c || complete[repo]) return {state: 'done', issue: c, url: `https://github.com/${CFG.org}/${repo}/issues/${num}`};
    return {state: 'unknown'};
  };
  if (plan) plan.items.forEach(it => Object.assign(it, refState(it.ref)));

  M = {order, byName, color, openIssues, closedIssues, problems, solved, ideas, ideasAll, modules, ev, plan, board, refState,
    viewer: state.data.viewer ? state.data.viewer.login : ''};
}

/* ------------------------------------------------------------------ writes */
async function createIssue(repo, title, body, labels, type) {
  if (LOCAL) return localCreate(repo, title, body, labels);
  const path = `/repos/${CFG.org}/${encodeURIComponent(repo)}/issues`;
  try { return await rest('POST', path, {title, body, labels, type}); }
  catch (e) { if (e.status === 422 && type) return rest('POST', path, {title, body, labels}); throw e; }
}
async function addToBoard(nodeId, priority) {
  if (LOCAL) return 'local preview: not added to the board';
  if (!state.board) return 'not added to the board: your token cannot write to it';
  const j = await gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item{ id } } }`, {p: state.board.id, c: nodeId});
  const item = j.data && j.data.addProjectV2ItemById && j.data.addProjectV2ItemById.item;
  if (!item) return 'not added to the board: ' + ((j.errors || [])[0] || {}).message;
  const f = M.board.fields.Priority, opt = f && f.options && priority && f.options.find(o => o.name === priority);
  if (opt) await gql(`mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }`,
    {p: state.board.id, i: item.id, f: f.id, o: opt.id});
  return 'added to the board' + (opt ? ` as ${priority}` : '');
}
async function setIssueState(issue, open, note) {
  if (LOCAL) return localSetState(issue, open);
  const path = `/repos/${CFG.org}/${encodeURIComponent(issue.repo)}/issues/${issue.number}`;
  if (note && note.trim()) await rest('POST', path + '/comments', {body: note.trim()});
  await rest('PATCH', path, open ? {state: 'open'} : {state: 'closed', state_reason: 'completed'});
}
async function addComment(issue, body) {
  if (LOCAL) { localComment(issue, body); return; }
  await rest('POST', `/repos/${CFG.org}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments`, {body});
}
async function loadComments(issue) {
  if (LOCAL) return (window.__COMPO_LOCAL.comments || {})[issue.id] || [];
  return rest('GET', `/repos/${CFG.org}/${encodeURIComponent(issue.repo)}/issues/${issue.number}/comments?per_page=50`);
}
// Local preview: the same flows, applied to the loaded data only.
function localRepo(name) { return state.data.organization.repositories.nodes.find(r => r.name === name); }
function localCreate(repo, title, body, labels) {
  const r = localRepo(repo), n = 900 + Math.floor(Math.random() * 99);
  const node = {id: 'local-' + n, number: n, title, url: `${r.url}/issues/${n}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    bodyText: body, author: {login: M.viewer || 'you'}, labels: {nodes: labels.map(name => ({name}))}, comments: {totalCount: 0}, assignees: {nodes: []}};
  r.issues.nodes.unshift(node); r.issues.totalCount++;
  return {node_id: node.id, number: n, html_url: node.url};
}
function localSetState(issue, open) {
  const r = localRepo(issue.repo);
  const from = open ? r.closedIssues.nodes : r.issues.nodes, to = open ? r.issues.nodes : r.closedIssues.nodes;
  const k = from.findIndex(x => x.id === issue.id); if (k < 0) return;
  const [node] = from.splice(k, 1); node.closedAt = open ? null : new Date().toISOString(); to.unshift(node);
  r.issues.totalCount += open ? 1 : -1;
}
function localComment(issue, body) {
  const L = window.__COMPO_LOCAL; L.comments = L.comments || {};
  (L.comments[issue.id] = L.comments[issue.id] || []).push({user: {login: M.viewer || 'you'}, created_at: new Date().toISOString(), body});
  const r = localRepo(issue.repo), node = r.issues.nodes.find(x => x.id === issue.id); if (node) node.comments.totalCount++;
}

/* ------------------------------------------------------------- the frame */
function renderBar() {
  const right = document.getElementById('bar-right');
  right.replaceChildren();
  if (!state.token && !LOCAL) return;
  const upd = state.loading ? 'Updating…' : (state.loadedAt ? 'Updated ' + ago(state.loadedAt.toISOString()) : '');
  right.append(
    h('span', {class: 'upd', 'aria-live': 'polite'}, upd),
    h('button', {class: 'btn small', type: 'button', disabled: state.loading, onclick: () => load()}, 'Refresh'),
    M && M.viewer ? h('span', {class: 'who'}, '@' + M.viewer) : null,
    LOCAL ? h('span', {class: 'pill'}, 'local preview') : h('button', {class: 'btn small', type: 'button', onclick: () => signOut()}, 'Sign out'));
}
function renderTabs() {
  const nav = document.getElementById('tabs');
  if (!M) { nav.hidden = true; return; }
  nav.hidden = false;
  const counts = {problems: M.problems.length, improvements: M.ideas.fresh.length};
  nav.replaceChildren(...VIEWS.map(([id, label]) => h('a', {href: '#' + id, 'aria-current': state.view === id ? 'page' : null},
    label, counts[id] != null ? h('span', {class: 'n'}, counts[id]) : null)));
}
function renderFoot() {
  const f = document.getElementById('foot');
  f.replaceChildren(
    h('span', null, LOCAL ? 'Local preview: nothing is sent to GitHub.' : 'Read live from GitHub with your token. This site stores no project data.'),
    state.rate ? h('span', null, `GitHub allowance left this hour: ${state.rate}`) : null);
}
function render(auto) {
  if (auto && isEditing()) { state.deferred = true; return; }
  state.deferred = false;
  renderBar(); renderTabs(); renderFoot();
  if (!state.token && !LOCAL) { main.replaceChildren(signInView()); return; }
  if (!M) { main.replaceChildren(state.error ? errorBox() : h('p', {class: 'loading'}, 'Reading the repos…')); return; }
  const views = {overview: overviewView, problems: problemsView, improvements: improvementsView, activity: activityView, plan: planView};
  main.replaceChildren(...[state.error ? errorBox() : null, flashBox(), (views[state.view] || overviewView)()].filter(Boolean));
}
main.addEventListener('focusout', () => setTimeout(() => { if (state.deferred && !isEditing()) render(true); }, 0));
function errorBox() { return h('div', {class: 'notice err', role: 'alert'}, h('b', null, 'The last update failed'), state.error); }
function flashBox() {
  if (!state.flash) return null;
  const f = state.flash; state.flash = null;
  return h('div', {class: 'notice', role: 'status'}, h('b', null, f.title), f.text, f.url ? [' ', link(f.url, 'Open on GitHub')] : null);
}
const repoTag = (name, num, url) => {
  const t = h('span', {class: 'repo', style: `--c:${M.color[name] || 'var(--m0)'}`}, name + (num ? '#' + num : ''));
  return url ? link(url, t) : t;
};
const ciMark = ci => ci.url ? link(ci.url, h('span', {class: 'ci ' + ci.cls}, ci.text)) : h('span', {class: 'ci ' + ci.cls}, ci.text);
const prioPill = p => p ? h('span', {class: 'pill ' + p.toLowerCase()}, p) : null;

/* --------------------------------------------------------------- overview */
function overviewView() {
  const P = M.plan, items = P ? P.items : [];
  const done = items.filter(i => i.state === 'done').length;
  const pct = items.length ? Math.round(100 * done / items.length) : 0;
  const withCi = M.modules.filter(m => m.ci.cls === 'good' || m.ci.cls === 'crit');
  const green = withCi.filter(m => m.ci.cls === 'good');
  const red = M.modules.filter(m => m.ci.cls === 'crit');
  const byKind = k => M.problems.filter(p => p.kind === k).length;
  const ev = M.ev;
  const commits = ev.filter(e => e.kind === 'commit').length, merged = ev.filter(e => e.cls === 'merged').length, closed = ev.filter(e => e.verb === 'issue closed').length;
  const tiles = h('div', {class: 'tiles'},
    h('div', {class: 'tile'}, h('h3', null, 'Next up in the plan'),
      h('div', {class: 'big'}, done, h('small', null, ` of ${items.length} done`)),
      h('div', {class: 'meter', role: 'img', 'aria-label': `${pct} percent done`}, h('i', {style: `width:${pct}%`})),
      h('div', {class: 'sub'}, P && P.milestone ? P.milestone.title.replace(/\s*\([^)]*\)\s*$/, '') : 'No plan.md found')),
    h('div', {class: 'tile'}, h('h3', null, 'Open problems'),
      h('div', {class: 'big'}, M.problems.length),
      h('div', {class: 'sub'}, CFG.problemLabels.map(([l, name, one]) => `${byKind(l)} ${byKind(l) === 1 ? one : name.toLowerCase()}`).join(' · '))),
    h('div', {class: 'tile'}, h('h3', null, 'Builds on main'),
      h('div', {class: 'big'}, green.length, h('small', null, ` of ${withCi.length} passing`)),
      h('div', {class: 'sub'}, red.length ? 'Failing: ' + red.map(m => m.name).join(', ') : (withCi.length ? 'Nothing failing' : 'No CI data for your token'))),
    h('div', {class: 'tile'}, h('h3', null, `Last ${CFG.activityDays} days`),
      h('div', {class: 'big'}, commits, h('small', null, ' commits')),
      h('div', {class: 'sub'}, `${plural(merged, 'PR')} merged · ${plural(closed, 'issue')} closed`)));

  const mods = h('section', {class: 'panel'},
    h('div', {class: 'panel-h'}, h('h2', null, 'Modules'), link(`https://github.com/orgs/${CFG.org}/repositories`, 'All repos', 'more')),
    h('div', {class: 'panel-b mods'}, M.modules.map(m => h('div', {class: 'mod'},
      link(m.url, h('span', {class: 'repo', style: `--c:${M.color[m.name]}`}, m.name)),
      ciMark(m.ci),
      h('div', {class: 'last'}, m.tip ? [link(m.tip.url, m.tip.messageHeadline), h('small', null, `${m.tip.author && m.tip.author.user ? '@' + m.tip.author.user.login : (m.tip.author ? m.tip.author.name : '')} · ${ago(m.tip.committedDate)}`)] : h('small', null, 'no commits')),
      h('div', {class: 'counts'},
        h('span', null, h('b', null, m.problems), ' problems'),
        h('span', null, h('b', null, m.prs), ' PRs'),
        h('span', null, h('b', null, m.issues), ' issues'))))));

  const sprint = sprintPanel();
  const recent = h('section', {class: 'panel'},
    h('div', {class: 'panel-h'}, h('h2', null, 'Latest activity'), h('a', {href: '#activity', class: 'more'}, 'All activity')),
    h('div', {class: 'panel-b'}, ev.length ? h('ul', {class: 'feed'}, ev.slice(0, 9).map(evItem)) : h('p', {class: 'empty'}, `Nothing in the last ${CFG.activityDays} days.`)));
  const rank = p => ({P0: 0, P1: 1, P2: 2}[p.prio] ?? 3) * 10 + CFG.problemLabels.findIndex(([l]) => l === p.kind);
  const top = M.problems.slice().sort((a, b) => rank(a) - rank(b) || new Date(a.createdAt) - new Date(b.createdAt)).slice(0, 7);
  const attention = h('section', {class: 'panel'},
    h('div', {class: 'panel-h'}, h('h2', null, 'Needs attention'), h('a', {href: '#problems', class: 'more'}, 'All problems')),
    h('div', {class: 'panel-b'}, top.length ? h('ul', {class: 'list'}, top.map(p => h('li', {class: 'row', style: 'grid-template-columns:minmax(0,1fr)'},
      h('div', {class: 't'}, link(p.url, p.title)),
      h('div', {class: 'meta'}, repoTag(p.repo, p.number), prioPill(p.prio), h('span', {class: 'label'}, labelName(p.kind)), h('span', null, 'opened ' + ago(p.createdAt))))))
      : h('p', {class: 'empty'}, 'No open problems.')));

  return h('div', null,
    h('div', {class: 'head'}, h('h2', null, P && P.sprint ? P.sprint.title : 'How COMPO is doing'), P && P.sprint && P.sprint.goal ? h('p', null, stripMd(P.sprint.goal)) : null),
    tiles,
    h('div', {class: 'grid2'}, mods, sprint),
    h('div', {class: 'grid2 even', style: 'margin-top:18px'}, attention, recent));
}
const labelName = k => { const one = (CFG.problemLabels.find(([l]) => l === k) || [k, k, k])[2]; return one.charAt(0).toUpperCase() + one.slice(1); };
function boardProblem(msg) {
  if (!msg) return 'The board could not be read.';
  if (/read:project|projects?\b.*permission|scope/i.test(msg)) return 'Your token cannot read the board. Give it the organization permission Projects: Read and write (classic tokens: the project scope).';
  return msg.length > 180 ? msg.slice(0, 177) + '…' : msg;
}
const stripMd = s => String(s).replace(/\*\*|__|`/g, '');
function sprintPanel() {
  const B = M.board;
  const head = h('div', {class: 'panel-h'}, h('h2', null, B.sprint ? B.sprint.title : 'Sprint'),
    state.board ? link(state.board.url, 'Board', 'more') : link(`https://github.com/orgs/${CFG.org}/projects/${CFG.project}`, 'Board', 'more'));
  if (!state.board) {
    return h('section', {class: 'panel'}, head, h('div', {class: 'panel-b'},
      h('p', {class: 'empty'}, boardProblem(state.boardError)),
      M.plan && M.plan.items.length ? [h('h3', {style: 'margin-top:6px'}, 'Next up, from plan.md'), planItems(M.plan.items.slice(0, 8))] : null));
  }
  if (!B.sprint) return h('section', {class: 'panel'}, head, h('div', {class: 'panel-b'}, h('p', {class: 'empty'}, 'No sprint on the board covers today.')));
  const end = new Date(new Date(B.sprint.startDate).getTime() + B.sprint.duration * DAY);
  const cols = ['In Progress', 'Todo', 'Done'];
  const pts = list => list.reduce((s, x) => s + (x.size || 0), 0);
  const all = B.sprintItems, doneP = pts(all.filter(x => x.status === 'Done')), totP = pts(all);
  return h('section', {class: 'panel'}, head, h('div', {class: 'panel-b'},
    h('p', {class: 'empty', style: 'padding-bottom:2px'}, `Ends ${end.toLocaleDateString('en-GB', {day: 'numeric', month: 'short'})} · ${doneP} of ${totP} points done`),
    h('div', {class: 'meter'}, h('i', {style: `width:${totP ? Math.round(100 * doneP / totP) : 0}%`})),
    all.length ? cols.map(st => {
      const list = all.filter(x => (x.status || 'Todo') === st); if (!list.length) return null;
      return h('div', {class: 'sprint-col'}, h('h3', null, `${st} · ${list.length}`), list.map(x => h('div', {class: 'sprint-item'},
        repoTag(x.repo, x.number), link(x.url, x.title), prioPill(x.priority), h('span', {class: 'pts'}, x.size != null ? x.size + ' pts' : ''))));
    }) : h('p', {class: 'empty'}, 'Nothing is planned in this sprint yet.')));
}
function planItems(items) {
  return h('ul', {class: 'list'}, items.map(it => h('li', {class: 'sprint-item'},
    h('span', {class: 'ref' + (it.state === 'done' ? ' done' : '')}, it.ref),
    it.issue || it.url ? link(it.issue ? it.issue.url : it.url, stripMd(it.item)) : h('span', null, stripMd(it.item)),
    h('span', {class: 'pts'}, stripMd(it.note)))));
}
function evItem(e) {
  return h('li', {class: 'ev'}, h('span', {class: 'k ' + e.cls, 'aria-hidden': 'true'}),
    h('div', {class: 'what'}, link(e.url, e.title)),
    h('div', {class: 'meta'}, repoTag(e.repo), h('span', null, e.kind === 'commit' ? 'commit ' + e.ref : `${e.kind === 'pr' ? 'PR ' : ''}${e.ref} ${e.verb}`),
      e.who ? h('span', null, '@' + e.who) : null, h('span', null, ago(e.when))));
}

/* --------------------------------------------------------------- problems */
const forms = {};
function repoSelect(id) {
  const s = h('select', {id, name: 'repo', required: true});
  return s;
}
function fillRepos(select) {
  const keep = select.value;
  select.replaceChildren(...M.order.map(n => h('option', {value: n}, n)));
  if (keep && M.order.includes(keep)) select.value = keep;
}
function problemForm() {
  if (forms.problem) { fillRepos(forms.problem.querySelector('#pf-repo')); return forms.problem; }
  const msg = h('span', {'aria-live': 'polite'});
  const f = h('form', {class: 'form', novalidate: true},
    h('label', {class: 'f wide'}, 'What is the problem', h('input', {type: 'text', id: 'pf-title', name: 'title', required: true, maxlength: '200', placeholder: 'One line someone else will understand'})),
    h('label', {class: 'f'}, 'Module', repoSelect('pf-repo')),
    h('label', {class: 'f'}, 'Kind', h('select', {id: 'pf-kind', name: 'kind'}, CFG.problemLabels.map(([l, n]) => h('option', {value: l}, labelName(l))))),
    h('label', {class: 'f'}, 'Priority', h('select', {id: 'pf-prio', name: 'prio'}, h('option', {value: ''}, 'Not set'), Object.keys(SEVERITY).map(p => h('option', {value: p}, SEVERITY[p])))),
    h('label', {class: 'f wide'}, 'Details', h('textarea', {id: 'pf-body', name: 'body', placeholder: 'What happens, what should happen, where you saw it (material, module, computer)'})),
    h('div', {class: 'actions'},
      h('button', {class: 'btn primary', type: 'submit'}, 'Add problem'),
      h('label', {class: 'check'}, h('input', {type: 'checkbox', id: 'pf-board', checked: true}), 'Put it on the board'),
      msg));
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const title = f.querySelector('#pf-title').value.trim(), repo = f.querySelector('#pf-repo').value, kind = f.querySelector('#pf-kind').value;
    const prio = f.querySelector('#pf-prio').value, details = f.querySelector('#pf-body').value.trim();
    if (!title) { msg.className = 'err-msg'; msg.textContent = 'Give the problem a title.'; f.querySelector('#pf-title').focus(); return; }
    const body = [details || '_No details yet._', '', prio ? `**Priority:** ${SEVERITY[prio]}` : null, `**Kind:** ${labelName(kind)}`, '',
      `_Added from COMPO Status by @${M.viewer}. Needs refinement: add steps and acceptance criteria before it is planned._`].filter(x => x !== null).join('\n');
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = ''; msg.textContent = 'Saving…';
    try {
      const issue = await createIssue(repo, title, body, [kind, CFG.newLabel], kind === 'bug' ? 'Bug' : 'Task');
      let boardNote = '';
      if (f.querySelector('#pf-board').checked) { try { boardNote = await addToBoard(issue.node_id, prio); } catch (e) { boardNote = 'not added to the board: ' + e.message; } }
      f.reset(); f.querySelector('#pf-repo').value = repo; msg.textContent = '';
      state.flash = {title: `Added ${repo}#${issue.number}`, text: `${title}${boardNote ? ' · ' + boardNote : ''}.`, url: issue.html_url};
      if (LOCAL) { derive(); render(); } else await load();
    } catch (e) { msg.className = 'err-msg'; msg.textContent = writeError(e, repo); }
    finally { btn.disabled = false; }
  });
  forms.problem = h('details', {class: 'add'}, h('summary', null, 'Add a problem'), f);
  fillRepos(f.querySelector('#pf-repo'));
  return forms.problem;
}
function problemsView() {
  const rf = state.filters.repo;
  const list = M.problems.filter(p => !rf || p.repo === rf);
  const solved = M.solved.filter(p => !rf || p.repo === rf).sort((a, b) => new Date(b.closedAt) - new Date(a.closedAt));
  const filter = h('select', {id: 'pr-filter', 'aria-label': 'Module', onchange: e => { state.filters.repo = e.target.value; render(); }},
    h('option', {value: ''}, 'All modules'), M.order.map(n => h('option', {value: n, selected: n === rf}, n)));
  const groups = CFG.problemLabels.map(([l, name]) => {
    const g = list.filter(p => p.kind === l).sort((a, b) => ({P0: 0, P1: 1, P2: 2}[a.prio] ?? 3) - ({P0: 0, P1: 1, P2: 2}[b.prio] ?? 3) || new Date(a.createdAt) - new Date(b.createdAt));
    return h('div', {class: 'group'}, h('h3', null, name, h('span', {class: 'n'}, `· ${g.length}`)),
      g.length ? h('ul', {class: 'list'}, g.map(problemRow)) : h('p', {class: 'empty'}, 'None open.'));
  });
  return h('div', null,
    h('div', {class: 'head'}, h('h2', null, 'Problems we are facing'), h('p', null, `Open issues labelled ${CFG.problemLabels.map(([l]) => l).join(', ')}. Tick one when it is solved: that closes the issue.`)),
    problemForm(),
    h('div', {class: 'filters'}, filter),
    h('section', {class: 'panel'}, h('div', {class: 'panel-b'}, groups,
      h('div', {class: 'group'}, h('h3', null, `Solved in the last ${CFG.solvedDays} days`, h('span', {class: 'n'}, `· ${solved.length}`)),
        solved.length ? h('ul', {class: 'list'}, solved.map(solvedRow)) : h('p', {class: 'empty'}, 'Nothing solved yet.')))));
}
function problemRow(p) {
  const pend = state.pending[p.id];
  const box = h('input', {type: 'checkbox', checked: !!pend, 'aria-label': `Mark ${p.repo}#${p.number} as solved`,
    onchange: e => { if (e.target.checked) state.pending[p.id] = {note: ''}; else delete state.pending[p.id]; render(); }});
  const row = h('li', {class: 'row'}, box,
    h('div', null,
      h('div', {class: 't'}, link(p.url, p.title)),
      h('div', {class: 'meta'}, repoTag(p.repo, p.number), prioPill(p.prio), p.labels.filter(l => l !== p.kind).map(l => h('span', {class: 'label'}, l)),
        h('span', null, `opened ${ago(p.createdAt)} by @${p.author}`), p.assignees.length ? h('span', null, p.assignees.map(a => '@' + a).join(', ')) : null,
        p.comments ? h('span', null, plural(p.comments, 'comment')) : null)));
  if (pend) {
    const note = h('textarea', {id: 'note-' + p.number + p.repo, placeholder: 'What solved it (optional, posted as a comment)', oninput: e => { pend.note = e.target.value; }});
    note.value = pend.note || '';
    const err = h('span', {class: 'err-msg', 'aria-live': 'polite'});
    const go = h('button', {class: 'btn primary', type: 'button', onclick: async () => {
      go.disabled = true; err.textContent = '';
      try { await setIssueState(p, false, pend.note); delete state.pending[p.id]; state.flash = {title: `Closed ${p.repo}#${p.number}`, text: p.title, url: p.url}; if (LOCAL) { derive(); render(); } else await load(); }
      catch (e) { go.disabled = false; err.textContent = writeError(e, p.repo); }
    }}, 'Close issue');
    row.append(h('div', {class: 'confirm'}, h('p', null, `Mark as solved? This closes ${p.repo}#${p.number} on GitHub.`), note,
      h('div', {class: 'actions'}, go, h('button', {class: 'btn', type: 'button', onclick: () => { delete state.pending[p.id]; render(); }}, 'Cancel'), err)));
  }
  return row;
}
function solvedRow(p) {
  const err = h('span', {class: 'err-msg', 'aria-live': 'polite'});
  const btn = h('button', {class: 'btn small', type: 'button', onclick: async () => {
    btn.disabled = true;
    try { await setIssueState(p, true); state.flash = {title: `Reopened ${p.repo}#${p.number}`, text: p.title, url: p.url}; if (LOCAL) { derive(); render(); } else await load(); }
    catch (e) { btn.disabled = false; err.textContent = writeError(e, p.repo); }
  }}, 'Reopen');
  return h('li', {class: 'row done'}, h('input', {type: 'checkbox', checked: true, disabled: true, 'aria-label': 'Solved'}),
    h('div', null, h('div', {class: 't'}, link(p.url, p.title)),
      h('div', {class: 'meta'}, repoTag(p.repo, p.number), h('span', {class: 'label'}, labelName(p.kind)), h('span', null, 'closed ' + ago(p.closedAt)), btn, err)));
}

/* ----------------------------------------------------------- improvements */
function ideaForm() {
  if (forms.idea) { fillRepos(forms.idea.querySelector('#if-repo')); return forms.idea; }
  const msg = h('span', {'aria-live': 'polite'});
  const f = h('form', {class: 'form', novalidate: true},
    h('label', {class: 'f wide'}, 'Idea', h('input', {type: 'text', id: 'if-title', name: 'title', required: true, maxlength: '200', placeholder: 'How COMPO could be better'})),
    h('label', {class: 'f'}, 'Module', repoSelect('if-repo')),
    h('label', {class: 'f wide'}, 'Notes', h('textarea', {id: 'if-body', name: 'body', placeholder: 'Why it would help, what it would change, links'})),
    h('div', {class: 'actions'}, h('button', {class: 'btn primary', type: 'submit'}, 'Save idea'), msg));
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const title = f.querySelector('#if-title').value.trim(), repo = f.querySelector('#if-repo').value, notes = f.querySelector('#if-body').value.trim();
    if (!title) { msg.className = 'err-msg'; msg.textContent = 'Give the idea a title.'; f.querySelector('#if-title').focus(); return; }
    const body = [notes || '_No notes yet._', '', `_Idea added from COMPO Status by @${M.viewer}. Needs refinement before it is planned._`].join('\n');
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true; msg.className = ''; msg.textContent = 'Saving…';
    try {
      const issue = await createIssue(repo, title, body, [CFG.ideaLabel, CFG.newLabel], 'Feature');
      f.reset(); f.querySelector('#if-repo').value = repo; msg.textContent = '';
      state.flash = {title: `Saved ${repo}#${issue.number}`, text: title, url: issue.html_url};
      if (LOCAL) { derive(); render(); } else await load();
    } catch (e) { msg.className = 'err-msg'; msg.textContent = writeError(e, repo); }
    finally { btn.disabled = false; }
  });
  forms.idea = h('details', {class: 'add', open: true}, h('summary', null, 'Add an idea'), f);
  fillRepos(f.querySelector('#if-repo'));
  return forms.idea;
}
function improvementsView() {
  const rf = state.filters.repo;
  const pick = l => l.filter(i => !rf || i.repo === rf).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const fresh = pick(M.ideas.fresh), planned = pick(M.ideas.planned);
  const filter = h('select', {id: 'im-filter', 'aria-label': 'Module', onchange: e => { state.filters.repo = e.target.value; render(); }},
    h('option', {value: ''}, 'All modules'), M.order.map(n => h('option', {value: n, selected: n === rf}, n)));
  return h('div', null,
    h('div', {class: 'head'}, h('h2', null, 'How we can improve COMPO'), h('p', null, `Ideas are issues labelled ${CFG.ideaLabel}. New ones also carry ${CFG.newLabel} until they are groomed.`)),
    ideaForm(),
    h('div', {class: 'filters'}, filter),
    h('div', {class: 'grid2 even'},
      h('section', {class: 'panel'}, h('div', {class: 'panel-h'}, h('h2', null, 'New ideas'), h('span', {class: 'more'}, fresh.length)),
        h('div', {class: 'panel-b'}, fresh.length ? fresh.map(ideaCard) : h('p', {class: 'empty'}, 'No new ideas. Add the first one above.'))),
      h('section', {class: 'panel'}, h('div', {class: 'panel-h'}, h('h2', null, 'Planned improvements'), h('span', {class: 'more'}, planned.length)),
        h('div', {class: 'panel-b'}, planned.length ? planned.map(ideaCard) : h('p', {class: 'empty'}, 'None planned.')))));
}
function ideaCard(i) {
  const o = state.open[i.id];
  const excerpt = i.body.replace(/\s+/g, ' ').trim();
  const toggle = h('button', {class: 'btn link', type: 'button', 'aria-expanded': String(!!o), onclick: async () => {
    if (state.open[i.id]) { delete state.open[i.id]; render(); return; }
    state.open[i.id] = {comments: null, draft: '', error: ''}; render();
    try { state.open[i.id].comments = await loadComments(i); } catch (e) { state.open[i.id].error = writeError(e, i.repo); }
    render();
  }}, o ? 'Hide notes' : (i.comments ? `${plural(i.comments, 'note')}` : 'Add a note'));
  const card = h('article', {class: 'idea'},
    h('div', {class: 't'}, link(i.url, i.title)),
    excerpt ? h('p', {class: 'x'}, excerpt.length > 220 ? excerpt.slice(0, 217) + '…' : excerpt) : null,
    h('div', {class: 'row meta', style: 'display:flex;padding:0;border:0'}, repoTag(i.repo, i.number), prioPill(i.prio), h('span', null, 'updated ' + ago(i.updatedAt)), toggle));
  if (o) {
    const ta = h('textarea', {id: 'c-' + i.repo + i.number, placeholder: 'Add a note to this idea', oninput: e => { o.draft = e.target.value; }}); ta.value = o.draft || '';
    const err = h('span', {class: 'err-msg', 'aria-live': 'polite'}, o.error || '');
    const post = h('button', {class: 'btn primary small', type: 'button', onclick: async () => {
      if (!o.draft.trim()) { err.textContent = 'Write the note first.'; return; }
      post.disabled = true;
      try { await addComment(i, o.draft.trim()); o.draft = ''; o.comments = await loadComments(i); if (LOCAL) derive(); else await load(); state.open[i.id] = o; render(); }
      catch (e) { post.disabled = false; err.textContent = writeError(e, i.repo); }
    }}, 'Post note');
    card.append(h('div', {class: 'notes'},
      o.comments == null ? h('p', {class: 'empty'}, 'Loading notes…') :
        (o.comments.length ? o.comments.map(c => h('div', {class: 'note'}, h('div', {class: 'meta'}, `@${c.user ? c.user.login : 'ghost'} · ${ago(c.created_at)}`), h('p', null, c.body))) : h('p', {class: 'empty'}, 'No notes yet.')),
      ta, h('div', {class: 'actions'}, post, err)));
  }
  return card;
}

/* --------------------------------------------------------------- activity */
function activityView() {
  const rf = state.filters.repo, kinds = state.filters.kinds;
  const list = M.ev.filter(e => (!rf || e.repo === rf) && kinds.has(e.kind));
  const chip = (k, label) => h('button', {class: 'chip', type: 'button', 'aria-pressed': String(kinds.has(k)), onclick: () => { kinds.has(k) ? kinds.delete(k) : kinds.add(k); render(); }}, label);
  const filter = h('select', {id: 'ac-filter', 'aria-label': 'Module', onchange: e => { state.filters.repo = e.target.value; render(); }},
    h('option', {value: ''}, 'All modules'), M.order.map(n => h('option', {value: n, selected: n === rf}, n)));
  const days = []; let cur = null;
  list.forEach(e => { const k = dayKey(e.when); if (!cur || cur.k !== k) { cur = {k, items: []}; days.push(cur); } cur.items.push(e); });
  return h('div', null,
    h('div', {class: 'head'}, h('h2', null, 'What happened'), h('p', null, `Commits to main, pull requests and issues across the org, last ${CFG.activityDays} days.`)),
    h('div', {class: 'filters'}, filter, chip('commit', 'Commits'), chip('pr', 'Pull requests'), chip('issue', 'Issues')),
    h('section', {class: 'panel'}, h('div', {class: 'panel-b'}, days.length ? days.map(d => [h('div', {class: 'day'}, d.k), h('ul', {class: 'feed'}, d.items.map(evItem))])
      : h('p', {class: 'empty'}, 'Nothing matches.'))));
}

/* ------------------------------------------------------------------- plan */
function inline(text) {
  // Everything is escaped first, so only the markup built below reaches the page.
  const esc = s => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const raw = u.replace(/&amp;/g, '&');
    const href = /^https?:/i.test(raw) ? raw : `https://github.com/${CFG.org}/${CFG.planRepo}/blob/HEAD/${raw.replace(/^\.\//, '')}`;
    const ok = safeUrl(href);
    return ok === '#' ? t : `<a href="${esc(ok)}" target="_blank" rel="noopener noreferrer">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:]|$)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(·,])([A-Za-z][\w.-]*)#(\d+)\b/g, (m, pre, repo, n) => {
    if (!M.byName[repo]) return m;
    const st = M.refState(`${repo}#${n}`);
    return `${pre}<a class="ref${st.state === 'done' ? ' done' : ''}" href="https://github.com/${CFG.org}/${encodeURIComponent(repo)}/issues/${n}" target="_blank" rel="noopener noreferrer">${repo}#${n}</a>`;
  });
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => `<code>${codes[+k]}</code>`);
}
function markdown(md) {
  const out = [], lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) { const n = Math.min(3, m[1].length); out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue; }
    if (/^\|/.test(ln)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = r => r.split('|').slice(1, -1).map(c => c.trim());
      const body = rows.filter((r, k) => !(k === 1 && /^\|[\s|:-]+\|?\s*$/.test(r)));
      const [hd, ...rest] = body;
      out.push('<div class="tbl"><table><thead><tr>' + cells(hd).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rest.map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(ln)) {
      const ordered = /^\s*\d+\./.test(ln), items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '')); i++; }
      out.push(`<${ordered ? 'ol' : 'ul'}>` + items.map(t => `<li>${inline(t)}</li>`).join('') + `</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const para = []; while (i < lines.length && lines[i].trim() && !/^(#|\||\s*([-*]|\d+\.)\s)/.test(lines[i])) { para.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}
function planView() {
  const edit = `https://github.com/${CFG.org}/${CFG.planRepo}/edit/HEAD/${CFG.planPath}`;
  if (!state.plan) return h('div', null, h('div', {class: 'head'}, h('h2', null, 'Plan')), h('p', {class: 'empty'}, `${CFG.planRepo}/${CFG.planPath} could not be read with your token.`));
  const box = h('article', {class: 'md'}); box.innerHTML = markdown(state.plan);
  return h('div', null,
    h('div', {class: 'head'}, h('h2', null, 'Plan'), h('p', null, `${CFG.planRepo}/${CFG.planPath}, read live. Issue references show ✓ once closed.`), link(edit, 'Edit on GitHub', 'btn small')),
    box);
}

/* ---------------------------------------------------------------- sign in */
function signInView() {
  const msg = h('p', {class: 'err-msg', 'aria-live': 'polite'}, state.signInMsg || '');
  const tok = h('input', {type: 'password', id: 'token', name: 'token', autocomplete: 'off', spellcheck: 'false', placeholder: 'github_pat_…', required: true});
  const remember = h('input', {type: 'checkbox', id: 'remember'});
  const newToken = 'https://github.com/settings/personal-access-tokens/new';
  const f = h('form', {novalidate: true},
    h('label', {class: 'f'}, 'Your GitHub token', tok),
    h('label', {class: 'check'}, remember, 'Remember on this device'),
    h('div', {class: 'actions'}, h('button', {class: 'btn primary', type: 'submit'}, 'Sign in')), msg);
  f.addEventListener('submit', ev => {
    ev.preventDefault();
    const t = tok.value.trim();
    if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(t)) { msg.textContent = 'That does not look like a GitHub token. Fine-grained tokens start with github_pat_.'; return; }
    state.token = t; store.set(t, remember.checked); state.signInMsg = ''; tok.value = '';
    render(); load();
  });
  return h('section', {class: 'signin'},
    h('h1', null, 'COMPO Status'),
    h('p', null, `How COMPO is doing, read live from the ${CFG.org} repos: builds, the sprint, what changed, the problems we are facing and the ideas to improve it. You can add problems and ideas from here; they become issues in the private repos.`),
    h('p', null, 'This page holds no project data. It needs your own GitHub token to read the private repos:'),
    h('ol', null,
      h('li', null, link(newToken, 'Create a fine-grained token'), ` with resource owner ${CFG.org} and access to all repositories.`),
      h('li', null, 'Repository permissions: Issues read and write; Contents, Pull requests, Actions and Metadata read-only.'),
      h('li', null, 'Organization permissions: Projects read and write, for the sprint and for putting new problems on the board.'),
      h('li', null, 'Paste it below.')),
    f,
    h('p', {class: 'fine'}, 'The token stays in this browser and is sent only to api.github.com. Without "Remember" it is gone when you close the tab. Sign out removes it.'));
}
function signOut(why) {
  store.clear(); state.token = null; M = null; state.data = null; state.loadedAt = null; state.board = null;
  state.signInMsg = why || ''; render();
}

/* ------------------------------------------------------------------- boot */
function route() {
  const v = location.hash.slice(1);
  state.view = VIEWS.some(([id]) => id === v) ? v : 'overview';
  render(); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
setInterval(() => { if ((state.token || LOCAL) && document.visibilityState === 'visible' && !LOCAL) load(); }, CFG.refreshSeconds * 1000);
setInterval(() => renderBar(), 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token && !LOCAL && state.loadedAt && Date.now() - state.loadedAt > 60000) load();
});
function start() {
  state.token = LOCAL ? 'local' : store.get();
  const v = location.hash.slice(1); state.view = VIEWS.some(([id]) => id === v) ? v : 'overview';
  render();
  if (state.token) load();
}
if (LOCAL) {
  const s = document.createElement('script'); s.src = '.local/local-data.js';
  s.onload = start; s.onerror = () => { state.error = 'Local preview: .local/local-data.js was not found.'; start(); };
  document.head.appendChild(s);
} else start();
})();
