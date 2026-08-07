const express = require('express');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');
const iconv = require('iconv-lite');
const { pool } = require('./db');

const app = express();

// CORS: 仅允许无 Origin 的请求（小程序）或调试页面
app.use(cors({
  origin: function(origin, callback) {
    // 微信小程序 wx.request 不带 Origin 头，直接放行
    if (!origin) return callback(null, true);
    // 允许 Vercel 部署域名和本地调试
    if (origin && (origin.includes('vercel.app') || origin.includes('localhost') || origin.includes('127.0.0.1'))) {
      return callback(null, true);
    }
    callback(null, true);
  }
}));
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const WX_APPID = process.env.WX_APPID || '';
const WX_SECRET = process.env.WX_SECRET || '';
const TOKEN_SECRET = process.env.TOKEN_SECRET || WX_SECRET || 'nestegg-default-secret';
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天

// 启动时校验关键配置
if (!WX_APPID || !WX_SECRET) {
  console.warn('[nestegg] WX_APPID or WX_SECRET not set. WeChat login will fail.');
}
if (!process.env.TOKEN_SECRET) {
  console.warn('[nestegg] TOKEN_SECRET not set. Using WX_SECRET as signing key.');
}

// ─── 行情缓存（减少对外部 API 的重复请求）─────────

var quoteCache = {};  // { key: { data, ts } }
var QUOTE_CACHE_TTL = 60000;  // 60 秒

function getCached(key) {
  var entry = quoteCache[key];
  if (entry && (Date.now() - entry.ts) < QUOTE_CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCache(key, data) {
  quoteCache[key] = { data: data, ts: Date.now() };
}

// ─── HMAC Token 认证 ─────────────────────────────

function createToken(openid) {
  var payload = JSON.stringify({ openid: openid, exp: Date.now() + TOKEN_TTL });
  var encoded = Buffer.from(payload).toString('base64');
  var signature = crypto.createHmac('sha256', TOKEN_SECRET).update(encoded).digest('base64');
  return encoded + '.' + signature;
}

function verifyToken(token) {
  if (!token) return null;
  var parts = token.split('.');
  if (parts.length !== 2) return null;
  try {
    var expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0]).digest('base64');
    if (parts[1] !== expectedSig) return null;
    var payload = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
    if (!payload.openid || payload.exp < Date.now()) return null;
    return payload.openid;
  } catch (e) {
    return null;
  }
}

function getUserId(req) {
  // 优先从 Authorization: Bearer <token> 获取
  var authHeader = (req.headers['authorization'] || '').trim();
  if (authHeader && authHeader.startsWith('Bearer ')) {
    var token = authHeader.slice(7);
    return verifyToken(token) || '';
  }
  // 兼容旧 x-openid（仅在 TOKEN_SECRET 和 WX_SECRET 均未配置时生效）
  if (!process.env.TOKEN_SECRET && !process.env.WX_SECRET) {
    return (req.headers['x-openid'] || '').trim();
  }
  return '';
}

// ─── 输入校验工具 ─────────────────────────────────

function validateId(id, label) {
  if (!id || typeof id !== 'string' || id.length > 64) {
    return label || 'ID';
  }
  return null;
}

function validateCode(code) {
  if (!code || typeof code !== 'string') return false;
  return /^\d{6}$/.test(code.trim());
}

// ─── 错误响应（不泄露内部信息）─────────────────────

function handleError(res, err, context) {
  console.error('[nestegg] ' + (context || 'Error') + ':', err.message);
  res.status(500).json({ error: 'Service error' });
}

// ─── 微信登录 ────────────────────────────────────

