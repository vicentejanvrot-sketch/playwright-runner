/**
 * Power Apps Regression Recorder - Runner Service v2.1
 * 
 * WITH VIDEO UPLOAD TO CLOUDINARY (Free)
 * 
 * Cloudinary free tier: 25GB storage + 25GB bandwidth/month
 */

const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Configuration
const PORT = process.env.PORT || 3001;
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS || '3');
const ARTIFACTS_DIR = path.join(__dirname, '../artifacts');

// Cloudinary Configuration
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Ensure artifacts directory exists
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// Track active runs
let activeRuns = 0;
const runQueue = [];

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType = 'video') {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.log('  ⚠️ Cloudinary not configured - skipping upload');
    return null;
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const fileBuffer = fs.readFileSync(filePath);
    const base64File = fileBuffer.toString('base64');
    const mimeType = resourceType === 'video' ? 'video/webm' : 'image/png';
    const dataUri = `data:${mimeType};base64,${base64File}`;

    // Create signature for authenticated upload
    const crypto = require('crypto');
    const signatureString = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(signatureString).digest('hex');

    // Upload to Cloudinary
    const formData = new URLSearchParams();
    formData.append('file', dataUri);
    formData.append('public_id', publicId);
    formData.append('timestamp', timestamp.toString());
    formData.append('api_key', CLOUDINARY_API_KEY);
    formData.append('signature', signature);

    const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
    
    console.log(`  📤 Uploading ${resourceType} to Cloudinary...`);
    
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`  ❌ Cloudinary upload failed: ${response.status} - ${error}`);
      return null;
    }

    const result = await response.json();
    console.log(`  ✓ Uploaded: ${result.secure_url}`);
    return result.secure_url;

  } catch (error) {
    console.error(`  ❌ Cloudinary upload error: ${error.message}`);
    return null;
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'playwright-runner',
    version: '2.1.0',
    activeRuns,
    maxConcurrent: MAX_CONCURRENT_RUNS,
    queueLength: runQueue.length,
    cloudinaryConfigured: !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET)
  });
});

app.post('/webhook/run', async (req, res) => {
  const payload = req.body;
  
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    return res.status(400).json({ 
      error: 'Invalid payload',
      details: errors 
    });
  }

  console.log(`\n📥 Received run request: ${payload.runId}`);
  console.log(`   Environment: ${payload.environment.name}`);
  console.log(`   Suite: ${payload.suite.name}`);
  console.log(`   Tests: ${payload.suite.tests.length}`);
  console.log(`   Record Video: ${payload.artifacts?.recordVideo}`);
  
  res.json({ 
    status: 'queued', 
    runId: payload.runId,
    queuePosition: runQueue.length + 1
  });

  runQueue.push(payload);
  processQueue();
});

app.post('/webhook/cancel/:runId', (req, res) => {
  const { runId } = req.params;
  
  const queueIndex = runQueue.findIndex(p => p.runId === runId);
  if (queueIndex >= 0) {
    runQueue.splice(queueIndex, 1);
    console.log(`🛑 Cancelled queued run: ${runId}`);
    return res.json({ status: 'cancelled', runId });
  }

  res.json({ status: 'not_found', runId });
});

// ============================================================
// VALIDATION
// ============================================================

function validatePayload(payload) {
  const errors = [];
  
  if (!payload.runId) errors.push('Missing: runId');
  if (!payload.environment) errors.push('Missing: environment');
  if (!payload.environment?.powerapps_url) errors.push('Missing: environment.powerapps_url');
  if (!payload.suite) errors.push('Missing: suite');
  if (!payload.suite?.tests || !Array.isArray(payload.suite.tests)) {
    errors.push('Missing or invalid: suite.tests');
  }
  if (!payload.callbackUrl) errors.push('Missing: callbackUrl');
  
  return errors;
}

// ============================================================
// QUEUE PROCESSING
// ============================================================

