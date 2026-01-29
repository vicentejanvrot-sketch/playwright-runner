/**
 * Complete TypeScript Types for Runner Service
 * 
 * Based on RUNNER_SERVICE.md with expanded details.
 * Use these types in your Lovable app when queuing test runs.
 */

// ============================================================
// INCOMING PAYLOAD (what your Lovable app sends)
// ============================================================

export interface RunnerPayload {
  /** Unique identifier for this test run */
  runId: string;
  
  /** Environment configuration */
  environment: {
    /** Display name (e.g., "Production", "UAT") */
    name: string;
    /** Full Power Apps URL to test against */
    powerapps_url: string;
  };
  
  /** Test suite to execute */
  suite: {
    /** Suite name */
    name: string;
    /** Array of tests to run */
    tests: TestPayload[];
  };
  
  /** URL where runner will POST results */
  callbackUrl: string;
  
  /** Artifact options */
  artifacts: {
    /** Record video of the entire run */
    recordVideo: boolean;
    /** Capture screenshot when a step fails */
    screenshotOnFail: boolean;
  };
}

export interface TestPayload {
  /** Unique test identifier */
  id: string;
  /** Test name */
  name: string;
  /** Steps to execute */
  steps: StepPayload[];
}

export interface StepPayload {
  /** Action to perform */
  action: 
    | 'click' 
    | 'doubleclick' 
    | 'rightclick'
    | 'fill' 
    | 'type' 
    | 'clear'
    | 'select' 
    | 'wait' 
    | 'wait_for_text'
    | 'wait_for_navigation'
    | 'navigate' 
    | 'reload'
    | 'back'
    | 'forward'
    | 'assert' 
    | 'assert_text'
    | 'screenshot'
    | 'hover'
    | 'press'
    | 'scroll';
  
  /** Step name/description */
  name?: string;
  description?: string;
  
  // ---- Locators (use one) ----
  /** CSS selector */
  selector?: string;
  /** Power Apps control name */
  control_name?: string;
  /** Text content to find */
  text?: string;
  /** Aria label */
  aria_label?: string;
  /** Input placeholder */
  placeholder?: string;
  
  // ---- Values ----
  /** Value for fill/select actions */
  value?: string;
  /** Duration in ms for wait action */
  duration?: string;
  /** Key name for press action */
  key?: string;
  /** URL for navigate action */
  url?: string;
  
  // ---- Assertion options ----
  /** Assertion type: visible, hidden, enabled, disabled, exists */
  type?: 'visible' | 'hidden' | 'enabled' | 'disabled' | 'exists';
  /** Exact text match */
  exact?: boolean;
  
  // ---- Scroll options ----
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  x?: number;
  y?: number;
  
  // ---- Other ----
  /** Custom timeout in ms */
  timeout?: number;
  /** Full page screenshot */
  fullPage?: boolean;
}

// ============================================================
// CALLBACK PAYLOAD (what the runner sends back)
// ============================================================

export interface CallbackPayload {
  /** Run ID matching the request */
  run_id: string;
  
  /** Final status */
  status: 'passed' | 'failed' | 'cancelled';
  
  /** ISO timestamp when run completed */
  finished_at: string;
  
  /** URL to video recording (if enabled) */
  replay_video_url?: string;
  
  /** Results for each step */
  steps: StepResult[];
}

export interface StepResult {
  /** Name of the test this step belongs to */
  test_name: string;
  
  /** Step name/description */
  step_name: string;
  
  /** Step index (1-based) */
  step_index: number;
  
  /** Action that was executed */
  action: string;
  
  /** Step result */
  status: 'passed' | 'failed';
  
  /** Error message if failed */
  error?: string | null;
  
  /** When step started */
  started_at: string;
  
  /** When step finished */
  finished_at: string;
  
  /** Screenshot URL if captured */
  screenshot_url?: string;
}


// ============================================================
// EXAMPLE USAGE IN LOVABLE APP
// ============================================================

/*
import type { RunnerPayload } from './types';

const payload: RunnerPayload = {
  runId: `run-${Date.now()}`,
  environment: {
    name: 'Production',
    powerapps_url: 'https://apps.powerapps.com/play/...'
  },
  suite: {
    name: 'Regression Suite',
    tests: myRecordedTests  // Your recorded test cases
  },
  callbackUrl: 'https://your-project.supabase.co/functions/v1/receive-test-results',
  artifacts: {
    recordVideo: true,
    screenshotOnFail: true
  }
};

// Send to runner
await fetch('https://your-runner.railway.app/webhook/run', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload)
});
*/
