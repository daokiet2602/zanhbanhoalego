/**
 * SERVER DUY NHẤT CHO SHOP DÁNH BÁN HOA  —  Phiên bản 4.0 (Cloudflare D1)
 *
 * Nguyên tắc thiết kế (để admin và khách LUÔN khớp nhau):
 *  1. D1 là nguồn dữ liệu DUY NHẤT cho sản phẩm, tồn kho, giá, đơn hàng.
 *     Không còn file JSON tĩnh làm "nguồn thứ hai", không còn localStorage làm nguồn sự thật.
 *  2. Server tự tra giá + tồn kho. Không bao giờ tin giá/tồn do trình duyệt gửi.
 *  3. Trừ kho là 1 câu lệnh nguyên tử trong cùng transaction với việc tạo đơn
 *     (+ CHECK qty >= 0 trong schema) => không thể bán lố, không bị ghi đè.
 *  4. Admin chỉ gửi "thay đổi" (cộng/trừ n bộ, đổi giá...), KHÔNG BAO GIỜ đẩy cả kho lên.
 *  5. Mọi thay đổi tăng meta.version. Client poll số này (1 dòng) rồi mới tải lại khi cần.
 */

const SHIP_RATES = { hcm_std: 25000, hcm_express: 0, prov_std: 35000 };
const SHIP_NAMES = {
  hcm_std: 'Giao Tiêu Chuẩn TP.HCM (1 - 2 ngày)',
  hcm_express: 'Giao Hỏa Tốc Nội Thành (2 - 4h qua Grab/AhaMove)',
  prov_std: 'Giao Hàng Tiêu Chuẩn Toàn Quốc (2 - 4 ngày)'
};
const HOLD_MS = 24 * 3600 * 1000;               // giữ kho cho đơn chuyển khoản 24h
const PRODUCT_STATUSES = ['active', 'discontinued', 'hidden'];
const WORKFLOW_STATUSES = ['CONFIRMED', 'SHIPPED', 'DELIVERED'];
const DEFAULT_ORIGINS = ['https://daokiet2602.github.io'];

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = buildCors(req, env);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (!env.DB) {
        return json({ ok: false, error: 'DB_NOT_BOUND', message: 'Worker chưa được gắn D1 database (binding tên DB).' }, 500, cors);
      }
      const p = url.pathname, m = req.method;

      if (p === '/webhook/sepay' && m === 'POST') {
        const r = await handleSepayWebhook(req, env, ctx);
        return json(r.body, r.status, cors);
      }
      if (p === '/store' && m === 'GET') return json(await handlePublicStore(env, url), 200, cors);
      if (p === '/order' && m === 'POST') {
        const r = await handleCreateOrder(req, env, ctx);
        return json(r.body, r.status, cors);
      }
      if (p === '/order-status' && m === 'GET') return json(await handleOrderStatus(env, url), 200, cors);
      if (p === '/order-lookup' && m === 'GET') {
        const r = await handleOrderLookup(req, env, url);
        return json(r.body, r.status, cors);
      }

      if (p.startsWith('/admin/')) {
        const auth = await verifyAdmin(req, env);
        if (!auth.ok) return json({ ok: false, error: auth.error, message: auth.message }, auth.status, cors);
        const r = await handleAdmin(p, m, req, env, url);
        return json(r.body, r.status || 200, cors);
      }

      return json({ ok: false, error: 'NOT_FOUND' }, 404, cors);
    } catch (e) {
      // Ghi log nội bộ (xem bằng `wrangler tail`), chỉ trả thông báo chung cho client
      console.error('SERVER_ERROR', req.method, url.pathname, e && e.stack ? e.stack : e);
      return json({ ok: false, error: 'SERVER_ERROR', message: 'Hệ thống đang bận. Vui lòng thử lại sau.' }, 500, cors);
    }
  },

  // Cron: hết hạn đơn chưa thanh toán + dọn bảng tạm
  async scheduled(evt, env, ctx) {
    ctx.waitUntil(runCron(env).catch(e => console.error('CRON_ERROR', e)));
  }
};

/* ============================ TIỆN ÍCH CHUNG ============================ */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
function fail(status, error, message, extra = {}) {
  return { status, body: { ok: false, error, message, ...extra } };
}
async function readJson(req) {
  try { const b = await req.json(); return b && typeof b === 'object' ? b : null; } catch (e) { return null; }
}

function buildCors(req, env) {
  const origin = req.headers.get('Origin') || '';
  const list = [...DEFAULT_ORIGINS, ...String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)];
  // localhost kèm cổng (vd http://localhost:8080) để test trên máy
  const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const ok = isLocal || list.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

// Giờ Việt Nam (UTC+7) — Worker chạy theo UTC nên phải tự đổi
function vnDateParts(ts = Date.now()) {
  const d = new Date(ts + 7 * 3600 * 1000);
  return {
    yy: String(d.getUTCFullYear()).slice(-2),
    mm: String(d.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(d.getUTCDate()).padStart(2, '0')
  };
}
function vnTimeStr(ts = Date.now()) {
  return new Date(ts).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}
function genOrderId() {
  const { yy, mm, dd } = vnDateParts();
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `DH${yy}${mm}${dd}${rand}`;
}

function cleanText(str, max = 300) {
  return String(str == null ? '' : str).replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, max);
}
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function fmtVND(n) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function normPhone(p) {
  let s = String(p || '').replace(/[\s.\-_()]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('84') && s.length === 11) s = '0' + s.slice(2);
  return s;
}
function toInt(v, def = 0) {
  if (v === null || v === undefined || v === '') return def;   // Number(null) = 0 sẽ gây lỗi âm thầm
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : def;
}

