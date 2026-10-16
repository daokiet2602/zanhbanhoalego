/**
 * CLOUDFLARE WORKER / SERVERLESS PROXY FOR TELEGRAM ORDER NOTIFICATION
 * Bảo vệ Token Telegram và Chat ID trong Secret Environment Variables (không lộ ra ngoài code client)
 */

export default {
  async fetch(request, env) {
    // 1. Chỉ nhận phương thức POST
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "METHOD_NOT_ALLOWED", message: "Chỉ chấp nhận yêu cầu POST" }), {
        status: 405,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. Kiểm tra Header Origin bảo vệ CORS (Chỉ cho phép từ domain GitHub Pages của shop)
    const origin = request.headers.get("Origin") || "";
    const allowedDomains = ["https://daokiet2602.github.io", "http://localhost", "http://127.0.0.1"];
    const isAllowed = allowedDomains.some(d => origin.startsWith(d));

    const corsHeaders = {
      "Access-Control-Allow-Origin": isAllowed ? origin : "https://daokiet2602.github.io",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const data = await request.json();
      const { orderId, name, phone, address, note, subtotal, shipName, shipFeeDisplay, totalAmount, itemsSummaryHtml, payMethodText, timeStr } = data;

      if (!orderId || !phone || !name) {
        return new Response(JSON.stringify({ ok: false, error: "INVALID_INPUT", message: "Thiếu thông tin đơn hàng bắt buộc" }), {
          status: 400,
          headers: corsHeaders
        });
      }

      // Đọc secret từ Cloudflare Worker Environment Variables
      const botToken = env.TELEGRAM_BOT_TOKEN;
      const chatIds = (env.TELEGRAM_CHAT_IDS || "").split(",").map(id => id.trim()).filter(Boolean);

      if (!botToken || chatIds.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: "SERVER_CONFIG_ERROR", message: "Server chưa cấu hình Telegram Bot Token hoặc Chat ID" }), {
          status: 500,
          headers: corsHeaders
        });
      }

      // Xây dựng tin nhắn Telegram chuẩn chỉ tại Server
      const teleMsg = `🌸 <b>ĐƠN HÀNG MỚI - DÁNH BÁN HOA!</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>Mã đơn:</b> <code>#${escapeHtml(orderId)}</code>\n` +
        `👤 <b>Khách hàng:</b> ${escapeHtml(name)}\n` +
        `📞 <b>Điện thoại:</b> <code>${escapeHtml(phone)}</code>\n` +
        `📍 <b>Địa chỉ:</b> ${escapeHtml(address)}\n` +
        `🚚 <b>Vận chuyển:</b> ${escapeHtml(shipName)} (${escapeHtml(shipFeeDisplay)})\n` +
        `${note ? `📝 <b>Ghi chú:</b> <i>${escapeHtml(note)}</i>\n` : ''}` +
        `💵 <b>Hình thức:</b> <b>${escapeHtml(payMethodText)}</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🛍️ <b>CHI TIẾT SẢN PHẨM:</b>\n${itemsSummaryHtml}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `💵 <b>Tiền hàng:</b> ${fmtVND(subtotal)}\n` +
        `🚚 <b>Phí ship:</b> ${escapeHtml(shipFeeDisplay)}\n` +
        `💰 <b>TỔNG THANH TOÁN:</b> <b>${fmtVND(totalAmount)}</b>\n` +
        `⏰ <b>Thời gian:</b> ${escapeHtml(timeStr)}`;

      // Bắn tin nhắn đồng thời tới tất cả người nhận
      const sendPromises = chatIds.map(chatId => {
        return fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: teleMsg,
            parse_mode: "HTML"
          })
        });
      });

      await Promise.all(sendPromises);

      return new Response(JSON.stringify({ ok: true, orderId: orderId }), {
        status: 200,
        headers: corsHeaders
      });

    } catch (err) {
      return new Response(JSON.stringify({ ok: false, error: "SERVER_ERROR", message: err.message }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, function(m) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
  });
}

function fmtVND(n) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n || 0);
}
