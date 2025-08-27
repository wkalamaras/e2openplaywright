# Use official Playwright image with browsers pre-installed
# Build timestamp: 2025-08-27
FROM mcr.microsoft.com/playwright:v1.48.0-focal

# Set working directory
WORKDIR /app

# Copy ONLY package files first for dependency caching
# This layer will be cached unless package.json changes
COPY package.json package-lock.json ./

# Install curl for health checks and dependencies
RUN echo "=== Installing system dependencies ===" && \
    apt-get update && \
    apt-get install -y curl && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    echo "=== System dependencies installed ==="

# Install dependencies - this will be cached if package files don't change
RUN echo "=== Installing Node.js dependencies ===" && \
    echo "Running npm ci for production dependencies..." && \
    npm ci --only=production && \
    echo "=== Node.js dependencies installed ===" && \
    echo "Cleaning npm cache..." && \
    npm cache clean --force && \
    echo "=== Checking Playwright browsers ===" && \
    npx playwright --version && \
    echo "=== Installing Playwright browsers ===" && \
    npx playwright install chromium && \
    echo "=== Verifying Chromium installation ===" && \
    npx playwright install-deps chromium 2>&1 || echo "Chromium deps already satisfied" && \
    echo "=== All dependencies ready ==="

# Copy application files AFTER dependencies
# This way, code changes don't invalidate the dependency cache
COPY *.js ./

# Create temp directory for PDF storage with proper permissions
RUN mkdir -p /app/temp && \
    chmod 755 /app/temp

# Set environment variables
ENV NODE_ENV=production
ENV PDF_SAVE_PATH=/app/temp
ENV PORT=3952
ENV HEADLESS=true
ENV OPEN_PDF_AFTER_SAVE=false

# Expose port
EXPOSE 3952

# Add health check using curl
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:3952/health || exit 1

# Run as non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:appuser /app/temp
USER appuser

# Start the API server
CMD ["node", "api-server.js"]