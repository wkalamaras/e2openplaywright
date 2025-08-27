const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3952;

// Global browser session management
let browserSession = {
  browser: null,
  context: null,
  page: null,
  isLoggedIn: false,
  lastActivity: null,
  sessionId: null
};

// Session timeout (30 minutes)
const SESSION_TIMEOUT = 30 * 60 * 1000;

app.use(express.json());

// Middleware to log requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  console.log('Headers:', req.headers);
  next();
});

// Health check endpoint
app.get('/health', async (req, res) => {
  const sessionStatus = await checkBrowserSession();
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    session: {
      active: sessionStatus.active,
      loggedIn: sessionStatus.loggedIn,
      lastActivity: browserSession.lastActivity,
      sessionId: browserSession.sessionId
    }
  });
});

// Session status endpoint
app.get('/api/session', async (req, res) => {
  const status = await checkBrowserSession();
  res.json(status);
});

// Force new session endpoint
app.post('/api/session/reset', async (req, res) => {
  console.log('Force resetting browser session...');
  await closeBrowserSession();
  const status = await initializeBrowserSession();
  res.json(status);
});

// Main automation endpoint
app.post('/api/automation', async (req, res) => {
  // Get action and parameters from headers
  const action = req.headers['x-action'] || req.headers.action;
  const loadNumber = req.headers['x-load-number'] || req.headers.load || req.body.loadNumber;
  
  console.log(`[AUTOMATION] Processing action: ${action}, Load: ${loadNumber}`);
  
  // Validate required parameters
  if (!action) {
    return res.status(400).json({ 
      error: 'Missing required header: action',
      message: 'Please provide x-action header (e.g., printloadconfirmation)'
    });
  }
  
  // Route to appropriate action
  switch (action.toLowerCase()) {
    case 'printloadconfirmation':
    case 'print-load-confirmation':
      if (!loadNumber) {
        return res.status(400).json({ 
          error: 'Missing required header: load',
          message: 'Please provide x-load-number header with the load number'
        });
      }
      
      try {
        const pdfPath = await executeLoadConfirmation(loadNumber);
        
        // Read the PDF file
        const pdfBuffer = await fs.readFile(pdfPath);
        
        // Generate the proper filename for the response
        const today = new Date();
        const dateStr = String(today.getMonth() + 1).padStart(2, '0') + '.' + 
                       String(today.getDate()).padStart(2, '0') + '.' + 
                       String(today.getFullYear()).slice(-2);
        const responseFilename = `RATECON MULDER BROTHERS ${loadNumber} ${dateStr}.pdf`;
        
        // Set response headers for PDF with proper filename
        res.set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${responseFilename}"`,
          'Content-Length': pdfBuffer.length
        });
        
        // Send PDF as binary response
        res.send(pdfBuffer);
        
        // Clean up: Delete the file after response is sent
        res.on('finish', async () => {
          try {
            await fs.unlink(pdfPath);
            console.log(`[CLEANUP] Deleted temporary file: ${path.basename(pdfPath)}`);
          } catch (err) {
            console.error(`[CLEANUP] Failed to delete file: ${err.message}`);
          }
        });
        
      } catch (error) {
        console.error('[ERROR] Automation failed:', error);
        res.status(500).json({ 
          error: 'Automation failed',
          message: error.message,
          details: error.stack
        });
      }
      break;
      
    default:
      res.status(400).json({ 
        error: 'Unknown action',
        message: `Action '${action}' is not supported`,
        supportedActions: ['printloadconfirmation']
      });
  }
});

// Check browser session status
async function checkBrowserSession() {
  const now = Date.now();
  const isActive = browserSession.browser && 
                   browserSession.context && 
                   browserSession.page;
  
  const isTimedOut = browserSession.lastActivity && 
                     (now - browserSession.lastActivity) > SESSION_TIMEOUT;
  
  if (isActive && !isTimedOut) {
    // Verify the session is still valid
    try {
      await browserSession.page.evaluate(() => document.title);
      console.log('[SESSION] Browser session is active and valid');
      
      // Check if still logged in
      const loggedIn = await verifyLogin();
      
      return {
        active: true,
        loggedIn: loggedIn,
        sessionId: browserSession.sessionId,
        lastActivity: browserSession.lastActivity,
        uptime: now - browserSession.lastActivity
      };
    } catch (error) {
      console.log('[SESSION] Browser session is invalid, will reinitialize');
      await closeBrowserSession();
      return { active: false, loggedIn: false, error: 'Session invalid' };
    }
  }
  
  if (isTimedOut) {
    console.log('[SESSION] Session timed out, closing...');
    await closeBrowserSession();
  }
  
  return { active: false, loggedIn: false };
}

