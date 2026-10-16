/**
 * CLOUDFLARE WORKER: SEPAY + CLOUD KV DATABASE
 * Tự động hỗ trợ mọi kiểu đặt tên biến: Store_kv, store_kv, STORE_KV
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

    // Nhận diện linh hoạt: Store_kv, store_kv, STORE_KV
    const kv = env.Store_kv || env.store_kv || env.STORE_KV;

    const url = new URL(request.url);

    // 1. ENDPOINT CLOUD DATABASE (TỒN KHO, SẢN PHẨM MỚI, LỊCH SỬ ĐƠN HÀNG)
    if (url.pathname.includes("/api/cloud-store")) {
      if (request.method === "GET") {
        try {
          let storeData = null;
          if (kv) {
            const raw = await kv.get("lego_global_store");
            if (raw) storeData = JSON.parse(raw);
          }
          return new Response(JSON.stringify(storeData || { inventory: {}, newProducts: [], salesHistory: [] }), { status: 200, headers: corsHeaders });
        } catch(e) {
          return new Response(JSON.stringify({ inventory: {}, newProducts: [], salesHistory: [] }), { status: 200, headers: corsHeaders });
        }
      }

      if (request.method === "POST") {
        try {
          const body = await request.json();
          let currentStore = { inventory: {}, newProducts: [], salesHistory: [] };
          if (kv) {
            const raw = await kv.get("lego_global_store");
            if (raw) currentStore = JSON.parse(raw);
          }
          const updatedStore = {
            inventory: { ...(currentStore.inventory || {}), ...(body.inventory || {}) },
            newProducts: body.newProducts !== undefined ? body.newProducts : (currentStore.newProducts || []),
            salesHistory: body.newOrder ? [body.newOrder, ...(currentStore.salesHistory || [])] : (body.salesHistory || currentStore.salesHistory || []),
            updatedAt: Date.now()
          };
          if (kv) {
            await kv.put("lego_global_store", JSON.stringify(updatedStore));
          }
          return new Response(JSON.stringify({ ok: true, data: updatedStore }), { status: 200, headers: corsHeaders });
        } catch(e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: corsHeaders });
        }
      }
    }

    // 2. SEPAY AUTO CHECK
    const token = "2WBXRD7DRRJUJN2PH1OIMKA5JTVO3AEEYJDMLPCGHGOVF676PMS9L8KANFGUQQR1";
    try {
      const response = await fetch("https://my.sepay.vn/userapi/transactions/list", {
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
      });
      const data = await response.text();
      return new Response(data, { status: response.status, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  }
};
