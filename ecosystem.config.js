module.exports = {
  apps: [
    {
      name: "mapa-disponibilidade",
      script: "./api/server.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
    },
  ],
};