// Verify if still logged in
async function verifyLogin() {
  if (!browserSession.page) return false;
  
  try {
    // Check for username in header (indicates logged in)
    const username = process.env.TMS_USERNAME;
    const userElement = await browserSession.page.locator(`text=${username.toUpperCase()}`).count();
    
    if (userElement > 0) {
      console.log('[AUTH] User is logged in');
      return true;
    }
    
    // Check if on login page
    const loginForm = await browserSession.page.locator('#userSubmit').count();
    if (loginForm > 0) {
      console.log('[AUTH] On login page - not logged in');
      return false;
    }
    
    // Check URL for login indicators
    const url = browserSession.page.url();
    if (url.includes('/login') || url.includes('security')) {
      console.log('[AUTH] URL indicates login page');
      return false;
    }
    
    console.log('[AUTH] Login status uncertain, assuming logged in');
    return true;
    
  } catch (error) {
    console.error('[AUTH] Error checking login status:', error.message);
    return false;
  }
}

// Initialize or get browser session
async function initializeBrowserSession() {
  const sessionStatus = await checkBrowserSession();
  
  if (sessionStatus.active && sessionStatus.loggedIn) {
    console.log('[SESSION] Reusing existing logged-in session');
    browserSession.lastActivity = Date.now();
    return sessionStatus;
  }
  
  if (sessionStatus.active && !sessionStatus.loggedIn) {
    console.log('[SESSION] Session exists but not logged in, will re-login');
    await performLogin();
    return await checkBrowserSession();
  }
  
  console.log('[SESSION] Creating new browser session...');
  
  const username = process.env.TMS_USERNAME;
  const password = process.env.TMS_PASSWORD;
  
  if (!username || !password) {
    throw new Error('TMS_USERNAME and TMS_PASSWORD must be configured');
  }
  
  // Launch browser (keep it running)
  browserSession.browser = await chromium.launch({
    headless: process.env.HEADLESS === 'true',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  browserSession.context = await browserSession.browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  });
  
  browserSession.page = await browserSession.context.newPage();
  browserSession.sessionId = Date.now().toString();
  browserSession.lastActivity = Date.now();
  
  console.log('[SESSION] New browser session created:', browserSession.sessionId);
  
  // Perform initial login
  await performLogin();
  
  return await checkBrowserSession();
}

// Perform login
async function performLogin() {
  if (!browserSession.page) {
    throw new Error('No browser session available');
  }
  
  const username = process.env.TMS_USERNAME;
  const password = process.env.TMS_PASSWORD;
  
  console.log('[LOGIN] Navigating to E2Open TMS...');
  await browserSession.page.goto('https://na-app.tms.e2open.com/agent/webmessages.do?query.current=true');
  await browserSession.page.waitForLoadState('domcontentloaded');
  
  // Handle cookie consent if present
  try {
    const cookieButton = browserSession.page.getByRole('button', { name: 'Agree and proceed' });
    if (await cookieButton.count() > 0) {
      console.log('[LOGIN] Accepting cookies...');
      await cookieButton.click();
      await browserSession.page.waitForLoadState('domcontentloaded');
    }
  } catch (e) {
    console.log('[LOGIN] No cookie consent needed');
  }
  
  // Check if login is needed
  const usernameField = browserSession.page.getByRole('textbox', { name: 'Username' });
  const loginFormPresent = await usernameField.count() > 0;
  
  if (loginFormPresent) {
    console.log('[LOGIN] Login form detected, entering credentials...');
    
    await usernameField.fill(username);
    console.log('[LOGIN] Username entered');
    
    const passwordField = browserSession.page.getByRole('textbox', { name: 'Password' });
    await passwordField.fill(password);
    console.log('[LOGIN] Password entered');
    
    const loginButton = browserSession.page.locator('#userSubmit');
    await loginButton.click();
    console.log('[LOGIN] Login button clicked, waiting for navigation...');
    
    await browserSession.page.waitForLoadState('networkidle');
    
    // Verify login success
    const userAccount = browserSession.page.locator('text=' + username.toUpperCase());
    if (await userAccount.count() > 0) {
      console.log('[LOGIN] ✓ Login successful!');
      browserSession.isLoggedIn = true;
    } else {
      console.error('[LOGIN] ✗ Login may have failed');
      browserSession.isLoggedIn = false;
    }
  } else {
    console.log('[LOGIN] Already logged in or no login form found');
    browserSession.isLoggedIn = true;
  }
  
  browserSession.lastActivity = Date.now();
}

