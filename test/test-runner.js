/**
 * Test Script for the Runner Service
 * 
 * This tests the runner locally using example.com as the target.
 * 
 * Usage:
 *   1. Start the runner: npm start
 *   2. In another terminal: npm test
 */

const http = require('http');

const RUNNER_URL = 'http://localhost:3001';
const CALLBACK_PORT = 3002;

// Start a simple callback server
const callbackServer = http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      
      console.log('\n' + '═'.repeat(60));
      console.log('📥 CALLBACK RECEIVED');
      console.log('═'.repeat(60));
      console.log(`Run ID: ${data.run_id}`);
      console.log(`Status: ${data.status}`);
      console.log(`Finished: ${data.finished_at}`);
      console.log(`Video URL: ${data.replay_video_url || 'None'}`);
      console.log('\nStep Results:');
      
      data.steps.forEach((step, i) => {
        const icon = step.status === 'passed' ? '✓' : '✗';
        console.log(`  ${icon} [${step.test_name}] ${step.step_name}: ${step.status}`);
        if (step.error) {
          console.log(`      Error: ${step.error}`);
        }
      });
      
      console.log('═'.repeat(60));
      
      res.writeHead(200);
      res.end('OK');
      
      // Exit after receiving final callback
      setTimeout(() => {
        console.log('\n✅ Test completed!');
        process.exit(data.status === 'passed' ? 0 : 1);
      }, 1000);
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

callbackServer.listen(CALLBACK_PORT, async () => {
  console.log(`\n📡 Callback server listening on port ${CALLBACK_PORT}`);
  
  // Test payload matching the schema
  const testPayload = {
    runId: `test-${Date.now()}`,
    environment: {
      name: 'Test Environment',
      powerapps_url: 'https://example.com'
    },
    suite: {
      name: 'Demo Test Suite',
      tests: [
        {
          id: 'demo-test-1',
          name: 'Verify Example.com Page',
          steps: [
            {
              action: 'wait',
              selector: 'h1',
              name: 'Wait for heading'
            },
            {
              action: 'assert_text',
              selector: 'h1',
              value: 'Example Domain',
              name: 'Verify page title'
            },
            {
              action: 'screenshot',
              name: 'example-page.png'
            },
            {
              action: 'click',
              selector: 'a',
              name: 'Click the link'
            }
          ]
        }
      ]
    },
    callbackUrl: `http://localhost:${CALLBACK_PORT}/callback`,
    artifacts: {
      recordVideo: false,
      screenshotOnFail: true
    }
  };

  console.log('\n📤 Sending test payload to runner...');
  console.log(`   Run ID: ${testPayload.runId}`);
  console.log(`   Target: ${testPayload.environment.powerapps_url}`);
  
  try {
    const response = await fetch(`${RUNNER_URL}/webhook/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log('\n✅ Runner acknowledged:', result);
    console.log('\n⏳ Waiting for test execution...\n');
    
  } catch (error) {
    console.error('\n❌ Failed to connect to runner:', error.message);
    console.log('\n💡 Make sure the runner is started with: npm start');
    process.exit(1);
  }
});

// Timeout after 2 minutes
setTimeout(() => {
  console.log('\n⏰ Test timed out after 2 minutes');
  process.exit(1);
}, 120000);
