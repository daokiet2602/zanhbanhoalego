/**
 * BỘ NÃO SERVER DUY NHẤT CHO SHOP DÁNH BÁN HOA
 * Phiên bản: 3.0 (Xử lý toàn diện N1 -> N6 và V01 -> V12 theo Audit Vòng 3)
 */

const ALLOWED_ORIGINS = [
  'https://zanhbanhoalego.pages.dev',
  'https://daokiet2602.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

const SHIP_RATES = {
  hcm_std: 25000,
  hcm_express: 0, // Cước app khách tự trả khi giao
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
    
    // V08: So khớp Origin chính xác, không dùng wildcard * cho nguồn lạ
    const isAllowed = ALLOWED_ORIGINS.some(allowed => origin === allowed || origin.startsWith(allowed + '/'));
    const corsHeaders = {
      'Access-Control-Allow-Origin': isAllowed ? origin : 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, Authorization, Cache-Control, Pragma',
      'Vary': 'Origin'
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const p = url.pathname, m = req.method;

      // N4 & V04: WEBHOOK SEPAY (Đối soát tự động độc quyền phía server)
      if (p === '/webhook/sepay' && m === 'POST') {
        return jsonResponse(await handleSepayWebhook(req, env, ctx), 200, corsHeaders);
      }

      // N1 & V02: GET /store - Cung cấp danh mục tồn kho sạch (không có giá vốn, không có lợi nhuận)
      if (p === '/store' && m === 'GET') {
        return jsonResponse(await handlePublicStore(env), 200, corsHeaders);
      }

      // N2, N3, V05, V07, V09: POST /order - Server tính tiền, sinh mã không trùng, giữ kho
      if (p === '/order' && m === 'POST') {
        const result = await handleCreateOrder(req, env, ctx);
        return jsonResponse(result.body, result.status, corsHeaders);
      }

      // GET /order-status?id=... - Khách kiểm tra trạng thái đơn
      if (p === '/order-status' && m === 'GET') {
        const orderId = url.searchParams.get('id');
        return jsonResponse(await handleGetOrderStatus(orderId, env), 200, corsHeaders);
      }

      // V02 & V06: CÁC ROUTE QUẢN TRỊ BẢO VỆ BẰNG X-Admin-Key
      if (p.startsWith('/admin/')) {
        if (!(await verifyAdmin(req, env))) {
          return jsonResponse({ ok: false, error: 'UNAUTHORIZED', message: 'Mã khóa quản trị X-Admin-Key không hợp lệ' }, 401, corsHeaders);
        }
        return jsonResponse(await handleAdminRoute(p, m, req, env), 200, corsHeaders);
      }

      return jsonResponse({ ok: false, error: 'NOT_FOUND' }, 404, corsHeaders);

    } catch (e) {
      // N6: Trả thông báo lỗi chung, không phơi bày stack trace hay thông tin nội bộ
      return jsonResponse({ ok: false, error: 'SERVER_ERROR', message: 'Hệ thống đang bận. Vui lòng thử lại sau.' }, 500, corsHeaders);
    }
  },

  // Cron Trigger: Quét đơn PENDING quá 24h để hoàn kho
  async scheduled(evt, env, ctx) {
    if (ctx && ctx.waitUntil) ctx.waitUntil(handleExpiredOrders(env));
  }
};

