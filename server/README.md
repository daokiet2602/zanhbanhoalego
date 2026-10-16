# HƯỚNG DẪN CẤU HÌNH SERVERLESS WORKER DUY NHẤT (SHOP-WORKER)
Phiên bản: 2.0 (Toàn bộ logic nghiệp vụ, đối soát SePay và bảo mật nằm tại đây)

## 1. Triển khai Worker lên Cloudflare
1. Đăng nhập vào [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Vào Worker `sepay-checker` của bạn -> Bấm **Edit code**.
3. Copy toàn bộ mã trong file `server/shop-worker.js` dán đè vào `worker.js` trên Cloudflare -> Bấm **Save and deploy**.

## 2. Cấu hình biến môi trường và Secret
Vào Worker `sepay-checker` -> Tab **Settings**:
1. Mục **Bindings**:
   - Gắn biến `STORE_KV` (hoặc `Store_kv`) trỏ vào KV Namespace `STORE_KV` của bạn.
2. Mục **Variables and Secrets**:
   - Thêm Secret: `TELEGRAM_BOT_TOKEN` = `8615110743:AAFWqNOTLgdFQMDelen2WbxPUW-Na5iwDRo`
   - Thêm Secret: `TELEGRAM_CHAT_IDS` = `6401633197,8687700662`
   - Thêm Secret: `SEPAY_WEBHOOK_KEY` = `danhbanhoa_sepay_secret_key_2026`
   - Thêm Secret: `ADMIN_KEY` = `danhbanhoa2602secretkey`

## 3. Cấu hình Webhook trên SePay
1. Đăng nhập vào [SePay Dashboard](https://my.sepay.vn).
2. Vào mục **Tích hợp WebHooks** -> Bấm **Tạo Webhook mới**:
   - **URL Webhook:** `https://sepay-checker.daokiet-work.workers.dev/webhook/sepay`
   - **Kiểu xác thực (Authentication):** API Key
   - **API Key:** `danhbanhoa_sepay_secret_key_2026` (Khớp đúng với biến SEPAY_WEBHOOK_KEY)
3. Bấm **Lưu Webhook**.

Xong! Giờ đây khi có tiền chuyển vào MBBank, SePay sẽ tự động gọi webhook về Worker để duyệt đơn và nổ thông báo về Telegram!
