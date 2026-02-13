import { readFileSync } from 'fs';
import { createWriteStream } from 'fs';
import fetch from 'node-fetch';

const FASTMAIL_USER = "mark";
const JMAP_API_URL = "https://api.fastmail.com/jmap/api/";

// Load tokens and rules
const jmapTokens = JSON.parse(readFileSync('./secrets/jmapTokens.json', 'utf8'));
const rules = JSON.parse(readFileSync('./rules.jsonc', 'utf8').replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

const apiToken = jmapTokens[FASTMAIL_USER];
if (!apiToken) {
  console.error(`No API token found for user: ${FASTMAIL_USER}`);
  process.exit(1);
}

// Dual logging setup
const logStream = createWriteStream('jmap-proc.log', { flags: 'a' });
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = (chunk, encoding, callback) => {
  logStream.write(chunk, encoding);
  return originalStdoutWrite(chunk, encoding, callback);
};

process.stderr.write = (chunk, encoding, callback) => {
  logStream.write(chunk, encoding);
  return originalStderrWrite(chunk, encoding, callback);
};

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

function getTextString(message, rule) {
  const parts = [];
  
  if (rule.header) {
    const headerValue = message.headers?.find(h => h.name.toLowerCase() === rule.header.toLowerCase())?.value || '';
    parts.push(headerValue);
  }
  
  if (rule.from) {
    parts.push(message.from?.[0]?.email || '');
  }
  
  if (rule.to) {
    parts.push(message.to?.map(t => t.email).join(' ') || '');
  }
  
  if (rule.subject) {
    parts.push(message.subject || '');
  }
  
  if (rule.body) {
    parts.push(message.bodyValues?.['body']?.value || message.textBody?.[0]?.partId ? message.bodyValues?.[message.textBody[0].partId]?.value || '' : '');
  }
  
  return parts.join('|').toLowerCase();
}

function testRule(textString, rule) {
  if (rule.empty !== undefined) {
    if (rule.empty && textString !== '') return false;
    if (!rule.empty && textString === '') return false;
  }
  
  if (rule['not-empty'] !== undefined) {
    if (rule['not-empty'] && textString === '') return false;
    if (!rule['not-empty'] && textString !== '') return false;
  }
  
  if (rule.exact !== undefined) {
    if (textString !== rule.exact.toLowerCase()) return false;
  }
  
  if (rule['not-exact'] !== undefined) {
    if (textString === rule['not-exact'].toLowerCase()) return false;
  }
  
  if (rule.regex !== undefined) {
    const regex = new RegExp(rule.regex, 'i');
    if (!regex.test(textString)) return false;
  }
  
  if (rule.contains !== undefined) {
    if (!textString.includes(rule.contains.toLowerCase())) return false;
  }
  
  if (rule['one-of'] !== undefined) {
    const found = rule['one-of'].some(str => textString.includes(str.toLowerCase()));
    if (!found) return false;
  }
  
  return true;
}

async function processMessages() {
  console.log(`Starting Fastmail message processor for user: ${FASTMAIL_USER}`);
  console.log(`Scan folder: ${rules['scan-folder']}`);
  console.log(`Max messages: ${rules['max-messages']}`);
  
  // Get account ID
  const accountResponse = await jmapRequest([
    ['Mailbox/get', { accountId: null }, 'mailboxes']
  ]);
  
  const accountId = Object.keys(accountResponse.methodResponses[0][1].state)[0] || accountResponse.methodResponses[0][1].accountId;
  
  // Get mailbox ID for scan folder
  const mailboxes = accountResponse.methodResponses[0][1].list;
  const scanMailbox = mailboxes.find(mb => mb.name.toLowerCase() === rules['scan-folder'].toLowerCase());
  
  if (!scanMailbox) {
    console.error(`Folder not found: ${rules['scan-folder']}`);
    process.exit(1);
  }
  
  console.log(`Found mailbox: ${scanMailbox.name} (${scanMailbox.id})`);
  
  // Query messages
  const queryResponse = await jmapRequest([
    ['Email/query', {
      accountId,
      filter: { inMailbox: scanMailbox.id },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: rules['max-messages']
    }, 'emailQuery']
  ]);
  
  const emailIds = queryResponse.methodResponses[0][1].ids;
  console.log(`Found ${emailIds.length} messages to process`);
  
  if (emailIds.length === 0) {
    console.log('No messages to process');
    return;
  }
  
  // Get message details
  const getResponse = await jmapRequest([
    ['Email/get', {
      accountId,
      ids: emailIds,
      properties: ['id', 'subject', 'from', 'to', 'headers', 'keywords', 'mailboxIds', 'textBody', 'bodyValues'],
      fetchTextBodyValues: true
    }, 'emailGet']
  ]);
  
  const messages = getResponse.methodResponses[0][1].list;
  const updates = {};
  let stopProcessing = false;
  
  // Process each message
  for (const message of messages) {
    if (stopProcessing) break;
    
    console.log(`\nProcessing: ${message.subject}`);
    const messageUpdates = { keywords: { ...message.keywords } };
    let messageModified = false;
    
    // Apply each rule
    for (const rule of rules['rule-list']) {
      const textString = getTextString(message, rule);
      
      if (testRule(textString, rule)) {
        console.log(`  Rule matched`);
        
        if (rule['add-label']) {
          console.log(`    Adding label: ${rule['add-label']}`);
          messageUpdates.keywords[rule['add-label']] = true;
          messageModified = true;
        }
        
        if (rule['remove-label']) {
          console.log(`    Removing label: ${rule['remove-label']}`);
          delete messageUpdates.keywords[rule['remove-label']];
          messageModified = true;
        }
        
        if (rule.stop) {
          console.log(`    Stopping rule processing`);
          stopProcessing = true;
          break;
        }
      }
    }
    
    if (messageModified) {
      updates[message.id] = messageUpdates;
    }
  }
  
  // Apply updates
  if (Object.keys(updates).length > 0) {
    console.log(`\nApplying updates to ${Object.keys(updates).length} messages`);
    
    await jmapRequest([
      ['Email/set', {
        accountId,
        update: updates
      }, 'emailUpdate']
    ]);
    
    console.log('Updates applied successfully');
  } else {
    console.log('\nNo updates needed');
  }
  
  console.log('\nProcessing complete');
}

// Run the processor
processMessages().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