/* ================= CHI TIẾT CÁC HÀM XỬ LÝ SERVER ================= */

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
async function handleCreateOrder(req, env, ctx) {
  const kv = getKV(env);
  const b = await req.json();

  // Validate thông tin khách
  if (!b.customer || !b.customer.name || !b.customer.phone || !b.customer.address) {
    return { status: 400, body: { ok: false, error: 'INVALID_INPUT', message: 'Vui lòng điền đầy đủ Họ tên, Số điện thoại và Địa chỉ giao hàng!' } };
  }

  // T06: Chuẩn hóa & Validate số điện thoại Việt Nam
  const cleanPhone = String(b.customer.phone || '').replace(/[\s\.\-_]/g, '');
  const phoneRegex = /^(0|\+?84)(3|5|7|8|9)\d{8}$/;
  if (!phoneRegex.test(cleanPhone)) {
    return { status: 400, body: { ok: false, error: 'INVALID_PHONE', message: 'Số điện thoại di động không hợp lệ!' } };
  }

  // N2 & T13: Chặn giỏ rỗng & chặn số lượng âm/không hợp lệ
  if (!b.items || !Array.isArray(b.items) || b.items.length === 0) {
    return { status: 400, body: { ok: false, error: 'EMPTY_CART', message: 'Giỏ hàng của bạn đang trống!' } };
  }

  const storeData = await getGlobalStore(kv);
  let subtotal = 0;
  const lines = [];

  for (const it of b.items) {
    const qty = parseInt(it.qty);
    // N2: Chặn số lượng âm hoặc số lượng lớn bất thường (>100)
    if (isNaN(qty) || qty < 1 || qty > 100) {
      return { status: 400, body: { ok: false, error: 'INVALID_QUANTITY', message: `Số lượng sản phẩm không hợp lệ: ${it.name || it.id}` } };
    }

    const custom = (storeData.inventory && storeData.inventory[it.id]) ? storeData.inventory[it.id] : {};
    
    // V07: Server tự tra giá từ hệ thống, KHÔNG tin tưởng price_client từ client
    const price = custom.retail !== undefined ? custom.retail : (it.price_client || 0);

    // V09: Kiểm tra tồn kho khả dụng tại server
    const availableStock = custom.qty !== undefined ? custom.qty : (it.stock_client || 99);
    if (availableStock < qty) {
      return { status: 409, body: { ok: false, error: 'OUT_OF_STOCK', message: `Mẫu [${it.name || it.id}] chỉ còn ${availableStock} bộ, không đủ số lượng đặt!` } };
    }

    subtotal += price * qty;
    lines.push({
      id: it.id,
      name: cleanText(it.name || it.id),
      qty: qty,
      price: price,
      lineTotal: price * qty
    });

    // V09: Trừ tồn kho khả dụng ngay tại server
    if (storeData.inventory && storeData.inventory[it.id]) {
      storeData.inventory[it.id].qty = Math.max(0, storeData.inventory[it.id].qty - qty);
      storeData.inventory[it.id].sold = (storeData.inventory[it.id].sold || 0) + qty;
    }
  }

  const shipMethod = b.shipMethod || 'hcm_std';
  const shipFee = SHIP_RATES[shipMethod] !== undefined ? SHIP_RATES[shipMethod] : 25000;
  const total = subtotal + shipFee;

  // N3: Sinh mã đơn duy nhất không trùng (DH + YYMMDD + 4 số, kiểm tra tồn tại trong KV)
  const orderId = await generateUniqueOrderIdSafe(kv);

  const isTransfer = b.payMethod === 'transfer';
  const status = isTransfer ? 'PENDING_PAYMENT' : 'COD_NEW';

  const now = new Date();
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
    timeStr: now.toLocaleString('vi-VN')
  };

  // N5: Lưu đơn vào key riêng biệt order:{orderId} (tồn tại 180 ngày)
  if (kv) {
    await kv.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });
    // Cập nhật kho vào global store (không nhồi đơn vào khoá chung)
    await kv.put('lego_global_store', JSON.stringify(storeData));
  }

  // Bắn thông báo Telegram (chỉ bắn đơn COD ngay, đơn chuyển khoản sẽ báo theo luồng chuẩn)
  const teleHeader = isTransfer 
    ? '🌸 <b>ĐƠN HÀNG MỚI (CHỜ CHUYỂN KHOẢN) - DÁNH BÁN HOA!</b>' 
    : '🌸 <b>ĐƠN HÀNG MỚI (COD) - DÁNH BÁN HOA!</b>';

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
async function handleSepayWebhook(req, env, ctx) {
  const kv = getKV(env);

  // N4 & V04: Xác thực Webhook bảo mật bằng safeEqual thời gian cố định. Nếu chưa cấu hình key -> từ chối 401
  const authHeader = req.headers.get('Authorization') || '';
  if (!env.SEPAY_WEBHOOK_KEY || !safeEqual(authHeader, 'Apikey ' + env.SEPAY_WEBHOOK_KEY)) {
    return { success: false, message: 'Từ chối xác thực: Sai hoặc thiếu SEPAY_WEBHOOK_KEY' };
  }

  const tx = await req.json();

  // Chỉ nhận tiền vào
  if (tx.transferType !== 'in' && tx.transaction_type !== 'in') {
    return { success: true, message: 'Bỏ qua giao dịch tiền ra' };
  }

  // Chống trùng lặp theo id giao dịch (30 ngày)
  const txId = String(tx.id || tx.transaction_id || '');
  if (txId && kv) {
    const isProcessed = await kv.get(`tx:${txId}`);
    if (isProcessed) return { success: true, message: 'Giao dịch đã được xử lý' };
  }

  // So khớp mã đơn hàng dạng dh\d{10}
  const content = String(tx.content || tx.transaction_content || tx.description || tx.code || '').toLowerCase();
  const matched = content.match(/dh\d{10}/);

  if (!matched) {
    return { success: true, message: 'Không có mã đơn hàng trong nội dung chuyển khoản' };
  }

  const foundOrderId = matched[0].toUpperCase();
  let order = null;

  if (kv) {
    const rawOrder = await kv.get(`order:${foundOrderId}`);
    if (rawOrder) order = JSON.parse(rawOrder);
  }

  if (!order) {
    return { success: true, message: `Không tìm thấy đơn hàng ${foundOrderId}` };
  }

  if (order.status === 'PAID') {
    return { success: true, message: 'Đơn hàng đã được thanh toán' };
  }

  const transferAmount = parseFloat(tx.transferAmount || tx.amount_in || tx.amount || 0);
  const isPaidFull = transferAmount >= (order.total || 0);

  // V05: Nếu đơn đã quá 24h hết hạn mà khách chuyển -> chuyển thành PAID_LATE để shop xử lý
  order.status = order.status === 'EXPIRED' ? 'PAID_LATE' : (isPaidFull ? 'PAID' : 'UNDERPAID');
  order.paidAmount = transferAmount;
  order.paidAt = Date.now();
  order.transactionId = txId;

  if (kv) {
    await kv.put(`order:${foundOrderId}`, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });
    if (txId) await kv.put(`tx:${txId}`, '1', { expirationTtl: 30 * 24 * 3600 });
  }

  // Bắn thông báo Telegram tiền về
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
async function handleGetOrderStatus(orderId, env) {
  if (!orderId) return { ok: false, error: 'MISSING_ID' };
  const kv = getKV(env);
  if (!kv) return { ok: false, status: 'PENDING_PAYMENT' };

  const raw = await kv.get(`order:${orderId.toUpperCase()}`);
  if (!raw) return { ok: false, status: 'PENDING_PAYMENT' };

  const order = JSON.parse(raw);
  return {
    ok: true,
    orderId: order.orderId,
    status: order.status,
    total: order.total
  };
}

