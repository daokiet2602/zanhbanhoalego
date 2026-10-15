/**
 * CLOUDFLARE WORKER / SEPAY PROXY
 * Chuyển tiếp yêu cầu SePay từ trình duyệt và gắn Header CORS '*'
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

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