async function processQueue() {
  if (activeRuns >= MAX_CONCURRENT_RUNS || runQueue.length === 0) {
    return;
  }

  activeRuns++;
  const payload = runQueue.shift();
  
  try {
    await executeRun(payload);
  } catch (error) {
    console.error(`❌ Run ${payload.runId} failed:`, error.message);
    await sendCallback(payload.callbackUrl, {
      run_id: payload.runId,
      status: 'failed',
      finished_at: new Date().toISOString(),
      replay_video_url: null,
      steps: [{
        test_name: 'Runner Error',
        status: 'failed',
        error: error.message
      }]
    });
  } finally {
    activeRuns--;
    processQueue();
  }
}

// ============================================================
// TEST EXECUTION
// ============================================================

async function executeRun(payload) {
  const { runId, environment, suite, callbackUrl, artifacts } = payload;
  
  console.log(`\n🚀 Starting run: ${runId}`);
  const startTime = Date.now();
  
  // Create run-specific artifacts directory
  const runArtifactsDir = path.join(ARTIFACTS_DIR, runId);
  if (!fs.existsSync(runArtifactsDir)) {
    fs.mkdirSync(runArtifactsDir, { recursive: true });
  }

  // Configure browser context
  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true
  };

  // ENABLE VIDEO RECORDING
  const shouldRecordVideo = artifacts?.recordVideo !== false;
  if (shouldRecordVideo) {
    console.log('  📹 Video recording ENABLED');
    contextOptions.recordVideo = {
      dir: runArtifactsDir,
      size: { width: 1920, height: 1080 }
    };
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const results = {
    run_id: runId,
    status: 'passed',
    finished_at: null,
    replay_video_url: null,
    steps: []
  };

  let videoPath = null;

  try {
    // Navigate to target URL
    console.log(`📍 Navigating to: ${environment.powerapps_url}`);
    await page.goto(environment.powerapps_url, { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });

    // Wait for page to load
    await waitForPowerAppsLoad(page);

    // Execute each test in the suite
    for (const test of suite.tests) {
      console.log(`\n  📋 Running test: ${test.name}`);
      
      const testResult = await executeTest(page, test, {
        screenshotOnFail: artifacts?.screenshotOnFail,
        artifactsDir: runArtifactsDir,
        runId
      });

      results.steps.push(...testResult.steps);

      if (testResult.status === 'failed') {
        results.status = 'failed';
      }
    }

  } catch (error) {
    console.error(`❌ Execution error:`, error.message);
    results.status = 'failed';
    results.steps.push({
      test_name: 'Execution Error',
      step_name: 'Browser Error',
      status: 'failed',
      error: error.message
    });

    // Capture failure screenshot
    if (artifacts?.screenshotOnFail) {
      try {
        const screenshotPath = path.join(runArtifactsDir, 'error-screenshot.png');
        await page.screenshot({ path: screenshotPath, fullPage: true });
        
        const screenshotUrl = await uploadToCloudinary(
          screenshotPath, 
          `regression-tests/${runId}/error-screenshot`,
          'image'
        );
        if (screenshotUrl) {
          results.steps[results.steps.length - 1].screenshot_url = screenshotUrl;
        }
      } catch (e) {
        console.log('Could not capture error screenshot');
      }
    }
  }

  // IMPORTANT: Close page first to finalize video
  await page.close();
  
  // Wait for video file to be written
  if (shouldRecordVideo) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Find the video file
    const videoFiles = fs.readdirSync(runArtifactsDir).filter(f => f.endsWith('.webm'));
    if (videoFiles.length > 0) {
      videoPath = path.join(runArtifactsDir, videoFiles[0]);
      console.log(`  📹 Video saved locally: ${videoPath}`);
      console.log(`  📹 Video size: ${(fs.statSync(videoPath).size / 1024 / 1024).toFixed(2)} MB`);
    }
  }

  await context.close();
  await browser.close();

  // UPLOAD VIDEO TO CLOUDINARY
  if (videoPath && fs.existsSync(videoPath)) {
    console.log('  📤 Uploading video to Cloudinary...');
    const videoUrl = await uploadToCloudinary(
      videoPath,
      `regression-tests/${runId}/replay`,
      'video'
    );
    results.replay_video_url = videoUrl;
  } else {
    console.log('  ⚠️ No video file found to upload');
  }

  // Upload failure screenshots
  const screenshotFiles = fs.readdirSync(runArtifactsDir).filter(f => f.endsWith('.png'));
  for (const screenshotFile of screenshotFiles) {
    const screenshotPath = path.join(runArtifactsDir, screenshotFile);
    const screenshotName = screenshotFile.replace('.png', '');
    await uploadToCloudinary(
      screenshotPath, 
      `regression-tests/${runId}/${screenshotName}`,
      'image'
    );
  }

  // Cleanup local artifacts
  try {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
    console.log('  🧹 Cleaned up local artifacts');
  } catch (e) {
    // Ignore cleanup errors
  }

  results.finished_at = new Date().toISOString();
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Run ${runId} completed: ${results.status} (${duration}s)`);
  console.log(`   Video URL: ${results.replay_video_url || 'None'}`);

  // Send callback with results
  await sendCallback(callbackUrl, results);
  
  return results;
}

/**
 * Wait for Power Apps to fully load
 */
async function waitForPowerAppsLoad(page) {
  try {
    await page.waitForSelector('[class*="appLoadingSpinner"]', { 
      state: 'hidden', 
      timeout: 30000 
    }).catch(() => {});

    await page.waitForSelector('[data-control-name], .powerapps-app, [class*="appContainer"]', {
      state: 'visible',
      timeout: 30000
    }).catch(() => {});

    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log('  ✓ Page loaded');
  } catch (error) {
    console.log('  ⚠️ Page load detection timed out, continuing...');
  }
}

/**
 * Execute a single test
 */
async function executeTest(page, test, options) {
  const result = {
    status: 'passed',
    steps: []
  };

  const steps = test.steps || [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepResult = await executeStep(page, step, {
      ...options,
      testName: test.name,
      stepIndex: i + 1
    });

    result.steps.push({
      test_name: test.name,
      step_name: step.name || step.description || `Step ${i + 1}`,
      step_index: i + 1,
      action: step.action,
      ...stepResult
    });

    if (stepResult.status === 'failed') {
      result.status = 'failed';
      
      // Capture and upload failure screenshot
      if (options.screenshotOnFail) {
        try {
          const screenshotName = `${test.id || test.name}-step${i + 1}-failure.png`;
          const screenshotPath = path.join(options.artifactsDir, screenshotName);
          await page.screenshot({ path: screenshotPath, fullPage: true });
          
          const screenshotUrl = await uploadToCloudinary(
            screenshotPath,
            `regression-tests/${options.runId}/${test.id || test.name}-step${i + 1}-failure`,
            'image'
          );
          if (screenshotUrl) {
            result.steps[result.steps.length - 1].screenshot_url = screenshotUrl;
          }
        } catch (e) {
          console.log('Could not capture step failure screenshot');
        }
      }

      break;
    }
  }

  return result;
}

/**
 * Execute a single step
 */
async function executeStep(page, step, options) {
  const result = {
    status: 'passed',
    started_at: new Date().toISOString(),
    error: null
  };

  const timeout = step.timeout || 30000;

  try {
    switch (step.action?.toLowerCase()) {
      case 'click':
        await performClick(page, step, timeout);
        break;

      case 'doubleclick':
      case 'double_click':
        await performDoubleClick(page, step, timeout);
        break;

      case 'rightclick':
      case 'right_click':
        await performRightClick(page, step, timeout);
        break;

      case 'fill':
      case 'type':
      case 'input':
      case 'text_input':
        await performFill(page, step, timeout);
        break;

      case 'clear':
        await page.locator(step.selector).clear({ timeout });
        break;

      case 'select':
      case 'dropdown':
      case 'select_option':
        await performSelect(page, step, timeout);
        break;

      case 'wait':
      case 'wait_for_element':
        await performWait(page, step, timeout);
        break;

      case 'wait_for_text':
        await page.waitForSelector(`text=${step.value}`, { 
          state: 'visible', 
          timeout 
        });
        break;

      case 'wait_for_navigation':
        await page.waitForNavigation({ timeout });
        break;

      case 'navigate':
      case 'goto':
        await page.goto(step.url || step.value, { 
          waitUntil: 'networkidle', 
          timeout 
        });
        break;

      case 'reload':
      case 'refresh':
        await page.reload({ waitUntil: 'networkidle', timeout });
        break;

      case 'back':
        await page.goBack({ timeout });
        break;

      case 'forward':
        await page.goForward({ timeout });
        break;

      case 'assert':
      case 'verify':
      case 'check_visibility':
        await performAssertion(page, step, timeout);
        break;

      case 'assert_text':
      case 'verify_text':
        await performTextAssertion(page, step, timeout);
        break;

      case 'press':
      case 'key':
      case 'keyboard':
        await page.keyboard.press(step.key || step.value);
        break;

      case 'hover':
        await page.hover(step.selector, { timeout });
        break;

      case 'scroll':
      case 'scroll_to':
        await performScroll(page, step, timeout);
        break;

      case 'screenshot':
        const screenshotPath = path.join(
          options.artifactsDir,
          step.name || `${options.testName}-step${options.stepIndex}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: step.fullPage !== false });
        break;

      default:
        console.log(`    ⚠️ Unknown action: ${step.action}`);
    }

    console.log(`    ✓ ${step.action}: ${step.selector || step.control_name || step.value || ''}`);

  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    console.log(`    ✗ ${step.action} failed: ${error.message}`);
  }

  result.finished_at = new Date().toISOString();
  return result;
}