app.post('/api/auth/login', function(req, res) {
  var code = req.body && req.body.code;
  if (!code) return res.status(400).json({ error: 'Missing code' });

  var url = 'https://api.weixin.qq.com/sns/jscode2session' +
      '?appid=' + encodeURIComponent(WX_APPID) +
      '&secret=' + encodeURIComponent(WX_SECRET) +
      '&js_code=' + encodeURIComponent(code) +
      '&grant_type=authorization_code';

  https.get(url, { timeout: 10000 }, function(wxRes) {
    var body = '';
    wxRes.on('data', function(chunk) { body += chunk; });
    wxRes.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (data.openid) {
          var token = createToken(data.openid);
          res.json({ token: token, openid: data.openid });
        } else {
          console.error('[nestegg] WeChat login failed:', data.errcode, data.errmsg);
          res.status(400).json({ error: 'Login failed' });
        }
      } catch (e) {
        handleError(res, e, 'Login parse');
      }
    });
  }).on('error', function(err) {
    handleError(res, err, 'Login request');
  });
});

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
    // 兼容 avatar 和 avatar_url 两种列名
    res.json({ nickname: row.nickname || '', avatar: (row.avatar || row.avatar_url || '') });
  } catch (err) {
    handleError(res, err, 'GET /user/profile');
  }
});

app.post('/api/user/profile', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var p = req.body || {};
    // 优先写 avatar_url（schema.sql 定义），也写 avatar（兼容旧 schema）
    await pool.query(
      'INSERT INTO users (openid, nickname, avatar_url, avatar, create_time, update_time) ' +
      'VALUES ($1,$2,$3,$4,$5,$6) ' +
      'ON CONFLICT (openid) DO UPDATE SET ' +
      'nickname = EXCLUDED.nickname, avatar_url = EXCLUDED.avatar_url, avatar = EXCLUDED.avatar, ' +
      'update_time = EXCLUDED.update_time',
      [userId, (p.nickname || '').toString().slice(0, 32), p.avatar || '', p.avatar || '',
       new Date().toISOString(), new Date().toISOString()]
    );
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'POST /user/profile');
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
    handleError(res, err, 'GET /holdings');
  }
});

app.get('/api/holdings/:id', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var result = await pool.query(
      'SELECT * FROM holdings WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(toHolding(result.rows[0]));
  } catch (err) {
    handleError(res, err, 'GET /holdings/:id');
  }
});

