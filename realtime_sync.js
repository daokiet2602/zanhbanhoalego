// REALTIME CLOUD SYNC & INVENTORY/PRICE MANAGEMENT MODULE
const CLOUD_CONFIG = {
    STORAGE_KEY: "lego_store_realtime_inventory",
    SALES_KEY: "lego_store_sales_history",
    NEW_PRODUCTS_KEY: "lego_store_new_products",
    CLOUD_STORE_URL: "https://sepay-checker.daokiet-work.workers.dev/api/cloud-store"
};

class RealtimeStore {
    constructor() {
        this.inventoryState = {}; // { [id]: { qty: number, status: string, sold: number, cost: number, retail: number } }
        this.salesHistory = [];   // [ { orderId, prodId, name, qty, price, cost, profit, note, time } ]
        this.newProducts = [];    // Danh sách các sản phẩm mới do chủ shop thêm trực tiếp
        this.listeners = [];
        this.loadInitialState();
        this.syncWithCloudWorker(); // Tự động kéo dữ liệu mới nhất từ Cloud Worker
    }

    loadInitialState() {
        try {
            const localInv = localStorage.getItem(CLOUD_CONFIG.STORAGE_KEY);
            if (localInv) this.inventoryState = JSON.parse(localInv);

            const localSales = localStorage.getItem(CLOUD_CONFIG.SALES_KEY);
            if (localSales) this.salesHistory = JSON.parse(localSales);

            const localNewProds = localStorage.getItem(CLOUD_CONFIG.NEW_PRODUCTS_KEY);
            if (localNewProds) this.newProducts = JSON.parse(localNewProds);
        } catch (e) {
            console.warn("Chưa có cache:", e);
        }
    }

    // KÉO DỮ LIỆU DÙNG CHUNG TỪ CLOUD WORKER (CHỐNG CACHE TRIỆT ĐỂ & ĐỒNG BỘ TỨC THÌ)
    async syncWithCloudWorker() {
        try {
            // Thêm timestamp ?_t= để ép trình duyệt điện thoại luôn kéo dữ liệu tươi mới 100%, không dính cache
            const freshUrl = `${CLOUD_CONFIG.CLOUD_STORE_URL}?_t=${Date.now()}`;
            const res = await fetch(freshUrl);
            if (res.ok) {
                const cloudData = await res.json();
                if (cloudData) {
                    if (cloudData.inventory && Object.keys(cloudData.inventory).length > 0) {
                        this.inventoryState = { ...this.inventoryState, ...cloudData.inventory };
                        localStorage.setItem(CLOUD_CONFIG.STORAGE_KEY, JSON.stringify(this.inventoryState));
                    }
                    if (cloudData.newProducts && cloudData.newProducts.length > 0) {
                        this.newProducts = cloudData.newProducts;
                        localStorage.setItem(CLOUD_CONFIG.NEW_PRODUCTS_KEY, JSON.stringify(this.newProducts));
                    }
                    if (cloudData.salesHistory && cloudData.salesHistory.length > 0) {
                        this.salesHistory = cloudData.salesHistory;
                        localStorage.setItem(CLOUD_CONFIG.SALES_KEY, JSON.stringify(this.salesHistory));
                    }
                    this.notify();
                }
            }
        } catch(e) {
            console.warn("Không kết nối được Cloud Worker:", e);
        }
    }