// ============================================================
// STEP IMPLEMENTATIONS
// ============================================================

async function performClick(page, step, timeout) {
  const locator = getLocator(page, step);
  await locator.click({ timeout });
  await waitForStabilize(page);
}

async function performDoubleClick(page, step, timeout) {
  const locator = getLocator(page, step);
  await locator.dblclick({ timeout });
  await waitForStabilize(page);
}

async function performRightClick(page, step, timeout) {
  const locator = getLocator(page, step);
  await locator.click({ button: 'right', timeout });
}

async function performFill(page, step, timeout) {
  const locator = getLocator(page, step);
  
  if (step.clear !== false) {
    await locator.clear({ timeout });
  }
  
  await locator.fill(step.value || step.text || '', { timeout });
  await waitForStabilize(page);
}

async function performSelect(page, step, timeout) {
  const locator = getLocator(page, step);
  
  try {
    await locator.selectOption(step.value, { timeout: 5000 });
  } catch (e) {
    await locator.click({ timeout });
    await page.waitForTimeout(500);
    const optionLocator = page.getByText(step.value, { exact: step.exact });
    await optionLocator.click({ timeout });
  }
  
  await waitForStabilize(page);
}

async function performWait(page, step, timeout) {
  if (step.selector) {
    const state = step.state || 'visible';
    await page.waitForSelector(step.selector, { state, timeout });
  } else if (step.duration || step.value) {
    const ms = parseInt(step.duration || step.value);
    await page.waitForTimeout(ms);
  } else {
    await page.waitForLoadState('networkidle', { timeout });
  }
}

