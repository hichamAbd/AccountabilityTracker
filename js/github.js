// Minimal GitHub REST client using the Git Data API (one commit can change many files).
import { utf8FromB64 } from './crypto.js';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class GitHub {
  constructor(owner, repo, token) {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
  }

  async req(method, path, body, auth = true) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(`https://api.github.com/repos/${this.owner}/${this.repo}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store',
      });
    } catch {
      throw new GitHubError(0, 'Network error');
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new GitHubError(res.status, (data && data.message) || res.statusText);
    return data;
  }

  getRepo() { return this.req('GET', ''); }

  async headSha(branch) {
    try {
      const r = await this.req('GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
      return r.object.sha;
    } catch (e) {
      if (e.status === 404 || e.status === 409) return null;
      throw e;
    }
  }

  commit(sha) { return this.req('GET', `/git/commits/${sha}`); }
  tree(sha) { return this.req('GET', `/git/trees/${sha}?recursive=1`); }
  async blob(sha) { return utf8FromB64((await this.req('GET', `/git/blobs/${sha}`)).content); }

  createTree(entries, baseTree) {
    const body = { tree: entries };
    if (baseTree) body.base_tree = baseTree;
    return this.req('POST', '/git/trees', body);
  }
  createCommit(message, tree, parents) { return this.req('POST', '/git/commits', { message, tree, parents }); }
  updateRef(branch, sha) { return this.req('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false }); }
  createRef(branch, sha) { return this.req('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha }); }

  // Read a file without a token (public repo). Falls back to raw.githubusercontent.com on rate limits.
  async publicFile(path, ref) {
    try {
      const r = await this.req('GET', `/contents/${path}?ref=${encodeURIComponent(ref)}`, null, false);
      return { text: utf8FromB64(r.content), sha: r.sha };
    } catch (e) {
      if (e.status === 404) return null;
      if (e.status !== 403) throw e;
      let res;
      try {
        res = await fetch(`https://raw.githubusercontent.com/${this.owner}/${this.repo}/${ref}/${path}`, { cache: 'no-store' });
      } catch {
        throw new GitHubError(0, 'Network error');
      }
      if (res.status === 404) return null;
      if (!res.ok) throw e;
      return { text: await res.text(), sha: null };
    }
  }
}
