# Power Apps Regression Runner
# Uses Playwright's official image with all browser dependencies

FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (use npm install instead of npm ci)
RUN npm install --only=production

# Copy source code
COPY src/ ./src/

# Create artifacts directory
RUN mkdir -p /app/artifacts

# Environment variables
ENV PORT=3001
ENV MAX_CONCURRENT_RUNS=3
ENV PUBLIC_URL=""

# Expose port
EXPOSE 3001

# Start the service
CMD ["npm", "start"]
