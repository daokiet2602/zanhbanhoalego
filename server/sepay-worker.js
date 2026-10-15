/**
 * CLOUDFLARE WORKER / SEPAY & INVENTORY REALTIME SYNC PROXY
 * 1. Chuyển tiếp SePay API bypass CORS
 * 2. Lưu trữ và đồng bộ kho hàng/sản phẩm mới giữa Admin và Khách dùng chung trên mây (Global State)
 */

// Bộ nhớ đệm Cloudflare Edge lưu trữ tồn kho & sản phẩm mới
let CLOUD_INVENTORY_CACHE = null;

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

    // 1. ENDPOINT ĐỒNG BỘ KHO HÀNG & SẢN PHẨM MỚI (Admin <-> Khách)
    if (url.pathname.startsWith("/api/cloud-store")) {
      // ĐỌC DỮ LIỆU TỒN KHO & SẢN PHẨM MỚI
      if (request.method === "GET") {
        return new Response(JSON.stringify(CLOUD_INVENTORY_CACHE || { inventory: {}, newProducts: [] }), {
          status: 200,
          headers: corsHeaders
        });
      }

      // CẬP NHẬT KHO HÀNG / THÊM SẢN PHẨM MỚI TỪ ADMIN
      if (request.method === "POST") {
        try {
          const body = await request.json();
          CLOUD_INVENTORY_CACHE = {
            inventory: body.inventory || (CLOUD_INVENTORY_CACHE ? CLOUD_INVENTORY_CACHE.inventory : {}),
            newProducts: body.newProducts || (CLOUD_INVENTORY_CACHE ? CLOUD_INVENTORY_CACHE.newProducts : []),
            updatedAt: Date.now()
          };
          return new Response(JSON.stringify({ ok: true, data: CLOUD_INVENTORY_CACHE }), {
            status: 200,
            headers: corsHeaders
          });
        } catch(e) {
          return new Response(JSON.stringify({ ok: false, error: e.message }), { status: 400, headers: corsHeaders });
        }
      }
    }

    // 2. ENDPOINT CHUYỂN TIẾP SEPAY API (BYPASS CORS)
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
