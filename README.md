# Shop Dánh Bán Hoa — hướng dẫn triển khai (bản D1)

**Không ghi khóa bí mật vào file này hay bất kỳ file nào trong repo.** Khóa chỉ đặt bằng `wrangler secret put`.

## Kiến trúc
- **Trang web** (`index.html`, `admin.html`, `realtime_sync.js`): chỉ hiển thị, không giữ "kho riêng".
- **Worker** (`server/shop-worker.js`): API duy nhất. Dữ liệu nằm trong **Cloudflare D1**.
- Giá và tồn kho do **server** quyết định. Admin chỉ gửi thay đổi nhỏ (cộng/trừ n bộ, đổi giá), không bao giờ đẩy cả kho.
- `products_public.json` chỉ còn là danh mục dự phòng khi máy chủ chưa trả lời.

## Làm 1 lần (theo thứ tự)

### 0. Đổi khóa đã lộ (làm trước tiên)
Token Telegram bot (BotFather → `/revoke`), token API SePay, `SEPAY_WEBHOOK_KEY`, `ADMIN_KEY`. Khóa cũ nằm trong lịch sử git nên phải đổi thật, không chỉ xóa file.

### 1. Dọn repo
```
git rm --cached data.json sepay-worker.js shop-worker.js wrangler.toml server/order-proxy.js server/README.md
```
(chép file mới trong gói này đè lên, rồi commit). `data.json` chứa giá vốn nên không được để public.

### 2. Lấy dữ liệu đang chạy từ worker CŨ (trước khi deploy worker mới)
```
curl -H "X-Admin-Key: <KHÓA ADMIN CŨ>" https://sepay-checker.daokiet-work.workers.dev/admin/store  > kv_store.json
curl -H "X-Admin-Key: <KHÓA ADMIN CŨ>" https://sepay-checker.daokiet-work.workers.dev/admin/orders > orders.json
```

### 3. Tạo database
```
cd server
npx wrangler d1 create lego-store        # dán database_id vào wrangler.toml
# sửa ALLOWED_ORIGINS trong wrangler.toml cho đúng domain web thật
npx wrangler d1 execute lego-store --remote --file=schema.sql
node ../tools/build-seed.mjs ../data.json ../kv_store.json ../orders.json > seed.sql
npx wrangler d1 execute lego-store --remote --file=seed.sql
```
> `data.json` có 2 sản phẩm cùng mã `LG-62`. Script tự đổi sản phẩm thứ 2 thành `LG-62-B`.

### 4. Đặt khóa bí mật và deploy
```
npx wrangler secret put ADMIN_KEY            # chọn mã dài >= 12 ký tự
npx wrangler secret put SEPAY_WEBHOOK_KEY    # nhập cùng khóa này vào cấu hình webhook SePay
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_IDS    # nhiều chat cách nhau bằng dấu phẩy
npx wrangler deploy
```
Địa chỉ webhook SePay giữ nguyên: `https://<worker>/webhook/sepay`, kiểu xác thực **API Key**.

### 5. Đưa web lên
Chép `index.html`, `admin.html`, `realtime_sync.js`, `_headers`, `robots.txt` lên Pages/GitHub như cũ.

### 6. Kiểm kho 1 lần
Bản cũ có thể từng trừ kho 2 lần khi bán quầy. Vào `admin.html`, đối chiếu tồn kho thực tế và sửa số lệch (từ giờ sửa là chính xác tuyệt đối).

## Kiểm tra sau khi chạy
1. Mở web khách và `admin.html` trên 2 thiết bị. Admin đổi giá/kho thì khách thấy trong ≤10 giây (hoặc ngay khi chuyển lại tab).
2. Khách đặt 1 đơn COD: kho giảm, đơn xuất hiện ở admin, Telegram báo.
3. Chuyển khoản thử: đơn tự chuyển "Đã thanh toán".
4. `npx wrangler tail` để xem log lỗi thật của server.

## Bật thêm (tuỳ chọn)
- **Chống bot đặt đơn ảo:** tạo Turnstile, `wrangler secret put TURNSTILE_SECRET`, rồi thêm widget vào form (cần sitekey).
- **Khóa admin bằng Cloudflare Access:** bảo vệ `/admin.html` thêm 1 lớp.

## Chạy thử trên máy
Tạo `server/.dev.vars` (không commit) gồm `ADMIN_KEY=...`, `SEPAY_WEBHOOK_KEY=...`, rồi `npx wrangler d1 execute lego-store --local --file=schema.sql`, `... --file=seed.sql`, `npx wrangler dev`.
