/**
 * Power Apps Regression Recorder - Runner Service v2.4
 * 
 * Uses Cloudinary SDK for automatic signature handling
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
const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

// Initialize Cloudinary
let cloudinary = null;
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
  console.log('✓ Cloudinary SDK initialized');
}

// Ensure artifacts directory exists
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// Track active runs
let activeRuns = 0;
const runQueue = [];

// ============================================================
// CLOUDINARY UPLOAD - USING SDK
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType = 'video') {
  console.log(`\n  📤 CLOUDINARY UPLOAD`);
  console.log(`     File: ${filePath}`);
  console.log(`     Public ID: ${publicId}`);

  if (!cloudinary) {
    console.log('  ❌ Cloudinary not configured!');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    console.log(`  ❌ File does not exist`);
    return null;
  }

  const stats = fs.statSync(filePath);
  console.log(`     File size: ${(stats.size / 1024).toFixed(2)} KB`);

  if (stats.size < 1000) {
    console.log(`  ❌ File too small`);
    return null;
  }

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true
    });

    console.log(`  ✅ Upload SUCCESS!`);
    console.log(`     URL: ${result.secure_url}`);
    return result.secure_url;

  } catch (error) {
    console.error(`  ❌ Upload error: ${error.message}`);
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
    version: '2.4.0',
    activeRuns,
    maxConcurrent: MAX_CONCURRENT_RUNS,
    queueLength: runQueue.length,
    cloudinaryConfigured: !!cloudinary
  });
});

app.post('/webhook/run', async (req, res) => {
  const payload = req.body;
  
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📥 RECEIVED RUN REQUEST`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   Run ID: ${payload.runId}`);
  console.log(`   Environment: ${payload.environment.name}`);
  console.log(`   Suite: ${payload.suite.name}`);
  console.log(`   Tests: ${payload.suite.tests.length}`);
  
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
  if (activeRuns >= MAX_CONCURRENT_RUNS || runQueue.length === 0) return;

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
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 STARTING RUN: ${runId}`);
  console.log(`${'='.repeat(60)}`);
  
  const startTime = Date.now();
  
  // Create run-specific artifacts directory
  const runArtifactsDir = path.join(ARTIFACTS_DIR, runId);
  if (fs.existsSync(runArtifactsDir)) {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runArtifactsDir, { recursive: true });

  const shouldRecordVideo = artifacts?.recordVideo !== false;
  
  // Browser context options
  const contextOptions = {
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  };

  if (shouldRecordVideo) {
    console.log('📹 Video recording ENABLED');
    contextOptions.recordVideo = {
      dir: runArtifactsDir,
      size: { width: 1280, height: 720 }
    };
  }

  // Launch browser
  console.log('🌐 Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
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

  try {
    // Navigate to target URL
    console.log(`📍 Navigating to: ${environment.powerapps_url}`);
    await page.goto(environment.powerapps_url, { 
      waitUntil: 'load',
      timeout: 60000 
    });
    console.log('✓ Page loaded');

    // Wait for Power Apps to fully load
    console.log('⏳ Waiting for Power Apps to initialize...');
    await page.waitForTimeout(5000);
    
    // Try to wait for loading spinner to disappear
    try {
      await page.waitForSelector('[class*="spinner"], [class*="loading"]', { 
        state: 'hidden', 
        timeout: 10000 
      });
    } catch (e) {
      // No spinner found, continue
    }
    
    console.log('✓ Page ready');

    // Execute each test
    for (const test of suite.tests) {
      console.log(`\n📋 Test: ${test.name}`);
      
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

    // Add delay to ensure video captures final state
    console.log('⏳ Finalizing recording...');
    await page.waitForTimeout(2000);

  } catch (error) {
    console.error(`❌ Execution error: ${error.message}`);
    results.status = 'failed';
    results.steps.push({
      test_name: 'Execution Error',
      step_name: 'Browser Error',
      status: 'failed',
      error: error.message
    });
  }

  // ============================================================
  // VIDEO CAPTURE
  // ============================================================
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('📹 VIDEO CAPTURE');
  console.log(`${'='.repeat(60)}`);

  let videoUrl = null;

  if (shouldRecordVideo) {
    try {
      // Get video path BEFORE closing the page
      const video = page.video();
      let videoPath = null;
      
      if (video) {
        videoPath = await video.path();
        console.log(`Video path from API: ${videoPath}`);
      }

      // Close page to finalize video
      console.log('Closing page...');
      await page.close();
      
      // Close context
      console.log('Closing context...');
      await context.close();

      // Wait for video file to be written
      console.log('Waiting for video file...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      // If we got path from API, use it; otherwise search directory
      if (!videoPath || !fs.existsSync(videoPath)) {
        const files = fs.readdirSync(runArtifactsDir);
        const videoFiles = files.filter(f => f.endsWith('.webm'));
        if (videoFiles.length > 0) {
          videoPath = path.join(runArtifactsDir, videoFiles[0]);
        }
      }

      if (videoPath && fs.existsSync(videoPath)) {
        const stats = fs.statSync(videoPath);
        console.log(`📹 Video file: ${videoPath}`);
        console.log(`📹 Video size: ${(stats.size / 1024).toFixed(2)} KB`);

        if (stats.size > 1000) {
          const simpleId = `regression_${runId.replace(/-/g, '_')}`;
          videoUrl = await uploadToCloudinary(videoPath, simpleId, 'video');
          results.replay_video_url = videoUrl;
        } else {
          console.log('⚠️ Video file too small, skipping upload');
        }
      } else {
        console.log('⚠️ No video file found');
      }

    } catch (videoError) {
      console.error(`Video error: ${videoError.message}`);
    }
  }

  // Close browser
  try {
    await browser.close();
  } catch (e) {}

  // Cleanup
  try {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  } catch (e) {}

  results.finished_at = new Date().toISOString();
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ RUN COMPLETED`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   Status: ${results.status}`);
  console.log(`   Duration: ${duration}s`);
  console.log(`   Video URL: ${results.replay_video_url || 'NONE'}`);

  await sendCallback(callbackUrl, results);
  return results;
}

/**
 * Execute a single test
 */