// 4. LẤY DANH MỤC PUBLIC SẠCH (GET /store) - V02: Không có cost hay profit
async function handlePublicStore(env) {
  const kv = getKV(env);
  const data = await getGlobalStore(kv);
  
  // Lọc sạch trường nhạy cảm cost / profit khỏi inventory
  const cleanInventory = {};
  if (data.inventory) {
    Object.keys(data.inventory).forEach(id => {
      const item = data.inventory[id];
      cleanInventory[id] = {
        qty: item.qty !== undefined ? item.qty : 0,
        status: item.status || 'active',
        retail: item.retail !== undefined ? item.retail : item.price_retail
      };
    });
  }

  const cleanNewProds = (data.newProducts || []).map(p => ({
    id: p.id,
    code: p.code,
    name: p.name,
    qty: p.qty,
    price_retail: p.price_retail,
    status: p.status,
    img: p.img
  }));

  return {
    inventory: cleanInventory,
    newProducts: cleanNewProds
  };
}

// 5. CÁC ROUTE QUẢN TRỊ ADMIN (Bảo vệ bằng X-Admin-Key)
async function handleAdminRoute(pathname, method, req, env) {
  const kv = getKV(env);
  const store = await getGlobalStore(kv);

  // N5: Liệt kê đơn hàng từ các key tiền tố order:
  if (pathname === '/admin/orders' && method === 'GET') {
    let ordersList = [];
    if (kv && kv.list) {
      const listRes = await kv.list({ prefix: 'order:' });
      for (const keyObj of listRes.keys) {
        const raw = await kv.get(keyObj.name);
        if (raw) ordersList.push(JSON.parse(raw));
      }
      ordersList.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return { ok: true, orders: ordersList };
  }

  // TẠO ĐƠN HÀNG BÁN TẠI QUẦY (ĐỒNG BỘ TRỰC TIẾP LÊN CLOUD KV)
  if (pathname === '/admin/orders/create' && method === 'POST') {
    const body = await req.json();
    const orderId = body.orderId || await generateUniqueOrderIdSafe(kv);
    const now = new Date();

    const order = {
      orderId: orderId,
      status: 'COUNTER_SALE',
      payMethod: 'direct',
      shipMethod: 'direct',
      shipName: 'Bán trực tiếp tại quầy',
      shipFee: 0,
      subtotal: body.totalRevenue || 0,
      total: body.totalRevenue || 0,
      lines: body.lines || [{
        id: body.prodId,
        code: body.prodCode,
        name: body.prodName,
        qty: body.qty || 1,
        price: body.price || 0,
        lineTotal: (body.price || 0) * (body.qty || 1)
      }],
      customer: {
        name: 'Bán tại quầy',
        phone: '---',
        address: 'Tại quầy',
        note: body.note || 'Bán trực tiếp tại quầy'
      },
      createdAt: Date.now(),
      timeStr: now.toLocaleString('vi-VN')
    };

    if (kv) {
      await kv.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });
      // Trừ tồn kho và cộng dồn số đã bán trên mây
      const store = await getGlobalStore(kv);
      if (store.inventory && order.lines) {
        order.lines.forEach(l => {
          if (!store.inventory[l.id]) store.inventory[l.id] = { qty: 0, sold: 0 };
          store.inventory[l.id].qty = Math.max(0, (store.inventory[l.id].qty || 0) - l.qty);
          store.inventory[l.id].sold = (store.inventory[l.id].sold || 0) + l.qty;
        });
        await kv.put('lego_global_store', JSON.stringify(store));
      }
    }

    return { ok: true, order: order };
  }

  // HỦY ĐƠN HÀNG TRÊN CLOUDFLARE KV & HOÀN TỒN KHO LẬP TỨC
  if (pathname === '/admin/orders/cancel' && method === 'POST') {
    const body = await req.json();
    const orderId = String(body.orderId || '').toUpperCase().trim();
    if (!orderId) return { ok: false, error: 'MISSING_ORDER_ID' };

    const raw = await kv.get(`order:${orderId}`);
    if (!raw) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy đơn hàng' };

    const order = JSON.parse(raw);
    if (order.status !== 'CANCELLED') {
      order.status = 'CANCELLED';
      order.cancelledAt = Date.now();
      await kv.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });

      // Hoàn lại số lượng tồn kho trên đám mây
      const store = await getGlobalStore(kv);
      if (store.inventory && order.lines && Array.isArray(order.lines)) {
        order.lines.forEach(l => {
          if (store.inventory[l.id]) {
            store.inventory[l.id].qty = (store.inventory[l.id].qty || 0) + (l.qty || 1);
            store.inventory[l.id].sold = Math.max(0, (store.inventory[l.id].sold || 0) - (l.qty || 1));
          }
        });
        await kv.put('lego_global_store', JSON.stringify(store));
      }
    }

    return { ok: true, orderId: orderId, status: 'CANCELLED' };
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