const bump = db => db.prepare("UPDATE meta SET value = value + 1 WHERE key = 'version'");
async function getVersion(db) {
  const r = await db.prepare("SELECT value FROM meta WHERE key = 'version'").first();
  return r ? r.value : 0;
}

// Giới hạn tần suất: trả true nếu CÒN trong hạn mức
async function rateHit(db, key, limit, windowMs) {
  const now = Date.now();
  await db.prepare(
    `INSERT INTO rate (k, n, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN reset_at < ?3 THEN 1 ELSE n + 1 END,
       reset_at = CASE WHEN reset_at < ?3 THEN ?2 ELSE reset_at END`
  ).bind(key, now + windowMs, now).run();
  const r = await db.prepare('SELECT n FROM rate WHERE k = ?').bind(key).first();
  return !r || r.n <= limit;
}
async function rateCount(db, key) {
  const r = await db.prepare('SELECT n FROM rate WHERE k = ? AND reset_at > ?').bind(key, Date.now()).first();
  return r ? r.n : 0;
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;            // chưa bật Turnstile => bỏ qua
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token), remoteip: ip })
    });
    const j = await r.json();
    return !!j.success;
  } catch (e) { return false; }
}

/* ============================ MAPPING DỮ LIỆU ============================ */

function publicProduct(r) {
  return {
    id: r.id, code: r.code, name: r.name, qty: r.qty,
    price_retail: r.price_retail, price_market: r.price_market,
    status: r.status, img: r.img
  };
}
function adminProduct(r) {
  return {
    ...publicProduct(r),
    sold: r.sold, price_cost: r.price_cost, price_wholesale: r.price_wholesale,
    note: r.note, sort_order: r.sort_order, created_at: r.created_at, updated_at: r.updated_at
  };
}
function rowToOrder(r) {
  let lines = [];
  try { lines = JSON.parse(r.lines || '[]'); } catch (e) {}
  return {
    orderId: r.order_id, status: r.status, payMethod: r.pay_method,
    shipMethod: r.ship_method, shipName: r.ship_name, shipFee: r.ship_fee,
    subtotal: r.subtotal, total: r.total, lines,
    customer: {
      name: r.customer_name, phone: r.customer_phone, address: r.customer_address,
      ward: r.customer_ward, province: r.customer_province, note: r.customer_note
    },
    source: r.source, paidAmount: r.paid_amount, paidAt: r.paid_at,
    createdAt: r.created_at, timeStr: r.time_str
  };
}
function insertOrderStmt(db, o) {
  return db.prepare(
    `INSERT INTO orders (order_id, status, pay_method, ship_method, ship_name, ship_fee, subtotal, total,
       customer_name, customer_phone, customer_address, customer_ward, customer_province, customer_note,
       lines, source, created_at, updated_at, time_str)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    o.orderId, o.status, o.payMethod, o.shipMethod, o.shipName, o.shipFee, o.subtotal, o.total,
    o.customer.name, o.customer.phone, o.customer.address, o.customer.ward, o.customer.province, o.customer.note,
    JSON.stringify(o.lines), o.source, o.createdAt, o.createdAt, o.timeStr
  );
}
const takeStockStmt = (db, id, qty, now) =>
  db.prepare('UPDATE products SET qty = qty - ?1, sold = sold + ?1, updated_at = ?2 WHERE id = ?3').bind(qty, now, id);
const giveStockStmt = (db, id, qty, now) =>
  db.prepare('UPDATE products SET qty = qty + ?1, sold = MAX(0, sold - ?1), updated_at = ?2 WHERE id = ?3').bind(qty, now, id);

async function loadProducts(db, ids) {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const { results } = await db.prepare(`SELECT * FROM products WHERE id IN (${ph})`).bind(...ids).all();
  return new Map(results.map(r => [r.id, r]));
}
async function outOfStockFail(db, lines) {
  const prods = await loadProducts(db, lines.map(l => l.id));
  for (const l of lines) {
    const p = prods.get(l.id);
    if (!p || p.qty < l.qty) {
      const left = p ? p.qty : 0;
      return fail(409, 'OUT_OF_STOCK',
        left > 0 ? `Mẫu [${l.name}] chỉ còn ${left} bộ, không đủ số lượng bạn đặt!` : `Mẫu [${l.name}] vừa hết hàng!`,
        { productId: l.id, available: left });
    }
  }
  return fail(409, 'OUT_OF_STOCK', 'Một số sản phẩm vừa thay đổi tồn kho, vui lòng kiểm tra lại giỏ hàng.');
}

/* ============================ API CÔNG KHAI ============================ */

// GET /store?v=<version>  -> danh mục + tồn kho + giá "sạch" (không có giá vốn / lợi nhuận)
async function handlePublicStore(env, url) {
  const db = env.DB;
  const version = await getVersion(db);
  if (url.searchParams.get('v') === String(version)) return { ok: true, version, unchanged: true };
  const { results } = await db.prepare(
    "SELECT id, code, name, qty, price_retail, price_market, status, img FROM products WHERE status != 'hidden' ORDER BY sort_order ASC, id ASC"
  ).all();
  return { ok: true, version, products: results.map(publicProduct) };
}

// POST /order
async function handleCreateOrder(req, env, ctx) {
  const db = env.DB;
  const b = await readJson(req);
  if (!b) return fail(400, 'INVALID_INPUT', 'Dữ liệu gửi lên không hợp lệ.');
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';

  if (!(await rateHit(db, 'order-ip:' + ip, toInt(env.ORDER_RATE_LIMIT, 20), 3600 * 1000))) {
    return fail(429, 'TOO_MANY_REQUESTS', 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít phút.');
  }
  if (!(await verifyTurnstile(env, b.turnstileToken, ip))) {
    return fail(403, 'CAPTCHA_FAILED', 'Xác minh chống spam không thành công, vui lòng tải lại trang và thử lại.');
  }

  const c = b.customer || {};
  const name = cleanText(c.name, 100), address = cleanText(c.address, 300);
  if (!name || !c.phone || !address) {
    return fail(400, 'INVALID_INPUT', 'Vui lòng điền đầy đủ Họ tên, Số điện thoại và Địa chỉ giao hàng!');
  }
  const phone = normPhone(c.phone);
  if (!/^0(3|5|7|8|9)\d{8}$/.test(phone)) return fail(400, 'INVALID_PHONE', 'Số điện thoại di động không hợp lệ!');

  const payMethod = b.payMethod === 'transfer' ? 'transfer' : (b.payMethod === 'cod' ? 'cod' : null);
  if (!payMethod) return fail(400, 'INVALID_PAY', 'Phương thức thanh toán không hợp lệ.');
  const shipMethod = b.shipMethod || 'hcm_std';
  if (SHIP_RATES[shipMethod] === undefined) return fail(400, 'INVALID_SHIP', 'Phương thức vận chuyển không hợp lệ.');

  if (!Array.isArray(b.items) || b.items.length === 0) return fail(400, 'EMPTY_CART', 'Giỏ hàng của bạn đang trống!');
  if (b.items.length > 30) return fail(400, 'TOO_MANY_ITEMS', 'Giỏ hàng có quá nhiều sản phẩm.');

  // Gộp dòng trùng id, kiểm tra số lượng
  const agg = new Map();
  for (const it of b.items) {
    const id = String((it && it.id) || '');
    const qty = toInt(it && it.qty, NaN);
    if (!id || !Number.isFinite(qty) || qty < 1 || qty > 100) {
      return fail(400, 'INVALID_QUANTITY', `Số lượng sản phẩm không hợp lệ: ${cleanText((it && (it.name || it.id)) || '', 60)}`);
    }
    agg.set(id, (agg.get(id) || 0) + qty);
  }

  // Chặn spam giữ kho: tối đa 3 đơn chuyển khoản đang chờ trên mỗi số điện thoại
  if (payMethod === 'transfer') {
    const pend = await db.prepare("SELECT COUNT(*) AS c FROM orders WHERE customer_phone = ? AND status = 'PENDING_PAYMENT'").bind(phone).first();
    if (pend && pend.c >= 3) {
      return fail(429, 'TOO_MANY_PENDING', 'Bạn đang có 3 đơn chờ chuyển khoản. Vui lòng thanh toán hoặc chờ đơn cũ hết hạn trước khi đặt thêm.');
    }
  }

  // Server tự tra giá & tồn kho — KHÔNG tin dữ liệu từ trình duyệt
  const prods = await loadProducts(db, [...agg.keys()]);
  const lines = [];
  let subtotal = 0;
  for (const [id, qty] of agg) {
    const pr = prods.get(id);
    if (!pr || pr.status === 'hidden') return fail(404, 'PRODUCT_NOT_FOUND', `Sản phẩm ${cleanText(id, 30)} không còn trong cửa hàng.`);
    if (pr.status === 'discontinued') return fail(409, 'DISCONTINUED', `Mẫu [${pr.name}] đã ngừng bán.`);
    if (pr.qty < qty) {
      return fail(409, 'OUT_OF_STOCK',
        pr.qty > 0 ? `Mẫu [${pr.name}] chỉ còn ${pr.qty} bộ, không đủ số lượng đặt!` : `Mẫu [${pr.name}] vừa hết hàng!`,
        { productId: id, available: pr.qty });
    }
    const lineTotal = pr.price_retail * qty;
    subtotal += lineTotal;
    lines.push({ id, code: pr.code, name: pr.name, qty, price: pr.price_retail, cost: pr.price_cost, lineTotal });
  }

  const shipFee = SHIP_RATES[shipMethod];
  const total = subtotal + shipFee;
  const now = Date.now();
  const status = payMethod === 'transfer' ? 'PENDING_PAYMENT' : 'COD_NEW';

  let order = null;
  for (let attempt = 0; attempt < 6 && !order; attempt++) {
    const candidate = {
      orderId: genOrderId(), status, payMethod, shipMethod, shipName: SHIP_NAMES[shipMethod],
      shipFee, subtotal, total, lines, source: 'web',
      customer: {
        name, phone, address,
        ward: cleanText(c.ward, 100), province: cleanText(c.province, 100), note: cleanText(c.note, 500)
      },
      createdAt: now, timeStr: vnTimeStr(now)
    };
    // 1 transaction: trừ kho từng món + tạo đơn + tăng version. Hỏng 1 bước => hoàn tác tất cả.
    const stmts = lines.map(l => takeStockStmt(db, l.id, l.qty, now));
    stmts.push(insertOrderStmt(db, candidate));
    stmts.push(bump(db));
    try {
      await db.batch(stmts);
      order = candidate;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/UNIQUE/i.test(msg)) continue;                           // trùng mã đơn -> thử mã khác
      if (/CHECK/i.test(msg)) return await outOfStockFail(db, lines); // kho vừa bị người khác mua hết
      throw e;
    }
  }
  if (!order) return fail(503, 'ORDER_ID_BUSY', 'Hệ thống đang bận, vui lòng thử lại sau giây lát.');

  const header = payMethod === 'transfer'
    ? '🌸 <b>ĐƠN HÀNG MỚI (CHỜ CHUYỂN KHOẢN) - DÁNH BÁN HOA!</b>'
    : '🌸 <b>ĐƠN HÀNG MỚI (COD) - DÁNH BÁN HOA!</b>';
  ctx.waitUntil(sendTelegramOrder(env, order, header));

  return {
    status: 200,
    body: { ok: true, orderId: order.orderId, status, subtotal, shipFee, total, memo: `${order.orderId} ${phone}` }
  };
}

// GET /order-status?id=  (client poll chờ tiền về)
async function handleOrderStatus(env, url) {
  const id = String(url.searchParams.get('id') || '').toUpperCase();
  if (!/^DH\d{10}$/.test(id)) return { ok: false, error: 'INVALID_ID' };
  const r = await env.DB.prepare('SELECT order_id, status, total, paid_amount FROM orders WHERE order_id = ?').bind(id).first();
  if (!r) return { ok: false, error: 'NOT_FOUND', status: 'NOT_FOUND' };
  return { ok: true, orderId: r.order_id, status: r.status, total: r.total, paid: r.paid_amount >= r.total && r.total > 0 };
}

// GET /order-lookup?id=&phone=  (khách tra cứu đơn: phải khớp cả mã đơn và SĐT)
async function handleOrderLookup(req, env, url) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await rateHit(env.DB, 'lookup-ip:' + ip, 30, 10 * 60 * 1000))) {
    return fail(429, 'TOO_MANY_REQUESTS', 'Bạn tra cứu quá nhiều lần, vui lòng thử lại sau ít phút.');
  }
  const id = String(url.searchParams.get('id') || '').trim().toUpperCase();
  const phone = normPhone(url.searchParams.get('phone'));
  const r = await env.DB.prepare('SELECT * FROM orders WHERE order_id = ?').bind(id).first();
  if (!r || r.customer_phone !== phone) {
    return fail(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng khớp mã đơn và số điện thoại này.');
  }
  const o = rowToOrder(r);
  return {
    status: 200,
    body: {
      ok: true,
      order: {
        orderId: o.orderId, status: o.status, payMethod: o.payMethod, shipName: o.shipName, shipFee: o.shipFee,
        subtotal: o.subtotal, total: o.total, paidAmount: o.paidAmount, timeStr: o.timeStr,
        lines: o.lines.map(l => ({ name: l.name, qty: l.qty, price: l.price, lineTotal: l.lineTotal }))
      }
    }
  };
}

/* ============================ WEBHOOK SEPAY ============================ */

async function handleSepayWebhook(req, env, ctx) {
  const db = env.DB;
  const authHeader = req.headers.get('Authorization') || '';
  if (!env.SEPAY_WEBHOOK_KEY || !safeEqual(authHeader, 'Apikey ' + env.SEPAY_WEBHOOK_KEY)) {
    return { status: 401, body: { success: false, message: 'Unauthorized' } };
  }
  const tx = await readJson(req);
  if (!tx) return { status: 400, body: { success: false, message: 'Bad JSON' } };

  if (tx.transferType !== 'in' && tx.transaction_type !== 'in') {
    return { status: 200, body: { success: true, message: 'Bỏ qua giao dịch tiền ra' } };
  }

  const txId = String(tx.id || tx.transaction_id || '');
  const content = String(tx.content || tx.transaction_content || tx.description || tx.code || '').toLowerCase();
  const m = content.match(/dh\d{10}/);
  if (!m) return { status: 200, body: { success: true, message: 'Không có mã đơn hàng trong nội dung chuyển khoản' } };
  const orderId = m[0].toUpperCase();

  // Chống xử lý trùng: ghi nhận tx_id trước; nếu đã có -> bỏ qua
  if (txId) {
    const ins = await db.prepare('INSERT OR IGNORE INTO processed_tx (tx_id, at) VALUES (?, ?)').bind(txId, Date.now()).run();
    if (!ins.meta || ins.meta.changes === 0) return { status: 200, body: { success: true, message: 'Giao dịch đã được xử lý' } };
  }

  try {
    const row = await db.prepare('SELECT * FROM orders WHERE order_id = ?').bind(orderId).first();
    if (!row) return { status: 200, body: { success: true, message: `Không tìm thấy đơn hàng ${orderId}` } };

    const amount = Math.round(parseFloat(tx.transferAmount || tx.amount_in || tx.amount || 0)) || 0;
    const newPaid = (row.paid_amount || 0) + amount;      // cộng dồn nếu khách chuyển bù
    const full = newPaid >= row.total;
    const now = Date.now();
    let newStatus = row.status;
    let note = '';

    if (row.status === 'PENDING_PAYMENT' || row.status === 'UNDERPAID') {
      newStatus = full ? 'PAID' : 'UNDERPAID';
    } else if (row.status === 'EXPIRED' || row.status === 'CANCELLED') {
      // Đơn đã trả kho: thử giữ lại kho cho khách. Hết hàng => PAID_LATE để shop xử lý/hoàn tiền thủ công.
      const lines = JSON.parse(row.lines || '[]');
      try {
        await db.batch([...lines.map(l => takeStockStmt(db, l.id, l.qty, now)), bump(db)]);
        newStatus = full ? 'PAID' : 'UNDERPAID';
        note = 'Đơn đã hết hạn/hủy nhưng khách chuyển khoản: hệ thống đã giữ lại kho cho đơn này.';
      } catch (e) {
        newStatus = 'PAID_LATE';
        note = 'Đơn đã hết hạn/hủy và KHO KHÔNG ĐỦ: cần liên hệ khách hoàn tiền hoặc xử lý thủ công.';
      }
    }
    // Các trạng thái còn lại (đã PAID, CONFIRMED, SHIPPED...): chỉ ghi nhận thêm số tiền

    await db.batch([
      db.prepare('UPDATE orders SET status = ?, paid_amount = ?, paid_at = ?, transaction_id = ?, updated_at = ?, cancelled_at = CASE WHEN ? IN (\'PAID\',\'UNDERPAID\') THEN NULL ELSE cancelled_at END WHERE order_id = ?')
        .bind(newStatus, newPaid, now, txId || null, now, newStatus, orderId),
      bump(db)
    ]);

    const order = rowToOrder({ ...row, status: newStatus, paid_amount: newPaid });
    const header = newStatus === 'PAID'
      ? `💰 <b>[TỰ ĐỘNG SEPAY] ĐƠN HÀNG #${orderId} ĐÃ THANH TOÁN THÀNH CÔNG!</b>`
      : (newStatus === 'PAID_LATE'
        ? `🚨 <b>[SEPAY] ĐƠN #${orderId} CHUYỂN KHOẢN MUỘN - CẦN XỬ LÝ!</b>`
        : `⚠️ <b>[SEPAY] ĐƠN HÀNG #${orderId} THANH TOÁN THIẾU TIỀN!</b>`);
    ctx.waitUntil(sendTelegramPaidAlert(env, order, tx, header, note));

    return { status: 200, body: { success: true, orderId, status: newStatus } };
  } catch (e) {
    // Lỗi giữa chừng: bỏ dấu đã xử lý để SePay gửi lại webhook, rồi trả 500
    if (txId) await db.prepare('DELETE FROM processed_tx WHERE tx_id = ?').bind(txId).run().catch(() => {});
    throw e;
  }
}

