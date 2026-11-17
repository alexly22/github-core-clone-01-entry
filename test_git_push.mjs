// Test git push (receive-pack)

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
    body: JSON.stringify({ name: 'git-push-test-2', description: 'Git push test 2', private: false })
  });
  console.log('Create repo:', repoRes.status, await repoRes.json());
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Test git receive-pack (push) - create a simple commit
  console.log('\n--- Testing git receive-pack (push) ---');
  
  // Create a blob object
  const blobContent = 'Hello, World!\n';
  const blobHeader = `blob ${blobContent.length}\0`;
  const blobData = Buffer.concat([Buffer.from(blobHeader), Buffer.from(blobContent)]);
  const blobSha = require('crypto').createHash('sha1').update(blobData).digest('hex');
  console.log('Blob SHA:', blobSha);
  
  // Create a tree object
  const treeEntry = `100644 file.txt\0` + Buffer.from(blobSha, 'hex');
  const treeHeader = `tree ${treeEntry.length}\0`;
  const treeData = Buffer.concat([Buffer.from(treeHeader), treeEntry]);
  const treeSha = require('crypto').createHash('sha1').update(treeData).digest('hex');
  console.log('Tree SHA:', treeSha);
  
  // Create a commit object
  const commitContent = `tree ${treeSha}\nauthor Test User <test@example.com> ${Math.floor(Date.now()/1000)} +0000\ncommitter Test User <test@example.com> ${Math.floor(Date.now()/1000)} +0000\n\nInitial commit\n`;
  const commitHeader = `commit ${commitContent.length}\0`;
  const commitData = Buffer.concat([Buffer.from(commitHeader), Buffer.from(commitContent)]);
  const commitSha = require('crypto').createHash('sha1').update(commitData).digest('hex');
  console.log('Commit SHA:', commitSha);
  
  // Create a simple pack file with the commit
  // This is a minimal pack - in reality we'd need all objects
  const packReq = `0000000000000000000000000000000000000000 ${commitSha} refs/heads/main\n0000`;
  
  const pushRes = await fetch(`${baseUrl}/testuser/git-push-test-2.git/git-receive-pack`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-git-receive-pack-request',
      'Authorization': 'Bearer test-token'
    },
    body: packReq
  });
  console.log('git-receive-pack status:', pushRes.status);
  const pushBody = await pushRes.text();
  console.log('Response:', pushBody);
  
  server.kill();
}

runTest().catch(console.error);