const express = require('express');
const cors = require('cors');
const https = require('https');
const { pool } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';

// ─── 微信登录 ────────────────────────────────────

app.post('/api/auth/login', function(req, res) {
    var code = req.body.code;
    if (!code) return res.status(400).json({ error: 'Missing code' });

    var url = 'https://api.weixin.qq.com/sns/jscode2session' +
        '?appid=' + WX_APPID +
        '&secret=' + WX_SECRET +
        '&js_code=' + code +
        '&grant_type=authorization_code';

    https.get(url, function(wxRes) {
        var body = '';
        wxRes.on('data', function(chunk) { body += chunk; });
        wxRes.on('end', function() {
            try {
                var data = JSON.parse(body);
                if (data.openid) {
                    res.json({ openid: data.openid });
                } else {
                    res.status(400).json({ error: 'Login failed', detail: data });
                }
            } catch (e) {
                res.status(500).json({ error: 'Parse error' });
            }
        });
    }).on('error', function(err) {
        res.status(500).json({ error: err.message });
    });
});

// ─── 从请求头获取 openid ─────────────────────────

function getUserId(req) {
    return (req.headers['x-openid'] || '').trim();
}

// ─── 字段转换 ─────────────────────────────────────

function toHolding(row) {
    return {
        id: row.id,
        category: row.category,
        name: row.name,
        code: row.code || '',
        totalShares: parseFloat(row.total_shares) || 0,
        totalCost: parseFloat(row.total_cost) || 0,
        avgCostPrice: parseFloat(row.avg_cost_price) || 0,
        currentPrice: parseFloat(row.current_price) || 0,
        note: row.note || '',
        createTime: row.create_time || '',
        updateTime: row.update_time || ''
    };
}

function toTransaction(row) {
    return {
        id: row.id,
        holdingId: row.holding_id,
        type: row.type || 'buy',
        quantity: parseFloat(row.quantity) || 0,
        price: parseFloat(row.price) || 0,
        amount: parseFloat(row.amount) || 0,
        date: row.date || '',
        note: row.note || '',
        createTime: row.create_time || ''
    };
}

function toDividend(row) {
    return {
        id: row.id,
        holdingId: row.holding_id,
        shares: parseFloat(row.shares) || 0,
        amount: parseFloat(row.amount) || 0,
        date: row.date || '',
        note: row.note || '',
        createTime: row.create_time || ''
    };
}

// ─── 用户资料 ────────────────────────────────────