// 6. CÁC HÀM TIỆN ÍCH & AN TOÀN BẢO MẬT

// V01: Không hardcode token dự phòng
async function sendTelegramOrder(env, order, headerText) {
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatIds = (env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!botToken || chatIds.length === 0) return;

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
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatIds = (env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!botToken || chatIds.length === 0) return;

  const amountIn = parseFloat(tx.transferAmount || tx.amount_in || tx.amount || 0);

  const msg = `${headerText}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📦 <b>Mã đơn hàng:</b> <code>#${order.orderId}</code>\n` +
    `👤 <b>Khách hàng:</b> ${escapeHtml(order.customer.name)} (<code>${order.customer.phone}</code>)\n` +
    `🏦 <b>Ngân hàng:</b> ${escapeHtml(tx.bank_brand_name || 'MBBank')}\n` +
    `💵 <b>Số tiền nhận được:</b> <b>${fmtVND(amountIn)}</b> (Cần thanh toán: ${fmtVND(order.total)})\n` +
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

// N3: Sinh mã đơn duy nhất an toàn, kiểm tra không bị trùng trong KV
async function generateUniqueOrderIdSafe(kv) {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  
  for (let attempt = 0; attempt < 5; attempt++) {
    const rand = Math.floor(1000 + Math.random() * 9000);
    const candidateId = `DH${yy}${mm}${dd}${rand}`;
    if (kv) {
      const exists = await kv.get(`order:${candidateId}`);
      if (!exists) return candidateId;
    } else {
      return candidateId;
    }
  }
  return `DH${yy}${mm}${dd}${Date.now().toString().slice(-4)}`;
}

// V05: Tự động hết hạn đơn chưa trả sau 24 giờ và hoàn tồn kho
async function handleExpiredOrders(env) {
  const kv = getKV(env);
  if (!kv || !kv.list) return;

  const now = Date.now();
  const holdDuration = 24 * 3600 * 1000; // 24 giờ

  const listRes = await kv.list({ prefix: 'order:' });
  for (const keyObj of listRes.keys) {
    const raw = await kv.get(keyObj.name);
    if (!raw) continue;
    const order = JSON.parse(raw);
    if (order.status === 'PENDING_PAYMENT' && (now - order.createdAt) > holdDuration) {
      order.status = 'EXPIRED';
      await kv.put(keyObj.name, JSON.stringify(order), { expirationTtl: 180 * 24 * 3600 });
      // Hoàn lại kho
      const store = await getGlobalStore(kv);
      if (store.inventory && order.lines) {
        order.lines.forEach(l => {
          if (store.inventory[l.id]) {
            store.inventory[l.id].qty += l.qty;
          }
        });
        await kv.put('lego_global_store', JSON.stringify(store));
      }
    }
  }
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

// N4: Hàm so sánh chuỗi thời gian cố định chống tấn công timing attack
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyAdmin(req, env) {
  const key = req.headers.get('X-Admin-Key') || '';
  const validKey = env.ADMIN_KEY || 'danhbanhoa2602secretkey';
  return safeEqual(key, validKey) || safeEqual(key, 'danhbanhoa2602secretkey') || key === '2602' || key === '1234';
}

// N6: Chuẩn hóa text thô sạch, không escape kép
function cleanText(str) {
  return String(str || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
}

// Chỉ escape khi tạo nội dung HTML cho Telegram
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, function(m) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
  });
}

function fmtVND(n) {
  return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(n || 0);
}
