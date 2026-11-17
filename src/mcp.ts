// MCP (Model Context Protocol) handler

import { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { verifyToken, getCurrentUser, getRepoData, getRepository, getRef, setRef, listRefs, createRepository, createIssue, listIssues, createPullRequest, getPullRequest, mergePullRequest } from './storage.ts';
import type { Repository, Issue, PullRequest, User, Label } from './types.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': randomUUID() });
  res.end(text);
}

function getAuthUser(req: IncomingMessage): ReturnType<typeof getCurrentUser> | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return verifyToken(token);
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

// JSON-RPC 2.0 helpers
function rpcSuccess(id: string | number | null, result: any): any {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string, data?: any): any {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function rpcNotification(method: string, params: any): any {
  return { jsonrpc: '2.0', method, params };
}

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

const TOOLS = [
  { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string' }, private: { type: 'boolean' }, description: { type: 'string' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get repository details', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create a new issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
];

function normalizeToolName(name: string): string {
  // Allow server prefix (e.g., github__create_issue)
  if (name.includes('__')) return name.split('__').pop()!;
  return name;
}

export async function handleMCP(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const user = getAuthUser(req);
  if (!user) {
    sendError(res, 401, 'Unauthorized');
    return true;
  }
  
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  
  const body = await parseBody(req);
  
  // Handle batch requests (array) or single request
  const requests = Array.isArray(body) ? body : [body];
  const responses: any[] = [];
  
  for (const req of requests) {
    const { jsonrpc, id, method, params } = req;
    
    if (jsonrpc !== '2.0') {
      responses.push(rpcError(id, -32600, 'Invalid Request'));
      continue;
    }
    
    try {
      let result: any;
      
      switch (method) {
        case 'initialize': {
          const protocolVersion = params?.protocolVersion ?? '2026-07-28';
          if (!SUPPORTED_VERSIONS.includes(protocolVersion)) {
            result = rpcError(id, -32602, `Unsupported protocol version: ${protocolVersion}`);
            break;
          }
          result = rpcSuccess(id, {
            protocolVersion: '2026-07-28',
            capabilities: { tools: {} },
            serverInfo: { name: 'github-forge', version: '1.0.0' },
            supportedVersions: SUPPORTED_VERSIONS,
          });
          break;
        }
        
        case 'notifications/initialized': {
          // No response for notifications
          continue;
        }
        
        case 'tools/list': {
          result = rpcSuccess(id, { tools: TOOLS });
          break;
        }
        
        case 'tools/call': {
          const toolName = normalizeToolName(params?.name ?? '');
          const args = params?.arguments ?? {};
          
          switch (toolName) {
            case 'create_repo': {
              const { name, private: private_ = false, description = '' } = args;
              const repo = createRepository(user, name, description, private_);
              result = rpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify({ id: repo.id, name: repo.name, full_name: repo.full_name, html_url: repo.html_url }, null, 2) }] });
              break;
            }
            
            case 'get_repo': {
              const { owner, repo: repoName } = args;
              const fullName = `${owner}/${repoName}`;
              const repo = getRepository(fullName);
              if (!repo) {
                result = rpcSuccess(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
              } else {
                result = rpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(repo, null, 2) }] });
              }
              break;
            }
            
            case 'create_issue': {
              const { owner, repo: repoName, title, body: issueBody } = args;
              const fullName = `${owner}/${repoName}`;
              const repo = getRepository(fullName);
              const repoData = getRepoData(fullName);
              if (!repo || !repoData) {
                result = rpcSuccess(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
              } else {
                const issue = createIssue(repoData, repo, title, issueBody ?? null, []);
                result = rpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(issue, null, 2) }] });
              }
              break;
            }
            
            case 'list_issues': {
              const { owner, repo: repoName, state = 'open' } = args;
              const fullName = `${owner}/${repoName}`;
              const repoData = getRepoData(fullName);
              if (!repoData) {
                result = rpcSuccess(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
              } else {
                const issues = listIssues(repoData, state);
                result = rpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(issues, null, 2) }] });
              }
              break;
            }
            
            case 'create_pull_request': {
              const { owner, repo: repoName, title, head, base, body: prBody } = args;
              const fullName = `${owner}/${repoName}`;
              const repo = getRepository(fullName);
              const repoData = getRepoData(fullName);
              if (!repo || !repoData) {
                result = rpcSuccess(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
              } else {
                const pr = createPullRequest(repoData, repo, title, head, base, prBody ?? null);
                result = rpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(pr, null, 2) }] });
              }
              break;
            }
            
            case 'merge_pull_request': {
              const { owner, repo: repoName, pull_number } = args;
              const fullName = `${owner}/${repoName}`;
              const repoData = getRepoData(fullName);
              if (!repoData) {
                result = rpcSuccess(id, { content: [{ type: 'text', text: 'Repository not found' }], isError: true });
              } else {
                const mergeResult = mergePullRequest(repoData, pull_number);
                if (!mergeResult) {
                  result = rpcSuccess(id, { content: [{ type: 'text', text: 'Pull request not found or cannot be merged' }], isError: true });
                } else {
                  result = rpcSuccess(id, { content: [{ type: 'text', text: JSON.stringify(mergeResult, null, 2) }] });
                }
              }
              break;
            }
            
            default: {
              result = rpcError(id, -32601, `Method not found: ${toolName}`);
              break;
            }
          }
          break;
        }
        
        default: {
          result = rpcError(id, -32601, `Method not found: ${method}`);
          break;
        }
      }
      
      if (result) responses.push(result);
      
    } catch (err) {
      responses.push(rpcError(id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  
  // Return array for batch, single object for single request
  const responseBody = Array.isArray(body) ? responses : responses[0];
  sendJson(res, 200, responseBody);
  return true;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}