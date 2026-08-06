const { Pool } = require('pg');
require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('[nestegg] Error: DATABASE_URL 未设置。请复制 .env.example 为 .env 并填入 Neon 连接字符串。');
  // Vercel serverless 环境不能 process.exit，改为抛出错误
  throw new Error('DATABASE_URL is required');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon 使用 Let's Encrypt 证书，需要验证
  ssl: { rejectUnauthorized: true },
  // Serverless 环境限制连接池大小，避免耗尽 Neon 连接数
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: true
});

pool.on('error', function(err) {
  console.error('[nestegg] Unexpected pool error:', err.message);
});

module.exports = { pool };
