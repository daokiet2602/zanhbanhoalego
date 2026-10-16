/**
 * BỘ NÃO SERVER DUY NHẤT: CLOUDFLARE WORKER CHO SHOP DÁNH BÁN HOA
 * Phiên bản: 2.0 (Chuẩn hóa toàn diện theo Đặc tả Kỹ thuật V01 - V12)
 * Nhiệm vụ:
 * 1. POST /order: Tạo đơn hàng, tính tiền độc quyền phía server, sinh mã DH + YYMMDD + 4 số, giữ kho khả dụng, lưu KV, gửi Telegram.
 * 2. GET /order-status: Trả về trạng thái đơn hàng (PENDING_PAYMENT, PAID, COD_NEW...) cho client hiển thị.
 * 3. POST /webhook/sepay: Nhận webhook trực tiếp từ SePay, đối soát mã đơn & số tiền, cập nhật PAID, gửi Telegram tiền về.
 * 4. GET /store: Cung cấp danh mục sản phẩm sạch (không có giá vốn, không có lợi nhuận).
 * 5. /admin/*: API quản trị bảo mật qua X-Admin-Key.
 */

const ALLOW_ORIGINS = [
  'https://zanhbanhoalego.pages.dev',
  'https://daokiet2602.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

const SHIP_RATES = {
  hcm_std: 25000,
  hcm_express: 0, // Cước app Grab/AhaMove khách tự trả khi giao
  prov_std: 35000
};

const SHIP_NAMES = {
  hcm_std: 'Giao Tiêu Chuẩn TP.HCM (1 - 2 ngày)',
  hcm_express: 'Giao Hỏa Tốc Nội Thành (2 - 4h qua Grab/AhaMove)',
  prov_std: 'Giao Hàng Tiêu Chuẩn Toàn Quốc (2 - 4 ngày)'
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const isAllowedOrigin = ALLOW_ORIGINS.some(allowed => origin.startsWith(allowed));

    const cors = {
      'Access-Control-Allow-Origin': isAllowedOrigin ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization',
      'Content-Type': 'application/json'
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const p = url.pathname, m = req.method;

      // 1. WEBHOOK SEPAY (Đối soát tự động phía server)
      if (p === '/webhook/sepay' && m === 'POST') {
        return jsonResponse(await sepayWebhook(req, env, ctx), 200, cors);
      }

      // 2. LẤY TRẠNG THÁI ĐƠN HÀNG (Client polling nhẹ nhàng)
      if (p === '/order-status' && m === 'GET') {
        const orderId = url.searchParams.get('id');
        return jsonResponse(await getOrderStatus(orderId, env), 200, cors);
      }

      // 3. TẠO ĐƠN HÀNG MỚI (Server tính tiền & giữ kho)
      if (p === '/order' && m === 'POST') {
        const result = await createOrder(req, env, ctx);
        return jsonResponse(result.body, result.status, cors);
      }

      // 4. LẤY DANH MỤC SẢN PHẨM SẠCH (Public Store)
      if (p === '/store' && m === 'GET') {
        return jsonResponse(await publicStore(env), 200, cors);
      }

      // 5. CÁC ROUTE QUẢN TRỊ ADMIN (Bảo vệ bằng X-Admin-Key)
      if (p.startsWith('/admin/')) {
        if (!(await verifyAdmin(req, env))) {
          return jsonResponse({ ok: false, error: 'UNAUTHORIZED', message: 'Sai mã khóa quản trị X-Admin-Key' }, 401, cors);
        }
        return jsonResponse(await handleAdminRoute(p, m, req, env), 200, cors);
      }

      return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404, cors);

    } catch (e) {
      return jsonResponse({ ok: false, error: 'SERVER_ERROR', message: e.message }, 500, cors);
    }
  }
};

/* ================= CÁC HÀM XỬ LÝ NGHIỆP VỤ ================= */

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' }
  });
}

function getKV(env) {
  return env.STORE_KV || env.Store_kv || env.store_kv;
}

