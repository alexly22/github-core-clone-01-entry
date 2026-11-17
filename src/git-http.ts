// Git smart HTTP handler (upload-pack v2, receive-pack v0)

import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { getRepoData, getOrCreateRepoData, getRepository, getRef, setRef, deleteRef, getAllRefs, getHeadRef, getDefaultBranchSha, getObject, storeObject, parseTree, parseCommitData } from './storage.ts';
import type { Repository, TreeEntry, CommitData } from './types.ts';
import { buildV2Advertisement, buildV0Advertisement, buildReceivePackAdvertisement, verifyFastForward, writePktLine, writeFlushPkt, readPktLines, handleUploadPackV2, handleUploadPackV0, handleReceivePack, ZERO_OID } from './git-protocol.ts';

function sendText(res: ServerResponse, status: number, body: string, contentType: string = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID() });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function getAuthUser(req: IncomingMessage): { login: string } | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  // In trial, token is MAKEFUN_SHOP_TOKEN
  if (token === process.env.MAKEFUN_SHOP_TOKEN || token === 'test-token') {
    return { login: 'testuser' };
  }
  return null;
}

function parseBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseGitPath(path: string, queryString: string): { owner: string; repo: string; service: string; action: string } | null {
  // /{owner}/{repo}.git/info/refs?service=git-upload-pack
  // /{owner}/{repo}.git/git-upload-pack
  // /{owner}/{repo}.git/git-receive-pack
  const match = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
  if (!match) return null;
  
  const [, owner, repo, rest] = match;
  const [endpoint] = rest.split('?');
  
  // Parse service from query string
  const params = new URLSearchParams(queryString);
  const serviceParam = params.get('service');
  
  if (endpoint === 'info/refs') {
    if (serviceParam === 'git-upload-pack') return { owner, repo, service: 'upload-pack', action: 'info-refs' };
    if (serviceParam === 'git-receive-pack') return { owner, repo, service: 'receive-pack', action: 'info-refs' };
  } else if (endpoint === 'git-upload-pack') {
    return { owner, repo, service: 'upload-pack', action: 'post' };
  } else if (endpoint === 'git-receive-pack') {
    return { owner, repo, service: 'receive-pack', action: 'post' };
  }
  
  return null;
}

export async function handleGitSmartHTTP(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const path = url.pathname;
  const queryString = url.search;
  const method = req.method ?? 'GET';
  
  const parsed = parseGitPath(path, queryString);
  if (!parsed) return false;
  
  const { owner, repo: repoName, service, action } = parsed;
  const fullName = `${owner}/${repoName}`;
  
  // Check repository exists
  const repo = getRepository(fullName);
  if (!repo) {
    sendText(res, 404, 'Not Found');
    return true;
  }
  
  const repoData = getOrCreateRepoData(fullName);
  
  // Check auth for write operations
  if (service === 'receive-pack') {
    const user = getAuthUser(req);
    if (!user) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Unauthorized');
      return true;
    }
  }
  
  // Check protocol version for upload-pack
  const protocolVersion = req.headers['git-protocol'] ?? '';
  const wantsV2 = protocolVersion.includes('version=2');
  
  if (service === 'upload-pack' && action === 'info-refs') {
    if (wantsV2) {
      // v2 advertisement
      const adv = buildV2Advertisement(repoData, fullName);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': adv.length });
      res.end(adv);
    } else {
      // v0 advertisement
      const adv = buildV0Advertisement(repoData);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': adv.length });
      res.end(adv);
    }
    return true;
  }
  
  if (service === 'receive-pack' && action === 'info-refs') {
    const adv = buildReceivePackAdvertisement(repoData);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': adv.length });
    res.end(adv);
    return true;
  }
  
  if (service === 'upload-pack' && action === 'post' && method === 'POST') {
    // Handle fetch request (v2 or v0)
    const body = await parseBody(req);
    
    let pack: Buffer;
    if (wantsV2) {
      pack = await handleUploadPackV2(repoData, body);
    } else {
      pack = await handleUploadPackV0(repoData, body);
    }
    
    if (pack.length === 0) {
      // Fallback: send all objects from main branch
      const defaultSha = getDefaultBranchSha(repoData);
      if (defaultSha && defaultSha !== ZERO_OID) {
        pack = await handleUploadPackV0(repoData, Buffer.from(`want ${defaultSha}\n`));
      }
    }
    
    if (pack.length > 0) {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': pack.length });
      res.end(pack);
    } else {
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': 0 });
      res.end();
    }
    return true;
  }
  
  if (service === 'receive-pack' && action === 'post' && method === 'POST') {
    // Handle push
    const body = await parseBody(req);
    const response = await handleReceivePack(repoData, body);
    
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': response.length });
    res.end(response);
    return true;
  }
  
  return false;
}