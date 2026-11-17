// Test git fetch and push

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
  
  // Find port
  const { execSync } = await import('node:child_process');
  let portOutput;
  try {
    const output = execSync('ss -tlnp | grep "node" | grep -v grep | grep -v ":33403" | grep -v ":33643" | tail -1', { encoding: 'utf8' });
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
  
  const baseUrl = `http://localhost:${port}`;
  
  // Test health
  const health = await fetch(`${baseUrl}/healthz`);
  console.log('Health:', await health.json());
  
  // Create repo
  const repoRes = await fetch(`${baseUrl}/api/v3/user/repos`, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer test-token',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name: 'git-push-test', description: 'Git push test', private: false })
  });
  console.log('Create repo:', repoRes.status, await repoRes.json());
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test git upload-pack (fetch) - v0
  console.log('\n--- Testing git upload-pack (fetch) ---');
  const fetchReq = `want 0000000000000000000000000000000000000000\n0000`;
  const fetchRes = await fetch(`${baseUrl}/testuser/git-push-test.git/git-upload-pack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-git-upload-pack-request',
      'Authorization': 'Bearer test-token'
    },
    body: fetchReq
  });
  console.log('git-upload-pack status:', fetchRes.status);
  const fetchBody = await fetchRes.arrayBuffer();
  console.log('Response size:', fetchBody.byteLength, 'bytes');
  console.log('First 200 bytes:', Buffer.from(fetchBody).slice(0, 200).toString('hex'));
  
  server.kill();
}

runTest().catch(console.error);