/* ============================ ADMIN ============================ */

async function verifyAdmin(req, env) {
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 8) {
    return { ok: false, status: 503, error: 'ADMIN_NOT_CONFIGURED', message: 'Server chưa cấu hình ADMIN_KEY (cần ít nhất 8 ký tự).' };
  }
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if ((await rateCount(env.DB, 'adminfail:' + ip)) >= 10) {
    return { ok: false, status: 429, error: 'TOO_MANY_ATTEMPTS', message: 'Nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.' };
  }
  const key = req.headers.get('X-Admin-Key') || '';
  if (!safeEqual(key, env.ADMIN_KEY)) {
    await rateHit(env.DB, 'adminfail:' + ip, 10, 15 * 60 * 1000);
    return { ok: false, status: 401, error: 'UNAUTHORIZED', message: 'Mã quản trị không đúng.' };
  }
  return { ok: true };
}

async function handleAdmin(p, m, req, env, url) {
  const db = env.DB;

  if (p === '/admin/ping' && m === 'GET') return { body: { ok: true, version: await getVersion(db) } };

  // Danh sách sản phẩm đầy đủ (có giá vốn, đã bán)
  if (p === '/admin/products' && m === 'GET') {
    const version = await getVersion(db);
    if (url.searchParams.get('v') === String(version)) return { body: { ok: true, version, unchanged: true } };
    const { results } = await db.prepare('SELECT * FROM products ORDER BY sort_order ASC, id ASC').all();
    return { body: { ok: true, version, products: results.map(adminProduct) } };
  }

  // Sửa 1 sản phẩm. Kho gửi dạng "cộng/trừ n bộ" (qtyDelta) để KHÔNG ghi đè đơn khách vừa đặt.
  if (p === '/admin/products/update' && m === 'POST') {
    const b = await readJson(req);
    if (!b || !b.id) return fail(400, 'INVALID_INPUT', 'Thiếu mã sản phẩm.');
    const cur = await db.prepare('SELECT * FROM products WHERE id = ?').bind(String(b.id)).first();
    if (!cur) return fail(404, 'NOT_FOUND', 'Không tìm thấy sản phẩm.');

    const sets = [], vals = [];
    const add = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    let explicitStatus = false;

    if (b.qtyDelta !== undefined) {
      const d = toInt(b.qtyDelta, NaN);
      if (!Number.isFinite(d)) return fail(400, 'INVALID_INPUT', 'qtyDelta không hợp lệ.');
      sets.push('qty = qty + ?'); vals.push(d);
    } else if (b.qty !== undefined) {
      const q = toInt(b.qty, NaN);
      if (!Number.isFinite(q) || q < 0) return fail(400, 'INVALID_INPUT', 'Số lượng không hợp lệ.');
      add('qty', q);
    }
    if (b.price_cost !== undefined || b.cost !== undefined) add('price_cost', Math.max(0, toInt(b.price_cost ?? b.cost)));
    if (b.price_retail !== undefined || b.retail !== undefined) {
      const r = toInt(b.price_retail ?? b.retail, NaN);
      if (!Number.isFinite(r) || r <= 0) return fail(400, 'INVALID_INPUT', 'Giá bán lẻ phải lớn hơn 0.');
      add('price_retail', r);
    }
    if (b.price_market !== undefined) add('price_market', Math.max(0, toInt(b.price_market)));
    if (b.name !== undefined) { const n = cleanText(b.name, 200); if (!n) return fail(400, 'INVALID_INPUT', 'Tên không được để trống.'); add('name', n); }
    if (b.code !== undefined) add('code', cleanText(b.code, 60));
    if (b.img !== undefined) add('img', cleanText(b.img, 500));
    if (b.note !== undefined) add('note', cleanText(b.note, 500));
    if (b.status !== undefined) {
      const st = b.status === 'out_of_stock' ? 'active' : String(b.status);
      if (!PRODUCT_STATUSES.includes(st)) return fail(400, 'INVALID_INPUT', 'Trạng thái không hợp lệ.');
      add('status', st); explicitStatus = true;
    }
    if (!sets.length) return { body: { ok: true, product: adminProduct(cur), version: await getVersion(db) } };
    add('updated_at', Date.now());

    try {
      await db.batch([
        db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, cur.id),
        bump(db)
      ]);
    } catch (e) {
      if (/CHECK/i.test(String(e && e.message))) return fail(409, 'NEGATIVE_STOCK', 'Tồn kho không thể âm (có thể vừa có khách đặt hàng). Dữ liệu đã được tải lại.', { product: adminProduct(await db.prepare('SELECT * FROM products WHERE id = ?').bind(cur.id).first()) });
      throw e;
    }
    const fresh = await db.prepare('SELECT * FROM products WHERE id = ?').bind(cur.id).first();
    return { body: { ok: true, product: adminProduct(fresh), version: await getVersion(db) } };
  }

  // Thêm sản phẩm mới
  if (p === '/admin/products/create' && m === 'POST') {
    const b = await readJson(req);
    if (!b) return fail(400, 'INVALID_INPUT', 'Dữ liệu không hợp lệ.');
    const name = cleanText(b.name, 200);
    const retail = toInt(b.price_retail ?? b.retail, 0);
    if (!name) return fail(400, 'INVALID_INPUT', 'Vui lòng nhập tên sản phẩm.');
    if (retail <= 0) return fail(400, 'INVALID_INPUT', 'Giá bán lẻ phải lớn hơn 0.');

    let id = cleanText(b.id, 32);
    if (id && !/^[A-Za-z0-9_-]{1,32}$/.test(id)) return fail(400, 'INVALID_INPUT', 'Mã SP chỉ gồm chữ, số, gạch ngang/dưới.');
    if (!id) {
      const { results } = await db.prepare("SELECT id FROM products WHERE id LIKE 'LG-%'").all();
      const max = results.reduce((mx, r) => Math.max(mx, parseInt(r.id.slice(3)) || 0), 0);
      id = 'LG-' + String(max + 1).padStart(2, '0');
    }
    const minSort = await db.prepare('SELECT COALESCE(MIN(sort_order), 0) AS s FROM products').first();
    const now = Date.now();
    const qty = Math.max(0, toInt(b.qty, 0));
    try {
      await db.batch([
        db.prepare(`INSERT INTO products (id, code, name, qty, sold, price_retail, price_wholesale, price_market, price_cost, status, img, note, sort_order, created_at, updated_at)
                    VALUES (?,?,?,?,0,?,0,?,?, 'active', ?, '', ?, ?, ?)`)
          .bind(id, cleanText(b.code, 60) || ('Mẫu #' + id.replace(/^LG-0*/, '')), name, qty, retail,
            Math.max(0, toInt(b.price_market, Math.round(retail * 1.3))), Math.max(0, toInt(b.price_cost ?? b.cost, 0)),
            cleanText(b.img, 500) || 'images/prod_row_2.jpeg', (minSort ? minSort.s : 0) - 1, now, now),
        bump(db)
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) return fail(409, 'DUPLICATE_ID', `Mã sản phẩm ${id} đã tồn tại.`);
      throw e;
    }
    const fresh = await db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
    return { body: { ok: true, product: adminProduct(fresh), version: await getVersion(db) } };
  }

  // Danh sách đơn
  if (p === '/admin/orders' && m === 'GET') {
    const version = await getVersion(db);
    if (url.searchParams.get('v') === String(version)) return { body: { ok: true, version, unchanged: true } };
    const limit = Math.min(1000, Math.max(1, toInt(url.searchParams.get('limit'), 500)));
    const { results } = await db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    return { body: { ok: true, version, orders: results.map(rowToOrder) } };
  }

  // Bán tại quầy — server là nơi DUY NHẤT trừ kho
  if (p === '/admin/orders/create' && m === 'POST') {
    const b = await readJson(req);
    if (!b) return fail(400, 'INVALID_INPUT', 'Dữ liệu không hợp lệ.');
    const input = Array.isArray(b.lines) && b.lines.length ? b.lines : [{ id: b.prodId, qty: b.qty, price: b.price }];
    if (input.length > 30) return fail(400, 'INVALID_INPUT', 'Quá nhiều dòng.');

    const prods = await loadProducts(db, input.map(l => String(l.id || '')));
    const lines = [];
    for (const l of input) {
      const pr = prods.get(String(l.id || ''));
      const qty = toInt(l.qty, NaN);
      if (!pr) return fail(404, 'NOT_FOUND', `Không tìm thấy sản phẩm ${cleanText(l.id, 30)}.`);
      if (!Number.isFinite(qty) || qty < 1 || qty > 1000) return fail(400, 'INVALID_QUANTITY', 'Số lượng bán phải từ 1 trở lên.');
      if (pr.qty < qty) return fail(409, 'OUT_OF_STOCK', `Tồn kho chỉ còn ${pr.qty} bộ, không đủ xuất bán ${qty} bộ!`, { productId: pr.id, available: pr.qty });
      const price = l.price !== undefined && l.price !== null && l.price !== '' ? Math.max(0, toInt(l.price, pr.price_retail)) : pr.price_retail;
      lines.push({ id: pr.id, code: pr.code, name: pr.name, qty, price, cost: pr.price_cost, lineTotal: price * qty });
    }
    const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
    const now = Date.now();
    let order = null;
    for (let attempt = 0; attempt < 6 && !order; attempt++) {
      const cand = {
        orderId: genOrderId(), status: 'COUNTER_SALE', payMethod: 'direct', shipMethod: 'direct',
        shipName: 'Bán trực tiếp tại quầy', shipFee: 0, subtotal, total: subtotal, lines, source: 'counter',
        customer: { name: 'Bán tại quầy', phone: '---', address: 'Tại quầy', ward: '', province: '', note: cleanText(b.note, 300) || 'Bán trực tiếp tại quầy' },
        createdAt: now, timeStr: vnTimeStr(now)
      };
      try {
        await db.batch([...lines.map(l => takeStockStmt(db, l.id, l.qty, now)), insertOrderStmt(db, cand), bump(db)]);
        order = cand;
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (/UNIQUE/i.test(msg)) continue;
        if (/CHECK/i.test(msg)) return await outOfStockFail(db, lines);
        throw e;
      }
    }
    if (!order) return fail(503, 'ORDER_ID_BUSY', 'Hệ thống bận, thử lại.');
    const after = await loadProducts(db, lines.map(l => l.id));
    return { body: { ok: true, order, products: [...after.values()].map(adminProduct), version: await getVersion(db) } };
  }

  // Hủy đơn + hoàn kho (chỉ hoàn đúng 1 lần)
  if (p === '/admin/orders/cancel' && m === 'POST') {
    const b = await readJson(req);
    const id = String((b && b.orderId) || '').toUpperCase().trim();
    if (!id) return fail(400, 'MISSING_ORDER_ID', 'Thiếu mã đơn.');
    const row = await db.prepare('SELECT * FROM orders WHERE order_id = ?').bind(id).first();
    if (!row) return fail(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng.');
    if (row.status === 'CANCELLED' || row.status === 'EXPIRED') {
      return { body: { ok: true, orderId: id, status: row.status, alreadyDone: true } };
    }
    const now = Date.now();
    // Chiếm quyền hủy bằng 1 UPDATE có điều kiện: chỉ 1 request thắng => không hoàn kho 2 lần
    const claim = await db.prepare(
      "UPDATE orders SET status = 'CANCELLED', cancelled_at = ?1, updated_at = ?1 WHERE order_id = ?2 AND status NOT IN ('CANCELLED','EXPIRED')"
    ).bind(now, id).run();
    if (claim.meta && claim.meta.changes === 1) {
      const lines = JSON.parse(row.lines || '[]');
      await db.batch([...lines.map(l => giveStockStmt(db, l.id, l.qty, now)), bump(db)]);
    }
    return { body: { ok: true, orderId: id, status: 'CANCELLED', version: await getVersion(db) } };
  }

  // Đổi trạng thái xử lý đơn: CONFIRMED | SHIPPED | DELIVERED | PAID (xác nhận đã nhận tiền thủ công)
  if (p === '/admin/orders/status' && m === 'POST') {
    const b = await readJson(req);
    const id = String((b && b.orderId) || '').toUpperCase().trim();
    const next = String((b && b.status) || '');
    if (!id || ![...WORKFLOW_STATUSES, 'PAID'].includes(next)) return fail(400, 'INVALID_INPUT', 'Trạng thái không hợp lệ.');
    const row = await db.prepare('SELECT * FROM orders WHERE order_id = ?').bind(id).first();
    if (!row) return fail(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng.');
    if (['CANCELLED', 'EXPIRED', 'COUNTER_SALE'].includes(row.status)) {
      return fail(409, 'INVALID_STATE', 'Đơn này không thể đổi trạng thái.');
    }
    const now = Date.now();
    if (next === 'PAID') {
      if (!['PENDING_PAYMENT', 'UNDERPAID', 'PAID_LATE'].includes(row.status)) return fail(409, 'INVALID_STATE', 'Đơn này không ở trạng thái chờ thanh toán.');
      await db.batch([
        db.prepare("UPDATE orders SET status = 'PAID', paid_amount = MAX(paid_amount, total), paid_at = ?1, updated_at = ?1 WHERE order_id = ?2").bind(now, id),
        bump(db)
      ]);
    } else {
      const paid = row.pay_method === 'cod' || row.paid_amount >= row.total;
      if (!paid) return fail(409, 'NOT_PAID', 'Đơn chuyển khoản này chưa nhận đủ tiền, chưa thể xác nhận/giao.');
      await db.batch([
        db.prepare('UPDATE orders SET status = ?1, updated_at = ?2 WHERE order_id = ?3').bind(next, now, id),
        bump(db)
      ]);
    }
    return { body: { ok: true, orderId: id, status: next, version: await getVersion(db) } };
  }

  return fail(404, 'NOT_FOUND', 'Không có chức năng này.');
}

/* ============================ CRON ============================ */

async function runCron(env) {
  const db = env.DB;
  const now = Date.now();

  const { results } = await db.prepare(
    "SELECT order_id, lines FROM orders WHERE status = 'PENDING_PAYMENT' AND created_at < ? LIMIT 200"
  ).bind(now - HOLD_MS).all();

  for (const o of results) {
    const claim = await db.prepare(
      "UPDATE orders SET status = 'EXPIRED', updated_at = ?1 WHERE order_id = ?2 AND status = 'PENDING_PAYMENT'"
    ).bind(now, o.order_id).run();
    if (claim.meta && claim.meta.changes === 1) {
      const lines = JSON.parse(o.lines || '[]');
      await db.batch([...lines.map(l => giveStockStmt(db, l.id, l.qty, now)), bump(db)]);
    }
  }

  await db.prepare('DELETE FROM rate WHERE reset_at < ?').bind(now).run();
  await db.prepare('DELETE FROM processed_tx WHERE at < ?').bind(now - 60 * 24 * 3600 * 1000).run();
}

/* ============================ TELEGRAM ============================ */

function chatIds(env) {
  return (env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}
async function broadcastTelegram(token, ids, htmlMsg) {
  return Promise.all(ids.map(chatId =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: htmlMsg, parse_mode: 'HTML' })
    }).catch(err => console.warn('Lỗi Telegram:', err))
  ));
}

