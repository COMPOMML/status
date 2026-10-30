/*
 * The public part of the site: sign in, then load everything else from the private
 * COMPOMML/BRAIN repo with the viewer's own token. This repo holds no project content.
 */
'use strict';
(() => {
  const OWNER = 'COMPOMML', REPO = 'BRAIN', API = 'https://api.github.com', KEY = 'compo.token';
  const LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && new URLSearchParams(location.search).has('local');
  const shell = document.getElementById('shell');
  let token = null;
  const store = {
    get() { try { return sessionStorage.getItem(KEY) || localStorage.getItem(KEY); } catch (_) { return null; } },
    set(t, keep) { try { (keep ? localStorage : sessionStorage).setItem(KEY, t); } catch (_) {} },
    clear() { try { sessionStorage.removeItem(KEY); localStorage.removeItem(KEY); } catch (_) {} },
  };
  const auth = () => { const e = new Error('GitHub did not accept the token. It may have expired or been revoked.'); e.auth = true; return e; };

  async function gql(query, variables) {
    if (LOCAL) return window.__FIXTURE.gql;
    const r = await fetch(API + '/graphql', {method: 'POST', headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify({query, variables})});
    if (r.status === 401) { signOut(auth().message); throw auth(); }
    const j = await r.json().catch(() => ({}));
    if (j.errors && !j.data) throw new Error(j.errors.map(e => e.message).join('; '));
    if (!r.ok && !j.data) throw new Error(j.message || 'GitHub answered ' + r.status);
    return j;
  }
  async function rest(method, path, body, accept) {
    if (LOCAL) { const m = /\/repos\/[^/]+\/([^/]+)\/actions\/runs/.exec(path); return m ? {workflow_runs: window.__FIXTURE.runs[decodeURIComponent(m[1])] || []} : []; }
    const r = await fetch(API + path, {method, headers: Object.assign({Authorization: 'Bearer ' + token, Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'}, body ? {'Content-Type': 'application/json'} : {}), body: body ? JSON.stringify(body) : undefined});
    if (r.status === 401) { signOut(auth().message); throw auth(); }
    if (accept && accept.includes('raw') && r.ok) return r.text();
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || 'GitHub answered ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  const raw = 'application/vnd.github.raw+json';
  async function file(name, sha) {
    if (LOCAL) { const r = await fetch('/BRAIN/site/' + name, {cache: 'no-store'}); if (!r.ok) throw new Error('missing ' + name); return r.text(); }
    return rest('GET', `/repos/${OWNER}/${REPO}/contents/site/${name}?ref=${sha}`, null, raw);
  }
  const addScript = (src, async) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.async = !!async; s.onload = ok; s.onerror = () => no(new Error('could not load ' + src)); document.head.appendChild(s); if (async) ok(); });
  const addBlob = text => addScript(URL.createObjectURL(new Blob([text], {type: 'text/javascript'})));

  async function boot() {
    shell.innerHTML = '<p class="loading">Reading the private repo…</p>';
    let sha = 'local';
    try {
      if (LOCAL) { const r = await fetch('/BRAIN/.local/fixture.json', {cache: 'no-store'}); window.__FIXTURE = await r.json(); }
      else sha = (await rest('GET', `/repos/${OWNER}/${REPO}/commits/main`)).sha;
      const [css, body, data, algo, labJs, appJs, algoJs] = await Promise.all(['app.css', 'body.html', 'data.json', 'algorithm.html', 'lab.js', 'app.js', 'algo.js'].map(n => file(n, sha)));
      const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
      document.body.innerHTML = body;
      document.getElementById('algo').innerHTML = algo;
      const who = document.createElement('div'); who.id = 'who';
      if (!LOCAL) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Sign out'; b.onclick = () => signOut(); who.append(b); } else who.textContent = 'local preview';
      document.body.append(who);
      window.__BRAIN = {data: JSON.parse(data), sha: LOCAL ? null : sha, local: LOCAL, gql, rest, signOut};
      window.MathJax = {tex: {inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']]}, svg: {fontCache: 'global'}, options: {enableMenu: false},
        startup: {typeset: false, ready() { MathJax.startup.defaultReady(); MathJax.startup.promise.then(() => window.__mjFlush && window.__mjFlush()); }}};
      await addScript('vendor/three.min.js');
      addScript('vendor/tex-svg.js', true);
      await addBlob(labJs); await addBlob(appJs); await addBlob(algoJs);
    } catch (e) {
      if (e.auth) return;
      const denied = e.status === 404 || e.status === 403;
      signIn(denied ? `This token cannot read ${OWNER}/${REPO}. Check its repository access and that it has Contents: Read.` : 'Could not load the site: ' + (e.message || e), !denied);
    }
  }
  function signOut(why) { store.clear(); token = null; location.hash = ''; sessionStorage.setItem('compo.msg', why || ''); location.reload(); }
  function signIn(msg, keepToken) {
    if (!keepToken) { store.clear(); token = null; }
    shell.innerHTML = `<section class="signin"><h1>COMPO Brain</h1>
      <p>How COMPO works, and what is changing in it, read live from the ${OWNER} repos. This page holds nothing itself: the content is in a private repo, so you need your own GitHub token to see it.</p>
      <ol><li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">Create a fine-grained token</a> with resource owner ${OWNER} and access to all repositories.</li>
      <li>Repository permissions: Issues read and write, for your notes. Contents, Pull requests, Actions and Metadata read-only.</li>
      <li>Paste it below.</li></ol>
      <form novalidate><label>Your GitHub token<input type="password" id="tok" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
      <label class="row"><input type="checkbox" id="keep">Remember on this device</label>
      <p class="err" id="msg" aria-live="polite"></p><button type="submit">Sign in</button></form>
      <p class="fine">The token stays in this browser and is sent only to api.github.com. Without "Remember" it is gone when you close the tab. Sign out removes it.</p></section>`;
    document.getElementById('msg').textContent = msg || '';
    shell.querySelector('form').addEventListener('submit', ev => {
      ev.preventDefault();
      const t = document.getElementById('tok').value.trim();
      if (!/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(t)) { document.getElementById('msg').textContent = 'That does not look like a GitHub token. Fine-grained tokens start with github_pat_.'; return; }
      token = t; store.set(t, document.getElementById('keep').checked); boot();
    });
  }
  if (LOCAL) { boot(); return; }
  token = store.get();
  let why = ''; try { why = sessionStorage.getItem('compo.msg') || ''; sessionStorage.removeItem('compo.msg'); } catch (_) {}
  if (token) boot(); else signIn(why);
})();