    // ĐẨY DỮ LIỆU LÊN CLOUD WORKER KHI ADMIN CẬP NHẬT HOẶC CÓ ĐƠN MỚI
    async pushToCloudWorker(newOrder = null) {
        try {
            await fetch(CLOUD_CONFIG.CLOUD_STORE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    inventory: this.inventoryState,
                    newProducts: this.newProducts,
                    salesHistory: this.salesHistory,
                    newOrder: newOrder
                })
            });
        } catch(e) {
            console.warn("Lỗi lưu lên Cloud Worker:", e);
        }
    }

    subscribe(callback) {
        this.listeners.push(callback);
    }

    notify() {
        this.listeners.forEach(cb => cb({ 
            inventory: this.inventoryState, 
            sales: this.salesHistory,
            newProducts: this.newProducts 
        }));
    }

    // THÊM SẢN PHẨM MỚI VÀO HỆ THỐNG
    addNewProduct(productData) {
        const id = productData.id || ('LG-' + (92 + this.newProducts.length));
        const newProd = {
            id: id,
            code: productData.code || ('Mẫu #' + id.replace('LG-', '')),
            name: productData.name || 'Mẫu Hoa Lego Mới',
            qty: Math.max(0, parseInt(productData.qty) || 0),
            sold_qty: 0,
            price_retail: parseFloat(productData.price_retail) || 0,
            price_market: parseFloat(productData.price_market) || (parseFloat(productData.price_retail) * 1.3),
            price_cost: parseFloat(productData.price_cost) || 0,
            status: (parseInt(productData.qty) || 0) > 0 ? 'active' : 'out_of_stock',
            img: productData.img || 'images/prod_row_2.jpeg',
            createdAt: Date.now()
        };

        this.newProducts.unshift(newProd);

        // Lưu thông số vào inventoryState
        this.inventoryState[id] = {
            qty: newProd.qty,
            cost: newProd.price_cost,
            retail: newProd.price_retail,
            status: newProd.status,
            sold: 0,
            updatedAt: Date.now()
        };

        this.saveAndBroadcast();
        return newProd;
    }

    // Lấy toàn bộ sản phẩm (Gồm sản phẩm gốc trong JSON + Sản phẩm mới thêm)
    getAllMergedProducts(baseProducts = []) {
        // Tránh trùng ID
        const existingIds = new Set(this.newProducts.map(p => p.id));
        const filteredBase = (baseProducts || []).filter(p => !existingIds.has(p.id));
        return [...this.newProducts, ...filteredBase];
    }

    // Lấy thông tin sản phẩm (Ưu tiên thông tin tùy chỉnh mới nhất)
    getProductData(p) {
        const custom = this.inventoryState[p.id] || {};
        const qty = custom.qty !== undefined ? custom.qty : p.qty;
        const status = custom.status || p.status;
        const sold = custom.sold !== undefined ? custom.sold : (p.sold_qty || 0);
        const cost = custom.cost !== undefined ? custom.cost : p.price_cost;
        const retail = custom.retail !== undefined ? custom.retail : p.price_retail;

        const profitUnit = retail - cost;
        const marginPct = retail > 0 ? Math.round((profitUnit / retail) * 1000) / 10 : 0;

        return {
            ...p,
            qty: qty,
            status: qty <= 0 ? 'out_of_stock' : status,
            sold: sold,
            price_cost: cost,
            price_retail: retail,
            profit_unit: profitUnit,
            margin_pct: marginPct
        };
    }

    getProductStock(p) {
        return this.getProductData(p);
    }

    // ĐIỀU CHỈNH TOÀN DIỆN: TỒN KHO, GIÁ VỐN, GIÁ BÁN
    updateProductConfig(id, newQty, newCost, newRetail) {
        const cur = this.inventoryState[id] || {};
        const q = Math.max(0, parseInt(newQty) || 0);
        const c = parseFloat(newCost) || 0;
        const r = parseFloat(newRetail) || 0;

        this.inventoryState[id] = {
            ...cur,
            qty: q,
            cost: c,
            retail: r,
            status: q === 0 ? 'out_of_stock' : 'active',
            updatedAt: Date.now()
        };

        this.saveAndBroadcast();
    }

    // TĂNG / GIẢM TỒN KHO NHANH (+1, -1 hoặc +/- delta)
    adjustStockDelta(id, defaultProduct, delta) {
        const currentData = this.getProductData(defaultProduct);
        const newQty = Math.max(0, currentData.qty + delta);
        this.updateProductConfig(id, newQty, currentData.price_cost, currentData.price_retail);
    }

    // NHẬP ĐƠN BÁN HÀNG CHỦ ĐỘNG
    recordSale(product, sellQty, actualPrice = null, note = '') {
        const qtyToSell = parseInt(sellQty) || 0;
        if (qtyToSell <= 0) return { success: false, msg: 'Số lượng bán phải lớn hơn 0' };

        const currentData = this.getProductData(product);
        if (qtyToSell > currentData.qty) {
            return { success: false, msg: `Tồn kho chỉ còn ${currentData.qty} bộ, không đủ xuất bán ${qtyToSell} bộ!` };
        }

        const price = actualPrice !== null ? parseFloat(actualPrice) : currentData.price_retail;
        const cost = currentData.price_cost || 0;
        const profit = (price - cost) * qtyToSell;

        // 1. Trừ tồn kho & cộng số lượng đã bán
        const updatedQty = Math.max(0, currentData.qty - qtyToSell);
        const curInfo = this.inventoryState[product.id] || {};

        this.inventoryState[product.id] = {
            ...curInfo,
            qty: updatedQty,
            cost: cost,
            retail: price,
            status: updatedQty === 0 ? 'out_of_stock' : 'active',
            sold: (curInfo.sold || currentData.sold || 0) + qtyToSell,
            updatedAt: Date.now()
        };

        // 2. Ghi nhật ký đơn bán hàng kèm timestamp chuẩn
        const now = new Date();
        const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM

        const orderRecord = {
            orderId: 'DH-' + Date.now().toString().slice(-6),
            prodId: product.id,
            prodCode: product.code,
            prodName: product.name,
            qty: qtyToSell,
            price: price,
            cost: cost,
            totalRevenue: price * qtyToSell,
            profit: profit,
            note: note || 'Bán trực tiếp',
            time: now.toLocaleString('vi-VN'),
            timestamp: Date.now(),
            monthKey: monthKey
        };

        this.salesHistory.unshift(orderRecord);
        this.saveAndBroadcast(orderRecord);

        return { success: true, order: orderRecord, remainingStock: updatedQty };
    }

    // HOÀN TÁC ĐƠN BÁN
    undoSale(orderId) {
        const idx = this.salesHistory.findIndex(o => o.orderId === orderId);
        if (idx === -1) return false;

        const order = this.salesHistory[idx];
        const curInfo = this.inventoryState[order.prodId] || { qty: 0, status: 'active', sold: 0 };

        this.inventoryState[order.prodId] = {
            ...curInfo,
            qty: curInfo.qty + order.qty,
            status: 'active',
            sold: Math.max(0, (curInfo.sold || 0) - order.qty),
            updatedAt: Date.now()
        };

        this.salesHistory.splice(idx, 1);
        this.saveAndBroadcast();
        return true;
    }

    saveAndBroadcast(newOrder = null) {
        localStorage.setItem(CLOUD_CONFIG.STORAGE_KEY, JSON.stringify(this.inventoryState));
        localStorage.setItem(CLOUD_CONFIG.SALES_KEY, JSON.stringify(this.salesHistory));
        localStorage.setItem(CLOUD_CONFIG.NEW_PRODUCTS_KEY, JSON.stringify(this.newProducts));
        this.notify();
        this.pushToCloudWorker(newOrder); // Đẩy ngay lên mây Cloud Worker kèm đơn mới (nếu có)

        if (window.BroadcastChannel) {
            const bc = new BroadcastChannel('lego_inventory_sync');
            bc.postMessage({
                type: 'SYNC_UPDATE',
                inventory: this.inventoryState,
                sales: this.salesHistory,
                newProducts: this.newProducts
            });
        }
    }

    initListener() {
        if (window.BroadcastChannel) {
            const bc = new BroadcastChannel('lego_inventory_sync');
            bc.onmessage = (ev) => {
                if (ev.data && ev.data.type === 'SYNC_UPDATE') {
                    if (ev.data.inventory) this.inventoryState = ev.data.inventory;
                    if (ev.data.sales) this.salesHistory = ev.data.sales;
                    if (ev.data.newProducts) this.newProducts = ev.data.newProducts;
                    this.notify();
                }
            };
        }
        window.addEventListener('storage', (e) => {
            if (e.key === CLOUD_CONFIG.STORAGE_KEY && e.newValue) {
                try { this.inventoryState = JSON.parse(e.newValue); this.notify(); } catch(err){}
            }
            if (e.key === CLOUD_CONFIG.SALES_KEY && e.newValue) {
                try { this.salesHistory = JSON.parse(e.newValue); this.notify(); } catch(err){}
            }
            if (e.key === CLOUD_CONFIG.NEW_PRODUCTS_KEY && e.newValue) {
                try { this.newProducts = JSON.parse(e.newValue); this.notify(); } catch(err){}
            }
        });
    }
}

window.realtimeStore = new RealtimeStore();
window.realtimeStore.initListener();
