const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function init() {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    try {
        await pool.query(schema);
        console.log('Database tables created successfully.');
    } catch (err) {
        console.error('Failed to create tables:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

init();
