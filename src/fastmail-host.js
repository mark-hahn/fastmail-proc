import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fetch from 'node-fetch';

const PORT = 3456;
const JMAP_API_URL = "https://api.fastmail.com/jmap/api/";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// Track if files are currently being edited by client
let clientHasLock = false;
let lockTimestamp = null;
const LOCK_TIMEOUT_MS = 300000; // 5 minutes

// Load tokens and rules
const jmapTokens = JSON.parse(readFileSync(join(rootDir, 'secrets/jmapTokens.json'), 'utf8'));
const rules = JSON.parse(readFileSync(join(rootDir, 'rules.jsonc'), 'utf8').replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

const FASTMAIL_USER = rules.user;
const apiToken = jmapTokens[FASTMAIL_USER];
if (!apiToken) {
  console.error(`No API token found for user: ${FASTMAIL_USER}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Function to check and clear expired locks
function checkLockTimeout() {
  if (clientHasLock && lockTimestamp && (Date.now() - lockTimestamp > LOCK_TIMEOUT_MS)) {
    console.log('Lock timeout expired, releasing lock');
    clientHasLock = false;
    lockTimestamp = null;
  }
}

// JMAP request helper
async function jmapRequest(methodCalls) {
  const response = await fetch(JMAP_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiToken}`
    },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls
    })
  });

  if (!response.ok) {
    throw new Error(`JMAP request failed: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// API endpoint to get subjects or exclusions
app.get('/api/data', (req, res) => {
  try {
    checkLockTimeout();
    
    const type = req.query.type; // 'subjects' or 'exclusions'
    if (!type || !['subjects', 'exclusions'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type parameter' });
    }

    const filename = `${type}.txt`;
    const filepath = join(rootDir, filename);
    
    if (!existsSync(filepath)) {
      return res.json({ content: '', locked: clientHasLock });
    }

    const content = readFileSync(filepath, 'utf8');
    res.json({ content, locked: clientHasLock });
  } catch (error) {
    console.error('Error reading data:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to save subjects or exclusions
app.post('/api/data', (req, res) => {
  try {
    checkLockTimeout();
    
    const { type, content } = req.body;
    if (!type || !['subjects', 'exclusions'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type parameter' });
    }

    if (content === undefined) {
      return res.status(400).json({ error: 'Missing content' });
    }

    const filename = `${type}.txt`;
    const filepath = join(rootDir, filename);
    
    writeFileSync(filepath, content, 'utf8');
    console.log(`Saved ${filename} (${content.length} bytes)`);
    
    // Acquire lock when client saves - they have active data
    clientHasLock = true;
    lockTimestamp = Date.now();
    
    res.json({ success: true, locked: clientHasLock });
  } catch (error) {
    console.error('Error saving data:', error);
    res.status(500).json({ error: error.message });
  }
});

// API endpoint to release lock
app.post('/api/release-lock', (req, res) => {
  clientHasLock = false;
  lockTimestamp = null;
  console.log('Client released lock');
  res.json({ success: true });
});

// API endpoint to check lock status
app.get('/api/lock-status', (req, res) => {
  checkLockTimeout();
  res.json({ locked: clientHasLock });
});

// API endpoint to get full message from Fastmail
app.get('/api/message/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;
    
    if (!messageId) {
      return res.status(400).json({ error: 'Missing messageId' });
    }

    // Get account ID first
    const sessionResponse = await jmapRequest([
      ['Session/get', {}, 'session']
    ]);
    
    const accountId = sessionResponse.methodResponses[0][1].primaryAccounts['urn:ietf:params:jmap:mail'];

    // Get full message details
    const messageResponse = await jmapRequest([
      ['Email/get', {
        accountId,
        ids: [messageId],
        properties: ['id', 'subject', 'from', 'to', 'receivedAt', 'htmlBody', 'textBody', 'bodyValues', 'headers'],
        fetchAllBodyValues: true
      }, 'emailGet']
    ]);

    const messages = messageResponse.methodResponses[0][1].list;
    
    if (messages.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const message = messages[0];
    
    // Try to get HTML body first, fallback to text
    let bodyContent = '';
    let bodyType = 'text';
    
    if (message.htmlBody && message.htmlBody.length > 0) {
      const htmlPartId = message.htmlBody[0].partId;
      bodyContent = message.bodyValues?.[htmlPartId]?.value || '';
      bodyType = 'html';
    } else if (message.textBody && message.textBody.length > 0) {
      const textPartId = message.textBody[0].partId;
      bodyContent = message.bodyValues?.[textPartId]?.value || '';
      bodyType = 'text';
    }

    res.json({
      id: message.id,
      subject: message.subject,
      from: message.from,
      to: message.to,
      receivedAt: message.receivedAt,
      bodyContent,
      bodyType,
      headers: message.headers
    });
  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve static files from public directory
app.use(express.static(join(rootDir, 'public')));

// Fallback for SPA routing
app.get('*', (req, res) => {
  res.sendFile(join(rootDir, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Fastmail host server running on port ${PORT}`);
  console.log(`Local URL: http://localhost:${PORT}`);
});
