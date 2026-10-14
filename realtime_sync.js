// REALTIME CLOUD SYNC & INVENTORY/PRICE MANAGEMENT MODULE
const CLOUD_CONFIG = {
    STORAGE_KEY: "lego_store_realtime_inventory",
    SALES_KEY: "lego_store_sales_history",
    PRICE_OVERRIDE_KEY: "lego_store_price_overrides"
};

class RealtimeStore {
    constructor() {
        this.inventoryState = {}; // { [id]: { qty: number, status: string, sold: number, cost: number, retail: number } }
        this.salesHistory = [];   // [ { orderId, prodId, name, qty, price, cost, profit, note, time } ]
        this.listeners = [];
        this.loadInitialState();
    }

    loadInitialState() {
        try {
            const localInv = localStorage.getItem(CLOUD_CONFIG.STORAGE_KEY);
            if (localInv) this.inventoryState = JSON.parse(localInv);

            const localSales = localStorage.getItem(CLOUD_CONFIG.SALES_KEY);
            if (localSales) this.salesHistory = JSON.parse(localSales);
        } catch (e) {
            console.warn("Chưa có cache:", e);
        }
    }

    subscribe(callback) {
        this.listeners.push(callback);
    }

    notify() {
        this.listeners.forEach(cb => cb({ inventory: this.inventoryState, sales: this.salesHistory }));
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

        // 2. Ghi nhật ký đơn bán hàng
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
            time: new Date().toLocaleString('vi-VN')
        };

        this.salesHistory.unshift(orderRecord);
        this.saveAndBroadcast();

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

    saveAndBroadcast() {
        localStorage.setItem(CLOUD_CONFIG.STORAGE_KEY, JSON.stringify(this.inventoryState));
        localStorage.setItem(CLOUD_CONFIG.SALES_KEY, JSON.stringify(this.salesHistory));
        this.notify();

        if (window.BroadcastChannel) {
            const bc = new BroadcastChannel('lego_inventory_sync');
            bc.postMessage({
                type: 'SYNC_UPDATE',
                inventory: this.inventoryState,
                sales: this.salesHistory
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
        });
    }
}

window.realtimeStore = new RealtimeStore();
window.realtimeStore.initListener();
