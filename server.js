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

// ─── 股票/基金行情代理（解决小程序域名白名单限制）─────

app.get('/api/stock/quote', function(req, res) {
    var code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    // 根据代码前缀判断交易所
    var prefix = code.charAt(0);
    if (prefix === '6') code = 'sh' + code;
    else code = 'sz' + code;

    var url = 'https://hq.sinajs.cn/list=' + code;
    https.get(url, { headers: { 'Referer': 'https://finance.sina.com.cn' } }, function(sinaRes) {
        var body = '';
        sinaRes.on('data', function(chunk) { body += chunk; });
        sinaRes.on('end', function() {
            try {
                var text = String(body);
                var match = text.match(/"([^"]+)"/);
                if (!match) return res.status(500).json({ error: 'Parse error' });
                var arr = match[1].split(',');
                if (arr.length < 32) return res.status(500).json({ error: 'Data error' });
                res.json({
                    name: arr[0],
                    currentPrice: parseFloat(arr[3]) || 0,
                    open: parseFloat(arr[1]) || 0,
                    high: parseFloat(arr[4]) || 0,
                    low: parseFloat(arr[5]) || 0,
                    change: parseFloat(arr[31]) || 0,
                    changePercent: parseFloat(arr[32]) || 0
                });
            } catch (e) {
                res.status(500).json({ error: 'Parse error' });
            }
        });
    }).on('error', function(err) {
        res.status(500).json({ error: err.message });
    });
});

