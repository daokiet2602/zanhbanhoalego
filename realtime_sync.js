/**
 * REALTIME STORE  —  v4.0 (khớp với shop-worker.js dùng D1)
 *
 * Quy tắc để KHÔNG BAO GIỜ lệch dữ liệu:
 *  - Server (D1) là nguồn sự thật. Trình duyệt chỉ HIỂN THỊ, không giữ "kho riêng" trong localStorage.
 *  - Admin KHÔNG đẩy cả kho lên. Mỗi thao tác = 1 yêu cầu nhỏ ("cộng 5 bộ", "đổi giá"...).
 *  - Poll chỉ hỏi "version" (1 dòng dữ liệu). Version đổi mới tải lại danh sách.
 *  - Mất mạng thì báo rõ trên màn hình, không im lặng.
 */
const API_BASE = (window.LEGO_API_BASE || 'https://sepay-checker.daokiet-work.workers.dev').replace(/\/$/, '');
const ADMIN_KEY_STORAGE = 'lego_admin_key';

class RealtimeStore {
    constructor() {
        this.products = [];          // danh sách sản phẩm từ server (admin: có giá vốn; khách: bản "sạch")
        this.byId = new Map();
        this.loaded = false;         // đã nhận dữ liệu từ server ít nhất 1 lần
        this.salesHistory = [];      // đơn hàng (chỉ admin)
        this.version = 0;            // version sản phẩm đã tải
        this.ordersVersion = 0;      // version đơn hàng đã tải
        this.listeners = [];
        this.adminMode = !!window.LEGO_ADMIN_PAGE;   // admin.html đặt cờ này trước khi nạp file
        this._queues = {};           // hàng đợi tuần tự theo từng sản phẩm
        this._pending = 0;           // số thao tác admin đang chờ server
        this._fails = 0;
        this._syncing = null;
        this._ordersSyncing = null;
        this._bc = null;

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.refreshAll();
        });
        window.addEventListener('online', () => this.refreshAll());
        try {
            if (window.BroadcastChannel) {
                this._bc = new BroadcastChannel('lego_sync_v4');
                this._bc.onmessage = (ev) => { if (ev.data === 'changed') this.refreshAll(); };
            }
        } catch (e) {}

        this.syncWithCloudWorker(true);
    }

    /* ---------------------------------- HẠ TẦNG ---------------------------------- */

    get adminKey() {
        try { return sessionStorage.getItem(ADMIN_KEY_STORAGE) || ''; } catch (e) { return ''; }
    }

    async _api(path, { method = 'GET', body, admin = false } = {}) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
            const headers = {};
            if (body !== undefined) headers['Content-Type'] = 'application/json';
            if (admin) headers['X-Admin-Key'] = this.adminKey;
            const res = await fetch(API_BASE + path, {
                method, headers, cache: 'no-store', signal: ctrl.signal,
                body: body !== undefined ? JSON.stringify(body) : undefined
            });
            let data = null;
            try { data = await res.json(); } catch (e) {}
            data = data || {};
            if (admin && res.status === 401) {
                try { sessionStorage.removeItem(ADMIN_KEY_STORAGE); } catch (e) {}
                window.dispatchEvent(new Event('lego-admin-unauthorized'));
            }
            this._netOk(res.status < 500);
            return { status: res.status, ok: res.ok && data.ok !== false, data };
        } catch (e) {
            this._netOk(false);
            return { status: 0, ok: false, data: { message: 'Không kết nối được máy chủ.' } };
        } finally {
            clearTimeout(timer);
        }
    }

    _netOk(good) {
        if (good) { this._fails = 0; this._banner(false); return; }
        this._fails++;
        if (this._fails >= 3) this._banner(true);
    }

    _banner(show) {
        let el = document.getElementById('lego-sync-banner');
        if (!show) { if (el) el.style.display = 'none'; return; }
        if (!el) {
            el = document.createElement('div');
            el.id = 'lego-sync-banner';
            el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#B91C1C;color:#fff;padding:10px 16px;border-radius:999px;font:600 13px system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:92vw;text-align:center';
            el.textContent = '⚠️ Mất kết nối máy chủ — đang hiển thị dữ liệu lần cuối. Đang tự thử lại...';
            document.body.appendChild(el);
        }
        el.style.display = 'block';
    }

    _toast(msg) {
        if (typeof window.showToast === 'function') window.showToast(msg);
        else console.warn(msg);
    }

    subscribe(callback) {
        this.listeners.push(callback);
        return () => { this.listeners = this.listeners.filter(cb => cb !== callback); };
    }

    notify() {
        const snap = { products: this.products, sales: this.salesHistory };
        this.listeners.forEach(cb => { try { cb(snap); } catch (e) { console.error(e); } });
    }

    _tellOtherTabs() {
        try { if (this._bc) this._bc.postMessage('changed'); } catch (e) {}
    }

    refreshAll() {
        this.syncWithCloudWorker();
        if (this.adminMode && this.adminKey) this.fetchAdminOrders();
    }

    _setProducts(list) {
        this.products = list;
        this.byId = new Map(list.map(p => [p.id, p]));
        this.loaded = true;
    }

    _applyProduct(p) {
        if (!p || !p.id) return;
        const idx = this.products.findIndex(x => x.id === p.id);
        if (idx >= 0) this.products[idx] = p; else this.products.unshift(p);
        this.byId.set(p.id, p);
    }

    /* ---------------------------------- ĐỒNG BỘ ---------------------------------- */

    // Khách: GET /store   |   Admin: GET /admin/products   (kèm ?v=version => server trả "unchanged" nếu chưa đổi)
    syncWithCloudWorker(force = false) {
        // Nếu đang có 1 lượt đồng bộ chạy dở mà mình cần bản MỚI NHẤT (force) thì chờ xong rồi chạy lại
        if (this._syncing) return force ? this._syncing.then(() => this.syncWithCloudWorker(true)) : this._syncing;
        this._syncing = this._doSync(force).finally(() => { this._syncing = null; });
        return this._syncing;
    }

    async _doSync(force) {
        if (this.adminMode && !this.adminKey) return false;
        if (this._pending > 0) return false;   // đang có thao tác admin chưa xong: để xong rồi tự đồng bộ lại
        const base = this.adminMode ? '/admin/products' : '/store';
        const q = (!force && this.loaded && this.version) ? `?v=${this.version}` : '';
        const r = await this._api(base + q, { admin: this.adminMode });
        if (!r.ok) return false;
        const d = r.data;
        if (d.unchanged) return false;
        if (!Array.isArray(d.products)) return false;
        if (this._pending > 0) return false;   // có thao tác mới phát sinh trong lúc chờ: bỏ bản cũ này
        this.version = d.version || 0;
        this._setProducts(d.products);
        this.notify();
        return true;
    }

    // Admin: tải danh sách đơn (chỉ tải lại khi version đổi)
    fetchAdminOrders(force = false) {
        if (this._ordersSyncing) return force ? this._ordersSyncing.then(() => this.fetchAdminOrders(true)) : this._ordersSyncing;
        this._ordersSyncing = this._doFetchOrders(force).finally(() => { this._ordersSyncing = null; });
        return this._ordersSyncing;
    }

    async _doFetchOrders(force) {
        if (!this.adminKey) return this.salesHistory;
        const q = (!force && this.ordersVersion) ? `&v=${this.ordersVersion}` : '';
        const r = await this._api(`/admin/orders?limit=500${q}`, { admin: true });
        if (r.ok && Array.isArray(r.data.orders)) {
            this.ordersVersion = r.data.version || 0;
            this.salesHistory = r.data.orders;
            this.notify();
        }
        return this.salesHistory;
    }

    // Tương thích code cũ: nút "Đồng bộ" giờ chỉ là "tải lại từ server" (không còn đẩy dữ liệu cũ lên nữa)
    async pushToCloudWorker() {
        await this.syncWithCloudWorker(true);
        if (this.adminMode) await this.fetchAdminOrders(true);
        return this.loaded;
    }

    /* ---------------------------------- ĐỌC DỮ LIỆU ---------------------------------- */

    // Chưa tải xong từ server thì dùng danh mục dự phòng (products_public.json) để trang không trống
    getAllMergedProducts(baseProducts = []) {
        return this.loaded ? this.products : (baseProducts || []);
    }

    getProductData(p) {
        const s = (p && this.byId.get(p.id)) || p || {};
        const qty = Math.max(0, parseInt(s.qty) || 0);
        const retail = Number(s.price_retail) || 0;
        const cost = Number(s.price_cost) || 0;
        const profitUnit = retail - cost;
        return {
            ...s,
            qty,
            status: qty <= 0 ? 'out_of_stock' : (s.status || 'active'),
            sold: Number(s.sold) || 0,
            price_cost: cost,
            price_retail: retail,
            profit_unit: profitUnit,
            margin_pct: retail > 0 ? Math.round((profitUnit / retail) * 1000) / 10 : 0
        };
    }

    getProductStock(p) { return this.getProductData(p); }

    /* ---------------------------------- ADMIN: GHI DỮ LIỆU ---------------------------------- */

    async login(key) {
        try { sessionStorage.setItem(ADMIN_KEY_STORAGE, String(key || '')); } catch (e) {}
        const r = await this._api('/admin/ping', { admin: true });
        if (!r.ok) {
            try { sessionStorage.removeItem(ADMIN_KEY_STORAGE); } catch (e) {}
            return { ok: false, status: r.status, message: r.data.message || 'Không đăng nhập được.' };
        }
        return { ok: true };
    }

    logout() {
        try { sessionStorage.removeItem(ADMIN_KEY_STORAGE); } catch (e) {}
    }

    // Serialize các thao tác trên cùng 1 sản phẩm; khi hết hàng đợi thì đồng bộ lại 1 lần cho chắc
    _enqueue(id, fn) {
        this._pending++;
        const prev = this._queues[id] || Promise.resolve();
        const next = prev.catch(() => {}).then(fn).finally(() => {
            this._pending--;
            if (this._queues[id] === next) delete this._queues[id];
            if (this._pending === 0) this.syncWithCloudWorker(true);
        });
        this._queues[id] = next;
        return next;
    }

    // Sửa kho / giá vốn / giá bán của 1 sản phẩm.
    // Kho được gửi dạng CHÊNH LỆCH (+5, -1...) nên không bao giờ ghi đè đơn khách vừa đặt.
    updateProductConfig(id, newQty, newCost, newRetail) {
        const cur = this.byId.get(id);
        if (!cur) return Promise.resolve(false);
        const q = Math.max(0, parseInt(newQty) || 0);
        const c = Math.max(0, parseFloat(newCost) || 0);
        const r = parseFloat(newRetail) || 0;
        const delta = q - (parseInt(cur.qty) || 0);

        // Cập nhật tạm trên màn hình cho mượt; kết quả thật do server trả về
        cur.qty = q; cur.price_cost = c; if (r > 0) cur.price_retail = r;

        const body = { id, cost: c };
        if (r > 0) body.retail = r;
        if (delta !== 0) body.qtyDelta = delta;

        return this._enqueue(id, async () => {
            const res = await this._api('/admin/products/update', { method: 'POST', admin: true, body });
            if (res.data && res.data.product) this._applyProduct(res.data.product);
            if (!res.ok) {
                this._toast('❌ ' + (res.data.message || 'Không lưu được thay đổi, đã tải lại dữ liệu từ máy chủ.'));
                this.notify();
                return false;
            }
            this._tellOtherTabs();
            this.notify();
            return true;
        });
    }

    adjustStockDelta(id, defaultProduct, delta) {
        const cur = this.getProductData(defaultProduct || { id });
        return this.updateProductConfig(id, Math.max(0, cur.qty + delta), cur.price_cost, cur.price_retail);
    }

    async addNewProduct(productData) {
        const r = await this._api('/admin/products/create', {
            method: 'POST', admin: true,
            body: {
                id: productData.id, code: productData.code, name: productData.name,
                qty: productData.qty, price_cost: productData.price_cost, price_retail: productData.price_retail,
                price_market: productData.price_market, img: productData.img
            }
        });
        if (!r.ok) return { success: false, msg: r.data.message || 'Không thêm được sản phẩm.' };
        this._applyProduct(r.data.product);
        this.notify();
        this._tellOtherTabs();
        return { success: true, product: r.data.product };
    }

    // Bán tại quầy: server là nơi DUY NHẤT trừ kho (trước đây client trừ 1 lần + server trừ thêm 1 lần)
    async recordSale(product, sellQty, actualPrice = null, note = '') {
        const qty = parseInt(sellQty) || 0;
        if (qty <= 0) return { success: false, msg: 'Số lượng bán phải lớn hơn 0' };
        const r = await this._api('/admin/orders/create', {
            method: 'POST', admin: true,
            body: { prodId: product.id, qty, price: actualPrice, note }
        });
        if (!r.ok) {
            this.syncWithCloudWorker(true);
            return { success: false, msg: r.data.message || 'Không ghi nhận được đơn bán.' };
        }
        (r.data.products || []).forEach(p => this._applyProduct(p));
        this.salesHistory.unshift(r.data.order);
        this.notify();
        this._tellOtherTabs();
        const p = this.byId.get(product.id);
        return { success: true, order: r.data.order, remainingStock: p ? p.qty : 0 };
    }

    async cancelOrderOnCloud(orderId) {
        const r = await this._api('/admin/orders/cancel', { method: 'POST', admin: true, body: { orderId } });
        if (r.ok) {
            await Promise.all([this.syncWithCloudWorker(true), this.fetchAdminOrders(true)]);
            this._tellOtherTabs();
        }
        return r.ok;
    }

    // Đổi trạng thái xử lý đơn: CONFIRMED | SHIPPED | DELIVERED | PAID (xác nhận đã nhận tiền thủ công)
    async setOrderStatus(orderId, status) {
        const r = await this._api('/admin/orders/status', { method: 'POST', admin: true, body: { orderId, status } });
        if (r.ok) {
            await this.fetchAdminOrders(true);
            this._tellOtherTabs();
            return { success: true };
        }
        return { success: false, msg: r.data.message || 'Không đổi được trạng thái.' };
    }

    // Đơn bán quầy đã nằm trên server, "hoàn tác" = hủy đơn. Giữ hàm này để code cũ không lỗi.
    undoSale() { return false; }
}

window.realtimeStore = new RealtimeStore();
