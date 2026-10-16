/**
 * CLOUDFLARE WORKER: SEPAY AUTO BANKING + GLOBAL CLOUDFLARE KV DATABASE
 * Lưu trữ vĩnh viễn tồn kho, sản phẩm mới và lịch sử đơn hàng trên mạng lưới toàn cầu Cloudflare
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 1. ENDPOINT CLOUD DATABASE (TỒN KHO, SẢN PHẨM MỚI, LỊCH SỬ ĐƠN HÀNG)
    if (url.pathname.includes("/api/cloud-store")) {
      // ĐỌC DỮ LIỆU TỪ KV DATABASE
      if (request.method === "GET") {
        try {
          let storeData = null;
          if (env.STORE_KV) {
            const raw = await env.STORE_KV.get("lego_global_store");
            if (raw) storeData = JSON.parse(raw);
          }
          if (!storeData) {
            storeData = { inventory: {}, newProducts: [], salesHistory: [] };
          }
          return new Response(JSON.stringify(storeData), { status: 200, headers: corsHeaders });
        } catch(e) {
          return new Response(JSON.stringify({ inventory: {}, newProducts: [], salesHistory: [] }), { status: 200, headers: corsHeaders });
        }
      }

      // LƯU DỮ LIỆU VÀO KV DATABASE (VĨNH VIỄN)
      if (request.method === "POST") {
        try {
          const body = await request.json();
          let currentStore = { inventory: {}, newProducts: [], salesHistory: [] };
          
          if (env.STORE_KV) {
            const raw = await env.STORE_KV.get("lego_global_store");
            if (raw) currentStore = JSON.parse(raw);
          }

          // Cập nhật và gộp dữ liệu
          const updatedStore = {
            inventory: { ...(currentStore.inventory || {}), ...(body.inventory || {}) },
            newProducts: body.newProducts !== undefined ? body.newProducts : (currentStore.newProducts || []),
            salesHistory: body.newOrder ? [body.newOrder, ...(currentStore.salesHistory || [])] : (body.salesHistory || currentStore.salesHistory || []),
            updatedAt: Date.now()
          };

          if (env.STORE_KV) {
            await env.STORE_KV.put("lego_global_store", JSON.stringify(updatedStore));
          }

          return new Response(JSON.stringify({ ok: true, data: updatedStore }), { status: 200, headers: corsHeaders });
        } catch(e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: corsHeaders });
        }
      }
    }

    // 2. ENDPOINT CHUYỂN TIẾP SEPAY API
    const token = "2WBXRD7DRRJUJN2PH1OIMKA5JTVO3AEEYJDMLPCGHGOVF676PMS9L8KANFGUQQR1";
    try {
      const response = await fetch("https://my.sepay.vn/userapi/transactions/list", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });
      const data = await response.text();
      return new Response(data, {
        status: response.status,
        headers: corsHeaders
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: corsHeaders
      });
    }
  }
};
