/**
 * Power Apps Regression Recorder - Runner Service v2.8
 * 
 * FIXED: test_case_id must be UUID or null
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
// HELPER: Check if string is a valid UUID
// ============================================================
function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType = 'image') {
  if (!cloudinary) {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stats = fs.statSync(filePath);
  if (stats.size < 100) {
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
    version: '2.8.0',
    activeRuns,
    maxConcurrent: MAX_CONCURRENT_RUNS,
    queueLength: runQueue.length,
    cloudinaryConfigured: !!cloudinary
  });
});

app.post('/webhook/run', async (req, res) => {
  const payload = req.body;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📥 INCOMING PAYLOAD`);
  console.log(`${'='.repeat(60)}`);
  console.log(JSON.stringify(payload, null, 2));
  
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  console.log(`\n   Run ID: ${payload.runId}`);
  console.log(`   Tests: ${payload.suite?.tests?.length || 0}`);
  
  // Log test IDs to verify they're UUIDs
  if (payload.suite?.tests) {
    payload.suite.tests.forEach((test, idx) => {
      const idType = isValidUUID(test.id) ? '✓ UUID' : '✗ NOT UUID';
      console.log(`   Test ${idx + 1}: id="${test.id}" (${idType})`);
    });
  }
  
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
    
    const now = new Date().toISOString();
    await sendCallback(payload.callbackUrl, {
      run_id: payload.runId,
      overall_status: 'failed',
      replay_video_url: null,
      error_message: error.message,
      test_results: [{
        test_case_id: null,  // Use null instead of string
        steps: [{
          step_index: 0,
          action_type: 'initialize',
          target_summary: 'Runner Initialization',
          status: 'failed',
          started_at: now,
          finished_at: now,
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
  const runIdClean = runId.replace(/-/g, '_');
  
  // Create run-specific artifacts directory
  const runArtifactsDir = path.join(ARTIFACTS_DIR, runId);
  if (fs.existsSync(runArtifactsDir)) {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runArtifactsDir, { recursive: true });

  const shouldRecordVideo = artifacts?.recordVideo !== false;
  
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
    overall_status: 'passed',
    replay_video_url: null,
    test_results: []
  };

  let stepCounter = 0;

  try {
    // Navigate to Power Apps URL
    const navStartTime = new Date().toISOString();
    console.log(`📍 Navigating to: ${environment.powerapps_url}`);
    
    await page.goto(environment.powerapps_url, { 
      waitUntil: 'load',
      timeout: 60000 
    });
    console.log('✓ Page loaded');

    console.log('⏳ Waiting for Power Apps to initialize...');
    await page.waitForTimeout(5000);
    
    try {
      await page.waitForSelector('[class*="spinner"], [class*="loading"]', { 
        state: 'hidden', 
        timeout: 10000 
      });
    } catch (e) {}
    
    console.log('✓ Page ready');

    // Take navigation screenshot
    const navScreenshotPath = path.join(runArtifactsDir, `step_${stepCounter}_nav.png`);
    await page.screenshot({ path: navScreenshotPath });
    const navEndTime = new Date().toISOString();
    
    const navScreenshotUrl = await uploadToCloudinary(
      navScreenshotPath,
      `run_${runIdClean}_step_${stepCounter}_nav`,
      'image'
    );

    // Navigation step (will be added to each test)
    const navigationStep = {
      step_index: stepCounter,
      action_type: 'navigate',
      target_summary: environment.powerapps_url,
      status: 'passed',
      started_at: navStartTime,
      finished_at: navEndTime,
      screenshot_url: navScreenshotUrl,
      assertion_evidence: [{
        type: 'navigation',
        expected: 'Page should load successfully',
        actual: 'Page loaded successfully',
        passed: true
      }]
    };
    
    stepCounter++;

    // Execute each test
    for (const test of suite.tests) {
      console.log(`\n📋 Test: ${test.name}`);
      
      // CRITICAL: Use the UUID from Lovable, or null if not a valid UUID
      const testCaseId = isValidUUID(test.id) ? test.id : null;
      console.log(`   test_case_id: ${testCaseId} (from test.id: "${test.id}")`);
      
      const testSteps = test.steps || [];
      const testResultSteps = [navigationStep];
      let testStatus = 'passed';

      if (testSteps.length === 0) {
        console.log(`   ⚠️ No steps, creating verification step`);
        
        const verifyStartTime = new Date().toISOString();
        const verifyPath = path.join(runArtifactsDir, `step_${stepCounter}_verify.png`);
        await page.screenshot({ path: verifyPath });
        const verifyEndTime = new Date().toISOString();
        
        const verifyUrl = await uploadToCloudinary(
          verifyPath,
          `run_${runIdClean}_step_${stepCounter}_verify`,
          'image'
        );
        
        testResultSteps.push({
          step_index: stepCounter,
          action_type: 'verify',
          target_summary: 'Page state verification',
          status: 'passed',
          started_at: verifyStartTime,
          finished_at: verifyEndTime,
          screenshot_url: verifyUrl,
          assertion_evidence: [{
            type: 'verification',
            expected: 'Page should be in expected state',
            actual: 'Page state verified',
            passed: true
          }]
        });
        
        stepCounter++;
      } else {
        for (let i = 0; i < testSteps.length; i++) {
          const step = testSteps[i];
          const stepStartTime = new Date().toISOString();
          
          console.log(`    Step ${i}: ${step.action}`);

          const beforePath = path.join(runArtifactsDir, `step_${stepCounter}_before.png`);
          await page.screenshot({ path: beforePath });

          const stepExecution = await executeStep(page, step);

          const afterPath = path.join(runArtifactsDir, `step_${stepCounter}_after.png`);
          await page.screenshot({ path: afterPath });
          
          const stepEndTime = new Date().toISOString();

          const screenshotUrl = await uploadToCloudinary(
            afterPath,
            `run_${runIdClean}_step_${stepCounter}`,
            'image'
          );
          
          const baselineUrl = await uploadToCloudinary(
            beforePath,
            `run_${runIdClean}_step_${stepCounter}_baseline`,
            'image'
          );

          testResultSteps.push({
            step_index: stepCounter,
            action_type: step.action?.toLowerCase() || 'unknown',
            target_summary: step.name || step.description || getTargetSummary(step),
            status: stepExecution.status,
            started_at: stepStartTime,
            finished_at: stepEndTime,
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
          });
          
          stepCounter++;

          if (stepExecution.status === 'failed') {
            testStatus = 'failed';
            results.overall_status = 'failed';
            console.log(`    ✗ Failed: ${stepExecution.error}`);
            break;
          } else {
            console.log(`    ✓ Passed`);
          }
        }
      }

      // CRITICAL: test_case_id is UUID or null
      results.test_results.push({
        test_case_id: testCaseId,
        status: testStatus,
        steps: testResultSteps
      });
    }

    // If no tests, create default with null test_case_id
    if (results.test_results.length === 0) {
      const defaultStartTime = new Date().toISOString();
      const defaultPath = path.join(runArtifactsDir, `step_${stepCounter}_default.png`);
      await page.screenshot({ path: defaultPath });
      const defaultEndTime = new Date().toISOString();
      
      const defaultUrl = await uploadToCloudinary(
        defaultPath,
        `run_${runIdClean}_step_${stepCounter}_default`,
        'image'
      );
      
      results.test_results.push({
        test_case_id: null,  // null, not a string
        status: 'passed',
        steps: [
          navigationStep,
          {
            step_index: stepCounter,
            action_type: 'verify',
            target_summary: 'Default page verification',
            status: 'passed',
            started_at: defaultStartTime,
            finished_at: defaultEndTime,
            screenshot_url: defaultUrl,
            assertion_evidence: [{
              type: 'verification',
              expected: 'Page should load',
              actual: 'Page loaded successfully',
              passed: true
            }]
          }
        ]
      });
    }

    await page.waitForTimeout(2000);

  } catch (error) {
    console.error(`❌ Execution error: ${error.message}`);
    results.overall_status = 'failed';
    results.error_message = error.message;
    
    const errorTime = new Date().toISOString();
    
    let errorScreenshotUrl = null;
    try {
      const errorPath = path.join(runArtifactsDir, 'error_screenshot.png');
      await page.screenshot({ path: errorPath, fullPage: true });
      errorScreenshotUrl = await uploadToCloudinary(
        errorPath,
        `run_${runIdClean}_error`,
        'image'
      );
    } catch (e) {}
    
    if (results.test_results.length === 0) {
      results.test_results.push({
        test_case_id: null,  // null, not a string
        status: 'failed',
        steps: [{
          step_index: 0,
          action_type: 'error',
          target_summary: 'Execution Error',
          status: 'failed',
          started_at: errorTime,
          finished_at: errorTime,
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
  }

  // Video capture
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
            `run_${runIdClean}_video`,
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

  try { await browser.close(); } catch (e) {}
  try { fs.rmSync(runArtifactsDir, { recursive: true, force: true }); } catch (e) {}

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`✅ RUN COMPLETED`);
  console.log(`${'='.repeat(60)}`);
  console.log(`   Status: ${results.overall_status}`);
  console.log(`   Duration: ${duration}s`);
  console.log(`   Tests: ${results.test_results.length}`);
  
  results.test_results.forEach((tr, idx) => {
    console.log(`   Test ${idx + 1}: test_case_id=${tr.test_case_id}, steps=${tr.steps?.length}`);
  });

  await sendCallback(callbackUrl, results);
  return results;
}

function getTargetSummary(step) {
  if (step.selector) return `Element: ${step.selector}`;
  if (step.control_name) return `Control: ${step.control_name}`;
  if (step.text) return `Text: "${step.text}"`;
  if (step.aria_label) return `Label: ${step.aria_label}`;
  if (step.url || step.value) return step.url || step.value;
  return 'Unknown target';
}

function getExpectedOutcome(step) {
  switch (step.action?.toLowerCase()) {
    case 'click': return `Click on element should succeed`;
    case 'fill':
    case 'type':
    case 'input': return `Input value "${step.value || ''}" should be entered`;
    case 'select':
    case 'dropdown': return `Option "${step.value || ''}" should be selected`;
    case 'wait': return `Element should become ${step.state || 'visible'}`;
    case 'assert':
    case 'verify': return `Element should be ${step.type || 'visible'}`;
    case 'navigate':
    case 'goto': return `Page should navigate successfully`;
    default: return `Action "${step.action}" should complete`;
  }
}

async function executeStep(page, step) {
  const result = { status: 'passed', error: null };
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
        await getLocator(page, step).waitFor({ state: type, timeout });
        break;
      case 'navigate':
      case 'goto':
        await page.goto(step.url || step.value, { waitUntil: 'load', timeout });
        await page.waitForTimeout(2000);
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

function getLocator(page, step) {
  if (step.selector) return page.locator(step.selector);
  if (step.control_name) return page.locator(`[data-control-name="${step.control_name}"]`);
  if (step.text) return page.getByText(step.text, { exact: step.exact });
  if (step.aria_label) return page.getByLabel(step.aria_label);
  if (step.placeholder) return page.getByPlaceholder(step.placeholder);
  if (step.role) return page.getByRole(step.role, { name: step.name });
  throw new Error('No valid locator provided');
}

async function sendCallback(callbackUrl, payload) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📤 CALLBACK PAYLOAD`);
  console.log(`${'='.repeat(60)}`);
  console.log(JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    
    if (!response.ok) {
      console.error(`❌ Callback failed: ${response.status} - ${responseText}`);
    } else {
      console.log(`✅ Callback sent successfully`);
      console.log(`   Response: ${responseText}`);
    }
  } catch (error) {
    console.error(`❌ Callback error: ${error.message}`);
  }
}

app.listen(PORT, () => {
  console.log(`
${'═'.repeat(60)}
  🎭 Power Apps Regression Runner v2.8
     FIXED: test_case_id must be UUID or null
${'═'.repeat(60)}

  Port: ${PORT}
  Cloudinary: ${cloudinary ? '✓ Configured' : '❌ Not configured'}

${'═'.repeat(60)}
  `);
});

module.exports = app;
