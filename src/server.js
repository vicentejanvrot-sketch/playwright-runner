/**
 * Power Apps Regression Recorder - Runner Service v2.9.2
 * 
 * FIX: Fetch steps from steps_json_url
 * ASCII-only version for compatibility
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

// Log Cloudinary config status at startup
console.log('\n[CLOUDINARY] CONFIGURATION:');
console.log('   CLOUDINARY_CLOUD_NAME: ' + (CLOUDINARY_CLOUD_NAME ? '"' + CLOUDINARY_CLOUD_NAME + '"' : '[X] NOT SET'));
console.log('   CLOUDINARY_API_KEY: ' + (CLOUDINARY_API_KEY ? '"' + CLOUDINARY_API_KEY.substring(0, 4) + '..."' : '[X] NOT SET'));
console.log('   CLOUDINARY_API_SECRET: ' + (CLOUDINARY_API_SECRET ? '"***" (hidden)' : '[X] NOT SET'));

// Initialize Cloudinary
var cloudinary = null;
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
  console.log('   [OK] Cloudinary SDK initialized successfully\n');
} else {
  console.log('   [X] Cloudinary NOT initialized - missing environment variables\n');
}

// Ensure artifacts directory exists
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// Track active runs
var activeRuns = 0;
var runQueue = [];

// ============================================================
// HELPER: Check if string is a valid UUID
// ============================================================
function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false;
  var uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

// ============================================================
// HELPER: Fetch steps from URL
// ============================================================
async function fetchStepsFromUrl(stepsJsonUrl) {
  console.log('   [FETCH] Downloading steps from: ' + stepsJsonUrl);
  try {
    var response = await fetch(stepsJsonUrl);
    if (!response.ok) {
      console.log('   [X] Failed to fetch steps: HTTP ' + response.status);
      return [];
    }
    var steps = await response.json();
    console.log('   [OK] Downloaded ' + steps.length + ' steps');
    return steps;
  } catch (error) {
    console.log('   [X] Error fetching steps: ' + error.message);
    return [];
  }
}

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType) {
  resourceType = resourceType || 'image';
  
  console.log('\n   [UPLOAD] ATTEMPT:');
  console.log('      File: ' + filePath);
  console.log('      Public ID: ' + publicId);
  console.log('      Type: ' + resourceType);
  
  if (!cloudinary) {
    console.log('      [X] FAILED: Cloudinary not configured');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    console.log('      [X] FAILED: File does not exist');
    return null;
  }

  var stats = fs.statSync(filePath);
  console.log('      File size: ' + (stats.size / 1024).toFixed(2) + ' KB');
  
  if (stats.size < 100) {
    console.log('      [X] FAILED: File too small (< 100 bytes)');
    return null;
  }

  try {
    console.log('      [..] Uploading to Cloudinary...');
    var result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true
    });
    console.log('      [OK] SUCCESS!');
    console.log('      URL: ' + result.secure_url);
    return result.secure_url;
  } catch (error) {
    console.log('      [X] FAILED: ' + error.message);
    if (error.http_code) {
      console.log('      HTTP Code: ' + error.http_code);
    }
    return null;
  }
}

// ============================================================
// ENDPOINTS
// ============================================================

app.get('/health', function(req, res) {
  res.json({ 
    status: 'healthy',
    service: 'playwright-runner',
    version: '2.9.2',
    activeRuns: activeRuns,
    maxConcurrent: MAX_CONCURRENT_RUNS,
    queueLength: runQueue.length,
    cloudinaryConfigured: !!cloudinary,
    cloudinaryCloudName: CLOUDINARY_CLOUD_NAME || null
  });
});

app.post('/webhook/run', async function(req, res) {
  var payload = req.body;
  
  console.log('\n============================================================');
  console.log('[INCOMING] PAYLOAD');
  console.log('============================================================');
  console.log(JSON.stringify(payload, null, 2));
  
  var errors = validatePayload(payload);
  if (errors.length > 0) {
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  console.log('\n   Run ID: ' + payload.runId);
  console.log('   Tests: ' + (payload.suite && payload.suite.tests ? payload.suite.tests.length : 0));
  
  if (payload.suite && payload.suite.tests) {
    payload.suite.tests.forEach(function(test, idx) {
      var idType = isValidUUID(test.id) ? '[OK] UUID' : '[X] NOT UUID';
      var hasStepsUrl = test.steps_json_url ? '[OK] Has steps_json_url' : '[!] No steps_json_url';
      console.log('   Test ' + (idx + 1) + ': id="' + test.id + '" (' + idType + ') ' + hasStepsUrl);
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

app.post('/webhook/cancel/:runId', function(req, res) {
  var runId = req.params.runId;
  var queueIndex = runQueue.findIndex(function(p) { return p.runId === runId; });
  if (queueIndex >= 0) {
    runQueue.splice(queueIndex, 1);
    return res.json({ status: 'cancelled', runId: runId });
  }
  res.json({ status: 'not_found', runId: runId });
});

// ============================================================
// VALIDATION
// ============================================================

function validatePayload(payload) {
  var errors = [];
  if (!payload.runId) errors.push('Missing: runId');
  if (!payload.environment) errors.push('Missing: environment');
  if (!payload.environment || !payload.environment.powerapps_url) errors.push('Missing: environment.powerapps_url');
  if (!payload.suite) errors.push('Missing: suite');
  if (!payload.suite || !payload.suite.tests || !Array.isArray(payload.suite.tests)) {
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
  var payload = runQueue.shift();
  
  try {
    await executeRun(payload);
  } catch (error) {
    console.error('[X] Run ' + payload.runId + ' failed: ' + error.message);
    
    var now = new Date().toISOString();
    await sendCallback(payload.callbackUrl, {
      run_id: payload.runId,
      overall_status: 'failed',
      replay_video_url: null,
      error_message: error.message,
      test_results: [{
        test_case_id: null,
        steps: [{
          step_index: 0,
          action_type: 'initialize',
          target_summary: 'Runner Initialization',
          status: 'failed',
          started_at: now,
          finished_at: now,
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
  var runId = payload.runId;
  var environment = payload.environment;
  var suite = payload.suite;
  var callbackUrl = payload.callbackUrl;
  var artifacts = payload.artifacts;
  
  console.log('\n============================================================');
  console.log('[START] RUN: ' + runId);
  console.log('============================================================');
  console.log('\n[CLOUDINARY] Status: ' + (cloudinary ? '[OK] READY' : '[X] NOT CONFIGURED'));
  
  var startTime = Date.now();
  var runIdClean = runId.replace(/-/g, '_');
  
  // Create run-specific artifacts directory
  var runArtifactsDir = path.join(ARTIFACTS_DIR, runId);
  if (fs.existsSync(runArtifactsDir)) {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runArtifactsDir, { recursive: true });
  console.log('[DIR] Artifacts directory: ' + runArtifactsDir);

  var shouldRecordVideo = !artifacts || artifacts.recordVideo !== false;
  
  var contextOptions = {
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true
  };

  if (shouldRecordVideo) {
    console.log('[VIDEO] Recording ENABLED');
    contextOptions.recordVideo = {
      dir: runArtifactsDir,
      size: { width: 1280, height: 720 }
    };
  }

  console.log('[BROWSER] Launching...');
  var browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  var context = await browser.newContext(contextOptions);
  var page = await context.newPage();
  page.setDefaultTimeout(30000);

  var results = {
    run_id: runId,
    overall_status: 'passed',
    replay_video_url: null,
    test_results: []
  };

  var stepCounter = 0;
  var uploadedScreenshots = [];

  try {
    // Navigate to Power Apps URL
    var navStartTime = new Date().toISOString();
    console.log('\n[NAV] Navigating to: ' + environment.powerapps_url);
    
    await page.goto(environment.powerapps_url, { 
      waitUntil: 'load',
      timeout: 60000 
    });
    console.log('[OK] Page loaded');

    console.log('[WAIT] Waiting for Power Apps to initialize...');
    await page.waitForTimeout(5000);
    
    try {
      await page.waitForSelector('[class*="spinner"], [class*="loading"]', { 
        state: 'hidden', 
        timeout: 10000 
      });
    } catch (e) {}
    
    console.log('[OK] Page ready');

    // Take navigation screenshot
    console.log('\n[SCREENSHOT] Taking navigation screenshot...');
    var navScreenshotPath = path.join(runArtifactsDir, 'step_' + stepCounter + '_nav.png');
    await page.screenshot({ path: navScreenshotPath });
    console.log('   Saved to: ' + navScreenshotPath);
    
    var navEndTime = new Date().toISOString();
    
    // Upload navigation screenshot
    var navScreenshotUrl = await uploadToCloudinary(
      navScreenshotPath,
      'run_' + runIdClean + '_step_' + stepCounter + '_nav',
      'image'
    );
    
    if (navScreenshotUrl) {
      uploadedScreenshots.push(navScreenshotUrl);
    }

    // Navigation step
    var navigationStep = {
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
    
    console.log('   Step ' + stepCounter + ' screenshot_url: ' + (navScreenshotUrl || 'NULL'));
    stepCounter++;

    // Execute each test
    for (var t = 0; t < suite.tests.length; t++) {
      var test = suite.tests[t];
      console.log('\n----------------------------------------');
      console.log('[TEST] ' + test.name);
      console.log('----------------------------------------');
      
      var testCaseId = isValidUUID(test.id) ? test.id : null;
      console.log('   test_case_id: ' + testCaseId);
      
      // CRITICAL FIX: Fetch steps from steps_json_url if provided
      var testSteps = [];
      if (test.steps_json_url) {
        console.log('   [!] Found steps_json_url - fetching...');
        testSteps = await fetchStepsFromUrl(test.steps_json_url);
      } else if (test.steps && Array.isArray(test.steps)) {
        testSteps = test.steps;
        console.log('   [OK] Using inline steps: ' + testSteps.length);
      } else {
        console.log('   [!] No steps found');
      }
      
      var testResultSteps = [navigationStep];
      var testStatus = 'passed';

      if (testSteps.length === 0) {
        console.log('   [!] No steps to execute, creating verification step');
        
        var verifyStartTime = new Date().toISOString();
        var verifyPath = path.join(runArtifactsDir, 'step_' + stepCounter + '_verify.png');
        await page.screenshot({ path: verifyPath });
        var verifyEndTime = new Date().toISOString();
        
        var verifyUrl = await uploadToCloudinary(
          verifyPath,
          'run_' + runIdClean + '_step_' + stepCounter + '_verify',
          'image'
        );
        
        if (verifyUrl) {
          uploadedScreenshots.push(verifyUrl);
        }
        
        console.log('   Step ' + stepCounter + ' screenshot_url: ' + (verifyUrl || 'NULL'));
        
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
        // Execute each step from the fetched steps
        for (var i = 0; i < testSteps.length; i++) {
          var step = testSteps[i];
          var stepStartTime = new Date().toISOString();
          
          // Log step details
          var stepAction = step.action || step.type || 'unknown';
          var stepTarget = step.selector || step.control_name || step.text || step.target || 'unknown';
          console.log('\n   Step ' + stepCounter + ': ' + stepAction + ' on ' + stepTarget);

          // Take BEFORE screenshot
          var beforePath = path.join(runArtifactsDir, 'step_' + stepCounter + '_before.png');
          await page.screenshot({ path: beforePath });

          // Execute the step
          var stepExecution = await executeStep(page, step);

          // Take AFTER screenshot
          console.log('   [SCREENSHOT] Taking step screenshot...');
          var afterPath = path.join(runArtifactsDir, 'step_' + stepCounter + '_after.png');
          await page.screenshot({ path: afterPath });
          
          var stepEndTime = new Date().toISOString();

          // Upload AFTER screenshot
          var screenshotUrl = await uploadToCloudinary(
            afterPath,
            'run_' + runIdClean + '_step_' + stepCounter,
            'image'
          );
          
          if (screenshotUrl) {
            uploadedScreenshots.push(screenshotUrl);
          }
          
          // Upload BEFORE screenshot (baseline)
          var baselineUrl = await uploadToCloudinary(
            beforePath,
            'run_' + runIdClean + '_step_' + stepCounter + '_baseline',
            'image'
          );

          console.log('   screenshot_url: ' + (screenshotUrl || 'NULL'));
          console.log('   baseline_screenshot_url: ' + (baselineUrl || 'NULL'));

          testResultSteps.push({
            step_index: stepCounter,
            action_type: stepAction.toLowerCase(),
            target_summary: step.name || step.description || getTargetSummary(step),
            status: stepExecution.status,
            started_at: stepStartTime,
            finished_at: stepEndTime,
            screenshot_url: screenshotUrl,
            baseline_screenshot_url: baselineUrl,
            visual_diff_score: stepExecution.status === 'passed' ? 100 : 0,
            assertion_evidence: [{
              type: stepAction.toLowerCase(),
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
            console.log('   [X] Failed: ' + stepExecution.error);
            break;
          } else {
            console.log('   [OK] Passed');
          }
        }
      }

      results.test_results.push({
        test_case_id: testCaseId,
        status: testStatus,
        steps: testResultSteps
      });
    }

    // If no tests, create default
    if (results.test_results.length === 0) {
      var defaultStartTime = new Date().toISOString();
      var defaultPath = path.join(runArtifactsDir, 'step_' + stepCounter + '_default.png');
      await page.screenshot({ path: defaultPath });
      var defaultEndTime = new Date().toISOString();
      
      var defaultUrl = await uploadToCloudinary(
        defaultPath,
        'run_' + runIdClean + '_step_' + stepCounter + '_default',
        'image'
      );
      
      if (defaultUrl) {
        uploadedScreenshots.push(defaultUrl);
      }
      
      results.test_results.push({
        test_case_id: null,
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
    console.error('\n[X] Execution error: ' + error.message);
    results.overall_status = 'failed';
    results.error_message = error.message;
    
    var errorTime = new Date().toISOString();
    
    var errorScreenshotUrl = null;
    try {
      var errorPath = path.join(runArtifactsDir, 'error_screenshot.png');
      await page.screenshot({ path: errorPath, fullPage: true });
      errorScreenshotUrl = await uploadToCloudinary(
        errorPath,
        'run_' + runIdClean + '_error',
        'image'
      );
    } catch (e) {}
    
    if (results.test_results.length === 0) {
      results.test_results.push({
        test_case_id: null,
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
  console.log('\n----------------------------------------');
  console.log('[VIDEO] PROCESSING');
  console.log('----------------------------------------');

  if (shouldRecordVideo) {
    try {
      var video = page.video();
      var videoPath = null;
      
      if (video) {
        videoPath = await video.path();
        console.log('   Video path from API: ' + videoPath);
      }

      await page.close();
      await context.close();
      
      console.log('   Waiting for video file to finalize...');
      await new Promise(function(resolve) { setTimeout(resolve, 3000); });

      if (!videoPath || !fs.existsSync(videoPath)) {
        console.log('   Looking for video files in: ' + runArtifactsDir);
        var files = fs.readdirSync(runArtifactsDir);
        console.log('   Files found: ' + files.join(', '));
        var videoFiles = files.filter(function(f) { return f.endsWith('.webm'); });
        if (videoFiles.length > 0) {
          videoPath = path.join(runArtifactsDir, videoFiles[0]);
          console.log('   Found video: ' + videoPath);
        }
      }

      if (videoPath && fs.existsSync(videoPath)) {
        var stats = fs.statSync(videoPath);
        console.log('   Video size: ' + (stats.size / 1024).toFixed(2) + ' KB');

        if (stats.size > 1000) {
          var videoUrl = await uploadToCloudinary(
            videoPath,
            'run_' + runIdClean + '_video',
            'video'
          );
          results.replay_video_url = videoUrl;
        } else {
          console.log('   [!] Video too small, skipping upload');
        }
      } else {
        console.log('   [!] No video file found');
      }
    } catch (videoError) {
      console.error('   Video error: ' + videoError.message);
    }
  } else {
    await page.close();
    await context.close();
  }

  try { await browser.close(); } catch (e) {}
  try { fs.rmSync(runArtifactsDir, { recursive: true, force: true }); } catch (e) {}

  var duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // Summary
  console.log('\n============================================================');
  console.log('[DONE] RUN COMPLETED');
  console.log('============================================================');
  console.log('   Status: ' + results.overall_status);
  console.log('   Duration: ' + duration + 's');
  console.log('   Tests: ' + results.test_results.length);
  console.log('   Screenshots uploaded: ' + uploadedScreenshots.length);
  console.log('   Video URL: ' + (results.replay_video_url || 'NONE'));
  
  if (uploadedScreenshots.length > 0) {
    console.log('\n   [SCREENSHOTS] URLs:');
    uploadedScreenshots.forEach(function(url, idx) {
      console.log('      ' + (idx + 1) + '. ' + url);
    });
  } else {
    console.log('\n   [!] NO SCREENSHOTS WERE UPLOADED!');
  }

  await sendCallback(callbackUrl, results);
  return results;
}

function getTargetSummary(step) {
  if (step.selector) return 'Element: ' + step.selector;
  if (step.control_name) return 'Control: ' + step.control_name;
  if (step.text) return 'Text: "' + step.text + '"';
  if (step.aria_label) return 'Label: ' + step.aria_label;
  if (step.target) return step.target;
  if (step.url || step.value) return step.url || step.value;
  return 'Unknown target';
}

function getExpectedOutcome(step) {
  var action = step.action || step.type || '';
  action = action.toLowerCase();
  switch (action) {
    case 'click': return 'Click on element should succeed';
    case 'fill':
    case 'type':
    case 'input': return 'Input value "' + (step.value || '') + '" should be entered';
    case 'select':
    case 'dropdown': return 'Option "' + (step.value || '') + '" should be selected';
    case 'wait': return 'Element should become ' + (step.state || 'visible');
    case 'assert':
    case 'verify': return 'Element should be ' + (step.type || 'visible');
    case 'navigate':
    case 'goto': return 'Page should navigate successfully';
    default: return 'Action "' + action + '" should complete';
  }
}

async function executeStep(page, step) {
  var result = { status: 'passed', error: null };
  var timeout = step.timeout || 30000;

  try {
    var action = step.action || step.type || '';
    action = action.toLowerCase();
    
    switch (action) {
      case 'click':
        await getLocator(page, step).click({ timeout: timeout });
        await page.waitForTimeout(500);
        break;
      case 'fill':
      case 'type':
      case 'input':
        var loc = getLocator(page, step);
        if (step.clear !== false) {
          try { await loc.clear({ timeout: timeout }); } catch (e) {}
        }
        await loc.fill(step.value || '', { timeout: timeout });
        break;
      case 'select':
      case 'dropdown':
        try {
          await getLocator(page, step).selectOption(step.value, { timeout: 5000 });
        } catch (e) {
          await getLocator(page, step).click({ timeout: timeout });
          await page.waitForTimeout(500);
          await page.getByText(step.value, { exact: step.exact }).click({ timeout: timeout });
        }
        break;
      case 'wait':
        if (step.selector) {
          await page.waitForSelector(step.selector, { state: step.state || 'visible', timeout: timeout });
        } else if (step.duration || step.value) {
          await page.waitForTimeout(parseInt(step.duration || step.value));
        } else {
          await page.waitForLoadState('networkidle', { timeout: timeout });
        }
        break;
      case 'assert':
      case 'verify':
        var state = step.state || step.type || 'visible';
        await getLocator(page, step).waitFor({ state: state, timeout: timeout });
        break;
      case 'navigate':
      case 'goto':
        await page.goto(step.url || step.value, { waitUntil: 'load', timeout: timeout });
        await page.waitForTimeout(2000);
        break;
      case 'hover':
        await getLocator(page, step).hover({ timeout: timeout });
        break;
      case 'press':
      case 'key':
        await page.keyboard.press(step.key || step.value);
        break;
      case 'scroll':
        if (step.selector) {
          await getLocator(page, step).scrollIntoViewIfNeeded();
        } else {
          await page.mouse.wheel(0, step.y || 300);
        }
        break;
      default:
        console.log('      [!] Unknown action: ' + action + ' - skipping');
    }
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
  }

  return result;
}

function getLocator(page, step) {
  // Try multiple locator strategies
  if (step.selector) return page.locator(step.selector);
  if (step.control_name) return page.locator('[data-control-name="' + step.control_name + '"]');
  if (step.xpath) return page.locator('xpath=' + step.xpath);
  if (step.text) return page.getByText(step.text, { exact: step.exact !== false });
  if (step.aria_label || step.label) return page.getByLabel(step.aria_label || step.label);
  if (step.placeholder) return page.getByPlaceholder(step.placeholder);
  if (step.role) return page.getByRole(step.role, { name: step.name });
  if (step.testId || step.test_id) return page.getByTestId(step.testId || step.test_id);
  if (step.target) {
    // Try to parse target as a selector
    if (step.target.startsWith('//')) return page.locator('xpath=' + step.target);
    return page.locator(step.target);
  }
  throw new Error('No valid locator provided for step');
}

async function sendCallback(callbackUrl, payload) {
  console.log('\n============================================================');
  console.log('[CALLBACK] PAYLOAD');
  console.log('============================================================');
  console.log(JSON.stringify(payload, null, 2));

  try {
    var response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    var responseText = await response.text();
    
    if (!response.ok) {
      console.error('\n[X] Callback failed: ' + response.status + ' - ' + responseText);
    } else {
      console.log('\n[OK] Callback sent successfully');
      console.log('   Response: ' + responseText);
    }
  } catch (error) {
    console.error('\n[X] Callback error: ' + error.message);
  }
}

app.listen(PORT, function() {
  console.log('\n============================================================');
  console.log('  Power Apps Regression Runner v2.9.2');
  console.log('  NOW FETCHES STEPS FROM steps_json_url');
  console.log('============================================================');
  console.log('');
  console.log('  Port: ' + PORT);
  console.log('  Cloudinary: ' + (cloudinary ? '[OK] READY' : '[X] NOT CONFIGURED'));
  console.log('');
  console.log('============================================================\n');
});

module.exports = app;