app.get('/api/fund/quote', function(req, res) {
    var code = (req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    var url = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo' +
        '?plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=wxmp&Fcodes=' + code;
    https.get(url, function(emRes) {
        var body = '';
        emRes.on('data', function(chunk) { body += chunk; });
        emRes.on('end', function() {
            try {
                var data = JSON.parse(body);
                if (!data.Datas || !data.Datas[0] || !data.Datas[0].SHORTNAME) {
                    return res.status(500).json({ error: 'Fund not found' });
                }
                var d = data.Datas[0];
                res.json({
                    code: d.FCODE || '',
                    name: d.SHORTNAME || '',
                    nav: parseFloat(d.NAV) || 0,
                    accNav: parseFloat(d.ACCNAV) || 0,
                    navChange: parseFloat(d.NAVCHGRT) || 0,
                    navDate: d.PDATE || '',
                    estimatedNav: parseFloat(d.GSZ) || 0,
                    estimatedChange: parseFloat(d.GSZZL) || 0
                });
            } catch (e) {
                res.status(500).json({ error: 'Parse error' });
            }
        });
    }).on('error', function(err) {
        res.status(500).json({ error: err.message });
    });
});

// ─── Debug 页（部署状态诊断）────────────────────

app.get('/', async function(req, res) {
    var dbStatus = { ok: false, error: '', latencyMs: 0 };
    var dbStart = Date.now();
    try {
        var dbResult = await pool.query('SELECT NOW() as now, current_database() as db, version() as version');
        dbStatus.ok = true;
        dbStatus.latencyMs = Date.now() - dbStart;
        dbStatus.now = dbResult.rows[0].now;
        dbStatus.db = dbResult.rows[0].db;
        dbStatus.version = dbResult.rows[0].version;
    } catch (err) {
        dbStatus.error = err.message;
        dbStatus.latencyMs = Date.now() - dbStart;
    }

    var info = {
        service: 'NestEgg',
        version: '1.0.0',
        node: process.version,
        platform: process.platform,
        uptime: Math.round(process.uptime()) + 's',
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
        env: process.env.VERCEL ? 'Vercel (Production)' : 'Local',
        vercelRegion: process.env.VERCEL_REGION || 'N/A',
        db: dbStatus,
        endpoints: [
            'GET  /api/health',
            'GET  /api/holdings',
            'POST /api/holdings',
            'GET  /api/transactions',
            'POST /api/transactions',
            'GET  /api/dividends',
            'POST /api/dividends',
            'GET  /api/user/profile',
            'POST /api/user/profile',
            'POST /api/auth/login'
        ]
    };

    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>NestEgg · 服务状态</title>' +
        '<style>' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;' +
        'background:#F8F4EC;color:#3D3027;padding:24px;min-height:100vh}' +
        '.card{background:#FFFDF8;border-radius:16px;padding:24px;margin-bottom:16px;' +
        'box-shadow:0 2px 16px rgba(61,48,39,.06)}' +
        'h1{font-size:28px;color:#6B8A42;margin-bottom:4px}' +
        'h2{font-size:16px;color:#8B7D6B;font-weight:400;margin-bottom:20px}' +
        '.status{display:inline-block;padding:4px 14px;border-radius:6px;font-size:13px;font-weight:600}' +
        '.ok{background:#E8EDE0;color:#6B8A42}' +
        '.fail{background:#FDE8E8;color:#C0392B}' +
        '.grid{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:16px}' +
        '.item{flex:1;min-width:140px}' +
        '.item-label{font-size:12px;color:#B8A99A;margin-bottom:2px}' +
        '.item-val{font-size:18px;font-weight:600}' +
        'table{width:100%;border-collapse:collapse}' +
        'td,th{padding:10px 14px;text-align:left;font-size:14px;' +
        'border-bottom:1px solid #F0ECE4}' +
        'th{color:#B8A99A;font-weight:500;font-size:12px}' +
        'td{font-family:monospace;font-size:13px}' +
        '.endpoint{color:#6B8A42}' +
        '.db-version{font-size:12px;color:#B8A99A;margin-top:8px;word-break:break-all}' +
        '</style></head><body>' +
        '<h1>🥚 NestEgg</h1>' +
        '<h2>EarnMoney 理财助手 · API 服务诊断</h2>' +
        '<div class="card">' +
        '<div class="grid">' +
        '<div class="item"><div class="item-label">服务状态</div>' +
        '<div class="item-val"><span class="status ok">● 运行中</span></div></div>' +
        '<div class="item"><div class="item-label">运行环境</div>' +
        '<div class="item-val">' + info.env + '</div></div>' +
        '<div class="item"><div class="item-label">Node 版本</div>' +
        '<div class="item-val">' + info.node + '</div></div>' +
        '<div class="item"><div class="item-label">内存占用</div>' +
        '<div class="item-val">' + info.memory + '</div></div>' +
        '<div class="item"><div class="item-label">运行时长</div>' +
        '<div class="item-val">' + info.uptime + '</div></div>' +
        (info.vercelRegion !== 'N/A' ? '<div class="item"><div class="item-label">Vercel 区域</div>' +
        '<div class="item-val">' + info.vercelRegion + '</div></div>' : '') +
        '</div></div>' +
        '<div class="card">' +
        '<h2 style="margin-bottom:12px">🗄 数据库连接</h2>' +
        (dbStatus.ok ?
        '<div><span class="status ok">● 连接正常</span>' +
        '<span style="margin-left:12px;font-size:13px;color:#8B7D6B">延迟 ' + dbStatus.latencyMs + 'ms</span></div>' +
        '<div class="grid" style="margin-top:12px">' +
        '<div class="item"><div class="item-label">数据库名</div><div class="item-val" style="font-size:15px">' + dbStatus.db + '</div></div>' +
        '<div class="item"><div class="item-label">服务器时间</div><div class="item-val" style="font-size:15px">' + dbStatus.now + '</div></div>' +
        '</div>' +
        '<div class="db-version">' + dbStatus.version + '</div>'
        :
        '<div><span class="status fail">● 连接失败</span>' +
        '<span style="margin-left:12px;font-size:13px;color:#C0392B">' + dbStatus.error + '</span></div>'
        ) +
        '</div>' +
        '<div class="card">' +
        '<h2 style="margin-bottom:12px">📡 API 端点</h2>' +
        '<table><tr><th>方法</th><th>路径</th></tr>';
    for (var i = 0; i < info.endpoints.length; i++) {
        var parts = info.endpoints[i].split(/\s+/);
        html += '<tr><td>' + parts[0] + '</td><td class="endpoint">' + parts.slice(1).join(' ') + '</td></tr>';
    }
    html += '</table></div></body></html>';

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
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
