#!/usr/bin/env node
/**
 * Tạo file seed.sql để nạp dữ liệu cũ vào D1.
 *
 *   node tools/build-seed.mjs <data.json> [kv_store.json] [orders.json] > server/seed.sql
 *
 *  - data.json     : danh mục gốc (bắt buộc)
 *  - kv_store.json : (tuỳ chọn) dữ liệu KV cũ  -> GET /admin/store trên worker cũ (hoặc `wrangler kv key get lego_global_store`)
 *                    có { inventory:{id:{qty,cost,retail,sold,status}}, newProducts:[...] }. Sẽ ghi đè lên data.json.
 *  - orders.json   : (tuỳ chọn) GET /admin/orders trên worker cũ -> { orders:[...] }
 *
 * Seed dùng INSERT OR IGNORE nên chạy lại nhiều lần cũng không ghi đè dữ liệu đang chạy trên D1.
 */
import fs from 'node:fs';

const [dataPath, kvPath, ordersPath] = process.argv.slice(2);
if (!dataPath) { console.error('Cách dùng: node tools/build-seed.mjs data.json [kv_store.json] [orders.json] > server/seed.sql'); process.exit(1); }

const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const q = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(Math.round(v)) : `'${String(v).replace(/'/g, "''")}'`;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
const normStatus = s => (s === 'discontinued' || s === 'hidden') ? s : 'active';

const base = read(dataPath).products || [];
const kvRaw = kvPath ? read(kvPath) : {};
const kv = kvRaw.store || kvRaw.data || kvRaw;   // chấp nhận cả dạng có bọc {ok, store:{...}}
const inv = kv.inventory || {};
const now = Date.now();
const rows = new Map();

base.forEach((p, i) => {
  // data.json có thể chứa 2 sản phẩm khác nhau trùng mã (vd LG-62) -> đổi mã sản phẩm thứ 2 thành LG-62-B, -C...
  if (rows.has(p.id)) {
    const oldId = p.id; let n = 0, nid;
    do { nid = `${oldId}-${String.fromCharCode(66 + n++)}`; } while (rows.has(nid));
    console.error(`⚠ Trùng mã ${oldId}: "${p.name}" được đổi mã thành ${nid}`);
    p = { ...p, id: nid };
  }
  const o = inv[p.id] || {};
  rows.set(p.id, {
    id: p.id, code: p.code || '', name: p.name,
    qty: Math.max(0, num(o.qty, num(p.qty))), sold: Math.max(0, num(o.sold, num(p.sold_qty))),
    price_retail: num(o.retail, num(p.price_retail)), price_wholesale: num(p.price_wholesale),
    price_market: num(p.price_market), price_cost: num(o.cost, num(p.price_cost)),
    status: normStatus(o.status && o.status !== 'out_of_stock' ? o.status : p.status),
    img: p.img || '', note: p.note || '', sort_order: num(p.stt, i + 1)
  });
});
// Sản phẩm thêm mới trên admin cũ
let minSort = 0;
(kv.newProducts || []).forEach((p, i) => {
  if (rows.has(p.id)) return;
  const o = inv[p.id] || {};
  rows.set(p.id, {
    id: p.id, code: p.code || '', name: p.name || 'Mẫu mới',
    qty: Math.max(0, num(o.qty, num(p.qty))), sold: Math.max(0, num(o.sold, num(p.sold_qty))),
    price_retail: num(o.retail, num(p.price_retail)), price_wholesale: 0,
    price_market: num(p.price_market), price_cost: num(o.cost, num(p.price_cost)),
    status: normStatus(o.status && o.status !== 'out_of_stock' ? o.status : p.status),
    img: p.img || '', note: '', sort_order: minSort - (kv.newProducts.length - i)
  });
});

const out = ['-- seed.sql (tạo bởi tools/build-seed.mjs) — CHỨA GIÁ VỐN, KHÔNG đưa lên git/web công khai'];
for (const r of rows.values()) {
  out.push(`INSERT OR IGNORE INTO products (id,code,name,qty,sold,price_retail,price_wholesale,price_market,price_cost,status,img,note,sort_order,created_at,updated_at) VALUES (${[
    q(r.id), q(r.code), q(r.name), r.qty, r.sold, r.price_retail, r.price_wholesale, r.price_market, r.price_cost,
    q(r.status), q(r.img), q(r.note), r.sort_order, now, now].join(',')});`);
}

let orderCount = 0;
if (ordersPath) {
  const list = (read(ordersPath).orders || []);
  for (const o of list) {
    if (!o.orderId || !Array.isArray(o.lines)) continue;
    const c = o.customer || {};
    const lines = o.lines.map(l => ({ ...l, cost: l.cost !== undefined ? l.cost : (rows.get(l.id)?.price_cost ?? 0) }));
    const created = num(o.createdAt, now);
    out.push(`INSERT OR IGNORE INTO orders (order_id,status,pay_method,ship_method,ship_name,ship_fee,subtotal,total,customer_name,customer_phone,customer_address,customer_ward,customer_province,customer_note,lines,source,paid_amount,paid_at,transaction_id,cancelled_at,created_at,updated_at,time_str) VALUES (${[
      q(o.orderId), q(o.status || 'PAID'), q(o.payMethod || ''), q(o.shipMethod || ''), q(o.shipName || ''),
      num(o.shipFee), num(o.subtotal), num(o.total), q(c.name || ''), q(c.phone || ''), q(c.address || ''),
      q(c.ward || ''), q(c.province || ''), q(c.note || ''), q(JSON.stringify(lines)),
      q(o.status === 'COUNTER_SALE' ? 'counter' : 'web'), num(o.paidAmount), o.paidAt ? num(o.paidAt) : 'NULL',
      q(o.transactionId || null), o.cancelledAt ? num(o.cancelledAt) : 'NULL', created, created, q(o.timeStr || '')].join(',')});`);
    orderCount++;
  }
}
out.push("UPDATE meta SET value = value + 1 WHERE key = 'version';");
console.log(out.join('\n'));
console.error(`✔ ${rows.size} sản phẩm, ${orderCount} đơn hàng đã đưa vào seed.sql`);
