module.exports = {
  apps: [{
    name: 'fastmail-host',
    script: './src/fastmail-host.js',
    cwd: '/root/dev/apps/fastmail-proc',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/fastmail-host-error.log',
    out_file: './logs/fastmail-host-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true
  }]
};

// To use this PM2 ecosystem file:
//
// 1. Install PM2 globally (if not already installed):
//    npm install -g pm2
//
// 2. Start the fastmail-host server:
//    pm2 start ecosystem.config.cjs
//
// 3. Save the PM2 process list:
//    pm2 save
//
// 4. Setup PM2 to start on system boot:
//    pm2 startup
//    (follow the instructions that PM2 prints)
//
// 5. Other useful PM2 commands:
//    pm2 list              - List all running processes
//    pm2 logs fastmail-host - View logs for fastmail-host
//    pm2 restart fastmail-host - Restart the server
//    pm2 stop fastmail-host    - Stop the server
//    pm2 delete fastmail-host  - Remove from PM2
//    pm2 monit             - Monitor all processes
