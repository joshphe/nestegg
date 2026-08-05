-- 迁移：v2 schema（holdings + transactions + dividends）
-- 如需清空旧表并重建，请运行 schema.sql 或 npm run db:init
-- 本文件供 Neon Console SQL Editor 手动执行

DROP TABLE IF EXISTS dividends;
DROP TABLE IF EXISTS records;
DROP TABLE IF EXISTS transactions;
DROP TABLE IF EXISTS holdings;

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
