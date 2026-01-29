/**
 * Supabase Edge Function: receive-test-results
 * 
 * Receives callbacks from the Runner Service and updates your database.
 * 
 * SETUP:
 * 1. Create this file at: supabase/functions/receive-test-results/index.ts
 * 2. Deploy: npx supabase functions deploy receive-test-results
 * 3. Your callback URL: https://YOUR-PROJECT.supabase.co/functions/v1/receive-test-results
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    /**
     * Expected CallbackPayload:
     * {
     *   run_id: string;
     *   status: 'passed' | 'failed' | 'cancelled';
     *   finished_at: string;
     *   replay_video_url?: string;
     *   steps: StepResult[];
     * }
     */
    const callback = await req.json()
    
    console.log(`📥 Received callback for run: ${callback.run_id}`)
    console.log(`   Status: ${callback.status}`)
    console.log(`   Steps: ${callback.steps?.length || 0}`)

    // Update the test run record
    const { error: updateError } = await supabase
      .from('test_runs')  // Adjust table name to match your schema
      .update({
        status: callback.status,
        finished_at: callback.finished_at,
        replay_video_url: callback.replay_video_url,
        updated_at: new Date().toISOString()
      })
      .eq('id', callback.run_id)

    if (updateError) {
      console.error('Failed to update test_runs:', updateError)
      throw updateError
    }

    // Insert step results
    if (callback.steps && callback.steps.length > 0) {
      const stepRecords = callback.steps.map(step => ({
        run_id: callback.run_id,
        test_name: step.test_name,
        step_name: step.step_name,
        step_index: step.step_index,
        action: step.action,
        status: step.status,
        error: step.error,
        started_at: step.started_at,
        finished_at: step.finished_at,
        screenshot_url: step.screenshot_url
      }))

      const { error: stepsError } = await supabase
        .from('test_step_results')  // Adjust table name
        .insert(stepRecords)

      if (stepsError) {
        console.error('Failed to insert step results:', stepsError)
        // Don't throw - main record was updated
      }
    }

    console.log(`✅ Successfully processed callback for ${callback.run_id}`)

    return new Response(
      JSON.stringify({ success: true, run_id: callback.run_id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Callback processing error:', error)
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    )
  }
})


/*
 * ============================================
 * SUGGESTED DATABASE SCHEMA
 * ============================================
 * 
 * Run this SQL in your Supabase SQL Editor:
 * 
 * -- Test Runs table (if you don't have it already)
 * CREATE TABLE IF NOT EXISTS test_runs (
 *   id TEXT PRIMARY KEY,
 *   suite_id UUID REFERENCES test_suites(id),
 *   environment_name TEXT,
 *   status TEXT DEFAULT 'queued',
 *   started_at TIMESTAMPTZ,
 *   finished_at TIMESTAMPTZ,
 *   replay_video_url TEXT,
 *   created_at TIMESTAMPTZ DEFAULT NOW(),
 *   updated_at TIMESTAMPTZ DEFAULT NOW()
 * );
 * 
 * -- Step Results table
 * CREATE TABLE IF NOT EXISTS test_step_results (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   run_id TEXT REFERENCES test_runs(id),
 *   test_name TEXT,
 *   step_name TEXT,
 *   step_index INTEGER,
 *   action TEXT,
 *   status TEXT,
 *   error TEXT,
 *   started_at TIMESTAMPTZ,
 *   finished_at TIMESTAMPTZ,
 *   screenshot_url TEXT,
 *   created_at TIMESTAMPTZ DEFAULT NOW()
 * );
 * 
 * -- Index for faster lookups
 * CREATE INDEX IF NOT EXISTS idx_step_results_run_id 
 *   ON test_step_results(run_id);
 */
