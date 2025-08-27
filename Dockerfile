# Use the official Playwright image which has browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# Create app directory
WORKDIR /app

# Copy only package files first (for better caching)
COPY package*.json ./

# Install dependencies (this layer will be cached if package.json doesn't change)
RUN npm ci --only=production

# Install Chromium browser (this will also be cached)
RUN npx playwright install chromium

# Copy application files (these change more frequently)
COPY *.js ./

# Create temp directory for PDF storage with proper permissions
RUN mkdir -p /app/temp && \
    chmod 755 /app/temp

# Create a non-root user to run the app
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app

# For Coolify persistent volumes, run as root to handle permissions
# Comment out USER directive to run as root
# USER appuser

# Set environment variables
ENV NODE_ENV=production
ENV PDF_SAVE_PATH=/app/temp
ENV PORT=3952
ENV HEADLESS=true
ENV OPEN_PDF_AFTER_SAVE=false

# Expose port
EXPOSE 3952

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3952) + '/health', (r) => {r.statusCode === 200 ? process.exit(0) : process.exit(1)})"

# Start the API server
CMD ["node", "api-server.js"]