module.exports = {
  apps: [
    {
      name: 'api-eater-backend',
      script: 'backend/index.js',
      node_args: '',
      env: { PORT: 4001 },
      watch: false
    },
    {
      name: 'api-eater-frontend',
      script: 'npm',
      args: '--prefix frontend run preview -- --port 3001 --host',
      env: {},
      watch: false
    }
  ]
}