// Execute load confirmation with session reuse
async function executeLoadConfirmation(loadNumber) {
  const pdfSavePath = process.env.PDF_SAVE_PATH || '/app/temp';
  
  console.log(`[AUTOMATION] Starting load confirmation for: ${loadNumber}`);
  
  // Ensure downloads directory exists
  await fs.mkdir(pdfSavePath, { recursive: true });
  
  // Initialize or reuse browser session
  const sessionStatus = await initializeBrowserSession();
  
  if (!sessionStatus.active || !sessionStatus.loggedIn) {
    throw new Error('Failed to establish logged-in session');
  }
  
  console.log(`[AUTOMATION] Using session: ${browserSession.sessionId}`);
  
  try {
    // Navigate to main page if not already there
    const currentUrl = browserSession.page.url();
    if (!currentUrl.includes('webmessages.do')) {
      console.log('[AUTOMATION] Navigating to messages page...');
      await browserSession.page.goto('https://na-app.tms.e2open.com/agent/webmessages.do?query.current=true');
      await browserSession.page.waitForLoadState('networkidle');
    }
    
    // Search for load number
    console.log(`[AUTOMATION] Searching for load: ${loadNumber}`);
    
    // Clear and fill search field
    const searchField = browserSession.page.locator('#menu-search-input');
    await searchField.clear();
    await searchField.fill(loadNumber);
    await searchField.press('Enter');
    
    console.log('[AUTOMATION] Waiting for search results...');
    await browserSession.page.waitForLoadState('networkidle');
    await browserSession.page.waitForTimeout(2000); // Give extra time for popup
    
    // Wait for Load Report page to open
    let loadReportPage = null;
    const maxRetries = 5;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[AUTOMATION] Looking for Load Report window (attempt ${attempt}/${maxRetries})...`);
      
      // Check if we need to click on a search result first
      if (attempt === 2) {
        // Try to click on the load link if it appears in search results
        try {
          const loadLink = browserSession.page.locator(`a:has-text("${loadNumber}")`).first();
          if (await loadLink.count() > 0) {
            console.log('[AUTOMATION] Found load link in search results, clicking...');
            await loadLink.click();
            await browserSession.page.waitForTimeout(2000);
          }
        } catch (e) {
          console.log('[AUTOMATION] No clickable load link found in results');
        }
      }
      
      await browserSession.page.waitForTimeout(3000);
      
      const pages = browserSession.context.pages();
      console.log(`[AUTOMATION] Found ${pages.length} page(s)`);
      
      for (const p of pages) {
        try {
          const url = p.url();
          const title = await p.title();
          console.log(`[AUTOMATION] Checking page: ${title || 'Untitled'}`);
          
          if (url.includes('LoadReport') || url.includes('loadID=' + loadNumber) || 
              (title && (title.includes('Load Report') || title.includes('Carrier Load Report')))) {
            loadReportPage = p;
            console.log('[AUTOMATION] ✓ Found Load Report page!');
            break;
          }
        } catch (e) {
          console.log(`[AUTOMATION] Error checking page: ${e.message}`);
          continue;
        }
      }
      
      if (loadReportPage) break;
    }
    
    if (!loadReportPage) {
      // Log current page content for debugging
      const currentUrl = browserSession.page.url();
      console.log(`[AUTOMATION] Still on page: ${currentUrl}`);
      
      // Check if there's an error message
      try {
        const errorMessage = await browserSession.page.locator('.error, .warning, .alert').textContent();
        if (errorMessage) {
          console.log(`[AUTOMATION] Error on page: ${errorMessage}`);
        }
      } catch (e) {
        // No error message found
      }
      
      throw new Error(`Load Report page not found for load ${loadNumber}. The load may not exist or you may not have access.`);
    }
    
    // Generate PDF
    await loadReportPage.bringToFront();
    await loadReportPage.waitForLoadState('networkidle');
    
    const today = new Date();
    const dateStr = String(today.getMonth() + 1).padStart(2, '0') + '.' + 
                   String(today.getDate()).padStart(2, '0') + '.' + 
                   String(today.getFullYear()).slice(-2);
    const pdfFilename = `RATECON MULDER BROTHERS ${loadNumber} ${dateStr}.pdf`;
    const pdfPath = path.join(pdfSavePath, pdfFilename);
    
    console.log(`[AUTOMATION] Generating PDF: ${pdfFilename}`);
    
    await loadReportPage.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: {
        top: '0.5in',
        right: '0.5in',
        bottom: '0.5in',
        left: '0.5in'
      }
    });
    
    console.log(`[AUTOMATION] ✓ PDF saved: ${pdfPath}`);
    
    // Close the Load Report tab but keep main session
    await loadReportPage.close();
    console.log('[AUTOMATION] Closed Load Report tab, keeping main session active');
    
    // Update last activity
    browserSession.lastActivity = Date.now();
    
    return pdfPath;
    
  } catch (error) {
    console.error('[AUTOMATION] Error:', error);
    throw error;
  }
}

// Close browser session
async function closeBrowserSession() {
  if (browserSession.browser) {
    console.log('[SESSION] Closing browser session...');
    try {
      await browserSession.browser.close();
    } catch (error) {
      console.error('[SESSION] Error closing browser:', error.message);
    }
  }
  
  browserSession = {
    browser: null,
    context: null,
    page: null,
    isLoggedIn: false,
    lastActivity: null,
    sessionId: null
  };
}

// Cleanup on shutdown
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Shutting down gracefully...');
  await closeBrowserSession();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[SHUTDOWN] Shutting down gracefully...');
  await closeBrowserSession();
  process.exit(0);
});

// List all downloads endpoint
app.get('/api/downloads', async (req, res) => {
  const downloadPath = process.env.PDF_SAVE_PATH || '/app/temp';
  
  try {
    const files = await fs.readdir(downloadPath);
    const pdfFiles = files.filter(file => file.endsWith('.pdf'));
    
    const fileDetails = await Promise.all(
      pdfFiles.map(async (file) => {
        const stats = await fs.stat(path.join(downloadPath, file));
        return {
          name: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
    );
    
    res.json({
      path: downloadPath,
      count: fileDetails.length,
      files: fileDetails
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download specific file endpoint
app.get('/api/download/:filename', async (req, res) => {
  const { filename } = req.params;
  const downloadPath = process.env.PDF_SAVE_PATH || '/app/temp';
  const filePath = path.join(downloadPath, filename);
  
  try {
    const pdfBuffer = await fs.readFile(filePath);
    
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length
    });
    
    res.send(pdfBuffer);
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[ERROR] Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('E2Open Automation API Server');
  console.log('='.repeat(60));
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Headless: ${process.env.HEADLESS || 'true'}`);
  console.log(`Session timeout: ${SESSION_TIMEOUT / 1000 / 60} minutes`);
  console.log('-'.repeat(60));
  console.log('Endpoints:');
  console.log(`  GET  /health                - Health check & session status`);
  console.log(`  GET  /api/session           - Check browser session`);
  console.log(`  POST /api/session/reset     - Force new session`);
  console.log(`  POST /api/automation        - Run automation`);
  console.log(`  GET  /api/downloads         - List downloaded PDFs`);
  console.log(`  GET  /api/download/:file    - Download specific PDF`);
  console.log('-'.repeat(60));
  console.log('Required headers for automation:');
  console.log(`  x-action: printloadconfirmation`);
  console.log(`  x-load-number: <load number>`);
  console.log('='.repeat(60));
});

module.exports = app;