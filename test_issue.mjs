// Test script to start server and test issue creation

import { spawn } from 'node:child_process';

async function runTest() {
  console.log('Starting server...');
  
  const server = spawn('node', ['--experimental-strip-types', 'src/main.ts'], {
    env: { 
      ...process.env, 
      MAKEFUN_ENV_URL: 'http://localhost:8080',
      MAKEFUN_SHOP_TOKEN: 'test-token'
    },
    cwd: '/root/makefun-gitforge',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  
  server.stdout.on('data', (data) => {
    console.log('STDOUT:', data.toString().trim());
  });
  
  server.stderr.on('data', (data) => {
    console.log('STDERR:', data.toString().trim());
  });
  
  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Find port using Node.js - get the port from the server's stdout
  const { execSync } = await import('node:child_process');
  let portOutput;
  try {
    // Wait a bit more for server to fully start
    await new Promise(resolve => setTimeout(resolve, 1000));
    const output = execSync('ss -tlnp | grep "node" | grep -v grep | grep -v ":33403" | grep -v ":33643" | tail -1', { encoding: 'utf8' });
    // Parse port from output like: LISTEN 0 511 *:33643 *:* users:(("node",pid=305525,fd=21))
    const match = output.match(/:(\d+)\s/);
    portOutput = match ? match[1] : '';
  } catch {
    portOutput = '';
  }
  
  const port = portOutput.trim();
  console.log('Port:', port);
  
  if (!port) {
    console.log('Could not find port');
    server.kill();
    process.exit(1);
  }
  
  // Test health
  const health = await fetch(`http://localhost:${port}/healthz`);
  console.log('Health:', await health.json());
  
  // Create repo
  const repoRes = await fetch(`http://localhost:${port}/api/v3/user/repos`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: 'test-repo-12', description: 'Test repo 12', private: false })
  });
  console.log('Create repo:', repoRes.status, await repoRes.json());
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Create issue
  const issueRes = await fetch(`http://localhost:${port}/api/v3/repos/testuser/test-repo-12/issues`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ title: 'Test Issue', body: 'This is a test issue' })
  });
  console.log('Create issue:', issueRes.status, await issueRes.json());
  
  server.kill();
}

runTest().catch(console.error);