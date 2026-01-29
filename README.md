# 🎭 Power Apps Regression Recorder - Runner Service

This is the test execution engine for your Lovable AI Regression Recorder. It receives test payloads, runs them against your Power Apps using Playwright, and sends results back.

## 📊 How It Works

```
┌─────────────────────┐         ┌──────────────────────┐         ┌─────────────────┐
│  Your Lovable App   │         │    Runner Service    │         │   Power Apps    │
│  (Regression        │  POST   │    (This Service)    │  Opens  │                 │
│   Recorder)         │────────▶│                      │────────▶│   Replays       │
│                     │         │  1. Receives payload │         │   test steps    │
│  Stores:            │         │  2. Launches browser │         │                 │
│  - Test bundles     │         │  3. Runs all steps   │         │                 │
│  - Test cases       │◀────────│  4. Captures video   │◀────────│                 │
│  - Results          │  POST   │  5. Sends callback   │         │                 │
└─────────────────────┘         └──────────────────────┘         └─────────────────┘
```

---

## 🚀 DEPLOYMENT OPTIONS

Choose ONE of these options:

---

### Option 1: Railway (Recommended - Easiest)

**Time needed:** ~10 minutes

#### Step 1: Create a GitHub Repository

1. Go to [github.com](https://github.com) and sign in (or create account)
2. Click the **+** button → **New repository**
3. Name it: `playwright-runner`
4. Keep it **Public** or **Private**
5. Click **Create repository**
6. Upload all the files from this folder to the repository

#### Step 2: Deploy to Railway

1. Go to [railway.app](https://railway.app)
2. Click **Login** → Sign in with GitHub
3. Click **New Project**
4. Click **Deploy from GitHub repo**
5. Select your `playwright-runner` repository
6. Railway will automatically detect it and start building

#### Step 3: Get Your URL

1. Wait for the build to complete (2-3 minutes)
2. Click on your deployment
3. Go to **Settings** → **Networking** → **Generate Domain**
4. Your URL will look like: `https://playwright-runner-production-xxxx.up.railway.app`

#### Step 4: Set Environment Variables (Optional)

In Railway, go to **Variables** and add:
- `PUBLIC_URL` = Your Railway URL (for video links)
- `MAX_CONCURRENT_RUNS` = 3 (default)

---

### Option 2: Render

**Time needed:** ~15 minutes

#### Step 1: Create GitHub Repository (same as above)

#### Step 2: Deploy to Render

1. Go to [render.com](https://render.com)
2. Sign up/login with GitHub
3. Click **New** → **Web Service**
4. Connect your GitHub repository
5. Configure:
   - **Name:** `playwright-runner`
   - **Environment:** `Docker`
   - **Plan:** Free (or Starter for better performance)
6. Add environment variable:
   - `PUBLIC_URL` = Will be your Render URL

#### Step 3: Deploy

Click **Create Web Service**. Render will build and deploy automatically.

---

### Option 3: Run Locally (For Testing)

**Time needed:** ~5 minutes

```bash
# 1. Install Node.js from https://nodejs.org (LTS version)

# 2. Open terminal, navigate to this folder
cd playwright-runner

# 3. Install dependencies
npm install

# 4. Install Playwright browser
npx playwright install chromium

# 5. Start the service
npm start
```

Your runner will be at: `http://localhost:3001`

---

### Option 4: Docker (For Advanced Users)

```bash
# Build and run
docker-compose up -d

# Or manually
docker build -t playwright-runner .
docker run -p 3001:3001 -e PUBLIC_URL=http://localhost:3001 playwright-runner
```

---

## 🔗 CONNECTING TO YOUR LOVABLE APP

Once deployed, you need to configure your Lovable app to send tests to the runner.

### Your Runner Webhook URL

```
https://YOUR-RUNNER-URL/webhook/run
```

Replace `YOUR-RUNNER-URL` with:
- Railway: `playwright-runner-production-xxxx.up.railway.app`
- Render: `playwright-runner.onrender.com`
- Local: `localhost:3001`

### What Your Lovable App Should Send

Your app queues runs by sending a POST request with this payload:

```json
{
  "runId": "unique-run-id",
  "environment": {
    "name": "Production",
    "powerapps_url": "https://apps.powerapps.com/play/..."
  },
  "suite": {
    "name": "My Test Suite",
    "tests": [
      {
        "id": "test-1",
        "name": "Test Name",
        "steps": [
          { "action": "click", "control_name": "btnSubmit" },
          { "action": "fill", "selector": "#input", "value": "Hello" }
        ]
      }
    ]
  },
  "callbackUrl": "https://your-supabase.co/functions/v1/receive-results",
  "artifacts": {
    "recordVideo": true,
    "screenshotOnFail": true
  }
}
```

---

## 📝 STEP ACTIONS REFERENCE

| Action | Description | Required Fields |
|--------|-------------|-----------------|
| `click` | Click element | `selector` OR `control_name` |
| `fill` / `type` | Type into input | `selector` OR `control_name` + `value` |
| `select` | Choose dropdown option | `selector` OR `control_name` + `value` |
| `wait` | Wait for element/time | `selector` OR `duration` |
| `assert` | Verify element state | `selector` + `type` |
| `assert_text` | Verify text content | `selector` + `value` |
| `screenshot` | Capture page | `name` (optional) |
| `hover` | Mouse hover | `selector` |
| `press` | Keyboard key | `key` |
| `scroll` | Scroll page | `selector` OR `direction` + `amount` |

### Locator Options

Steps can use any of these to find elements:

| Field | Description | Example |
|-------|-------------|---------|
| `selector` | CSS selector | `#myButton`, `.btn-primary` |
| `control_name` | Power Apps control | `btnSubmit` (becomes `[data-control-name="btnSubmit"]`) |
| `text` | Text content | `"Submit"` |
| `aria_label` | Accessibility label | `"Close dialog"` |
| `placeholder` | Input placeholder | `"Enter your name"` |

### Assertion Types

For `assert` action, use `type`:

| Type | Description |
|------|-------------|
| `visible` | Element is visible |
| `hidden` | Element is not visible |
| `enabled` | Element is enabled |
| `disabled` | Element is disabled |
| `exists` | Element exists in DOM |

---

## 📤 CALLBACK RESPONSE

The runner sends results back to your `callbackUrl`:

```json
{
  "run_id": "unique-run-id",
  "status": "passed",
  "finished_at": "2024-01-15T14:35:22.456Z",
  "replay_video_url": "https://runner/artifacts/run-id/video.webm",
  "steps": [
    {
      "test_name": "Login Test",
      "step_name": "Click login",
      "step_index": 1,
      "action": "click",
      "status": "passed",
      "started_at": "...",
      "finished_at": "...",
      "error": null
    }
  ]
}
```

---

## 🔧 HANDLING POWER APPS AUTHENTICATION

Power Apps requires authentication. Here are your options:

### Option A: Pre-Authenticated Browser State (Recommended)

1. Run the runner locally
2. Manually log into Power Apps once
3. Save the browser state
4. Deploy with saved state

### Option B: Test User Credentials

Pass credentials in the payload (requires custom handling):

```json
{
  "credentials": {
    "username": "test@company.com",
    "password": "password"
  }
}
```

### Option C: Service Principal (Advanced)

Set up an Azure AD app registration for automated access.

---

## 🐛 TROUBLESHOOTING

### "Cannot connect to runner"

- Check the runner is running (`npm start`)
- Verify the URL is correct
- Check if Railway/Render deployment succeeded

### "Element not found" / "Timeout"

- The selector might be wrong
- Add a `wait` step before the action
- Power Apps control names are case-sensitive
- Try using `text` instead of `selector`

### "Callback failed"

- Verify your Supabase function is deployed
- Check the callback URL is correct
- Look at Supabase function logs

### Videos not working

- Set `PUBLIC_URL` environment variable
- Ensure `recordVideo: true` in payload

---

## 📁 PROJECT STRUCTURE

```
playwright-runner/
├── src/
│   └── server.js           # Main service code
├── test/
│   └── test-runner.js      # Local test script
├── examples/
│   ├── example-payload.json          # Sample request
│   └── example-callback-response.json # Sample response
├── artifacts/              # Generated videos/screenshots
├── package.json
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 🆘 NEED HELP?

1. **Test locally first**: Run `npm test` (with runner running)
2. **Check the logs**: Railway and Render show real-time logs
3. **Verify the payload**: Use the examples as templates
4. **Check Power Apps**: Make sure controls have correct names

---

## 📋 QUICK CHECKLIST

- [ ] Deployed runner to Railway/Render/Docker
- [ ] Got your runner URL
- [ ] Updated Lovable app with runner URL
- [ ] Created callback endpoint in Supabase
- [ ] Tested with a simple payload
- [ ] Configured video recording (optional)

---

Built for Power Apps Regression Recorder 🎯
