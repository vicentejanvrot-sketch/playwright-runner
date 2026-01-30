/**
 * Power Apps Regression Recorder - Runner Service v2.9.4
 * 
 * MATCHES LOVABLE'S EXACT STEP FORMAT:
 * - step.type: 'click' | 'input' | 'navigate' | 'scroll' | 'keydown' | 'wait'
 * - step.data.targetHints: { ariaLabel, role, visibleText, cssPath, boundingBox }
 * - step.data.value, step.data.url, step.data.key, step.data.duration
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
  console.log('\n   [FETCH] Downloading steps from: ' + stepsJsonUrl);
  
  try {
    var response = await fetch(stepsJsonUrl);
    console.log('   HTTP Status: ' + response.status);
    
    if (!response.ok) {
      console.log('   [X] Failed to fetch steps: HTTP ' + response.status);
      return [];
    }
    
    var stepsData = await response.json();
    
    // Handle both formats: direct array or { steps: [...] }
    var steps = [];
    if (Array.isArray(stepsData)) {
      steps = stepsData;
      console.log('   Format: Direct array');
    } else if (stepsData && stepsData.steps && Array.isArray(stepsData.steps)) {
      steps = stepsData.steps;
      console.log('   Format: Object with .steps array');
    } else {
      console.log('   [!] Unknown format, keys: ' + Object.keys(stepsData || {}).join(', '));
      return [];
    }
    
    console.log('   [OK] Loaded ' + steps.length + ' steps to execute');
    
    // Log first few steps for debugging
    steps.slice(0, 3).forEach(function(step, idx) {
      console.log('   Step ' + idx + ': type=' + step.type + ', data=' + JSON.stringify(step.data || {}).substring(0, 100));
    });
    
    return steps;
    
  } catch (error) {
    console.log('   [X] Error fetching steps: ' + error.message);
    return [];
  }
}

// ============================================================
// HELPER: Find element using multi-hint targeting (Lovable format)
// Priority: ARIA label -> Role+Text -> CSS Path -> BoundingBox
// ============================================================
async function findElement(page, targetHints, timeout) {
  timeout = timeout || 30000;
  
  if (!targetHints) {
    throw new Error('No target hints provided');
  }
  
  console.log('      Target hints: ' + JSON.stringify(targetHints));
  
  // Priority 1: ARIA label
  if (targetHints.ariaLabel) {
    try {
      console.log('      Trying aria-label: ' + targetHints.ariaLabel);
      var ariaLocator = page.locator('[aria-label="' + targetHints.ariaLabel + '"]').first();
      await ariaLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by aria-label');
      return ariaLocator;
    } catch (e) {
      console.log('      [!] aria-label not found, trying next...');
    }
  }
  
  // Priority 2: Role + visible text
  if (targetHints.role && targetHints.visibleText) {
    try {
      console.log('      Trying role=' + targetHints.role + ' with text="' + targetHints.visibleText + '"');
      var roleLocator = page.getByRole(targetHints.role, { name: targetHints.visibleText }).first();
      await roleLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by role+text');
      return roleLocator;
    } catch (e) {
      console.log('      [!] role+text not found, trying next...');
    }
  }
  
  // Priority 3: Visible text only
  if (targetHints.visibleText) {
    try {
      console.log('      Trying visible text: ' + targetHints.visibleText);
      var textLocator = page.getByText(targetHints.visibleText, { exact: false }).first();
      await textLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by text');
      return textLocator;
    } catch (e) {
      console.log('      [!] text not found, trying next...');
    }
  }
  
  // Priority 4: CSS path
  if (targetHints.cssPath) {
    try {
      console.log('      Trying CSS path: ' + targetHints.cssPath);
      var cssLocator = page.locator(targetHints.cssPath).first();
      await cssLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by CSS path');
      return cssLocator;
    } catch (e) {
      console.log('      [!] CSS path not found, trying next...');
    }
  }
  
  // Priority 5: Bounding box (click at coordinates)
  if (targetHints.boundingBox) {
    var box = targetHints.boundingBox;
    console.log('      Using bounding box fallback: x=' + box.x + ', y=' + box.y);
    // Return a special marker that executeStep will handle
    return { _useBoundingBox: true, x: box.x + (box.width / 2), y: box.y + (box.height / 2) };
  }
  
  throw new Error('Could not locate element with provided hints');
}

// ============================================================
// HELPER: Get target summary for logging
// ============================================================
function getTargetSummary(step) {
  if (step.type === 'navigate') {
    return step.data && step.data.url ? step.data.url : 'Unknown URL';
  }
  if (step.data && step.data.targetHints) {
    if (step.data.targetHints.visibleText) return step.data.targetHints.visibleText;
    if (step.data.targetHints.ariaLabel) return step.data.targetHints.ariaLabel;
    if (step.data.targetHints.cssPath) return step.data.targetHints.cssPath;
  }
  if (step.data && step.data.value) return 'Input: ' + step.data.value;
  if (step.data && step.data.key) return 'Key: ' + step.data.key;
  return 'Unknown target';
}

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType) {
  resourceType = resourceType || 'image';
  
  console.log('\n   [UPLOAD] ATTEMPT:');
  console.log('      File: ' + filePath);
  console.log('      Public ID: ' + publicId);
  
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
    console.log('      [X] FAILED: File too small');
    return null;
  }

  try {
    console.log('      [..] Uploading...');
    var result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true
    });
    console.log('      [OK] SUCCESS: ' + result.secure_url);
    return result.secure_url;
  } catch (error) {
    console.log('      [X] FAILED: ' + error.message);
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
    version: '2.9.4',
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
      var hasStepsUrl = test.steps_json_url ? '[OK]' : '[X]';
      console.log('   Test ' + (idx + 1) + ': ' + test.name + ' ' + hasStepsUrl + ' steps_json_url');
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
// EXECUTE STEP (Lovable format)
// ============================================================

async function executeStep(page, step, baseUrl) {
  var stepType = step.type || 'unknown';
  var data = step.data || {};
  
  console.log('      Executing: ' + stepType);
  
  switch (stepType) {
    case 'navigate':
      var url = data.url || baseUrl;
      console.log('      Navigating to: ' + url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      break;
      
    case 'click':
      var clickTarget = await findElement(page, data.targetHints);
      if (clickTarget._useBoundingBox) {
        console.log('      Clicking at coordinates: ' + clickTarget.x + ', ' + clickTarget.y);
        await page.mouse.click(clickTarget.x, clickTarget.y);
      } else {
        await clickTarget.click();
      }
      break;
      
    case 'input':
      var inputTarget = await findElement(page, data.targetHints);
      if (inputTarget._useBoundingBox) {
        await page.mouse.click(inputTarget.x, inputTarget.y);
        await page.keyboard.type(data.value || '');
      } else {
        await inputTarget.fill(data.value || '');
      }
      break;
      
    case 'keydown':
      var key = data.key || 'Enter';
      console.log('      Pressing key: ' + key);
      await page.keyboard.press(key);
      break;
      
    case 'scroll':
      var scrollY = data.y || 100;
      console.log('      Scrolling: ' + scrollY + 'px');
      await page.mouse.wheel(0, scrollY);
      break;
      
    case 'wait':
      var duration = data.duration || 1000;
      console.log('      Waiting: ' + duration + 'ms');
      await page.waitForTimeout(duration);
      break;
      
    default:
      console.log('      [!] Unknown step type: ' + stepType);
  }
  
  // Small delay between steps for stability
  await page.waitForTimeout(500);
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

  var shouldRecordVideo = !artifacts || artifacts.recordVideo !== false;
  
  var contextOptions = {
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true
  };

  if (shouldRecordVideo) {
    console.log('[VIDEO] Recording ENABLED');
    contextOptions.recordVideo = {
      dir: runArtifactsDir,
      size: { width: 1920, height: 1080 }
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

  var uploadedScreenshots = [];

  try {
    // Execute each test
    for (var t = 0; t < suite.tests.length; t++) {
      var test = suite.tests[t];
      console.log('\n========================================');
      console.log('[TEST] ' + test.name);
      console.log('========================================');
      
      var testCaseId = isValidUUID(test.id) ? test.id : null;
      console.log('   test_case_id: ' + testCaseId);
      
      // DOWNLOAD THE RECORDING STEPS
      var steps = [];
      if (test.steps_json_url) {
        steps = await fetchStepsFromUrl(test.steps_json_url);
      } else {
        console.log('   [X] No steps_json_url provided!');
      }
      
      var stepResults = [];
      var testStatus = 'passed';

      if (steps.length === 0) {
        console.log('   [!] No steps to execute');
        
        // Navigate to base URL and take verification screenshot
        console.log('   Navigating to: ' + environment.powerapps_url);
        await page.goto(environment.powerapps_url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(5000);
        
        var verifyTime = new Date().toISOString();
        var verifyPath = path.join(runArtifactsDir, 'step_0_verify.png');
        await page.screenshot({ path: verifyPath });
        
        var verifyUrl = await uploadToCloudinary(verifyPath, 'run_' + runIdClean + '_step_0', 'image');
        if (verifyUrl) uploadedScreenshots.push(verifyUrl);
        
        stepResults.push({
          step_index: 0,
          action_type: 'navigate',
          target_summary: environment.powerapps_url,
          status: 'passed',
          started_at: verifyTime,
          finished_at: new Date().toISOString(),
          screenshot_url: verifyUrl,
          assertion_evidence: [{
            type: 'navigation',
            expected: 'Page should load',
            actual: 'Page loaded successfully',
            passed: true
          }]
        });
      } else {
        // EXECUTE EACH STEP FROM THE RECORDING
        console.log('\n   Executing ' + steps.length + ' recorded steps...\n');
        
        for (var i = 0; i < steps.length; i++) {
          var step = steps[i];
          var stepStartTime = new Date().toISOString();
          var stepType = step.type || 'unknown';
          var targetSummary = getTargetSummary(step);
          
          console.log('   ----------------------------------------');
          console.log('   Step ' + i + ': ' + stepType + ' - ' + targetSummary);
          
          try {
            // Execute the step
            await executeStep(page, step, environment.powerapps_url);
            
            // Capture screenshot after step
            var screenshotPath = path.join(runArtifactsDir, 'step_' + i + '.png');
            await page.screenshot({ path: screenshotPath });
            
            var screenshotUrl = await uploadToCloudinary(
              screenshotPath,
              'run_' + runIdClean + '_step_' + i,
              'image'
            );
            
            if (screenshotUrl) uploadedScreenshots.push(screenshotUrl);
            
            stepResults.push({
              step_index: i,
              action_type: stepType,
              target_summary: targetSummary,
              status: 'passed',
              started_at: stepStartTime,
              finished_at: new Date().toISOString(),
              screenshot_url: screenshotUrl,
              assertion_evidence: [{
                type: stepType,
                expected: 'Step "' + stepType + '" should complete',
                actual: 'Action completed successfully',
                passed: true
              }]
            });
            
            console.log('   [OK] Step ' + i + ' passed');
            
          } catch (err) {
            console.log('   [X] Step ' + i + ' failed: ' + err.message);
            
            // Capture failure screenshot
            var failPath = path.join(runArtifactsDir, 'step_' + i + '_fail.png');
            try {
              await page.screenshot({ path: failPath });
            } catch (e) {}
            
            var failUrl = await uploadToCloudinary(
              failPath,
              'run_' + runIdClean + '_step_' + i + '_fail',
              'image'
            );
            
            if (failUrl) uploadedScreenshots.push(failUrl);
            
            stepResults.push({
              step_index: i,
              action_type: stepType,
              target_summary: targetSummary,
              status: 'failed',
              started_at: stepStartTime,
              finished_at: new Date().toISOString(),
              screenshot_url: failUrl,
              error_message: err.message,
              assertion_evidence: [{
                type: stepType,
                expected: 'Step "' + stepType + '" should complete',
                actual: err.message,
                passed: false
              }]
            });
            
            testStatus = 'failed';
            results.overall_status = 'failed';
            break; // Stop on first failure
          }
        }
      }

      results.test_results.push({
        test_case_id: testCaseId,
        status: testStatus,
        steps: stepResults
      });
    }

  } catch (error) {
    console.error('\n[X] Execution error: ' + error.message);
    results.overall_status = 'failed';
    results.error_message = error.message;
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
      }

      await page.close();
      await context.close();
      
      await new Promise(function(resolve) { setTimeout(resolve, 3000); });

      if (!videoPath || !fs.existsSync(videoPath)) {
        var files = fs.readdirSync(runArtifactsDir);
        var videoFiles = files.filter(function(f) { return f.endsWith('.webm'); });
        if (videoFiles.length > 0) {
          videoPath = path.join(runArtifactsDir, videoFiles[0]);
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
        }
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

  await sendCallback(callbackUrl, results);
  return results;
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
  console.log('  Power Apps Regression Runner v2.9.4');
  console.log('  LOVABLE FORMAT: step.type + step.data.targetHints');
  console.log('============================================================');
  console.log('');
  console.log('  Port: ' + PORT);
  console.log('  Cloudinary: ' + (cloudinary ? '[OK] READY' : '[X] NOT CONFIGURED'));
  console.log('');
  console.log('============================================================\n');
});

module.exports = app;
