# HƯỚNG DẪN DEPLOY TELEGRAM ORDER PROXY (CLOUDFLARE WORKER)
Bảo mật tuyệt đối Token Bot Telegram và danh sách Chat ID khỏi code client public.

## 1. Yêu cầu chuẩn bị
- 1 Tài khoản Cloudflare miễn phí (https://dash.cloudflare.com)

## 2. Các bước triển khai (2 phút)
1. Đăng nhập vào Cloudflare Dashboard -> Vào mục **Workers & Pages** -> Bấm **Create Worker**.
2. Đặt tên Worker: `danhbanhoa-order-proxy` -> Bấm **Deploy**.
3. Bấm **Edit Code**, dán toàn bộ nội dung file `order-proxy.js` vào file `worker.js` trên Cloudflare -> Bấm **Save and deploy**.
4. Vào tab **Settings** của Worker -> Chọn mục **Variables and Secrets**:
   - Thêm Secret: `TELEGRAM_BOT_TOKEN` = `<Token Bot Telegram mới sau khi /revoke>`
   - Thêm Secret: `TELEGRAM_CHAT_IDS` = `6401633197,8687700662` (cách nhau bằng dấu phẩy)
5. Lấy đường dẫn Worker URL (VD: `https://danhbanhoa-order-proxy.tenban.workers.dev`) gán vào biến `ORDER_API_URL` trong file `index.html`.
