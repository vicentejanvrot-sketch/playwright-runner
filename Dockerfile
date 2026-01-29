# Power Apps Regression Runner v2.2
# BULLETPROOF VERSION - Installs matching Playwright browsers

FROM node:20-bookworm

WORKDIR /app

# Install dependencies required for Playwright browsers
RUN apt-get update && apt-get install -y \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package.json ./

# Install Node.js dependencies
RUN npm install --only=production

# Install Playwright browsers (this ensures version match!)
RUN npx playwright install chromium
RUN npx playwright install-deps chromium

# Copy source code
COPY src/ ./src/

# Create artifacts directory
RUN mkdir -p /app/artifacts

# Environment variables
ENV PORT=3001
ENV MAX_CONCURRENT_RUNS=3
ENV CLOUDINARY_CLOUD_NAME=""
ENV CLOUDINARY_API_KEY=""
ENV CLOUDINARY_API_SECRET=""

EXPOSE 3001

CMD ["npm", "start"]
```

### 2. Replace `package.json`
(In the ZIP file)

### 3. Replace `src/server.js`
(In the ZIP file - has improved video capture and detailed logging)

---

## ⚠️ Important: Clear Build Cache

After updating GitHub, go to Render:

1. Go to your service → **Settings**
2. Scroll to **Build & Deploy**
3. Click **"Clear build cache & deploy"**

This forces a fresh build with the new Dockerfile.

---

## ✅ After Deploy - Check Logs

Look for these messages:
```
🎭 Power Apps Regression Runner v2.2
Cloud Name: your-cloud-name
API Key: ✓ SET
API Secret: ✓ SET
```

Then run a test and look for:
```
📹 VIDEO RECORDING: ENABLED
🌐 Launching browser...
✓ Browser launched