async function performAssertion(page, step, timeout) {
  const type = step.type || step.assertion_type || 'visible';
  const locator = getLocator(page, step);

  switch (type) {
    case 'visible':
      await locator.waitFor({ state: 'visible', timeout });
      break;
    case 'hidden':
    case 'not_visible':
      await locator.waitFor({ state: 'hidden', timeout });
      break;
    case 'exists':
      await locator.waitFor({ state: 'attached', timeout });
      break;
    case 'not_exists':
      await locator.waitFor({ state: 'detached', timeout });
      break;
    default:
      await locator.waitFor({ state: 'visible', timeout });
  }
}

async function performTextAssertion(page, step, timeout) {
  const locator = getLocator(page, step);
  const text = await locator.textContent({ timeout });
  const expected = step.expected || step.value;

  if (step.exact) {
    if (text !== expected) {
      throw new Error(`Expected text "${expected}" but found "${text}"`);
    }
  } else {
    if (!text.includes(expected)) {
      throw new Error(`Expected text to contain "${expected}" but found "${text}"`);
    }
  }
}

async function performScroll(page, step, timeout) {
  if (step.selector) {
    const locator = getLocator(page, step);
    await locator.scrollIntoViewIfNeeded({ timeout });
  } else if (step.x !== undefined || step.y !== undefined) {
    await page.evaluate(({ x, y }) => window.scrollTo(x || 0, y || 0), { 
      x: step.x, 
      y: step.y 
    });
  } else if (step.direction) {
    const amount = step.amount || 300;
    await page.evaluate(({ dir, amt }) => {
      if (dir === 'down') window.scrollBy(0, amt);
      else if (dir === 'up') window.scrollBy(0, -amt);
      else if (dir === 'right') window.scrollBy(amt, 0);
      else if (dir === 'left') window.scrollBy(-amt, 0);
    }, { dir: step.direction, amt: amount });
  }
}