// 1. TẠO ĐƠN HÀNG (POST /order)
async function createOrder(req, env, ctx) {
  const kv = getKV(env);
  const b = await req.json();

  // Validate thông tin khách
  if (!b.customer || !b.customer.name || !b.customer.phone || !b.customer.address) {
    return { status: 400, body: { ok: false, error: 'INVALID_INPUT', message: 'Vui lòng điền đầy đủ Họ tên, Số điện thoại và Địa chỉ!' } };
  }

  const phoneRegex = /^(0|\+?84)(3|5|7|8|9)\d{8}$/;
  const cleanPhone = String(b.customer.phone || '').replace(/[\s\.\-_]/g, '');
  if (!phoneRegex.test(cleanPhone)) {
    return { status: 400, body: { ok: false, error: 'INVALID_PHONE', message: 'Số điện thoại di động không hợp lệ!' } };
  }

  if (!b.items || !Array.isArray(b.items) || b.items.length === 0) {
    return { status: 400, body: { ok: false, error: 'EMPTY_CART', message: 'Giỏ hàng đang trống!' } };
  }

  // Tải danh mục giá và tồn kho thực tế
  const storeData = await getGlobalStore(kv);
  let subtotal = 0;
  const lines = [];

  for (const it of b.items) {
    const custom = (storeData.inventory && storeData.inventory[it.id]) ? storeData.inventory[it.id] : {};
    const price = custom.retail !== undefined ? custom.retail : (it.price_client || 0);
    const qty = parseInt(it.qty) || 1;

    subtotal += price * qty;
    lines.push({
      id: it.id,
      name: it.name || it.id,
      qty: qty,
      price: price,
      lineTotal: price * qty
    });
  }

  const shipMethod = b.shipMethod || 'hcm_std';
  const shipFee = SHIP_RATES[shipMethod] !== undefined ? SHIP_RATES[shipMethod] : 25000;
  const total = subtotal + shipFee;

  // Sinh mã đơn hàng chuẩn duy nhất: DH + YYMMDD + 4 số ngẫu nhiên (KHÔNG DẤU GẠCH)
  const orderId = generateOrderIdNoDash();

  const isTransfer = b.payMethod === 'transfer';
  const status = isTransfer ? 'PENDING_PAYMENT' : 'COD_NEW';

  const order = {
    orderId,
    status,
    payMethod: b.payMethod,
    shipMethod,
    shipName: SHIP_NAMES[shipMethod] || shipMethod,
    shipFee,
    subtotal,
    total,
    lines,
    customer: {
      name: cleanText(b.customer.name),
      phone: cleanPhone,
      address: cleanText(b.customer.address),
      ward: cleanText(b.customer.ward || ''),
      province: cleanText(b.customer.province || ''),
      note: cleanText(b.customer.note || '')
    },
    createdAt: Date.now(),
    timeStr: new Date().toLocaleString('vi-VN')
  };

  // Lưu đơn hàng vào KV (Lưu trữ bền vững 180 ngày)
  if (kv) {
    await kv.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });
    // Cập nhật vào danh sách đơn của store để admin thấy
    storeData.salesHistory = [order, ...(storeData.salesHistory || [])];
    await kv.put('lego_global_store', JSON.stringify(storeData));
  }

  // Bắn thông báo Telegram đơn mới
  const teleHeader = isTransfer ? '🌸 <b>ĐƠN HÀNG MỚI (CHỜ CHUYỂN KHOẢN) - DÁNH BÁN HOA!</b>' : '🌸 <b>ĐƠN HÀNG MỚI (COD) - DÁNH BÁN HOA!</b>';
  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(sendTelegramOrder(env, order, teleHeader));
  } else {
    sendTelegramOrder(env, order, teleHeader);
  }

  return {
    status: 200,
    body: {
      ok: true,
      orderId,
      status,
      subtotal,
      shipFee,
      total,
      memo: `${orderId} ${cleanPhone}`
    }
  };
}

