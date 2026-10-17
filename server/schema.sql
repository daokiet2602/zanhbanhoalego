-- SCHEMA D1 CHO LEGO STORE
-- Chạy: wrangler d1 execute lego-store --remote --file=schema.sql
-- (An toàn khi chạy lại nhiều lần: dùng IF NOT EXISTS)

-- Mỗi sản phẩm là 1 dòng riêng => 2 người sửa 2 sản phẩm khác nhau không bao giờ ghi đè nhau.
-- CHECK (qty >= 0) là "chốt chặn cuối": dù code có lỗi thì kho cũng không thể âm / bán lố.
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  code            TEXT    NOT NULL DEFAULT '',
  name            TEXT    NOT NULL,
  qty             INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
  sold            INTEGER NOT NULL DEFAULT 0 CHECK (sold >= 0),
  price_retail    INTEGER NOT NULL DEFAULT 0,
  price_wholesale INTEGER NOT NULL DEFAULT 0,
  price_market    INTEGER NOT NULL DEFAULT 0,
  price_cost      INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'active',   -- active | discontinued | hidden
  img             TEXT    NOT NULL DEFAULT '',
  note            TEXT    NOT NULL DEFAULT '',
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  order_id          TEXT PRIMARY KEY,
  status            TEXT    NOT NULL,
  pay_method        TEXT    NOT NULL DEFAULT '',
  ship_method       TEXT    NOT NULL DEFAULT '',
  ship_name         TEXT    NOT NULL DEFAULT '',
  ship_fee          INTEGER NOT NULL DEFAULT 0,
  subtotal          INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  customer_name     TEXT    NOT NULL DEFAULT '',
  customer_phone    TEXT    NOT NULL DEFAULT '',
  customer_address  TEXT    NOT NULL DEFAULT '',
  customer_ward     TEXT    NOT NULL DEFAULT '',
  customer_province TEXT    NOT NULL DEFAULT '',
  customer_note     TEXT    NOT NULL DEFAULT '',
  lines             TEXT    NOT NULL DEFAULT '[]',     -- JSON: [{id,code,name,qty,price,cost,lineTotal}]
  source            TEXT    NOT NULL DEFAULT 'web',    -- web | counter
  paid_amount       INTEGER NOT NULL DEFAULT 0,
  paid_at           INTEGER,
  transaction_id    TEXT,
  cancelled_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  time_str          TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status  ON orders (status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_phone   ON orders (customer_phone);

-- Chống xử lý trùng 1 giao dịch SePay (SePay có thể gửi lại webhook)
CREATE TABLE IF NOT EXISTS processed_tx (
  tx_id TEXT PRIMARY KEY,
  at    INTEGER NOT NULL
);

-- Giới hạn tần suất (chống spam đặt đơn, dò mật khẩu admin)
CREATE TABLE IF NOT EXISTS rate (
  k        TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- "Số phiên bản" tăng lên mỗi khi kho/đơn đổi. Client chỉ hỏi số này (1 dòng) mỗi lần poll,
-- chỉ tải lại dữ liệu khi số đổi => nhẹ, nhanh, không tốn hạn mức.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', 1);
