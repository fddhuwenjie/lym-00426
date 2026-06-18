const express = require('express');
const path = require('path');
const fs = require('fs');

const { initTables } = require('./db');
const routes = require('./routes');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

initTables();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: 'Internal Server Error',
    message: err.message
  });
});

app.listen(PORT, () => {
  console.log(`
========================================
  会员积分与权益中心系统已启动
  服务地址: http://localhost:${PORT}
  API 前缀: /api
  健康检查: /api/health
========================================
  `);
});

module.exports = app;