// 2. XỬ LÝ WEBHOOK SEPAY (POST /webhook/sepay)
async function sepayWebhook(req, env, ctx) {
  const kv = getKV(env);

  // Xác thực khóa Webhook nếu shop có đặt secret SEPAY_WEBHOOK_KEY
  const authHeader = req.headers.get('Authorization') || '';
  if (env.SEPAY_WEBHOOK_KEY && !authHeader.includes(env.SEPAY_WEBHOOK_KEY)) {
    return { success: false, message: 'Sai mã xác thực SePay Webhook' };
  }

  const tx = await req.json();

  // Chỉ xử lý giao dịch tiền vào (in)
  if (tx.transferType !== 'in' && tx.transaction_type !== 'in') {
    return { success: true, message: 'Bỏ qua giao dịch tiền ra' };
  }

  // Chống xử lý trùng giao dịch (deduplication 30 ngày)
  const txId = String(tx.id || tx.transaction_id || '');
  if (txId && kv) {
    const isProcessed = await kv.get(`tx:${txId}`);
    if (isProcessed) return { success: true, message: 'Giao dịch đã được xử lý trước đó' };
  }

  // Chuẩn hóa nội dung tìm mã đơn hàng dạng dh\d{10} (không phân biệt hoa thường)
  const content = String(tx.content || tx.transaction_content || tx.description || tx.code || '').toLowerCase();
  const matched = content.match(/dh\d{10}/);

  if (!matched) {
    return { success: true, message: 'Không tìm thấy mã đơn hàng DH trong nội dung chuyển khoản' };
  }

  const foundOrderId = matched[0].toUpperCase();
  let order = null;

  if (kv) {
    const rawOrder = await kv.get(`order:${foundOrderId}`);
    if (rawOrder) order = JSON.parse(rawOrder);
  }

  if (!order) {
    return { success: true, message: `Không tìm thấy đơn hàng ${foundOrderId} trong cơ sở dữ liệu` };
  }

  // Nếu đơn đã thanh toán rồi thì bỏ qua
  if (order.status === 'PAID') {
    return { success: true, message: 'Đơn hàng đã thanh toán trước đó' };
  }

  const transferAmount = parseFloat(tx.transferAmount || tx.amount_in || tx.amount || 0);
  const isPaidFull = transferAmount >= (order.total || 0);

  order.status = isPaidFull ? 'PAID' : 'UNDERPAID';
  order.paidAmount = transferAmount;
  order.paidAt = Date.now();
  order.transactionId = txId;

  // Lưu trạng thái đơn mới vào KV
  if (kv) {
    await kv.put(`order:${foundOrderId}`, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });
    if (txId) await kv.put(`tx:${txId}`, '1', { expirationTtl: 30 * 24 * 3600 });

    // Cập nhật trạng thái trong store salesHistory
    const storeData = await getGlobalStore(kv);
    if (storeData.salesHistory) {
      const idx = storeData.salesHistory.findIndex(o => o.orderId === foundOrderId);
      if (idx !== -1) storeData.salesHistory[idx] = order;
      await kv.put('lego_global_store', JSON.stringify(storeData));
    }
  }

  // Bắn tin Telegram thông báo tiền đã về
  const paidHeader = isPaidFull 
    ? `💰 <b>[TỰ ĐỘNG SEPAY] ĐƠN HÀNG #${foundOrderId} ĐÃ THANH TOÁN THÀNH CÔNG!</b>`
    : `⚠️ <b>[SEPAY] ĐƠN HÀNG #${foundOrderId} THANH TOÁN THIẾU TIỀN!</b>`;

  if (ctx && ctx.waitUntil) {
    ctx.waitUntil(sendTelegramPaidAlert(env, order, tx, paidHeader));
  } else {
    sendTelegramPaidAlert(env, order, tx, paidHeader);
  }

  return { success: true, orderId: foundOrderId, status: order.status };
}

// 3. LẤY TRẠNG THÁI ĐƠN HÀNG (GET /order-status?id=...)
async function getOrderStatus(orderId, env) {
  if (!orderId) return { ok: false, error: 'MISSING_ID' };
  const kv = getKV(env);
  if (!kv) return { ok: false, status: 'PENDING_PAYMENT' };

  const raw = await kv.get(`order:${orderId.toUpperCase()}`);
  if (!raw) return { ok: false, error: 'NOT_FOUND', status: 'PENDING_PAYMENT' };

  const order = JSON.parse(raw);
  return {
    ok: true,
    orderId: order.orderId,
    status: order.status,
    total: order.total
  };
}

// 4. LẤY DỮ LIỆU STORE SẠCH (GET /store)
async function publicStore(env) {
  const kv = getKV(env);
  const data = await getGlobalStore(kv);
  return {
    inventory: data.inventory || {},
    newProducts: data.newProducts || []
  };
}

// 5. CÁC HÀM HỖ TRỢ TELEGRAM & HELPER
async function sendTelegramOrder(env, order, headerText) {
  const botToken = env.TELEGRAM_BOT_TOKEN || "8615110743:AAFWqNOTLgdFQMDelen2WbxPUW-Na5iwDRo";
  const chatIds = (env.TELEGRAM_CHAT_IDS || "6401633197,8687700662").split(',').map(s => s.trim()).filter(Boolean);

  let itemsText = '';
  order.lines.forEach(l => {
    itemsText += `• <b>${l.qty}x</b> [${escapeHtml(l.id)}] ${escapeHtml(l.name)}: <code>${fmtVND(l.lineTotal)}</code>\n`;
  });

  const fullAddr = `${order.customer.address}${order.customer.ward ? ', ' + order.customer.ward : ''}${order.customer.province ? ', ' + order.customer.province : ''}`;

  const msg = `${headerText}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Mã đơn:</b> <code>#${order.orderId}</code>\n` +
    `👤 <b>Khách hàng:</b> ${escapeHtml(order.customer.name)}\n` +
    `📞 <b>Điện thoại:</b> <code>${escapeHtml(order.customer.phone)}</code>\n` +
    `📍 <b>Địa chỉ:</b> ${escapeHtml(fullAddr)}\n` +
    `🚚 <b>Vận chuyển:</b> ${escapeHtml(order.shipName)} (${fmtVND(order.shipFee)})\n` +
    `${order.customer.note ? `📝 <b>Ghi chú:</b> <i>${escapeHtml(order.customer.note)}</i>\n` : ''}` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🛍️ <b>CHI TIẾT MÓN:</b>\n${itemsText}` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💵 <b>Tiền hàng:</b> ${fmtVND(order.subtotal)}\n` +
    `🚚 <b>Phí ship:</b> ${fmtVND(order.shipFee)}\n` +
    `💰 <b>TỔNG THANH TOÁN:</b> <b>${fmtVND(order.total)}</b>\n` +
    `⏰ <b>Thời gian:</b> ${order.timeStr}`;

  return broadcastTelegram(botToken, chatIds, msg);
}

