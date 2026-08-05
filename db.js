const { Pool } = require('pg');
require('dotenv').config();

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('Error: DATABASE_URL 未设置。请复制 .env.example 为 .env 并填入 Neon 连接字符串。');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    idleTimeoutMillis: 30000,
    allowExitOnIdle: true
});

pool.on('error', function(err) {
    console.error('Unexpected pool error:', err);
});

module.exports = { pool };
