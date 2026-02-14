# Fastmail Processor with Web Host

This project processes Fastmail messages using JMAP API and provides a web interface to manage email subjects and exclusions.

## Components

1. **fastmailProc.js** - Processes Fastmail messages and saves subjects to subjects.txt
2. **fastmail-host.js** - Web server that hosts the management interface
3. **public/index.html** - Vue-based web interface (Linda Mail)

## Setup

### 1. Install Dependencies

```bash
npm install
```

This will install:
- `node-fetch` - For JMAP API requests
- `express` - For the web server

### 2. Configure Nginx (for https://hahnca.com/fastmail)

Configuration has been added to `/etc/nginx/conf.d/server.conf` in the hahnca.com server block.

To manually update in the future:

```bash
sudo nano /etc/nginx/conf.d/server.conf
```

Test and reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 3. Start the Web Host with PM2

```bash
# Start the server
pm2 start ecosystem.config.cjs

# Save the PM2 process list
pm2 save

# Setup PM2 to start on boot (if not already done)
pm2 startup
```

The web interface will be available at:
- Local: http://localhost:3456
- Remote: https://hahnca.com/fastmail

## Usage

### Web Interface (Linda Mail)

The web interface at https://hahnca.com/fastmail provides:

1. **View Subjects** - Default view showing all subjects from subjects.txt
2. **View Exclusions** - Toggle checkbox to show exclusions from exclusions.txt
3. **Manage Items**:
   - Check boxes next to from names to mark for moving
   - Click "Save" to move checked items between subjects and exclusions
   - Items disappear from current view when saved
4. **View Messages** - Click "Open" button to display full message content
5. **Auto-sync** - After saving, data reloads from server to stay in sync

### Command Line Processing

Process Fastmail messages:

```bash
npm start
```

This runs `src/fastmailProc.js` which:
- Scans your Fastmail folder
- Applies label rules from `rules.jsonc`
- Saves new subjects to `subjects.txt` (with message IDs)
- Checks for duplicates across both subjects.txt and exclusions.txt
- Only saves subjects where the from name doesn't already exist

### PM2 Management

```bash
# View status
pm2 list

# View logs
pm2 logs fastmail-host

# Restart server
pm2 restart fastmail-host

# Stop server
pm2 stop fastmail-host

# Monitor
pm2 monit
```

## File Formats

### subjects.txt and exclusions.txt

Both files use the same format:

```
======= Label Name =======
From Name | Subject Text | MessageID
From Name | Subject Text | MessageID

======= Another Label =======
From Name | Subject Text | MessageID
```

- Labels are sorted alphabetically
- From names within each label are sorted alphabetically
- Message IDs are used to fetch full message content
- Duplicate checking is by from name only across both files

## Data Concurrency

The system prevents data conflicts:

1. When web interface saves data, it acquires a lock
2. Lock expires after 5 minutes of inactivity
3. fastmailProc.js should not run while web interface has dirty unsaved data
4. After each save, web interface reloads data from server to stay synced
5. Duplicate from names are prevented across both files

## Development

To test locally with hot-reload:

```bash
# Terminal 1: Start the Express backend
npm run host

# Terminal 2: Start Vite dev server
./run
```

Then visit http://localhost:5173

Vite dev server proxies API calls to the Express server on port 3456.

## Production

For production, the Express server on port 3456 serves static files from the `public/` directory:

```bash
pm2 start ecosystem.config.cjs
```

## Notes

- Web interface uses Vue 3 from CDN (no build step needed)
- Message content is fetched from Fastmail API on-demand
- Both files maintain the same label structure
- A label section is never removed, it can be empty
- When items move between files, they keep their original label
