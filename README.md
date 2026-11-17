# GitHub-compatible Git Forge

A standalone, GitHub-compatible git forge written in TypeScript. Runs as a single Node.js process serving:
- Git smart HTTP (v2 upload-pack, v0 receive-pack)
- REST API v3 (repositories, issues, pull requests, contents)
- GraphQL API v4
- MCP (Model Context Protocol) endpoint

Built for the [make.fun "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01).

## Badges

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/alexly22/github-core-clone-01-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/alexly22/github-core-clone-01-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

## Features

- **Git smart HTTP v2**: Full upload-pack/receive-pack protocol support
- **REST API v3**: Repositories, issues, pull requests, contents, labels, refs
- **GraphQL v4**: Full schema with introspection, matches GitHub's API
- **MCP**: Model Context Protocol endpoint with 6 tools
- **Single process**: No external dependencies, runs in sandbox
- **Performance**: Optimized for push, clone, read, write workloads

## Run

```bash
node --experimental-strip-types src/main.ts
```

The server binds an ephemeral port, registers with the grading environment, and serves requests until the environment signals completion.

## Architecture

```
src/
├── main.ts          # Entry point: lifecycle (bind, register, wait for done)
├── app.ts           # HTTP router: git-http, REST, GraphQL, MCP
├── storage.ts       # In-memory git object store + REST/GraphQL data
├── git-protocol.ts  # Git smart HTTP (pkt-line, pack files, capabilities)
├── git-http.ts      # Git smart HTTP handlers (info/refs, upload-pack, receive-pack)
├── rest.ts          # REST v3 API handlers
├── graphql.ts       # GraphQL v4 handlers (introspection + queries)
└── mcp.ts           # MCP (JSON-RPC 2.0 over Streamable HTTP)
```

## Requirements

- Node.js 22.18+
- No external dependencies at runtime
- No `git` binary required

## License

MIT
