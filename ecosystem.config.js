/*
 * PM2 ecosystem configuration
 * --------------------------
 * Defines apps for the main server process and an optional watchdog runner.
 * This file is only used when starting the application under PM2 and is
 * provided as a convenience for deployments.
 */
module.exports = {
  apps: [
    {
      name: 'home-control-center',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    },
    {
      // Watchdog is a short-lived script. Use pm2 cron_restart to run it on schedule
      name: 'home-control-watchdog',
      script: './watchdog.js',
      cwd: __dirname,
      exec_mode: 'fork',
      autorestart: false, // don't automatically restart after exit; use cron_restart to schedule runs
      watch: false,
      cron_restart: '*/1 * * * *', // default: run once per minute. Adjust as needed.
      env: {
        NODE_ENV: 'development'
      },
      env_production: {
        NODE_ENV: 'production'
      }
    }
  ]
};
