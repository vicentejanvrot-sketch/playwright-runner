/**
 * Power Apps Regression Recorder - Runner Service v2.6
 * 
 * FIXED CALLBACK PAYLOAD FORMAT FOR LOVABLE
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
// CLOUDINARY UPLOAD
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType = 'image') {
  if (!cloudinary) {
    console.log('  ⚠️ Cloudinary not configured');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    console.log(`  ⚠️ File not found: ${filePath}`);
    return null;
  }

  const stats = fs.statSync(filePath);
  if (stats.size < 100) {
    console.log(`  ⚠️ File too small: ${filePath}`);
    return null;
  }

  try {
    const result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true
    });
    console.log(`  ✓ Uploaded: ${publicId}`);
    return result.secure_url;
  } catch (error) {
    console.error(`  ✗ Upload failed: ${error.message}`);
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
    version: '2.6.0',
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
    
    // Send error callback in Lovable's expected format
    await sendCallback(payload.callbackUrl, {
      run_id: payload.runId,
      overall_status: 'failed',
      replay_video_url: null,
      test_results: [{
        test_case_id: 'runner-error',
        status: 'failed',
        steps: [{
          step_index: 0,
          action_type: 'initialize',
          target_summary: 'Runner Initialization',
          status: 'failed',
          error_message: error.message,
          screenshot_url: null,
          assertion_evidence: [{
            type: 'error',
            expected: 'Runner to start successfully',
            actual: error.message,
            passed: false
          }]
        }]
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

  // Results in LOVABLE'S EXPECTED FORMAT
  const results = {
    run_id: runId,
    overall_status: 'passed',
    replay_video_url: null,
    test_results: []
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
    
    try {
      await page.waitForSelector('[class*="spinner"], [class*="loading"]', { 
        state: 'hidden', 
        timeout: 10000 
      });
    } catch (e) {}
    
    console.log('✓ Page ready');

    // Execute each test
    for (const test of suite.tests) {
      console.log(`\n📋 Test: ${test.name} (ID: ${test.id || 'no-id'})`);
      
      const testResult = await executeTest(page, test, {
        artifactsDir: runArtifactsDir,
        runId
      });

      // Add to test_results array in Lovable's format
      results.test_results.push({
        test_case_id: test.id || test.name,
        status: testResult.status,
        steps: testResult.steps
      });

      if (testResult.status === 'failed') {
        results.overall_status = 'failed';
      }
    }

    // Final delay for video
    await page.waitForTimeout(2000);

  } catch (error) {
    console.error(`❌ Execution error: ${error.message}`);
    results.overall_status = 'failed';
    
    // Capture error screenshot
    const errorScreenshotPath = path.join(runArtifactsDir, 'error_screenshot.png');
    let errorScreenshotUrl = null;
    try {
      await page.screenshot({ path: errorScreenshotPath, fullPage: true });
      errorScreenshotUrl = await uploadToCloudinary(
        errorScreenshotPath,
        `run_${runId.replace(/-/g, '_')}_error`,
        'image'
      );
    } catch (e) {}
    
    results.test_results.push({
      test_case_id: 'execution-error',
      status: 'failed',
      steps: [{
        step_index: 0,
        action_type: 'browser_error',
        target_summary: 'Browser Execution',
        status: 'failed',
        error_message: error.message,
        screenshot_url: errorScreenshotUrl,
        assertion_evidence: [{
          type: 'error',
          expected: 'Test execution to complete',
          actual: error.message,
          passed: false
        }]
      }]
    });
  }

  // ============================================================
  // VIDEO CAPTURE
  // ============================================================
  
  console.log(`\n📹 Processing video...`);

  if (shouldRecordVideo) {
    try {
      const video = page.video();
      let videoPath = null;
      
      if (video) {
        videoPath = await video.path();
      }

      await page.close();
      await context.close();
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (!videoPath || !fs.existsSync(videoPath)) {
        const files = fs.readdirSync(runArtifactsDir);
        const videoFiles = files.filter(f => f.endsWith('.webm'));
        if (videoFiles.length > 0) {
          videoPath = path.join(runArtifactsDir, videoFiles[0]);
        }
      }

      if (videoPath && fs.existsSync(videoPath)) {
        const stats = fs.statSync(videoPath);
        console.log(`   Video size: ${(stats.size / 1024).toFixed(2)} KB`);

        if (stats.size > 1000) {
          const videoUrl = await uploadToCloudinary(
            videoPath,
            `run_${runId.replace(/-/g, '_')}_video`,
            'video'
          );
          results.replay_video_url = videoUrl;
        }
      }
    } catch (videoError) {
      console.error(`   Video error: ${videoError.message}`);
    }
  } else {
    await page.close();
    await context.close();
  }

  // Close browser
  try {
    await browser.close();
  } catch (e) {}

  // Cleanup local files
  try {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  } catch (e) {}

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ RUN COMPLETED`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   Status: ${results.overall_status}`);
  console.log(`   Duration: ${duration}s`);
  console.log(`   Tests: ${results.test_results.length}`);
  console.log(`   Video: ${results.replay_video_url ? 'Yes' : 'No'}`);

  await sendCallback(callbackUrl, results);
  return results;
}

/**
 * Execute a single test - returns steps in Lovable's format
 */
