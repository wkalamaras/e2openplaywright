# Use official Playwright image with browsers pre-installed
FROM mcr.microsoft.com/playwright:v1.40.0-focal

# Set working directory
WORKDIR /app

# Install Node.js dependencies first (for better caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
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

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3952/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }).on('error', () => { process.exit(1); })"

# Run as non-root user for security
RUN groupadd -r appuser && useradd -r -g appuser appuser && \
    chown -R appuser:appuser /app && \
    chown -R appuser:appuser /app/temp
USER appuser

# Start the API server
CMD ["node", "api-server.js"]