app.get('/api/user/profile', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var result = await pool.query('SELECT * FROM users WHERE openid = $1', [userId]);
        if (result.rows.length === 0) {
            return res.json({ nickname: '', avatar: '' });
        }
        var row = result.rows[0];
        res.json({ nickname: row.nickname || '', avatar: row.avatar || '' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/user/profile', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var p = req.body || {};
        await pool.query(
            'INSERT INTO users (openid, nickname, avatar, create_time, update_time) ' +
            'VALUES ($1,$2,$3,$4,$5) ' +
            'ON CONFLICT (openid) DO UPDATE SET ' +
            'nickname = EXCLUDED.nickname, avatar = EXCLUDED.avatar, update_time = EXCLUDED.update_time',
            [userId, (p.nickname || '').toString().slice(0, 32), p.avatar || '',
             new Date().toISOString(), new Date().toISOString()]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Holdings ────────────────────────────────────

app.get('/api/holdings', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var result = await pool.query(
            'SELECT * FROM holdings WHERE user_id = $1 ORDER BY update_time DESC',
            [userId]
        );
        res.json(result.rows.map(toHolding));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/holdings/:id', async function(req, res) {
    var userId = getUserId(req);
    try {
        var result = await pool.query(
            'SELECT * FROM holdings WHERE id = $1 AND user_id = $2',
            [req.params.id, userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(toHolding(result.rows[0]));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/holdings', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var h = req.body;
        await pool.query(
            'INSERT INTO holdings (id, user_id, category, name, code, total_shares, total_cost, ' +
            'avg_cost_price, current_price, note, create_time, update_time) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ' +
            'ON CONFLICT (id) DO UPDATE SET ' +
            'category = EXCLUDED.category, name = EXCLUDED.name, code = EXCLUDED.code, ' +
            'total_shares = EXCLUDED.total_shares, total_cost = EXCLUDED.total_cost, ' +
            'avg_cost_price = EXCLUDED.avg_cost_price, current_price = EXCLUDED.current_price, ' +
            'note = EXCLUDED.note, update_time = EXCLUDED.update_time',
            [h.id, userId, h.category, h.name, h.code || '', h.totalShares || 0, h.totalCost || 0,
             h.avgCostPrice || 0, h.currentPrice || 0, h.note || '',
             h.createTime || new Date().toISOString(), h.updateTime || new Date().toISOString()]
        );
        res.json({ success: true, id: h.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/holdings/:id', async function(req, res) {
    var userId = getUserId(req);
    try {
        await pool.query('DELETE FROM holdings WHERE id = $1 AND user_id = $2',
            [req.params.id, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Transactions ────────────────────────────────

app.get('/api/transactions', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var holdingId = req.query.holdingId;
        var result;
        if (holdingId) {
            result = await pool.query(
                'SELECT * FROM transactions WHERE user_id = $1 AND holding_id = $2 ORDER BY date DESC, create_time DESC',
                [userId, holdingId]
            );
        } else {
            result = await pool.query(
                'SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC, create_time DESC',
                [userId]
            );
        }
        res.json(result.rows.map(toTransaction));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/transactions', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var t = req.body;
        await pool.query(
            'INSERT INTO transactions (id, user_id, holding_id, type, quantity, price, amount, ' +
            'date, note, create_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
            'ON CONFLICT (id) DO UPDATE SET ' +
            'type = EXCLUDED.type, quantity = EXCLUDED.quantity, price = EXCLUDED.price, ' +
            'amount = EXCLUDED.amount, date = EXCLUDED.date, note = EXCLUDED.note',
            [t.id, userId, t.holdingId, t.type || 'buy', t.quantity || 0, t.price || 0,
             t.amount || 0, t.date || '', t.note || '',
             t.createTime || new Date().toISOString()]
        );
        res.json({ success: true, id: t.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/transactions/:id', async function(req, res) {
    var userId = getUserId(req);
    try {
        await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2',
            [req.params.id, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Dividends ───────────────────────────────────

app.get('/api/dividends', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var holdingId = req.query.holdingId;
        var result;
        if (holdingId) {
            result = await pool.query(
                'SELECT * FROM dividends WHERE user_id = $1 AND holding_id = $2 ORDER BY date DESC',
                [userId, holdingId]
            );
        } else {
            result = await pool.query(
                'SELECT * FROM dividends WHERE user_id = $1 ORDER BY date DESC', [userId]
            );
        }
        res.json(result.rows.map(toDividend));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/dividends', async function(req, res) {
    var userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: '未登录' });

    try {
        var d = req.body;
        await pool.query(
            'INSERT INTO dividends (id, user_id, holding_id, shares, amount, date, note, create_time) ' +
            'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
            'ON CONFLICT (id) DO UPDATE SET ' +
            'shares = EXCLUDED.shares, amount = EXCLUDED.amount, date = EXCLUDED.date, note = EXCLUDED.note',
            [d.id, userId, d.holdingId, d.shares || 0, d.amount || 0, d.date || '',
             d.note || '', d.createTime || new Date().toISOString()]
        );
        res.json({ success: true, id: d.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/dividends/:id', async function(req, res) {
    var userId = getUserId(req);
    try {
        await pool.query('DELETE FROM dividends WHERE id = $1 AND user_id = $2',
            [req.params.id, userId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Health ──────────────────────────────────────
app.get('/api/health', function(req, res) {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 导出 app 供 Vercel serverless 使用
module.exports = app;

// 仅在本地运行时监听端口
if (require.main === module) {
    app.listen(PORT, function() {
        console.log('NestEgg API running on http://localhost:' + PORT);
        if (!WX_APPID || !WX_SECRET) {
            console.warn('Warning: WX_APPID or WX_SECRET not set. WeChat login will fail.');
        }
    });
}