app.post('/api/holdings', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var h = req.body || {};
    var idErr = validateId(h.id, 'holding id');
    if (idErr) return res.status(400).json({ error: 'Invalid ' + idErr });
    if (!h.name || !h.name.toString().trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (h.category && ['stock', 'fund', 'other'].indexOf(h.category) === -1) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    // 校验所有权：已存在的记录必须属于当前用户
    if (h.id) {
      var existing = await pool.query('SELECT user_id FROM holdings WHERE id = $1', [h.id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await pool.query(
      'INSERT INTO holdings (id, user_id, category, name, code, total_shares, total_cost, ' +
      'avg_cost_price, current_price, note, create_time, update_time) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ' +
      'ON CONFLICT (id) DO UPDATE SET ' +
      'user_id = EXCLUDED.user_id, category = EXCLUDED.category, name = EXCLUDED.name, ' +
      'code = EXCLUDED.code, total_shares = EXCLUDED.total_shares, total_cost = EXCLUDED.total_cost, ' +
      'avg_cost_price = EXCLUDED.avg_cost_price, current_price = EXCLUDED.current_price, ' +
      'note = EXCLUDED.note, update_time = EXCLUDED.update_time',
      [h.id, userId, h.category || 'other', h.name.toString().trim(), (h.code || '').toString().trim(),
       parseFloat(h.totalShares) || 0, parseFloat(h.totalCost) || 0,
       parseFloat(h.avgCostPrice) || 0, parseFloat(h.currentPrice) || 0,
       (h.note || '').toString().slice(0, 500),
       h.createTime || new Date().toISOString(), h.updateTime || new Date().toISOString()]
    );
    res.json({ success: true, id: h.id });
  } catch (err) {
    handleError(res, err, 'POST /holdings');
  }
});

app.delete('/api/holdings/:id', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var result = await pool.query('DELETE FROM holdings WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'DELETE /holdings/:id');
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
    handleError(res, err, 'GET /transactions');
  }
});

app.post('/api/transactions', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var t = req.body || {};
    var idErr = validateId(t.id, 'transaction id');
    if (idErr) return res.status(400).json({ error: 'Invalid ' + idErr });
    if (t.type && ['buy', 'sell'].indexOf(t.type) === -1) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (!t.holdingId) return res.status(400).json({ error: 'Missing holdingId' });

    // 校验所有权
    if (t.id) {
      var existing = await pool.query('SELECT user_id FROM transactions WHERE id = $1', [t.id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await pool.query(
      'INSERT INTO transactions (id, user_id, holding_id, type, quantity, price, amount, ' +
      'date, note, create_time) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
      'ON CONFLICT (id) DO UPDATE SET ' +
      'user_id = EXCLUDED.user_id, holding_id = EXCLUDED.holding_id, ' +
      'type = EXCLUDED.type, quantity = EXCLUDED.quantity, price = EXCLUDED.price, ' +
      'amount = EXCLUDED.amount, date = EXCLUDED.date, note = EXCLUDED.note',
      [t.id, userId, t.holdingId, t.type || 'buy',
       parseFloat(t.quantity) || 0, parseFloat(t.price) || 0,
       parseFloat(t.amount) || 0, t.date || '',
       (t.note || '').toString().slice(0, 500),
       t.createTime || new Date().toISOString()]
    );
    res.json({ success: true, id: t.id });
  } catch (err) {
    handleError(res, err, 'POST /transactions');
  }
});

app.delete('/api/transactions/:id', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var result = await pool.query('DELETE FROM transactions WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'DELETE /transactions/:id');
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
    handleError(res, err, 'GET /dividends');
  }
});

app.post('/api/dividends', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var d = req.body || {};
    var idErr = validateId(d.id, 'dividend id');
    if (idErr) return res.status(400).json({ error: 'Invalid ' + idErr });
    if (!d.holdingId) return res.status(400).json({ error: 'Missing holdingId' });

    // 校验所有权
    if (d.id) {
      var existing = await pool.query('SELECT user_id FROM dividends WHERE id = $1', [d.id]);
      if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    await pool.query(
      'INSERT INTO dividends (id, user_id, holding_id, shares, amount, date, note, create_time) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ' +
      'ON CONFLICT (id) DO UPDATE SET ' +
      'user_id = EXCLUDED.user_id, holding_id = EXCLUDED.holding_id, ' +
      'shares = EXCLUDED.shares, amount = EXCLUDED.amount, date = EXCLUDED.date, note = EXCLUDED.note',
      [d.id, userId, d.holdingId, parseFloat(d.shares) || 0, parseFloat(d.amount) || 0,
       d.date || '', (d.note || '').toString().slice(0, 500),
       d.createTime || new Date().toISOString()]
    );
    res.json({ success: true, id: d.id });
  } catch (err) {
    handleError(res, err, 'POST /dividends');
  }
});

app.delete('/api/dividends/:id', async function(req, res) {
  var userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: '未登录' });

  try {
    var result = await pool.query('DELETE FROM dividends WHERE id = $1 AND user_id = $2',
      [req.params.id, userId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    handleError(res, err, 'DELETE /dividends/:id');
  }
});

// ─── 股票/基金行情代理（解决小程序域名白名单限制）─────

