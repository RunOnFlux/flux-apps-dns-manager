const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const appsDnsManager = require('../services/appsDnsManager');

const app = express();

// Middleware
app.use(cors());
app.use(morgan('combined'));
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'flux-apps-dns-manager' });
});

// Get service status
app.get('/status', (req, res) => {
  const status = appsDnsManager.getStatus();
  res.json(status);
});

// Get current DNS state for all tracked games
app.get('/dns-state', (req, res) => {
  const state = appsDnsManager.getDNSState();
  res.json(state);
});

// Trigger manual processing loop (for debugging)
app.post('/trigger', async (req, res) => {
  try {
    await appsDnsManager.runProcessingLoop();
    res.json({ status: 'ok', message: 'Processing loop triggered' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

module.exports = app;