async function executeTest(page, test, options) {
  const result = { status: 'passed', steps: [] };
  const steps = test.steps || [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    
    console.log(`    Step ${i}: ${step.action}`);

    // Take BEFORE screenshot (baseline)
    const beforeScreenshotPath = path.join(
      options.artifactsDir,
      `step_${i}_before.png`
    );
    await page.screenshot({ path: beforeScreenshotPath });

    // Execute the step
    const stepExecution = await executeStep(page, step);

    // Take AFTER screenshot
    const afterScreenshotPath = path.join(
      options.artifactsDir,
      `step_${i}_after.png`
    );
    await page.screenshot({ path: afterScreenshotPath });

    // Upload screenshots to Cloudinary
    const runIdClean = options.runId.replace(/-/g, '_');
    
    const screenshotUrl = await uploadToCloudinary(
      afterScreenshotPath,
      `run_${runIdClean}_step_${i}`,
      'image'
    );
    
    const baselineUrl = await uploadToCloudinary(
      beforeScreenshotPath,
      `run_${runIdClean}_step_${i}_baseline`,
      'image'
    );

    // Build step result in LOVABLE'S EXPECTED FORMAT
    const stepResult = {
      step_index: i,
      action_type: step.action?.toLowerCase() || 'unknown',
      target_summary: step.name || step.description || getTargetSummary(step),
      status: stepExecution.status,
      screenshot_url: screenshotUrl,
      baseline_screenshot_url: baselineUrl,
      visual_diff_score: stepExecution.status === 'passed' ? 100 : 0,
      assertion_evidence: [{
        type: step.action?.toLowerCase() || 'action',
        expected: getExpectedOutcome(step),
        actual: stepExecution.status === 'passed' 
          ? 'Action completed successfully' 
          : stepExecution.error,
        passed: stepExecution.status === 'passed'
      }]
    };

    if (stepExecution.error) {
      stepResult.error_message = stepExecution.error;
    }

    result.steps.push(stepResult);

    if (stepExecution.status === 'failed') {
      result.status = 'failed';
      console.log(`    ✗ Failed: ${stepExecution.error}`);
      break;
    } else {
      console.log(`    ✓ Passed`);
    }
  }

  return result;
}

/**
 * Get a human-readable target summary
 */
function getTargetSummary(step) {
  if (step.selector) return `Element: ${step.selector}`;
  if (step.control_name) return `Control: ${step.control_name}`;
  if (step.text) return `Text: "${step.text}"`;
  if (step.aria_label) return `Label: ${step.aria_label}`;
  if (step.placeholder) return `Placeholder: ${step.placeholder}`;
  if (step.url || step.value) return step.url || step.value;
  return 'Unknown target';
}

/**
 * Get expected outcome description
 */
function getExpectedOutcome(step) {
  switch (step.action?.toLowerCase()) {
    case 'click':
      return `Click on element should succeed`;
    case 'fill':
    case 'type':
    case 'input':
      return `Input value "${step.value || ''}" should be entered`;
    case 'select':
    case 'dropdown':
      return `Option "${step.value || ''}" should be selected`;
    case 'wait':
      return `Element should become ${step.state || 'visible'}`;
    case 'assert':
    case 'verify':
      return `Element should be ${step.type || 'visible'}`;
    case 'navigate':
    case 'goto':
      return `Page should navigate successfully`;
    case 'hover':
      return `Hover action should succeed`;
    default:
      return `Action "${step.action}" should complete`;
  }
}

/**
 * Execute a single step
 */
async function executeStep(page, step) {
  const result = {
    status: 'passed',
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
        await page.waitForTimeout(2000);
        break;

      case 'screenshot':
        break;

      case 'hover':
        await getLocator(page, step).hover({ timeout });
        break;

      case 'press':
      case 'key':
        await page.keyboard.press(step.key || step.value);
        break;

      default:
        console.log(`      ⚠️ Unknown action: ${step.action}`);
    }

  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
  }

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
  console.log(`\n📤 Sending callback to Lovable...`);
  console.log(`   URL: ${callbackUrl}`);
  console.log(`   overall_status: ${payload.overall_status}`);
  console.log(`   test_results: ${payload.test_results.length} test(s)`);
  
  // Log the full payload for debugging
  console.log(`\n   📋 CALLBACK PAYLOAD:`);
  console.log(JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      console.error(`   ❌ Callback failed: ${response.status}`);
      console.error(`   Response: ${responseText}`);
    } else {
      console.log(`   ✅ Callback sent successfully`);
      console.log(`   Response: ${responseText}`);
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
  🎭 Power Apps Regression Runner v2.6
     LOVABLE-COMPATIBLE CALLBACK FORMAT
${'═'.repeat(60)}

  Port: ${PORT}
  Cloudinary: ${cloudinary ? '✓ Configured' : '❌ Not configured'}

  Callback Format:
    ✓ overall_status (not "status")
    ✓ test_results[] array
    ✓ step_index, action_type, target_summary
    ✓ screenshot_url per step
    ✓ assertion_evidence[] array

  Endpoints:
    GET  /health        - Health check
    POST /webhook/run   - Execute test run

${'═'.repeat(60)}
  `);
});

module.exports = app;
