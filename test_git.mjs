// Test git smart HTTP endpoints

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
    body: JSON.stringify({ name: 'git-test-repo', description: 'Git test repo', private: false })
  });
  console.log('Create repo:', repoRes.status, await repoRes.json());
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test git smart HTTP - info/refs (v2)
  console.log('\n--- Testing git smart HTTP ---');
  
  const infoRefsV2 = await fetch(`${baseUrl}/testuser/git-test-repo.git/info/refs?service=git-upload-pack`, {
    headers: {
      'Git-Protocol': 'version=2',
      'Authorization': 'Bearer test-token'
    }
  });
  console.log('info/refs v2 status:', infoRefsV2.status);
  const v2Body = await infoRefsV2.text();
  console.log('info/refs v2 body (first 500):', v2Body.slice(0, 500));
  
  // Test git smart HTTP - info/refs (v0)
  const infoRefsV0 = await fetch(`${baseUrl}/testuser/git-test-repo.git/info/refs?service=git-upload-pack`, {
    headers: {
      'Authorization': 'Bearer test-token'
    }
  });
  console.log('\ninfo/refs v0 status:', infoRefsV0.status);
  const v0Body = await infoRefsV0.text();
  console.log('info/refs v0 body (first 500):', v0Body.slice(0, 500));
  
  // Test receive-pack info/refs
  const receiveRefs = await fetch(`${baseUrl}/testuser/git-test-repo.git/info/refs?service=git-receive-pack`, {
    headers: {
      'Authorization': 'Bearer test-token'
    }
  });
  console.log('\nreceive-pack info/refs status:', receiveRefs.status);
  const receiveBody = await receiveRefs.text();
  console.log('receive-pack body (first 500):', receiveBody.slice(0, 500));
  
  server.kill();
}

runTest().catch(console.error);