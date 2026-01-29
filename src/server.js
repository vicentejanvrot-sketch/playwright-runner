/**
 * Power Apps Regression Recorder - Runner Service
 * 
 * Matches the exact schema from RUNNER_SERVICE.md:
 * - Receives RunnerPayload via webhook
 * - Replays tests using Playwright
 * - Sends CallbackPayload with results
 */

const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve artifacts (videos, screenshots)
app.use('/artifacts', express.static(path.join(__dirname, '../artifacts')));

// Configuration
const PORT = process.env.PORT || 3001;
const MAX_CONCURRENT_RUNS = parseInt(process.env.MAX_CONCURRENT_RUNS || '3');
const ARTIFACTS_DIR = path.join(__dirname, '../artifacts');

// Ensure artifacts directory exists
if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

// Track active runs
let activeRuns = 0;
const runQueue = [];

// ============================================================
// SCHEMAS (matching RUNNER_SERVICE.md)
// ============================================================

/**
 * INCOMING: RunnerPayload
 * {
 *   runId: string;
 *   environment: {
 *     name: string;
 *     powerapps_url: string;
 *   };
 *   suite: {
 *     name: string;
 *     tests: TestPayload[];
 *   };
 *   callbackUrl: string;
 *   artifacts: {
 *     recordVideo: boolean;
 *     screenshotOnFail: boolean;
 *   };
 * }
 * 
 * OUTGOING: CallbackPayload
 * {
 *   run_id: string;
 *   status: 'passed' | 'failed' | 'cancelled';
 *   finished_at: string;
 *   replay_video_url?: string;
 *   steps: StepResult[];
 * }
 */

// ============================================================
// ENDPOINTS
// ============================================================

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'playwright-runner',
    activeRuns,
    maxConcurrent: MAX_CONCURRENT_RUNS,
    queueLength: runQueue.length
  });
});

/**
 * Main webhook endpoint - receives RunnerPayload
 */
app.post('/webhook/run', async (req, res) => {
  const payload = req.body;
  
  // Validate required fields per schema
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
  
  // Acknowledge receipt immediately
  res.json({ 
    status: 'queued', 
    runId: payload.runId,
    queuePosition: runQueue.length + 1
  });

  // Queue the run
  runQueue.push(payload);
  processQueue();
});

/**
 * Cancel a run
 */