async function executeTest(page, test, options) {
  const result = { status: 'passed', steps: [] };
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
        await getLocator(page, step).click({ timeout });
        await page.waitForTimeout(500);
        break;

      case 'fill':
      case 'type':
      case 'input':
        const loc = getLocator(page, step);
        if (step.clear !== false) await loc.clear({ timeout });
        await loc.fill(step.value || '', { timeout });
        break;

      case 'select':
      case 'dropdown':
        try {
          await getLocator(page, step).selectOption(step.value, { timeout: 5000 });
        } catch (e) {
          await getLocator(page, step).click({ timeout });
          await page.waitForTimeout(500);
          await page.getByText(step.value, { exact: step.exact }).click({ timeout });
        }
        break;

      case 'wait':
        if (step.selector) {
          await page.waitForSelector(step.selector, { state: step.state || 'visible', timeout });
        } else if (step.duration || step.value) {
          await page.waitForTimeout(parseInt(step.duration || step.value));
        } else {
          await page.waitForLoadState('networkidle', { timeout });
        }
        break;

      case 'assert':
      case 'verify':
        const type = step.type || 'visible';
        if (type === 'visible') {
          await getLocator(page, step).waitFor({ state: 'visible', timeout });
        } else if (type === 'hidden') {
          await getLocator(page, step).waitFor({ state: 'hidden', timeout });
        }
        break;

      case 'navigate':
      case 'goto':
        await page.goto(step.url || step.value, { waitUntil: 'load', timeout });
        break;

      case 'screenshot':
        const ssPath = path.join(options.artifactsDir, step.name || `step-${options.stepIndex}.png`);
        await page.screenshot({ path: ssPath, fullPage: step.fullPage !== false });
        break;

      case 'hover':
        await getLocator(page, step).hover({ timeout });
        break;

      case 'press':
      case 'key':
        await page.keyboard.press(step.key || step.value);
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
// LOCATOR HELPER
// ============================================================

function getLocator(page, step) {
  if (step.selector) return page.locator(step.selector);
  if (step.control_name) return page.locator(`[data-control-name="${step.control_name}"]`);
  if (step.text) return page.getByText(step.text, { exact: step.exact });
  if (step.aria_label) return page.getByLabel(step.aria_label);
  if (step.placeholder) return page.getByPlaceholder(step.placeholder);
  if (step.role) return page.getByRole(step.role, { name: step.name });
  throw new Error('No valid locator provided');
}

// ============================================================
// CALLBACK
// ============================================================

async function sendCallback(callbackUrl, payload) {
  console.log(`\n📤 Sending callback...`);
  console.log(`   URL: ${callbackUrl}`);
  console.log(`   Status: ${payload.status}`);
  console.log(`   Video: ${payload.replay_video_url || 'NONE'}`);

  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error(`   ❌ Callback failed: ${response.status}`);
    } else {
      console.log(`   ✅ Callback sent`);
    }
  } catch (error) {
    console.error(`   ❌ Callback error: ${error.message}`);
  }
}

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(`
${'═'.repeat(60)}
  🎭 Power Apps Regression Runner v2.4
     Using Cloudinary SDK
${'═'.repeat(60)}

  Port: ${PORT}
  Cloudinary: ${cloudinary ? '✓ Configured' : '❌ Not configured'}

  Endpoints:
    GET  /health        - Health check
    POST /webhook/run   - Execute test run

${'═'.repeat(60)}
  `);
});

module.exports = app;
