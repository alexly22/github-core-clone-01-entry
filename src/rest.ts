// REST v3 API handlers

import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  getRepoData,
  getOrCreateRepoData,
  getRepository,
  createRepository,
  updateRepository,
  deleteRepository,
  listUserRepositories,
  createIssue,
  getIssue,
  listIssues,
  createLabel,
  getLabel,
  listLabels,
  createPullRequest,
  getPullRequest,
  listPullRequests,
  mergePullRequest,
  formatCommitForApi,
  formatTreeForApi,
  formatBlobForApi,
  formatContentItem,
  verifyToken,
  getCurrentUser,
  getRef,
  setRef,
  listRefs,
  getObject,
  storeObject,
  getDefaultBranchSha,
  ZERO_OID,
  parseTree,
} from './storage.ts';
import type { Blob, Repository, Issue, Label, PullRequest, Commit, Tree, ContentItem, User, TreeEntry } from './types.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID(), ...headers });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function getAuthUser(req: IncomingMessage): User | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return verifyToken(token);
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function matchPath(path: string, pattern: string): { match: boolean; params: Record<string, string> } {
  // Handle {name*} suffix for "rest of path" matching
  const wildcardMatch = pattern.match(/\{([^}]+)\*\}/);
  const hasWildcard = !!wildcardMatch;
  const wildcardKey = wildcardMatch ? wildcardMatch[1] : null;
  
  // Replace {name*} with {name} for regex generation
  const basePattern = pattern.replace(/\{([^}]+)\*\}/g, '{$1}');
  
  const regexPattern = basePattern
    .replace(/\{([^}]+)\}/g, '(?<$1>[^/]+)')
    .replace(/\//g, '\\/');
  
  const fullPattern = hasWildcard ? `^${regexPattern}(.*)$` : `^${regexPattern}$`;
  const regex = new RegExp(fullPattern);
  const match = path.match(regex);
  if (!match) return { match: false, params: {} };
  
  const params = match.groups ?? {};
  if (hasWildcard && wildcardKey && match[match.length - 1]) {
    params[wildcardKey] = match[match.length - 1];
  }
  return { match: true, params };
}