// ============================================================
// LOCATOR HELPERS
// ============================================================

function getLocator(page, step) {
  if (step.selector) {
    return page.locator(step.selector);
  }
  
  if (step.control_name) {
    return page.locator(`[data-control-name="${step.control_name}"]`);
  }
  
  if (step.text) {
    return page.getByText(step.text, { exact: step.exact });
  }
  
  if (step.aria_label) {
    return page.getByLabel(step.aria_label);
  }
  
  if (step.placeholder) {
    return page.getByPlaceholder(step.placeholder);
  }
  
  if (step.role) {
    return page.getByRole(step.role, { name: step.name });
  }

  throw new Error('No valid locator provided');
}

async function waitForStabilize(page) {
  await page.waitForTimeout(300);
  
  try {
    await page.waitForSelector('[class*="Spinner"], [class*="loading"], [class*="busy"]', {
      state: 'hidden',
      timeout: 10000
    });
  } catch (e) {
    // No spinner found
  }
}

// ============================================================
// CALLBACK
// ============================================================

async function sendCallback(callbackUrl, payload) {
  console.log(`\n📤 Sending callback to: ${callbackUrl}`);
  console.log(`   Status: ${payload.status}`);
  console.log(`   Video URL: ${payload.replay_video_url || 'None'}`);
  console.log(`   Steps: ${payload.steps.length}`);

  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`   ⚠️ Callback failed: ${response.status} ${response.statusText}`);
    } else {
      console.log(`   ✓ Callback sent successfully`);
    }
  } catch (error) {
    console.error(`   ❌ Callback error:`, error.message);
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║  🎭 Power Apps Regression Runner v2.1                         ║
║     WITH VIDEO UPLOAD TO CLOUDINARY                           ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Port: ${PORT}                                                  ║
║  Max Concurrent Runs: ${MAX_CONCURRENT_RUNS}                                        ║
║                                                               ║
║  Cloudinary: ${CLOUDINARY_CLOUD_NAME ? '✓ Configured' : '✗ Not configured'}                            
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /health             - Health check                    ║
║    POST /webhook/run        - Execute test run                ║
║    POST /webhook/cancel/:id - Cancel a run                    ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
  
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    console.log('⚠️  WARNING: Cloudinary not configured!');
    console.log('   Videos will NOT be uploaded.');
    console.log('   Set these environment variables:');
    console.log('   - CLOUDINARY_CLOUD_NAME');
    console.log('   - CLOUDINARY_API_KEY');
    console.log('   - CLOUDINARY_API_SECRET');
    console.log('');
  }
});

module.exports = app;
