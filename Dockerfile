# Power Apps Regression Runner
# Uses Playwright's official image with all browser dependencies

FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Create artifacts directory
RUN mkdir -p /app/artifacts

# Create non-root user for security
RUN useradd -m appuser && chown -R appuser:appuser /app
USER appuser

# Environment variables
ENV PORT=3001
ENV MAX_CONCURRENT_RUNS=3
ENV PUBLIC_URL=""

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the service
CMD ["npm", "start"]