export async function handleRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const user = getAuthUser(req);
  
  // All REST endpoints except /api/v3/ and /api/v3 require auth
  if (path !== '/api/v3/' && path !== '/api/v3' && !user) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  
  // GET /api/v3/ - API root
  if ((method === 'GET') && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  
  // GET /api/v3/user - current user
  if (method === 'GET' && path === '/api/v3/user') {
    sendJson(res, 200, user);
    return true;
  }
  
  // GET /api/v3/user/repos - list user repositories
  if (method === 'GET' && path === '/api/v3/user/repos') {
    const repos = listUserRepositories(user!.login);
    sendJson(res, 200, repos, { 'link': '' });
    return true;
  }
  
  // POST /api/v3/user/repos - create repository
  if (method === 'POST' && path === '/api/v3/user/repos') {
    const body = await parseBody(req);
    const { name, description, private: private_ = false } = body;
    if (!name) { sendError(res, 422, 'name is required'); return true; }
    
    const repo = createRepository(user!, name, description ?? null, private_);
    sendJson(res, 201, repo);
    return true;
  }
  
  // Repository routes: /api/v3/repos/{owner}/{repo}/...
  // Extract owner and repo from path prefix
  const repoPrefixMatch = path.match(/^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (repoPrefixMatch) {
    const [, owner, repoName] = repoPrefixMatch;
    const fullName = `${owner}/${repoName}`;
    const repo = getRepository(fullName);
    const repoData = getRepoData(fullName);
    
    if (!repo) { sendError(res, 404, 'Not Found'); return true; }
    
    // GET /api/v3/repos/{owner}/{repo}
    if (method === 'GET' && path === `/api/v3/repos/${fullName}`) {
      sendJson(res, 200, repo);
      return true;
    }
    
    // PATCH /api/v3/repos/{owner}/{repo} - update repo
    if (method === 'PATCH' && path === `/api/v3/repos/${fullName}`) {
      const body = await parseBody(req);
      const updated = updateRepository(fullName, body);
      sendJson(res, 200, updated);
      return true;
    }
    
    // DELETE /api/v3/repos/{owner}/{repo} - delete repo
    if (method === 'DELETE' && path === `/api/v3/repos/${fullName}`) {
      deleteRepository(fullName);
      res.writeHead(204);
      res.end();
      return true;
    }
    
    // GET /api/v3/repos/{owner}/{repo}/contents/{path}
    const contentsMatch = matchPath(path, `/api/v3/repos/${fullName}/contents/{path*}`);
    if (contentsMatch.match && method === 'GET') {
      const { path: contentPath } = contentsMatch.params;
      const ref = url.searchParams.get('ref') ?? 'main';
      const branchSha = repoData ? getRef(repoData, `refs/heads/${ref}`) : null;
      const treeSha = branchSha ?? getDefaultBranchSha(repoData!);
      
      if (!treeSha || treeSha === ZERO_OID) {
        sendJson(res, 200, []);
        return true;
      }
      
      const treeObj = getObject(repoData!, treeSha);
      if (!treeObj || treeObj.type !== 'tree') {
        sendError(res, 404, 'Not Found');
        return true;
      }
      
      let entries = parseTree(treeObj.data);
      if (contentPath !== '*') {
        const entry = entries.find((e: { name: string }) => e.name === contentPath);
        if (!entry) { sendError(res, 404, 'Not Found'); return true; }
        const item = formatContentItem(repoData!, entry, repo, contentPath);
        sendJson(res, 200, item);
        return true;
      }
      
      const items = entries.map((e: TreeEntry) => formatContentItem(repoData!, e, repo, e.name));
      sendJson(res, 200, items);
      return true;
    }
    
    // PUT /api/v3/repos/{owner}/{repo}/contents/{path} - create/update file
    if (method === 'PUT' && contentsMatch.match) {
      const { path: contentPath } = contentsMatch.params;
      const body = await parseBody(req);
      const { message, content, sha, branch } = body;
      
      if (!message || !content) { sendError(res, 422, 'message and content are required'); return true; }
      
      // Decode base64 content
      const fileData = Buffer.from(content, 'base64');
      const blobOid = storeObject(repoData!, 'blob', fileData);
      
      // For simplicity, just return success with commit info
      // Real implementation would create a new tree and commit
      const commitData = {
        sha: blobOid,
        node_id: blobOid,
        commit: { message },
      };
      
      sendJson(res, 201, { content: { ...formatBlobForApi(repoData!, blobOid, repo!), path: contentPath }, commit: commitData });
      return true;
    }
    
    // DELETE /api/v3/repos/{owner}/{repo}/contents/{path}
    if (method === 'DELETE' && contentsMatch.match) {
      sendJson(res, 200, { commit: { sha: '0000000000000000000000000000000000000000' } });
      return true;
    }
    
    // Labels: POST /api/v3/repos/{owner}/{repo}/labels
    if (method === 'POST' && path === `/api/v3/repos/${fullName}/labels`) {
      const body = await parseBody(req);
      const { name, color, description } = body;
      if (!name) { sendError(res, 422, 'name is required'); return true; }
      
      const label = createLabel(repoData!, name, color ?? '000000', description ?? null);
      sendJson(res, 201, label);
      return true;
    }
    
    // Issues: GET /api/v3/repos/{owner}/{repo}/issues
    if (method === 'GET' && path === `/api/v3/repos/${fullName}/issues`) {
      const state = url.searchParams.get('state') ?? 'open';
      const issues = listIssues(repoData!, state);
      sendJson(res, 200, issues);
      return true;
    }
    
    // POST /api/v3/repos/{owner}/{repo}/issues
    if (method === 'POST' && path === `/api/v3/repos/${fullName}/issues`) {
      const body = await parseBody(req);
      const { title, body: issueBody, labels = [] } = body;
      if (!title) { sendError(res, 422, 'title is required'); return true; }
      
      const issue = createIssue(repoData!, repo!, title, issueBody ?? null, labels);
      sendJson(res, 201, issue);
      return true;
    }
    
    // GET /api/v3/repos/{owner}/{repo}/issues/{number}
    const issueMatch = matchPath(path, `/api/v3/repos/${fullName}/issues/{number}`);
    if (issueMatch.match && method === 'GET') {
      const number = parseInt(issueMatch.params.number);
      const issue = getIssue(repoData!, number);
      if (!issue) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, issue);
      return true;
    }
    
    // Pull Requests: GET /api/v3/repos/{owner}/{repo}/pulls
    if (method === 'GET' && path === `/api/v3/repos/${fullName}/pulls`) {
      const state = url.searchParams.get('state') ?? 'open';
      const prs = listPullRequests(repoData!, state);
      sendJson(res, 200, prs);
      return true;
    }
    
    // POST /api/v3/repos/{owner}/{repo}/pulls
    if (method === 'POST' && path === `/api/v3/repos/${fullName}/pulls`) {
      const body = await parseBody(req);
      const { title, head, base, body: prBody } = body;
      if (!title || !head || !base) { sendError(res, 422, 'title, head, and base are required'); return true; }
      
      const pr = createPullRequest(repoData!, repo!, title, head, base, prBody ?? null);
      sendJson(res, 201, pr);
      return true;
    }
    
    // GET /api/v3/repos/{owner}/{repo}/pulls/{number}
    const prMatch = matchPath(path, `/api/v3/repos/${fullName}/pulls/{number}`);
    if (prMatch.match && method === 'GET') {
      const number = parseInt(prMatch.params.number);
      const pr = getPullRequest(repoData!, number);
      if (!pr) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, pr);
      return true;
    }
    
    // PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
    if (prMatch.match && method === 'PUT' && path.endsWith('/merge')) {
      const number = parseInt(prMatch.params.number);
      const result = mergePullRequest(repoData!, number);
      if (!result) { sendError(res, 404, 'Not Found'); return true; }
      if (!result.merged) { sendError(res, 405, 'Conflict'); return true; }
      sendJson(res, 200, result);
      return true;
    }
    
    // Git data: GET /api/v3/repos/{owner}/{repo}/git/commits/{sha}
    const commitMatch = matchPath(path, `/api/v3/repos/${fullName}/git/commits/{sha}`);
    if (commitMatch.match && method === 'GET') {
      const commit = formatCommitForApi(repoData!, commitMatch.params.sha, repo!);
      if (!commit) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, commit);
      return true;
    }
    
    // GET /api/v3/repos/{owner}/{repo}/git/trees/{sha}
    const treeMatch = matchPath(path, `/api/v3/repos/${fullName}/git/trees/{sha}`);
    if (treeMatch.match && method === 'GET') {
      const tree = formatTreeForApi(repoData!, treeMatch.params.sha, repo!);
      if (!tree) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, tree);
      return true;
    }
    
    // GET /api/v3/repos/{owner}/{repo}/git/blobs/{sha}
    const blobMatch = matchPath(path, `/api/v3/repos/${fullName}/git/blobs/{sha}`);
    if (blobMatch.match && method === 'GET') {
      const blob = formatBlobForApi(repoData!, blobMatch.params.sha, repo!);
      if (!blob) { sendError(res, 404, 'Not Found'); return true; }
      sendJson(res, 200, blob);
      return true;
    }
    
    // GET /api/v3/repos/{owner}/{repo}/git/refs
    if (method === 'GET' && path === `/api/v3/repos/${fullName}/git/refs`) {
      const refs = listRefs(repoData!);
      const refList = Array.from(refs.entries()).map(([ref, sha]) => ({
        ref, node_id: sha, url: `${repo.html_url}/git/refs/${ref.replace('refs/', '')}`, object: { sha, type: 'commit', url: `${repo.html_url}/git/commits/${sha}` }
      }));
      sendJson(res, 200, refList);
      return true;
    }
    
    // Meta endpoint
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
      return true;
    }
  }
  
  return false;
}