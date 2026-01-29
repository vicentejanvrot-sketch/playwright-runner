# Power Apps Regression Runner v2.1
# WITH VIDEO UPLOAD TO CLOUDINARY

FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy source code
COPY src/ ./src/

# Create artifacts directory
RUN mkdir -p /app/artifacts

# Environment variables
ENV PORT=3001
ENV MAX_CONCURRENT_RUNS=3

# Cloudinary configuration (set these in Render)
ENV CLOUDINARY_CLOUD_NAME=""
ENV CLOUDINARY_API_KEY=""
ENV CLOUDINARY_API_SECRET=""

# Expose port
EXPOSE 3001

# Start the service
CMD ["npm", "start"]