async function sendTelegramOrder(env, order, headerText) {
  const token = env.TELEGRAM_BOT_TOKEN, ids = chatIds(env);
  if (!token || !ids.length) return;
  const itemsText = order.lines.map(l =>
    `• <b>${l.qty}x</b> [${escapeHtml(l.id)}] ${escapeHtml(l.name)}: <code>${fmtVND(l.lineTotal)}</code>\n`).join('');
  const c = order.customer;
  const fullAddr = `${c.address}${c.ward ? ', ' + c.ward : ''}${c.province ? ', ' + c.province : ''}`;
  const msg = `${headerText}\n━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Mã đơn:</b> <code>#${order.orderId}</code>\n` +
    `👤 <b>Khách hàng:</b> ${escapeHtml(c.name)}\n` +
    `📞 <b>Điện thoại:</b> <code>${escapeHtml(c.phone)}</code>\n` +
    `📍 <b>Địa chỉ:</b> ${escapeHtml(fullAddr)}\n` +
    `🚚 <b>Vận chuyển:</b> ${escapeHtml(order.shipName)} (${fmtVND(order.shipFee)})\n` +
    `${c.note ? `📝 <b>Ghi chú:</b> <i>${escapeHtml(c.note)}</i>\n` : ''}` +
    `━━━━━━━━━━━━━━━━━━\n🛍️ <b>CHI TIẾT MÓN:</b>\n${itemsText}` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>Tiền hàng:</b> ${fmtVND(order.subtotal)}\n` +
    `🚚 <b>Phí ship:</b> ${fmtVND(order.shipFee)}\n` +
    `💰 <b>TỔNG THANH TOÁN:</b> <b>${fmtVND(order.total)}</b>\n` +
    `⏰ <b>Thời gian:</b> ${order.timeStr}`;
  return broadcastTelegram(token, ids, msg);
}

async function sendTelegramPaidAlert(env, order, tx, headerText, note = '') {
  const token = env.TELEGRAM_BOT_TOKEN, ids = chatIds(env);
  if (!token || !ids.length) return;
  const amountIn = parseFloat(tx.transferAmount || tx.amount_in || tx.amount || 0);
  const msg = `${headerText}\n━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Mã đơn hàng:</b> <code>#${order.orderId}</code>\n` +
    `👤 <b>Khách hàng:</b> ${escapeHtml(order.customer.name)} (<code>${escapeHtml(order.customer.phone)}</code>)\n` +
    `🏦 <b>Ngân hàng:</b> ${escapeHtml(tx.bank_brand_name || tx.gateway || 'MBBank')}\n` +
    `💵 <b>Số tiền nhận:</b> <b>${fmtVND(amountIn)}</b> (Đã nhận tổng: ${fmtVND(order.paidAmount)} / Cần: ${fmtVND(order.total)})\n` +
    `📝 <b>Nội dung CK:</b> <i>${escapeHtml(tx.content || tx.transaction_content || tx.description || '')}</i>\n` +
    `⏰ <b>Thời gian:</b> ${escapeHtml(tx.transaction_date || vnTimeStr())}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    (note ? `ℹ️ <i>${escapeHtml(note)}</i>` : (order.status === 'PAID' ? '✅ <i>Hệ thống đã tự động duyệt đơn, sẵn sàng đóng gói giao hàng!</i>' : ''));
  return broadcastTelegram(token, ids, msg);
}
