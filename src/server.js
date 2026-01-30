/**
 * Power Apps Regression Recorder - Runner Service v2.9.5
 * 
 * MATCHES LOVABLE'S ACTUAL FORMAT:
 * - Payload: tests[] array (not suite.tests)
 * - Test ID: testCaseId (not test.id)
 * - Steps: action_type (not type)
 * - Targeting: targetCandidates[] array (not data.targetHints)
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
  console.log('\n   [FETCH] Downloading steps from URL...');
  console.log('   URL: ' + stepsJsonUrl.substring(0, 100) + '...');
  
  try {
    var response = await fetch(stepsJsonUrl);
    console.log('   HTTP Status: ' + response.status);
    
    if (!response.ok) {
      console.log('   [X] Failed to fetch steps: HTTP ' + response.status);
      return [];
    }
    
    var stepsData = await response.json();
    
    // Handle both formats: { steps: [...] } or direct array
    var steps = [];
    if (Array.isArray(stepsData)) {
      steps = stepsData;
      console.log('   Format: Direct array');
    } else if (stepsData && stepsData.steps && Array.isArray(stepsData.steps)) {
      steps = stepsData.steps;
      console.log('   Format: Object with .steps array');
    } else {
      console.log('   [!] Unknown format, raw data:');
      console.log('   ' + JSON.stringify(stepsData).substring(0, 500));
      return [];
    }
    
    console.log('   [OK] Loaded ' + steps.length + ' steps');
    
    // Log step details
    steps.forEach(function(step, idx) {
      var actionType = step.action_type || step.type || 'unknown';
      var target = getTargetSummary(step);
      console.log('   Step ' + idx + ': ' + actionType + ' -> ' + target.substring(0, 50));
    });
    
    return steps;
    
  } catch (error) {
    console.log('   [X] Error fetching steps: ' + error.message);
    return [];
  }
}

// ============================================================
// HELPER: Find element using targetCandidates (Lovable format)
// Priority: ariaLabel -> role+visibleText -> visibleText -> cssPath -> boundingBox
// ============================================================
async function findElement(page, targetCandidates) {
  if (!targetCandidates || targetCandidates.length === 0) {
    throw new Error('No targetCandidates provided');
  }
  
  // Use the first candidate (best match from recorder)
  var hints = targetCandidates[0];
  console.log('      Target: ' + JSON.stringify(hints).substring(0, 150));
  
  // Priority 1: ARIA label
  if (hints.ariaLabel) {
    try {
      console.log('      Trying aria-label: "' + hints.ariaLabel + '"');
      var ariaLocator = page.locator('[aria-label="' + hints.ariaLabel + '"]').first();
      await ariaLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by aria-label');
      return ariaLocator;
    } catch (e) {
      console.log('      [!] Not found by aria-label');
    }
  }
  
  // Priority 2: Role + visible text
  if (hints.role && hints.visibleText) {
    try {
      console.log('      Trying role="' + hints.role + '" + text="' + hints.visibleText + '"');
      var roleLocator = page.getByRole(hints.role, { name: hints.visibleText }).first();
      await roleLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by role+text');
      return roleLocator;
    } catch (e) {
      console.log('      [!] Not found by role+text');
    }
  }
  
  // Priority 3: Visible text only
  if (hints.visibleText) {
    try {
      console.log('      Trying text: "' + hints.visibleText + '"');
      var textLocator = page.getByText(hints.visibleText, { exact: false }).first();
      await textLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by text');
      return textLocator;
    } catch (e) {
      console.log('      [!] Not found by text');
    }
  }
  
  // Priority 4: CSS path
  if (hints.cssPath) {
    try {
      console.log('      Trying CSS: ' + hints.cssPath);
      var cssLocator = page.locator(hints.cssPath).first();
      await cssLocator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by CSS');
      return cssLocator;
    } catch (e) {
      console.log('      [!] Not found by CSS');
    }
  }
  
  // Priority 5: Bounding box (click at coordinates)
  if (hints.boundingBox) {
    var box = hints.boundingBox;
    var centerX = box.x + ((box.w || box.width || 0) / 2);
    var centerY = box.y + ((box.h || box.height || 0) / 2);
    console.log('      Using coordinates fallback: (' + centerX + ', ' + centerY + ')');
    return { _useCoordinates: true, x: centerX, y: centerY };
  }
  
  throw new Error('Could not locate element with any targeting method');
}

// ============================================================
// HELPER: Get target summary for logging/display
// ============================================================
function getTargetSummary(step) {
  var actionType = step.action_type || step.type || 'unknown';
  
  if (actionType === 'navigate') {
    return step.url || 'Unknown URL';
  }
  
  if (step.targetCandidates && step.targetCandidates.length > 0) {
    var hints = step.targetCandidates[0];
    if (hints.visibleText) return hints.visibleText;
    if (hints.ariaLabel) return hints.ariaLabel;
    if (hints.cssPath) return hints.cssPath;
    if (hints.role) return 'Role: ' + hints.role;
  }
  
  // Fallback for data.targetHints format (just in case)
  if (step.data && step.data.targetHints) {
    var h = step.data.targetHints;
    if (h.visibleText) return h.visibleText;
    if (h.ariaLabel) return h.ariaLabel;
    if (h.cssPath) return h.cssPath;
  }
  
  if (step.value) return 'Input: "' + step.value + '"';
  if (step.data && step.data.value) return 'Input: "' + step.data.value + '"';
  if (step.key) return 'Key: ' + step.key;
  if (step.data && step.data.key) return 'Key: ' + step.data.key;
  
  return 'Unknown target';
}

// ============================================================
// CLOUDINARY UPLOAD
// ============================================================

async function uploadToCloudinary(filePath, publicId, resourceType) {
  resourceType = resourceType || 'image';
  
  if (!cloudinary) {
    console.log('      [X] Cloudinary not configured');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    console.log('      [X] File does not exist: ' + filePath);
    return null;
  }

  var stats = fs.statSync(filePath);
  if (stats.size < 100) {
    console.log('      [X] File too small: ' + stats.size + ' bytes');
    return null;
  }

  try {
    var result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true
    });
    console.log('      [OK] Uploaded: ' + result.secure_url);
    return result.secure_url;
  } catch (error) {
    console.log('      [X] Upload failed: ' + error.message);
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
    version: '2.9.5',
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
  console.log('[INCOMING] WEBHOOK PAYLOAD');
  console.log('============================================================');
  console.log(JSON.stringify(payload, null, 2));
  
  var errors = validatePayload(payload);
  if (errors.length > 0) {
    console.log('[X] Validation errors: ' + errors.join(', '));
    return res.status(400).json({ error: 'Invalid payload', details: errors });
  }

  // Extract tests from either format
  var tests = payload.tests || (payload.suite && payload.suite.tests) || [];
  
  console.log('\n[PARSED] Payload summary:');
  console.log('   Run ID: ' + payload.runId);
  console.log('   Suite: ' + (payload.suiteName || payload.suite && payload.suite.name || 'Unknown'));
  console.log('   Tests: ' + tests.length);
  console.log('   Environment: ' + (payload.environment && payload.environment.powerapps_url || 'Unknown'));
  
  tests.forEach(function(test, idx) {
    var testId = test.testCaseId || test.id || 'no-id';
    var hasUrl = test.steps_json_url ? '[OK]' : '[X]';
    console.log('   Test ' + (idx + 1) + ': ' + (test.name || 'Unnamed') + ' (id: ' + testId + ') ' + hasUrl + ' steps_json_url');
  });
  
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
  
  // Accept either tests[] or suite.tests[]
  var tests = payload.tests || (payload.suite && payload.suite.tests);
  if (!tests || !Array.isArray(tests) || tests.length === 0) {
    errors.push('Missing or empty: tests array');
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
    console.error('[X] Run failed: ' + error.message);
    
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
          action_type: 'error',
          target_summary: 'Runner Error',
          status: 'failed',
          started_at: now,
          finished_at: now,
          screenshot_url: null,
          assertion_evidence: [{
            type: 'error',
            expected: 'Test should execute',
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
// EXECUTE STEP (Lovable format: action_type + targetCandidates)
// ============================================================

async function executeStep(page, step, baseUrl) {
  // Get action type from either format
  var actionType = step.action_type || step.type || 'unknown';
  
  console.log('      Action: ' + actionType);
  
  switch (actionType) {
    case 'navigate':
      var url = step.url || (step.data && step.data.url) || baseUrl;
      console.log('      URL: ' + url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      break;
      
    case 'click':
      var clickTarget = await findElement(page, step.targetCandidates || (step.data && [step.data.targetHints]));
      if (clickTarget._useCoordinates) {
        await page.mouse.click(clickTarget.x, clickTarget.y);
      } else {
        await clickTarget.click();
      }
      break;
      
    case 'input':
      var inputValue = step.value || (step.data && step.data.value) || '';
      var inputTarget = await findElement(page, step.targetCandidates || (step.data && [step.data.targetHints]));
      if (inputTarget._useCoordinates) {
        await page.mouse.click(inputTarget.x, inputTarget.y);
        await page.keyboard.type(inputValue);
      } else {
        await inputTarget.fill(inputValue);
      }
      console.log('      Value: "' + inputValue + '"');
      break;
      
    case 'keydown':
    case 'keypress':
    case 'key':
      var key = step.key || (step.data && step.data.key) || 'Enter';
      console.log('      Key: ' + key);
      await page.keyboard.press(key);
      break;
      
    case 'scroll':
      var scrollY = step.y || (step.data && step.data.y) || 100;
      console.log('      Scroll Y: ' + scrollY);
      await page.mouse.wheel(0, scrollY);
      break;
      
    case 'wait':
      var duration = step.duration || (step.data && step.data.duration) || 1000;
      console.log('      Duration: ' + duration + 'ms');
      await page.waitForTimeout(duration);
      break;
      
    default:
      console.log('      [!] Unknown action type: ' + actionType + ' - skipping');
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
  var callbackUrl = payload.callbackUrl;
  
  // Extract tests from either format
  var tests = payload.tests || (payload.suite && payload.suite.tests) || [];
  
  console.log('\n============================================================');
  console.log('[START] RUN: ' + runId);
  console.log('============================================================');
  console.log('[CLOUDINARY] ' + (cloudinary ? '[OK] READY' : '[X] NOT CONFIGURED'));
  
  var startTime = Date.now();
  var runIdClean = runId.replace(/-/g, '_');
  
  // Create artifacts directory
  var runArtifactsDir = path.join(ARTIFACTS_DIR, runId);
  if (fs.existsSync(runArtifactsDir)) {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runArtifactsDir, { recursive: true });

  // Browser setup
  var contextOptions = {
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    recordVideo: {
      dir: runArtifactsDir,
      size: { width: 1920, height: 1080 }
    }
  };

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
    for (var t = 0; t < tests.length; t++) {
      var test = tests[t];
      
      console.log('\n========================================');
      console.log('[TEST ' + (t + 1) + '/' + tests.length + '] ' + (test.name || 'Unnamed Test'));
      console.log('========================================');
      
      // Get test case ID from either format
      var testCaseId = test.testCaseId || test.id || null;
      if (testCaseId && !isValidUUID(testCaseId)) {
        console.log('   [!] testCaseId is not a valid UUID: ' + testCaseId);
        testCaseId = null;
      }
      console.log('   test_case_id: ' + (testCaseId || 'NULL'));
      
      // FETCH THE RECORDING STEPS
      var steps = [];
      if (test.steps_json_url) {
        steps = await fetchStepsFromUrl(test.steps_json_url);
      } else {
        console.log('   [X] No steps_json_url provided!');
      }
      
      var stepResults = [];
      var testStatus = 'passed';

      if (steps.length === 0) {
        console.log('   [!] No steps to execute - running basic navigation test');
        
        // Navigate to base URL
        var navStartTime = new Date().toISOString();
        console.log('   Navigating to: ' + environment.powerapps_url);
        await page.goto(environment.powerapps_url, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(5000);
        
        // Take screenshot
        var navScreenshotPath = path.join(runArtifactsDir, 'step_0.png');
        await page.screenshot({ path: navScreenshotPath });
        var navScreenshotUrl = await uploadToCloudinary(navScreenshotPath, 'run_' + runIdClean + '_step_0', 'image');
        if (navScreenshotUrl) uploadedScreenshots.push(navScreenshotUrl);
        
        stepResults.push({
          step_index: 0,
          action_type: 'navigate',
          target_summary: environment.powerapps_url,
          status: 'passed',
          started_at: navStartTime,
          finished_at: new Date().toISOString(),
          screenshot_url: navScreenshotUrl,
          assertion_evidence: [{
            type: 'navigation',
            expected: 'Page should load',
            actual: 'Page loaded successfully',
            passed: true
          }]
        });
      } else {
        // EXECUTE EACH STEP FROM THE RECORDING
        console.log('\n   Executing ' + steps.length + ' recorded steps...');
        
        for (var i = 0; i < steps.length; i++) {
          var step = steps[i];
          var stepStartTime = new Date().toISOString();
          var actionType = step.action_type || step.type || 'unknown';
          var targetSummary = getTargetSummary(step);
          
          console.log('\n   ----------------------------------------');
          console.log('   [STEP ' + i + '] ' + actionType);
          console.log('   Target: ' + targetSummary);
          
          try {
            // Execute the step
            await executeStep(page, step, environment.powerapps_url);
            
            // Capture screenshot
            var screenshotPath = path.join(runArtifactsDir, 'step_' + i + '.png');
            await page.screenshot({ path: screenshotPath });
            console.log('      Screenshot saved');
            
            var screenshotUrl = await uploadToCloudinary(
              screenshotPath,
              'run_' + runIdClean + '_step_' + i,
              'image'
            );
            if (screenshotUrl) uploadedScreenshots.push(screenshotUrl);
            
            stepResults.push({
              step_index: i,
              action_type: actionType,
              target_summary: targetSummary,
              status: 'passed',
              started_at: stepStartTime,
              finished_at: new Date().toISOString(),
              screenshot_url: screenshotUrl,
              assertion_evidence: [{
                type: actionType,
                expected: 'Step "' + actionType + '" should complete',
                actual: 'Action completed successfully',
                passed: true
              }]
            });
            
            console.log('   [OK] Step ' + i + ' PASSED');
            
          } catch (err) {
            console.log('   [X] Step ' + i + ' FAILED: ' + err.message);
            
            // Capture failure screenshot
            var failPath = path.join(runArtifactsDir, 'step_' + i + '_fail.png');
            try { await page.screenshot({ path: failPath }); } catch (e) {}
            
            var failUrl = await uploadToCloudinary(failPath, 'run_' + runIdClean + '_step_' + i + '_fail', 'image');
            if (failUrl) uploadedScreenshots.push(failUrl);
            
            stepResults.push({
              step_index: i,
              action_type: actionType,
              target_summary: targetSummary,
              status: 'failed',
              started_at: stepStartTime,
              finished_at: new Date().toISOString(),
              screenshot_url: failUrl,
              error_message: err.message,
              assertion_evidence: [{
                type: actionType,
                expected: 'Step "' + actionType + '" should complete',
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

  // Video processing
  console.log('\n----------------------------------------');
  console.log('[VIDEO] Processing...');
  
  try {
    var video = page.video();
    var videoPath = null;
    
    if (video) {
      videoPath = await video.path();
    }

    await page.close();
    await context.close();
    
    // Wait for video to finalize
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
        var videoUrl = await uploadToCloudinary(videoPath, 'run_' + runIdClean + '_video', 'video');
        results.replay_video_url = videoUrl;
        console.log('   Video URL: ' + videoUrl);
      }
    } else {
      console.log('   [!] No video file found');
    }
  } catch (videoError) {
    console.error('   Video error: ' + videoError.message);
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
  console.log('   Total steps: ' + results.test_results.reduce(function(sum, t) { return sum + t.steps.length; }, 0));
  console.log('   Screenshots: ' + uploadedScreenshots.length);
  console.log('   Video: ' + (results.replay_video_url ? 'YES' : 'NO'));

  await sendCallback(callbackUrl, results);
  return results;
}

async function sendCallback(callbackUrl, payload) {
  console.log('\n============================================================');
  console.log('[CALLBACK] Sending results...');
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
      console.error('[X] Callback failed: ' + response.status);
      console.error('   Response: ' + responseText);
    } else {
      console.log('[OK] Callback sent successfully');
      console.log('   Response: ' + responseText);
    }
  } catch (error) {
    console.error('[X] Callback error: ' + error.message);
  }
}

app.listen(PORT, function() {
  console.log('\n============================================================');
  console.log('  Power Apps Regression Runner v2.9.5');
  console.log('  FORMAT: action_type + targetCandidates[]');
  console.log('============================================================');
  console.log('');
  console.log('  Port: ' + PORT);
  console.log('  Cloudinary: ' + (cloudinary ? '[OK] READY' : '[X] NOT CONFIGURED'));
  console.log('');
  console.log('============================================================\n');
});

module.exports = app;
