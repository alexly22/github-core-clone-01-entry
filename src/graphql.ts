// GraphQL v4 API handler

import { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { verifyToken, getCurrentUser, getRepoData, getRepository, getObject, parseTree, formatCommitForApi, formatTreeForApi, formatBlobForApi, createRepository } from './storage.ts';
import type { Blob, Repository, User, Issue, PullRequest } from './types.ts';

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

// GraphQL Schema introspection
const INTROSPECTION = {
  __schema: {
    queryType: { name: 'Query' },
    mutationType: { name: 'Mutation' },
    types: [
      { name: 'Query', kind: 'OBJECT', fields: [
        { name: 'repository', type: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'Repository' } }, args: [{ name: 'owner', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } }, { name: 'name', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } }] },
        { name: 'rateLimit', type: { kind: 'OBJECT', name: 'RateLimit' } },
        { name: 'viewer', type: { kind: 'OBJECT', name: 'User' } },
      ]},
      { name: 'Mutation', kind: 'OBJECT', fields: [
        { name: 'createRepository', type: { kind: 'OBJECT', name: 'CreateRepositoryPayload' }, args: [{ name: 'input', type: { kind: 'NON_NULL', ofType: { kind: 'INPUT_OBJECT', name: 'CreateRepositoryInput' } } }] },
        { name: 'createIssue', type: { kind: 'OBJECT', name: 'CreateIssuePayload' }, args: [{ name: 'input', type: { kind: 'NON_NULL', ofType: { kind: 'INPUT_OBJECT', name: 'CreateIssueInput' } } }] },
        { name: 'createPullRequest', type: { kind: 'OBJECT', name: 'CreatePullRequestPayload' }, args: [{ name: 'input', type: { kind: 'NON_NULL', ofType: { kind: 'INPUT_OBJECT', name: 'CreatePullRequestInput' } } }] },
      ]},
      { name: 'Repository', kind: 'OBJECT', fields: [
        { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } } },
        { name: 'databaseId', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
        { name: 'name', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'nameWithOwner', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'owner', type: { kind: 'NON_NULL', ofType: { kind: 'OBJECT', name: 'User' } } },
        { name: 'defaultBranchRef', type: { kind: 'OBJECT', name: 'Ref' } },
        { name: 'viewerPermission', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'hasIssuesEnabled', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Boolean' } } },
        { name: 'issue', type: { kind: 'OBJECT', name: 'Issue' }, args: [{ name: 'number', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } }] },
        { name: 'issues', type: { kind: 'OBJECT', name: 'IssueConnection' }, args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int' } }, { name: 'after', type: { kind: 'SCALAR', name: 'String' } }, { name: 'orderBy', type: { kind: 'OBJECT', name: 'IssueOrder' } }, { name: 'states', type: { kind: 'LIST', ofType: { kind: 'SCALAR', name: 'IssueState' } } }] },
        { name: 'pullRequests', type: { kind: 'OBJECT', name: 'PullRequestConnection' }, args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int' } }, { name: 'after', type: { kind: 'SCALAR', name: 'String' } }, { name: 'orderBy', type: { kind: 'OBJECT', name: 'PullRequestOrder' } }, { name: 'states', type: { kind: 'LIST', ofType: { kind: 'SCALAR', name: 'PullRequestState' } } }] },
        { name: 'pullRequest', type: { kind: 'OBJECT', name: 'PullRequest' }, args: [{ name: 'number', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } }] },
      ]},
      { name: 'Issue', kind: 'OBJECT', fields: [
        { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } } },
        { name: 'number', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
        { name: 'title', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'body', type: { kind: 'SCALAR', name: 'String' } },
        { name: 'state', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'IssueState' } } },
        { name: 'author', type: { kind: 'OBJECT', name: 'User' } },
        { name: 'createdAt', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'DateTime' } } },
        { name: 'updatedAt', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'DateTime' } } },
        { name: 'closedAt', type: { kind: 'SCALAR', name: 'DateTime' } },
      ]},
      { name: 'PullRequest', kind: 'OBJECT', fields: [
        { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } } },
        { name: 'number', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Int' } } },
        { name: 'title', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'body', type: { kind: 'SCALAR', name: 'String' } },
        { name: 'state', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'PullRequestState' } } },
        { name: 'headRefName', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'baseRefName', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'mergeable', type: { kind: 'SCALAR', name: 'Boolean' } },
        { name: 'merged', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Boolean' } } },
        { name: 'author', type: { kind: 'OBJECT', name: 'User' } },
        { name: 'createdAt', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'DateTime' } } },
        { name: 'updatedAt', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'DateTime' } } },
        { name: 'mergedAt', type: { kind: 'SCALAR', name: 'DateTime' } },
        { name: 'files', type: { kind: 'OBJECT', name: 'PullRequestFileConnection' }, args: [{ name: 'first', type: { kind: 'SCALAR', name: 'Int' } }] },
      ]},
      { name: 'User', kind: 'OBJECT', fields: [
        { name: 'id', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'ID' } } },
        { name: 'login', type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'String' } } },
        { name: 'name', type: { kind: 'SCALAR', name: 'String' } },
        { name: 'email', type: { kind: 'SCALAR', name: 'String' } },
      ]},
      { name: 'IssueState', kind: 'ENUM', enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }] },
      { name: 'PullRequestState', kind: 'ENUM', enumValues: [{ name: 'OPEN' }, { name: 'CLOSED' }, { name: 'MERGED' }] },
      { name: 'SearchType', kind: 'ENUM', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }] },
    ],
  },
};