app.get('/api/stock/quote', function(req, res) {
  var code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });
  if (!validateCode(code)) return res.status(400).json({ error: 'Invalid code format' });

  // 根据代码前缀判断交易所：6、5 开头为上海，其余深圳
  var prefix = code.charAt(0);
  if (prefix === '6' || prefix === '5') code = 'sh' + code;
  else code = 'sz' + code;

  var cacheKey = 'stock:' + code;
  var cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  var url = 'https://hq.sinajs.cn/list=' + code;
  https.get(url, { timeout: 10000, headers: { 'Referer': 'https://finance.sina.com.cn' } }, function(sinaRes) {
    var chunks = [];
    sinaRes.on('data', function(chunk) { chunks.push(chunk); });
    sinaRes.on('end', function() {
      try {
        // Sina 返回 GBK 编码，需用 iconv-lite 解码
        var buffer = Buffer.concat(chunks);
        var text = iconv.decode(buffer, 'gbk');
        var match = text.match(/"([^"]+)"/);
        if (!match) return res.status(500).json({ error: 'Data error' });
        var arr = match[1].split(',');
        if (arr.length < 33) return res.status(500).json({ error: 'Data error' });
        var quoteData = {
          name: arr[0],
          currentPrice: parseFloat(arr[3]) || 0,
          open: parseFloat(arr[1]) || 0,
          high: parseFloat(arr[4]) || 0,
          low: parseFloat(arr[5]) || 0,
          change: parseFloat(arr[31]) || 0,
          changePercent: parseFloat(arr[32]) || 0
        };
        setCache(cacheKey, quoteData);
        res.json(quoteData);
      } catch (e) {
        handleError(res, e, 'Stock quote parse');
      }
    });
  }).on('error', function(err) {
    handleError(res, err, 'Stock quote request');
  });
});

app.get('/api/fund/quote', function(req, res) {
  var code = (req.query.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing code' });
  if (!validateCode(code)) return res.status(400).json({ error: 'Invalid code format' });

  var cacheKey = 'fund:' + code;
  var cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  var url = 'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo' +
      '?plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=wxmp&Fcodes=' + code;
  https.get(url, { timeout: 10000 }, function(emRes) {
    var body = '';
    emRes.on('data', function(chunk) { body += chunk; });
    emRes.on('end', function() {
      try {
        var data = JSON.parse(body);
        if (!data.Datas || !data.Datas[0] || !data.Datas[0].SHORTNAME) {
          return res.status(500).json({ error: 'Fund not found' });
        }
        var d = data.Datas[0];
        var fundData = {
          code: d.FCODE || '',
          name: d.SHORTNAME || '',
          nav: parseFloat(d.NAV) || 0,
          accNav: parseFloat(d.ACCNAV) || 0,
          navChange: parseFloat(d.NAVCHGRT) || 0,
          navDate: d.PDATE || '',
          estimatedNav: parseFloat(d.GSZ) || 0,
          estimatedChange: parseFloat(d.GSZZL) || 0
        };
        setCache(cacheKey, fundData);
        res.json(fundData);
      } catch (e) {
        handleError(res, e, 'Fund quote parse');
      }
    });
  }).on('error', function(err) {
    handleError(res, err, 'Fund quote request');
  });
});

// ─── Debug 页（部署状态诊断）────────────────────

app.get('/', async function(req, res) {
  // 仅在显式开启调试或非生产环境时显示诊断页
  if (!process.env.DEBUG_PAGE && process.env.VERCEL) {
    return res.status(200).json({ service: 'NestEgg', status: 'ok' });
  }
  var dbStatus = { ok: false, error: '', latencyMs: 0 };
  var dbStart = Date.now();
  try {
    var dbResult = await pool.query("SELECT NOW() as now, current_database() as db, version() as version");
    dbStatus.ok = true;
    dbStatus.latencyMs = Date.now() - dbStart;
    dbStatus.now = dbResult.rows[0].now;
    dbStatus.db = dbResult.rows[0].db;
  } catch (err) {
    dbStatus.error = 'Connection failed';
    dbStatus.latencyMs = Date.now() - dbStart;
  }

  var info = {
    service: 'NestEgg',
    version: '1.0.0',
    node: process.version,
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
    '</div>'
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

app.get('/api/health', async function(req, res) {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', timestamp: new Date().toISOString() });
  }
});

// 导出 app 供 Vercel serverless 使用
module.exports = app;

// 仅在本地运行时监听端口
if (require.main === module) {
  app.listen(PORT, function() {
    console.log('NestEgg API running on http://localhost:' + PORT);
    if (!WX_APPID || !WX_SECRET) {
      console.warn('[nestegg] Warning: WX_APPID or WX_SECRET not set. WeChat login will fail.');
    }
  });
}
