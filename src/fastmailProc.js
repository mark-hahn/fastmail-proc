import { readFileSync } from 'fs';
import { createWriteStream } from 'fs';
import fetch from 'node-fetch';

const JMAP_API_URL = "https://api.fastmail.com/jmap/api/";

// Load tokens and rules
const jmapTokens = JSON.parse(readFileSync('./secrets/jmapTokens.json', 'utf8'));
const rules = JSON.parse(readFileSync('./rules.jsonc', 'utf8').replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

const FASTMAIL_USER = rules.user;
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
    if (Array.isArray(rule.contains)) {
      const found = rule.contains.some(str => textString.includes(str.toLowerCase()));
      if (!found) return false;
    } else {
      if (!textString.includes(rule.contains.toLowerCase())) return false;
    }
  }
  
  if (rule['one-of'] !== undefined) {
    const found = rule['one-of'].some(str => textString.includes(str.toLowerCase()));
    if (!found) return false;
  }
  
  return true;
}

async function processMessages() {
  console.log('');
  console.log(`fastmail processing ...`);
  console.log(`   Source folder: ${rules['scan-folder']}`);
  console.log(`   From message:   ${rules['first-message']}`);
  console.log(`   Max messages:   ${rules['max-messages']}`);
  
  const startTime = Date.now();
  const labelsAdded = {};
  const labelsRemoved = {};
  
  // Get session to find account ID
  const sessionResponse = await fetch('https://api.fastmail.com/.well-known/jmap', {
    headers: { 'Authorization': `Bearer ${apiToken}` }
  });
  
  const session = await sessionResponse.json();
  const accountId = session.primaryAccounts['urn:ietf:params:jmap:mail'];
  
  // Get mailboxes
  const accountResponse = await jmapRequest([
    ['Mailbox/get', { accountId }, 'mailboxes']
  ]);
  
  // Get mailbox ID for scan folder
  const mailboxes = accountResponse.methodResponses[0][1].list;
  
  // Create required folders if they don't exist
  const requiredFolders = ['Promotions', 'Social', 'Updates', 'Receipts'];
  const existingFolderNames = mailboxes.map(mb => mb.name);
  const foldersToCreate = requiredFolders.filter(folder => !existingFolderNames.includes(folder));
  
  if (foldersToCreate.length > 0) {
    const createRequests = {};
    foldersToCreate.forEach((folderName, index) => {
      createRequests[`create${index}`] = {
        name: folderName,
        parentId: null,
        role: null
      };
    });
    
    console.log(`Creating folders: ${foldersToCreate.join(', ')}`);
    const createResponse = await jmapRequest([
      ['Mailbox/set', {
        accountId,
        create: createRequests
      }, 'mailboxCreate']
    ]);
    
    // Add newly created mailboxes to our list
    const created = createResponse.methodResponses[0][1].created;
    if (created) {
      for (const [tempId, mailbox] of Object.entries(created)) {
        mailboxes.push({ id: mailbox.id, name: createRequests[tempId].name });
      }
    }
  }
  
  // Create mailbox name to ID map
  const mailboxNameToId = {};
  mailboxes.forEach(mb => {
    mailboxNameToId[mb.name] = mb.id;
    mailboxNameToId[mb.name.toLowerCase()] = mb.id;
  });
  
  const scanMailbox = mailboxes.find(mb => mb.name.toLowerCase() === rules['scan-folder'].toLowerCase());
  
  if (!scanMailbox) {
    console.error(`Folder not found: ${rules['scan-folder']}`);
    process.exit(1);
  }
  
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
  
  if (emailIds.length === 0) {
    const elapsedSecs = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Scan finished ${elapsedSecs} secs, 0 processed`);
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
    
    const messageUpdates = { 
      mailboxIds: { ...message.mailboxIds },
      keywords: { ...message.keywords } 
    };
    let messageModified = false;
    
    // Apply each rule
    for (const rule of rules['rule-list']) {
      const textString = getTextString(message, rule);
      
      if (testRule(textString, rule)) {
        if (rule['add-label']) {
          const labelName = rule['add-label'];
          const mailboxId = mailboxNameToId[labelName];
          if (mailboxId) {
            messageUpdates.mailboxIds[mailboxId] = true;
            messageModified = true;
            labelsAdded[labelName] = (labelsAdded[labelName] || 0) + 1;
          }
        }
        
        if (rule['remove-label']) {
          const labelName = rule['remove-label'];
          const mailboxId = mailboxNameToId[labelName];
          if (mailboxId) {
            delete messageUpdates.mailboxIds[mailboxId];
            messageModified = true;
            labelsRemoved[labelName] = (labelsRemoved[labelName] || 0) + 1;
          }
          // Also remove any matching keywords (for cleanup)
          if (messageUpdates.keywords[labelName]) {
            delete messageUpdates.keywords[labelName];
            messageModified = true;
          }
          if (messageUpdates.keywords[labelName.toLowerCase()]) {
            delete messageUpdates.keywords[labelName.toLowerCase()];
            messageModified = true;
          }
        }
        
        if (rule.stop) {
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
    await jmapRequest([
      ['Email/set', {
        accountId,
        update: updates
      }, 'emailUpdate']
    ]);
  }
  
  const elapsedSecs = ((Date.now() - startTime) / 1000).toFixed(1);
  const processedCount = messages.length;
  
  console.log(`Scan finished ${elapsedSecs} secs, ${processedCount} processed`);
  
  for (const [label, count] of Object.entries(labelsAdded)) {
    console.log(`  Added   label to   ${count} messages:  ${label}`);
  }
  
  for (const [label, count] of Object.entries(labelsRemoved)) {
    console.log(`  Removed label from ${count} messages:  ${label}`);
  }
}

// Run the processor
processMessages().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
