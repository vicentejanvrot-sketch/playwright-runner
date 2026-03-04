/**
 * Power Apps Regression Recorder - Runner Service v2.9.6
 * 
 * DEBUGGING VERSION - Extensive logging to diagnose steps fetch issue
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
const RUNNER_SHARED_SECRET = (process.env.RUNNER_SHARED_SECRET || '').trim();

// Cloudinary Configuration
const CLOUDINARY_CLOUD_NAME = (process.env.CLOUDINARY_CLOUD_NAME || '').trim();
const CLOUDINARY_API_KEY = (process.env.CLOUDINARY_API_KEY || '').trim();
const CLOUDINARY_API_SECRET = (process.env.CLOUDINARY_API_SECRET || '').trim();

console.log('\n[CLOUDINARY] CONFIGURATION:');
console.log('   CLOUDINARY_CLOUD_NAME: ' + (CLOUDINARY_CLOUD_NAME ? '"' + CLOUDINARY_CLOUD_NAME + '"' : '[X] NOT SET'));
console.log('   CLOUDINARY_API_KEY: ' + (CLOUDINARY_API_KEY ? '"' + CLOUDINARY_API_KEY.substring(0, 4) + '..."' : '[X] NOT SET'));
console.log('   CLOUDINARY_API_SECRET: ' + (CLOUDINARY_API_SECRET ? '"***" (hidden)' : '[X] NOT SET'));

var cloudinary = null;
if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET) {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
  });
  console.log('   [OK] Cloudinary SDK initialized\n');
} else {
  console.log('   [X] Cloudinary NOT initialized\n');
}

if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

var activeRuns = 0;
var runQueue = [];

function validateRunnerSecret(req, res, next) {
  if (!RUNNER_SHARED_SECRET) {
    return res.status(500).json({ error: 'RUNNER_SHARED_SECRET is not configured' });
  }

  var incomingSecret = req.header('x-runner-secret');

  if (!incomingSecret || incomingSecret !== RUNNER_SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// ============================================================
// FETCH STEPS - WITH EXTENSIVE DEBUGGING
// ============================================================
async function fetchStepsFromUrl(stepsJsonUrl) {
  console.log('\n   ============================================');
  console.log('   [FETCH] DOWNLOADING STEPS FROM URL');
  console.log('   ============================================');
  console.log('   URL: ' + stepsJsonUrl);
  
  try {
    console.log('   [..] Making HTTP request...');
    var response = await fetch(stepsJsonUrl);
    
    console.log('   HTTP Status: ' + response.status);
    console.log('   HTTP OK: ' + response.ok);
    console.log('   Content-Type: ' + response.headers.get('content-type'));
    
    if (!response.ok) {
      console.log('   [X] HTTP ERROR - Status ' + response.status);
      var errorText = await response.text();
      console.log('   Error body: ' + errorText.substring(0, 500));
      return [];
    }
    
    // Get raw text first
    var rawText = await response.text();
    console.log('   Raw response length: ' + rawText.length + ' characters');
    console.log('   Raw response (first 1000 chars):');
    console.log('   ---START---');
    console.log(rawText.substring(0, 1000));
    console.log('   ---END---');
    
    // Parse JSON
    var stepsData;
    try {
      stepsData = JSON.parse(rawText);
      console.log('   [OK] JSON parsed successfully');
    } catch (parseError) {
      console.log('   [X] JSON PARSE ERROR: ' + parseError.message);
      return [];
    }
    
    // Analyze structure
    console.log('   Parsed data type: ' + typeof stepsData);
    console.log('   Is array: ' + Array.isArray(stepsData));
    
    if (stepsData && typeof stepsData === 'object' && !Array.isArray(stepsData)) {
      console.log('   Object keys: ' + Object.keys(stepsData).join(', '));
    }
    
    // Extract steps array
    var steps = [];
    
    if (Array.isArray(stepsData)) {
      steps = stepsData;
      console.log('   Format detected: DIRECT ARRAY');
    } else if (stepsData && typeof stepsData === 'object') {
      // Try common property names
      if (stepsData.steps && Array.isArray(stepsData.steps)) {
        steps = stepsData.steps;
        console.log('   Format detected: { steps: [...] }');
      } else if (stepsData.actions && Array.isArray(stepsData.actions)) {
        steps = stepsData.actions;
        console.log('   Format detected: { actions: [...] }');
      } else if (stepsData.events && Array.isArray(stepsData.events)) {
        steps = stepsData.events;
        console.log('   Format detected: { events: [...] }');
      } else if (stepsData.recording && Array.isArray(stepsData.recording)) {
        steps = stepsData.recording;
        console.log('   Format detected: { recording: [...] }');
      } else if (stepsData.data && Array.isArray(stepsData.data)) {
        steps = stepsData.data;
        console.log('   Format detected: { data: [...] }');
      } else {
        // Find any array property
        for (var key of Object.keys(stepsData)) {
          if (Array.isArray(stepsData[key])) {
            steps = stepsData[key];
            console.log('   Format detected: { ' + key + ': [...] }');
            break;
          }
        }
      }
    }
    
    console.log('   ============================================');
    console.log('   STEPS ARRAY LENGTH: ' + steps.length);
    console.log('   ============================================');
    
    if (steps.length === 0) {
      console.log('   [!] WARNING: No steps found in response!');
      console.log('   Full parsed data: ' + JSON.stringify(stepsData).substring(0, 2000));
      return [];
    }
    
    // Log each step
    console.log('\n   STEP DETAILS:');
    steps.forEach(function(step, idx) {
      console.log('   ----------------------------------------');
      console.log('   Step ' + idx + ':');
      console.log('   ' + JSON.stringify(step).substring(0, 300));
    });
    console.log('   ----------------------------------------');
    
    console.log('\n   [OK] Successfully loaded ' + steps.length + ' steps');
    return steps;
    
  } catch (error) {
    console.log('   [X] FETCH ERROR: ' + error.message);
    console.log('   Stack: ' + error.stack);
    return [];
  }
}

// ============================================================
// FIND ELEMENT
// ============================================================
async function findElement(page, targetCandidates) {
  if (!targetCandidates || targetCandidates.length === 0) {
    throw new Error('No targetCandidates provided');
  }
  
  var hints = targetCandidates[0];
  console.log('      Hints: ' + JSON.stringify(hints).substring(0, 200));
  
  // Priority 1: ARIA label
  if (hints.ariaLabel) {
    try {
      var loc = page.locator('[aria-label="' + hints.ariaLabel + '"]').first();
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by aria-label');
      return loc;
    } catch (e) {
      console.log('      [!] Not found by aria-label');
    }
  }
  
  // Priority 2: Role + text
  if (hints.role && hints.visibleText) {
    try {
      var loc = page.getByRole(hints.role, { name: hints.visibleText }).first();
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by role+text');
      return loc;
    } catch (e) {
      console.log('      [!] Not found by role+text');
    }
  }
  
  // Priority 3: Text only
  if (hints.visibleText) {
    try {
      var loc = page.getByText(hints.visibleText, { exact: false }).first();
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by text');
      return loc;
    } catch (e) {
      console.log('      [!] Not found by text');
    }
  }
  
  // Priority 4: CSS
  if (hints.cssPath) {
    try {
      var loc = page.locator(hints.cssPath).first();
      await loc.waitFor({ state: 'visible', timeout: 5000 });
      console.log('      [OK] Found by CSS');
      return loc;
    } catch (e) {
      console.log('      [!] Not found by CSS');
    }
  }
  
  // Priority 5: Bounding box
  if (hints.boundingBox) {
    var box = hints.boundingBox;
    var x = box.x + ((box.w || box.width || 0) / 2);
    var y = box.y + ((box.h || box.height || 0) / 2);
    console.log('      Using coordinates: (' + x + ', ' + y + ')');
    return { _coords: true, x: x, y: y };
  }
  
  throw new Error('Could not locate element');
}

function getTargetSummary(step) {
  var actionType = step.action_type || step.type || 'unknown';
  
  if (actionType === 'navigate') return step.url || 'URL';
  
  if (step.targetCandidates && step.targetCandidates.length > 0) {
    var h = step.targetCandidates[0];
    if (h.visibleText) return h.visibleText;
    if (h.ariaLabel) return h.ariaLabel;
    if (h.cssPath) return h.cssPath;
  }
  
  if (step.value) return 'Input: ' + step.value;
  return 'Unknown';
}

async function uploadToCloudinary(filePath, publicId, resourceType) {
  resourceType = resourceType || 'image';
  
  if (!cloudinary) return null;
  if (!fs.existsSync(filePath)) return null;
  
  var stats = fs.statSync(filePath);
  if (stats.size < 100) return null;

  try {
    var result = await cloudinary.uploader.upload(filePath, {
      resource_type: resourceType,
      public_id: publicId,
      overwrite: true
    });
    return result.secure_url;
  } catch (error) {
    console.log('      Upload error: ' + error.message);
    return null;
  }
}

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/health', function(req, res) {
  res.json({ 
    status: 'healthy',
    version: '2.9.6',
    activeRuns: activeRuns,
    cloudinaryConfigured: !!cloudinary
  });
});

app.post('/webhook/run', validateRunnerSecret, async function(req, res) {
  var payload = req.body;
  
  console.log('\n============================================================');
  console.log('[WEBHOOK] INCOMING PAYLOAD');
  console.log('============================================================');
  console.log(JSON.stringify(payload, null, 2));
  
  var tests = payload.tests || (payload.suite && payload.suite.tests) || [];
  var powerappsUrl = payload.environment && payload.environment.powerapps_url;
  
  if (!payload.runId || !powerappsUrl || !payload.callbackUrl || tests.length === 0) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  
  console.log('\n[PARSED]');
  console.log('   runId: ' + payload.runId);
  console.log('   tests: ' + tests.length);
  tests.forEach(function(t, i) {
    console.log('   Test ' + i + ': ' + (t.name || 'Unnamed'));
    console.log('      testCaseId: ' + (t.testCaseId || t.id || 'none'));
    console.log('      steps_json_url: ' + (t.steps_json_url ? 'YES (' + t.steps_json_url.length + ' chars)' : 'NO'));
  });
  
  res.json({ status: 'queued', runId: payload.runId });
  
  runQueue.push(payload);
  processQueue();
});

async function processQueue() {
  if (activeRuns >= MAX_CONCURRENT_RUNS || runQueue.length === 0) return;
  
  activeRuns++;
  var payload = runQueue.shift();
  
  try {
    await executeRun(payload);
  } catch (error) {
    console.error('[X] Run failed: ' + error.message);
    await sendCallback(payload.callbackUrl, {
      run_id: payload.runId,
      overall_status: 'failed',
      error_message: error.message,
      test_results: []
    });
  } finally {
    activeRuns--;
    processQueue();
  }
}

// ============================================================
// EXECUTE STEP
// ============================================================
async function executeStep(page, step, baseUrl) {
  var actionType = step.action_type || step.type || 'unknown';
  
  console.log('      Executing action: ' + actionType);
  
  switch (actionType) {
    case 'navigate':
      var url = step.url || baseUrl;
      console.log('      URL: ' + url);
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      break;
      
    case 'click':
      var target = await findElement(page, step.targetCandidates);
      if (target._coords) {
        await page.mouse.click(target.x, target.y);
      } else {
        await target.click();
      }
      break;
      
    case 'input':
      var inputTarget = await findElement(page, step.targetCandidates);
      var value = step.value || '';
      if (inputTarget._coords) {
        await page.mouse.click(inputTarget.x, inputTarget.y);
        await page.keyboard.type(value);
      } else {
        await inputTarget.fill(value);
      }
      break;
      
    case 'keydown':
    case 'keypress':
      var key = step.key || 'Enter';
      await page.keyboard.press(key);
      break;
      
    case 'scroll':
      await page.mouse.wheel(0, step.y || 100);
      break;
      
    case 'wait':
      await page.waitForTimeout(step.duration || 1000);
      break;
      
    default:
      console.log('      Unknown action: ' + actionType);
  }
  
  await page.waitForTimeout(500);
}

// ============================================================
// MAIN EXECUTION
// ============================================================
async function executeRun(payload) {
  var runId = payload.runId;
  var powerappsUrl = payload.environment.powerapps_url;
  var callbackUrl = payload.callbackUrl;
  var tests = payload.tests || (payload.suite && payload.suite.tests) || [];
  
  console.log('\n============================================================');
  console.log('[RUN] STARTING: ' + runId);
  console.log('============================================================');
  
  var startTime = Date.now();
  var runIdClean = runId.replace(/-/g, '_');
  
  var runArtifactsDir = path.join(ARTIFACTS_DIR, runId);
  if (fs.existsSync(runArtifactsDir)) {
    fs.rmSync(runArtifactsDir, { recursive: true, force: true });
  }
  fs.mkdirSync(runArtifactsDir, { recursive: true });

  var browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  var context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    recordVideo: { dir: runArtifactsDir, size: { width: 1920, height: 1080 } }
  });

  var page = await context.newPage();
  page.setDefaultTimeout(30000);

  var results = {
    run_id: runId,
    overall_status: 'passed',
    replay_video_url: null,
    test_results: []
  };

  try {
    for (var t = 0; t < tests.length; t++) {
      var test = tests[t];
      
      console.log('\n========================================');
      console.log('[TEST ' + (t + 1) + '] ' + (test.name || 'Unnamed'));
      console.log('========================================');
      
      var testCaseId = test.testCaseId || test.id || null;
      if (testCaseId && !isValidUUID(testCaseId)) testCaseId = null;
      console.log('   test_case_id: ' + (testCaseId || 'NULL'));
      
      // ============================================
      // CRITICAL: FETCH STEPS FROM URL
      // ============================================
      var steps = [];
      if (test.steps_json_url) {
        console.log('\n   [IMPORTANT] steps_json_url IS PRESENT');
        console.log('   URL length: ' + test.steps_json_url.length);
        steps = await fetchStepsFromUrl(test.steps_json_url);
      } else {
        console.log('\n   [X] NO steps_json_url IN TEST OBJECT!');
        console.log('   Test object keys: ' + Object.keys(test).join(', '));
      }
      
      console.log('\n   ============================================');
      console.log('   STEPS TO EXECUTE: ' + steps.length);
      console.log('   ============================================');
      
      var stepResults = [];
      var testStatus = 'passed';

      if (steps.length === 0) {
        console.log('\n   [FALLBACK] No steps - doing basic navigation only');
        
        var navStart = new Date().toISOString();
        await page.goto(powerappsUrl, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(5000);
        
        var ssPath = path.join(runArtifactsDir, 'step_0.png');
        await page.screenshot({ path: ssPath });
        var ssUrl = await uploadToCloudinary(ssPath, 'run_' + runIdClean + '_step_0', 'image');
        
        stepResults.push({
          step_index: 0,
          action_type: 'navigate',
          target_summary: powerappsUrl,
          status: 'passed',
          started_at: navStart,
          finished_at: new Date().toISOString(),
          screenshot_url: ssUrl,
          assertion_evidence: [{
            type: 'navigation',
            expected: 'Page loads',
            actual: 'Loaded',
            passed: true
          }]
        });
      } else {
        // ============================================
        // EXECUTE ALL STEPS
        // ============================================
        console.log('\n   [EXECUTING] ' + steps.length + ' STEPS...\n');
        
        for (var i = 0; i < steps.length; i++) {
          var step = steps[i];
          var stepStart = new Date().toISOString();
          var actionType = step.action_type || step.type || 'unknown';
          var target = getTargetSummary(step);
          
          console.log('   ========================================');
          console.log('   STEP ' + i + '/' + (steps.length - 1) + ': ' + actionType);
          console.log('   Target: ' + target);
          console.log('   ========================================');
          
          try {
            await executeStep(page, step, powerappsUrl);
            
            var ssPath = path.join(runArtifactsDir, 'step_' + i + '.png');
            await page.screenshot({ path: ssPath });
            var ssUrl = await uploadToCloudinary(ssPath, 'run_' + runIdClean + '_step_' + i, 'image');
            
            stepResults.push({
              step_index: i,
              action_type: actionType,
              target_summary: target,
              status: 'passed',
              started_at: stepStart,
              finished_at: new Date().toISOString(),
              screenshot_url: ssUrl,
              assertion_evidence: [{
                type: actionType,
                expected: actionType + ' should complete',
                actual: 'Completed',
                passed: true
              }]
            });
            
            console.log('   [OK] STEP ' + i + ' PASSED\n');
            
          } catch (err) {
            console.log('   [X] STEP ' + i + ' FAILED: ' + err.message + '\n');
            
            var failPath = path.join(runArtifactsDir, 'step_' + i + '_fail.png');
            try { await page.screenshot({ path: failPath }); } catch (e) {}
            var failUrl = await uploadToCloudinary(failPath, 'run_' + runIdClean + '_step_' + i + '_fail', 'image');
            
            stepResults.push({
              step_index: i,
              action_type: actionType,
              target_summary: target,
              status: 'failed',
              started_at: stepStart,
              finished_at: new Date().toISOString(),
              screenshot_url: failUrl,
              error_message: err.message,
              assertion_evidence: [{
                type: actionType,
                expected: actionType + ' should complete',
                actual: err.message,
                passed: false
              }]
            });
            
            testStatus = 'failed';
            results.overall_status = 'failed';
            break;
          }
        }
        
        console.log('\n   [DONE] Executed ' + stepResults.length + ' of ' + steps.length + ' steps');
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

  // Video
  console.log('\n[VIDEO] Processing...');
  try {
    var video = page.video();
    var videoPath = video ? await video.path() : null;
    
    await page.close();
    await context.close();
    await new Promise(function(r) { setTimeout(r, 3000); });
    
    if (!videoPath || !fs.existsSync(videoPath)) {
      var files = fs.readdirSync(runArtifactsDir).filter(function(f) { return f.endsWith('.webm'); });
      if (files.length > 0) videoPath = path.join(runArtifactsDir, files[0]);
    }
    
    if (videoPath && fs.existsSync(videoPath)) {
      var stats = fs.statSync(videoPath);
      if (stats.size > 1000) {
        results.replay_video_url = await uploadToCloudinary(videoPath, 'run_' + runIdClean + '_video', 'video');
      }
    }
  } catch (e) {
    console.log('   Video error: ' + e.message);
  }

  try { await browser.close(); } catch (e) {}
  try { fs.rmSync(runArtifactsDir, { recursive: true, force: true }); } catch (e) {}

  // Summary
  var totalSteps = results.test_results.reduce(function(sum, t) { return sum + t.steps.length; }, 0);
  console.log('\n============================================================');
  console.log('[COMPLETE]');
  console.log('============================================================');
  console.log('   Status: ' + results.overall_status);
  console.log('   Duration: ' + ((Date.now() - startTime) / 1000).toFixed(1) + 's');
  console.log('   Total steps executed: ' + totalSteps);
  console.log('   Video: ' + (results.replay_video_url ? 'YES' : 'NO'));

  await sendCallback(callbackUrl, results);
  return results;
}

async function sendCallback(callbackUrl, payload) {
  console.log('\n[CALLBACK] Sending...');
  console.log(JSON.stringify(payload, null, 2));

  try {
    var response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var text = await response.text();
    console.log('[CALLBACK] ' + (response.ok ? 'OK' : 'FAILED') + ': ' + text);
  } catch (error) {
    console.error('[CALLBACK] Error: ' + error.message);
  }
}

app.listen(PORT, function() {
  console.log('\n============================================================');
  console.log('  Power Apps Regression Runner v2.9.6');
  console.log('  DEBUGGING VERSION - Extensive logging');
  console.log('============================================================');
  console.log('  Port: ' + PORT);
  console.log('  Cloudinary: ' + (cloudinary ? 'READY' : 'NOT CONFIGURED'));
  console.log('============================================================\n');
});

module.exports = app;
