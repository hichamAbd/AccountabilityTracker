// In-memory fake of the parts of the GitHub REST API that Tally uses.
const crypto = require('crypto');

class FakeGitHub {
  constructor({ owner = 'hichamAbd', repo = 'AccountabilityTracker', token = 'good-token' } = {}) {
    this.owner = owner; this.repo = repo; this.token = token;
    this.blobs = new Map(); this.trees = new Map(); this.commits = new Map(); this.refs = new Map();
    this.log = [];
    this.writeDelay = 0;
    // main branch with the app (so the repo is not empty)
    const t = this.putTree([{ path: 'index.html', sha: this.putBlob('<html>') }]);
    const c = this.putCommit(t, [], 'app');
    this.refs.set('main', c);
  }
  putBlob(text) {
    const body = Buffer.from(text, 'utf8');
    const sha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
    this.blobs.set(sha, text);
    return sha;
  }
  putTree(entries) { const sha = crypto.randomBytes(20).toString('hex'); this.trees.set(sha, entries); return sha; }
  putCommit(tree, parents, message) { const sha = crypto.randomBytes(20).toString('hex'); this.commits.set(sha, { tree, parents, message }); return sha; }
  fileAt(branch, path) {
    const c = this.commits.get(this.refs.get(branch));
    const e = c && this.trees.get(c.tree).find(x => x.path === path);
    return e ? this.blobs.get(e.sha) : null;
  }
  filesAt(branch) {
    const c = this.commits.get(this.refs.get(branch));
    return c ? this.trees.get(c.tree).map(e => e.path) : [];
  }
  commitCount(branch) {
    let n = 0; let s = this.refs.get(branch);
    while (s) { n++; s = this.commits.get(s).parents[0]; }
    return n;
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const base = `/repos/${this.owner}/${this.repo}`;
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    let p = url.pathname;
    if (!p.toLowerCase().startsWith(base.toLowerCase())) return json(404, { message: 'Not Found' });
    p = p.slice(base.length);
    const auth = req.headers().authorization;
    this.log.push(`${method} ${p}`);
    if (p.startsWith('/contents/') && method === 'GET') {
      const path = decodeURIComponent(p.slice('/contents/'.length));
      const text = this.refs.has(url.searchParams.get('ref')) ? this.fileAt(url.searchParams.get('ref'), path) : null;
      if (text == null) return json(404, { message: 'Not Found' });
      return json(200, { content: Buffer.from(text).toString('base64'), sha: this.putBlob(text) });
    }
    if (auth !== `Bearer ${this.token}`) return json(401, { message: 'Bad credentials' });
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (this.writeDelay && method !== 'GET') await new Promise(r => setTimeout(r, this.writeDelay));
    let m;
    if (p === '' && method === 'GET') return json(200, { name: this.repo, permissions: { push: true } });
    if ((m = p.match(/^\/git\/ref\/heads\/(.+)$/)) && method === 'GET') {
      const s = this.refs.get(decodeURIComponent(m[1]));
      return s ? json(200, { object: { sha: s } }) : json(404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/git\/commits\/(\w+)$/)) && method === 'GET') {
      const c = this.commits.get(m[1]);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), message: c.message }) : json(404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/git\/trees\/(\w+)$/)) && method === 'GET') {
      const t = this.trees.get(m[1]);
      return t ? json(200, { sha: m[1], tree: t.map(e => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })), truncated: false }) : json(404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/git\/blobs\/(\w+)$/)) && method === 'GET') {
      const b = this.blobs.get(m[1]);
      return b != null ? json(200, { sha: m[1], content: Buffer.from(b).toString('base64').replace(/(.{60})/g, '$1\n'), encoding: 'base64' }) : json(404, { message: 'Not Found' });
    }
    if (p === '/git/trees' && method === 'POST') {
      const entries = body.base_tree ? [...this.trees.get(body.base_tree)] : [];
      for (const e of body.tree) {
        const i = entries.findIndex(x => x.path === e.path);
        if (e.sha === null) { if (i < 0) return json(422, { message: 'path not in tree' }); entries.splice(i, 1); continue; }
        const sha = e.content != null ? this.putBlob(e.content) : e.sha;
        if (i >= 0) entries[i] = { path: e.path, sha }; else entries.push({ path: e.path, sha });
      }
      return json(201, { sha: this.putTree(entries) });
    }
    if (p === '/git/commits' && method === 'POST') return json(201, { sha: this.putCommit(body.tree, body.parents, body.message) });
    if ((m = p.match(/^\/git\/refs\/heads\/(.+)$/)) && method === 'PATCH') {
      const br = decodeURIComponent(m[1]);
      const c = this.commits.get(body.sha);
      if (!c.parents.includes(this.refs.get(br))) return json(422, { message: 'Update is not a fast forward' });
      this.refs.set(br, body.sha);
      return json(200, { object: { sha: body.sha } });
    }
    if (p === '/git/refs' && method === 'POST') {
      const br = body.ref.replace('refs/heads/', '');
      if (this.refs.has(br)) return json(422, { message: 'Reference already exists' });
      this.refs.set(br, body.sha);
      return json(201, { object: { sha: body.sha } });
    }
    return json(404, { message: `Not handled: ${method} ${p}` });
  }
}
module.exports = { FakeGitHub };
