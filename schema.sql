-- NestEgg 数据库建表 v2 (非破坏性：仅 CREATE IF NOT EXISTS)
-- holdings（聚合持仓快照）+ transactions（不可变交易流水）+ dividends（分红）
-- 全新初始化：npm run db:init
-- 如需清空重建：先手动 DROP TABLE dividends, transactions, holdings CASCADE;

-- ─── 持仓快照（从 transactions 聚合计算，客户端维护）──────────
CREATE TABLE IF NOT EXISTS holdings (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL DEFAULT '',
    category       TEXT NOT NULL DEFAULT 'other',
    name           TEXT NOT NULL,
    code           TEXT DEFAULT '',
    total_shares   NUMERIC DEFAULT 0,
    total_cost     NUMERIC DEFAULT 0,
    avg_cost_price NUMERIC DEFAULT 0,
    current_price  NUMERIC DEFAULT 0,
    note           TEXT DEFAULT '',
    create_time    TEXT DEFAULT '',
    update_time    TEXT DEFAULT ''
);

-- ─── 交易流水（不可变，买入/卖出都追加不修改）───────────────
CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT '',
    holding_id  TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT 'buy',
    quantity    NUMERIC DEFAULT 0,
    price       NUMERIC DEFAULT 0,
    amount      NUMERIC DEFAULT 0,
    date        TEXT DEFAULT '',
    note        TEXT DEFAULT '',
    create_time TEXT DEFAULT ''
);

-- ─── 分红记录 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dividends (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL DEFAULT '',
    holding_id  TEXT NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
    shares      NUMERIC DEFAULT 0,
    amount      NUMERIC DEFAULT 0,
    date        TEXT DEFAULT '',
    note        TEXT DEFAULT '',
    create_time TEXT DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_holding ON transactions(holding_id);
CREATE INDEX IF NOT EXISTS idx_dividends_user ON dividends(user_id);
CREATE INDEX IF NOT EXISTS idx_dividends_holding ON dividends(holding_id);

-- ─── 用户信息 ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    openid      TEXT PRIMARY KEY,
    nickname    TEXT DEFAULT '',
    avatar      TEXT DEFAULT '',
    create_time TEXT DEFAULT '',
    update_time TEXT DEFAULT ''
);
