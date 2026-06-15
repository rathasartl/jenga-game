module.exports = {
  apps: [
    {
      name: 'jenga-game',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '220M',
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
      },
    },
  ],
};