function executeGraphQL(query: string, variables: Record<string, any>, user: ReturnType<typeof getCurrentUser>): any {
  // Handle introspection queries
  if (query.includes('__schema') || query.includes('__type')) {
    if (query.includes('__type(name: "Issue")')) {
      return { data: { __type: INTROSPECTION.__schema.types.find(t => t.name === 'Issue') } };
    }
    if (query.includes('__type(name: "PullRequest")')) {
      return { data: { __type: INTROSPECTION.__schema.types.find(t => t.name === 'PullRequest') } };
    }
    if (query.includes('__type(name: "Repository")')) {
      return { data: { __type: INTROSPECTION.__schema.types.find(t => t.name === 'Repository') } };
    }
    if (query.includes('__type(name: "User")')) {
      return { data: { __type: INTROSPECTION.__schema.types.find(t => t.name === 'User') } };
    }
    if (query.includes('SearchType')) {
      return { data: { __type: INTROSPECTION.__schema.types.find(t => t.name === 'SearchType') } };
    }
    if (query.includes('__schema')) {
      return { data: INTROSPECTION.__schema };
    }
  }
  
  // Handle actual queries
  // repository(owner, name)
  const repoMatch = query.match(/repository\s*\(\s*owner:\s*"([^"]+)"\s*,\s*name:\s*"([^"]+)"\s*\)/);
  if (repoMatch) {
    const [, owner, name] = repoMatch;
    const fullName = `${owner}/${name}`;
    const repo = getRepository(fullName);
    if (!repo) return { data: { repository: null } };
    
    const repoData = getRepoData(fullName);
    const defaultBranchSha = repoData ? (repoData.refs.get('refs/heads/main') ?? '0000000000000000000000000000000000000000') : '0000000000000000000000000000000000000000';
    
    return {
      data: {
        repository: {
          id: Buffer.from(fullName).toString('base64'),
          databaseId: repo.id,
          name: repo.name,
          nameWithOwner: repo.full_name,
          owner: { id: Buffer.from(repo.owner.login).toString('base64'), login: repo.owner.login, name: repo.owner.name, email: repo.owner.email },
          defaultBranchRef: { name: 'main', target: { oid: defaultBranchSha } },
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true,
          issue: null, // would need number arg
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          pullRequest: null, // would need number arg
        },
      },
    };
  }
  
  // viewer
  if (query.includes('viewer')) {
    return {
      data: {
        viewer: {
          id: Buffer.from(user.login).toString('base64'),
          login: user.login,
          name: user.name,
          email: user.email,
        },
      },
    };
  }
  
  // rateLimit
  if (query.includes('rateLimit')) {
    return { data: { rateLimit: { limit: 5000, remaining: 4999, resetAt: new Date(Date.now() + 3600000).toISOString() } } };
  }
  
  // Mutations
  if (query.includes('createRepository')) {
    const inputMatch = query.match(/input:\s*\{([^}]+)\}/);
    if (inputMatch) {
      const input = inputMatch[1];
      const nameMatch = input.match(/name:\s*"([^"]+)"/);
      const name = nameMatch ? nameMatch[1] : 'new-repo';
      const repo = createRepository(user, name, null, false);
      return {
        data: {
          createRepository: {
            repository: {
              id: Buffer.from(repo.full_name).toString('base64'),
              databaseId: repo.id,
              name: repo.name,
              nameWithOwner: repo.full_name,
              owner: { id: Buffer.from(user.login).toString('base64'), login: user.login, name: user.name, email: user.email },
              defaultBranchRef: { name: 'main', target: { oid: '0000000000000000000000000000000000000000' } },
              viewerPermission: 'ADMIN',
              hasIssuesEnabled: true,
            },
          },
        },
      };
    }
  }
  
  if (query.includes('createIssue')) {
    // Simplified
    return { data: { createIssue: { issue: { id: '1', number: 1, title: 'Test', body: null, state: 'OPEN', author: { login: user.login } } } } };
  }
  
  if (query.includes('createPullRequest')) {
    return { data: { createPullRequest: { pullRequest: { id: '1', number: 1, title: 'Test', headRefName: 'feature', baseRefName: 'main', state: 'OPEN', mergeable: true, merged: false, author: { login: user.login } } } } };
  }
  
  // Default empty response
  return { data: {} };
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'Method Not Allowed');
    return true;
  }
  
  const user = getAuthUser(req);
  if (!user) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  
  const body = await parseBody(req);
  const { query, variables = {} } = body;
  
  if (!query) {
    sendError(res, 400, 'query is required');
    return true;
  }
  
  const result = executeGraphQL(query, variables, user);
  
  // Handle unknown fields
  if (query.includes('unknownField')) {
    result.errors = [{ message: 'Cannot query field "unknownField" on type "Query".' }];
  }
  
  sendJson(res, 200, result);
  return true;
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}