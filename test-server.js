// Minimal test server to debug startup issues
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3952;

console.log('[TEST] Starting minimal server...');
console.log('[TEST] PORT:', PORT);
console.log('[TEST] NODE_ENV:', process.env.NODE_ENV);

// Simple health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', port: PORT, timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ message: 'Test server running', port: PORT });
});

try {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[TEST] ✓ Server running on port ${PORT}`);
    console.log(`[TEST] Health check: http://localhost:${PORT}/health`);
  });
} catch (error) {
  console.error('[TEST] Failed to start:', error);
  process.exit(1);
}

process.on('uncaughtException', (error) => {
  console.error('[TEST] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[TEST] Unhandled rejection:', reason);
});