app.post('/webhook/cancel/:runId', (req, res) => {
  const { runId } = req.params;
  
  // Remove from queue if waiting
  const queueIndex = runQueue.findIndex(p => p.runId === runId);
  if (queueIndex >= 0) {
    runQueue.splice(queueIndex, 1);
    console.log(`🛑 Cancelled queued run: ${runId}`);
    return res.json({ status: 'cancelled', runId });
  }

  // TODO: Implement cancellation of active runs
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

  // Configure video recording
  const contextOptions = {
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true
  };

  if (artifacts?.recordVideo) {
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

  try {
    // Navigate to Power Apps
    console.log(`📍 Navigating to: ${environment.powerapps_url}`);
    await page.goto(environment.powerapps_url, { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });

    // Wait for Power Apps to load
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
        // Continue with other tests or stop on first failure
        // Uncomment below to stop on first failure:
        // break;
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
      } catch (e) {
        console.log('Could not capture error screenshot');
      }
    }
  }

  // Close and save video
  await context.close();
  await browser.close();

  // Get video URL if recorded
  if (artifacts?.recordVideo) {
    const videoFiles = fs.readdirSync(runArtifactsDir).filter(f => f.endsWith('.webm'));
    if (videoFiles.length > 0) {
      // Construct public URL for video
      const baseUrl = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
      results.replay_video_url = `${baseUrl}/artifacts/${runId}/${videoFiles[0]}`;
    }
  }

  results.finished_at = new Date().toISOString();
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Run ${runId} completed: ${results.status} (${duration}s)`);

  // Send callback with results
  await sendCallback(callbackUrl, results);
  
  return results;
}

/**
 * Wait for Power Apps to fully load
 */
async function waitForPowerAppsLoad(page) {
  try {
    // Wait for common Power Apps loading indicators to disappear
    await page.waitForSelector('[class*="appLoadingSpinner"]', { 
      state: 'hidden', 
      timeout: 30000 
    }).catch(() => {});

    // Wait for main content
    await page.waitForSelector('[data-control-name], .powerapps-app, [class*="appContainer"]', {
      state: 'visible',
      timeout: 30000
    }).catch(() => {});

    // Additional settle time for dynamic content
    await page.waitForTimeout(2000);
    await page.waitForLoadState('networkidle').catch(() => {});

    console.log('  ✓ Power Apps loaded');
  } catch (error) {
    console.log('  ⚠️ Power Apps load detection timed out, continuing...');
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
      
      // Capture failure screenshot
      if (options.screenshotOnFail) {
        try {
          const screenshotPath = path.join(
            options.artifactsDir, 
            `${test.id || test.name}-step${i + 1}-failure.png`
          );
          await page.screenshot({ path: screenshotPath, fullPage: true });
          result.steps[result.steps.length - 1].screenshot_url = 
            `${process.env.PUBLIC_URL || `http://localhost:${PORT}`}/artifacts/${options.runId}/${path.basename(screenshotPath)}`;
        } catch (e) {
          console.log('Could not capture step failure screenshot');
        }
      }

      break; // Stop test on first step failure
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
      // -------- CLICK ACTIONS --------
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

      // -------- INPUT ACTIONS --------
      case 'fill':
      case 'type':
      case 'input':
      case 'text_input':
        await performFill(page, step, timeout);
        break;

      case 'clear':
        await page.locator(step.selector).clear({ timeout });
        break;

      // -------- SELECT ACTIONS --------
      case 'select':
      case 'dropdown':
      case 'select_option':
        await performSelect(page, step, timeout);
        break;

      // -------- WAIT ACTIONS --------
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

      // -------- NAVIGATION ACTIONS --------
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

      // -------- ASSERTION ACTIONS --------
      case 'assert':
      case 'verify':
      case 'check_visibility':
        await performAssertion(page, step, timeout);
        break;

      case 'assert_text':
      case 'verify_text':
        await performTextAssertion(page, step, timeout);
        break;

      // -------- KEYBOARD ACTIONS --------
      case 'press':
      case 'key':
      case 'keyboard':
        await page.keyboard.press(step.key || step.value);
        break;

      // -------- MOUSE ACTIONS --------
      case 'hover':
        await page.hover(step.selector, { timeout });
        break;

      case 'scroll':
      case 'scroll_to':
        await performScroll(page, step, timeout);
        break;

      // -------- SCREENSHOT --------
      case 'screenshot':
        const screenshotPath = path.join(
          options.artifactsDir,
          step.name || `${options.testName}-step${options.stepIndex}.png`
        );
        await page.screenshot({ path: screenshotPath, fullPage: step.fullPage !== false });
        break;

      // -------- CUSTOM/UNKNOWN --------
      default:
        console.log(`    ⚠️ Unknown action: ${step.action}`);
    }

    console.log(`    ✓ ${step.action}: ${step.selector || step.value || ''}`);

  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
    console.log(`    ✗ ${step.action} failed: ${error.message}`);
  }

  result.finished_at = new Date().toISOString();
  return result;
}

// ============================================================
// STEP IMPLEMENTATIONS (Power Apps optimized)
// ============================================================

async function performClick(page, step, timeout) {
  const locator = getLocator(page, step);
  await locator.click({ timeout });
  await waitForPowerAppsStabilize(page);
}

async function performDoubleClick(page, step, timeout) {
  const locator = getLocator(page, step);
  await locator.dblclick({ timeout });
  await waitForPowerAppsStabilize(page);
}

async function performRightClick(page, step, timeout) {
  const locator = getLocator(page, step);
  await locator.click({ button: 'right', timeout });
}

async function performFill(page, step, timeout) {
  const locator = getLocator(page, step);
  
  // Clear first if specified
  if (step.clear !== false) {
    await locator.clear({ timeout });
  }
  
  await locator.fill(step.value || step.text || '', { timeout });
  await waitForPowerAppsStabilize(page);
}

async function performSelect(page, step, timeout) {
  const locator = getLocator(page, step);
  
  try {
    // Try standard select first
    await locator.selectOption(step.value, { timeout: 5000 });
  } catch (e) {
    // Power Apps uses custom dropdowns - click to open, then select option
    await locator.click({ timeout });
    await page.waitForTimeout(500);
    
    // Find and click the option
    const optionLocator = page.getByText(step.value, { exact: step.exact });
    await optionLocator.click({ timeout });
  }
  
  await waitForPowerAppsStabilize(page);
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

    case 'enabled':
      await expect(locator).toBeEnabled({ timeout });
      break;

    case 'disabled':
      await expect(locator).toBeDisabled({ timeout });
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
// LOCATOR HELPERS (Power Apps specific)
// ============================================================

function getLocator(page, step) {
  // Priority: selector > control_name > text > aria_label
  
  if (step.selector) {
    return page.locator(step.selector);
  }
  
  if (step.control_name) {
    // Power Apps control name
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

  throw new Error('No valid locator provided (selector, control_name, text, aria_label, placeholder, or role)');
}

async function waitForPowerAppsStabilize(page) {
  // Brief wait for Power Apps to process the action
  await page.waitForTimeout(300);
  
  // Wait for loading indicators to disappear
  try {
    await page.waitForSelector('[class*="Spinner"], [class*="loading"], [class*="busy"]', {
      state: 'hidden',
      timeout: 10000
    });
  } catch (e) {
    // No spinner found, continue
  }
}

// ============================================================
// CALLBACK
// ============================================================

async function sendCallback(callbackUrl, payload) {
  console.log(`\n📤 Sending callback to: ${callbackUrl}`);
  console.log(`   Status: ${payload.status}`);
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
║  🎭 Power Apps Regression Recorder - Runner Service           ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║  Port: ${PORT}                                                  ║
║  Max Concurrent Runs: ${MAX_CONCURRENT_RUNS}                                        ║
║  Artifacts Directory: ${ARTIFACTS_DIR.substring(0, 30)}...     
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /health             - Health check                    ║
║    POST /webhook/run        - Execute test run                ║
║    POST /webhook/cancel/:id - Cancel a run                    ║
║    GET  /artifacts/*        - Download artifacts              ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

module.exports = app;