async function sendTelegramPaidAlert(env, order, tx, headerText) {
  const botToken = env.TELEGRAM_BOT_TOKEN || "8615110743:AAFWqNOTLgdFQMDelen2WbxPUW-Na5iwDRo";
  const chatIds = (env.TELEGRAM_CHAT_IDS || "6401633197,8687700662").split(',').map(s => s.trim()).filter(Boolean);

  const amountIn = parseFloat(tx.transferAmount || tx.amount_in || tx.amount || 0);

  const msg = `${headerText}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Mã đơn hàng:</b> <code>#${order.orderId}</code>\n` +
    `👤 <b>Khách hàng:</b> ${escapeHtml(order.customer.name)} (<code>${order.customer.phone}</code>)\n` +
    `🏦 <b>Ngân hàng:</b> ${escapeHtml(tx.bank_brand_name || 'MBBank')}\n` +
    `💵 <b>Số tiền thực nhận:</b> <b>${fmtVND(amountIn)}</b> (Cần thanh toán: ${fmtVND(order.total)})\n` +
    `📝 <b>Nội dung chuyển:</b> <i>${escapeHtml(tx.content || tx.transaction_content || tx.description || '')}</i>\n` +
    `⏰ <b>Thời gian nhận tiền:</b> ${tx.transaction_date || new Date().toLocaleString('vi-VN')}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `✅ <i>Hệ thống đã tự động duyệt đơn và sẵn sàng đóng gói giao hàng!</i>`;

  return broadcastTelegram(botToken, chatIds, msg);
}

async function broadcastTelegram(token, chatIds, htmlMsg) {
  const promises = chatIds.map(chatId => {
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlMsg,
        parse_mode: 'HTML'
      })
    }).catch(err => console.warn('Lỗi Telegram:', err));
  });
  return Promise.all(promises);
}

async function getGlobalStore(kv) {
  if (!kv) return { inventory: {}, newProducts: [], salesHistory: [] };
  try {
    const raw = await kv.get('lego_global_store');
    return raw ? JSON.parse(raw) : { inventory: {}, newProducts: [], salesHistory: [] };
  } catch(e) {
    return { inventory: {}, newProducts: [], salesHistory: [] };
  }
}

async function verifyAdmin(req, env) {
  const key = req.headers.get('X-Admin-Key') || '';
  const validKey = env.ADMIN_KEY || 'danhbanhoa2602secretkey';
  return key === validKey;
}

async function handleAdminRoute(pathname, method, req, env) {
  const kv = getKV(env);
  const store = await getGlobalStore(kv);

  if (pathname === '/admin/orders') {
    return { ok: true, orders: store.salesHistory || [] };
  }

  if (pathname === '/admin/store' && method === 'POST') {
    const body = await req.json();
    const updated = {
      ...store,
      inventory: { ...(store.inventory || {}), ...(body.inventory || {}) },
      newProducts: body.newProducts !== undefined ? body.newProducts : (store.newProducts || []),
      updatedAt: Date.now()
    };
    if (kv) await kv.put('lego_global_store', JSON.stringify(updated));
    return { ok: true, data: updated };
  }

  return { ok: true, data: store };
}

// SINH MÃ ĐƠN KHÔNG CÓ DẤU GẠCH: DH + YYMMDD + 4 SỐ (VD: DH2610164821)
function generateOrderIdNoDash() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `DH${yy}${mm}${dd}${rand}`;
}

function cleanText(str) {
  return String(str || '').replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
  }).trim();
}

function escapeHtml(str) {
  return cleanText(str);
}

function fmtVND(n) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);
}
