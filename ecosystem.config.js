/**
 * PM2 ecosystem config — keeps the bridge and dashboard running on boot.
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   pm2 startup        # outputs the platform-specific command to enable auto-start
 *
 * On Windows, install pm2-windows-startup or run via Task Scheduler.
 * On WSL/Linux/macOS, `pm2 startup` handles it.
 */
module.exports = {
  apps: [
    {
      name: 'marketing-os-bridge',
      script: 'bridge/index.js',
      watch: false,
      max_memory_restart: '512M',
      error_file: 'logs/bridge.error.log',
      out_file: 'logs/bridge.out.log',
      env: { NODE_ENV: 'production' }
    },
    {
      name: 'marketing-os-dashboard',
      script: 'dashboard/server.js',
      watch: false,
      max_memory_restart: '512M',
      error_file: 'logs/dashboard.error.log',
      out_file: 'logs/dashboard.out.log',
      env: { NODE_ENV: 'production' }
    }
  ]
};
