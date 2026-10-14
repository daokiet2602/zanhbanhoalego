// REALTIME CLOUD SYNC & SALES HISTORY MODULE
const CLOUD_CONFIG = {
    STORAGE_KEY: "lego_store_realtime_inventory",
    SALES_KEY: "lego_store_sales_history"
};

class RealtimeStore {
    constructor() {
        this.inventoryState = {}; // { [id]: { qty: number, status: string, sold: number } }
        this.salesHistory = [];   // [ { id, prodId, name, qty, price, cost, profit, note, time } ]
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

    getProductStock(p) {
        if (this.inventoryState[p.id]) {
            return {
                qty: this.inventoryState[p.id].qty,
                status: this.inventoryState[p.id].status,
                sold: this.inventoryState[p.id].sold || 0
            };
        }
        return {
            qty: p.qty,
            status: p.status,
            sold: p.sold_qty || 0
        };
    }

    // NHẬP ĐƠN BÁN HÀNG CHỦ ĐỘNG (Bán N bộ)
    recordSale(product, sellQty, actualPrice = null, note = '') {
        const qtyToSell = parseInt(sellQty) || 0;
        if (qtyToSell <= 0) return { success: false, msg: 'Số lượng bán phải lớn hơn 0' };

        const currentStock = this.getProductStock(product).qty;
        if (qtyToSell > currentStock) {
            return { success: false, msg: `Tồn kho chỉ còn ${currentStock} bộ, không đủ xuất bán ${qtyToSell} bộ!` };
        }

        const price = actualPrice !== null ? parseFloat(actualPrice) : product.price_retail;
        const cost = product.price_cost || 0;
        const profit = (price - cost) * qtyToSell;

        // 1. Trừ tồn kho & cộng số lượng đã bán
        const updatedQty = Math.max(0, currentStock - qtyToSell);
        const curInfo = this.inventoryState[product.id] || { qty: currentStock, status: product.status, sold: 0 };
        
        let newStatus = product.status;
        if (updatedQty === 0) newStatus = 'out_of_stock';

        this.inventoryState[product.id] = {
            qty: updatedQty,
            status: newStatus,
            sold: (curInfo.sold || 0) + qtyToSell,
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
            totalRevenue: price * qtyToSell,
            profit: profit,
            note: note || 'Bán trực tiếp',
            time: new Date().toLocaleString('vi-VN')
        };

        this.salesHistory.unshift(orderRecord);
        this.saveAndBroadcast();

        return { success: true, order: orderRecord, remainingStock: updatedQty };
    }

    // HOÀN TÁC ĐƠN BÁN (Nếu nhập nhầm)
    undoSale(orderId) {
        const idx = this.salesHistory.findIndex(o => o.orderId === orderId);
        if (idx === -1) return false;

        const order = this.salesHistory[idx];
        const curInfo = this.inventoryState[order.prodId] || { qty: 0, status: 'active', sold: 0 };

        // Cộng lại kho & trừ đã bán
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

    // ĐIỀU CHỈNH TỒN KHO TRỰC TIẾP
    adjustStockDirect(id, newQty, defaultStatus = 'active') {
        const cur = this.inventoryState[id] || { qty: 0, status: defaultStatus, sold: 0 };
        const q = Math.max(0, parseInt(newQty) || 0);
        this.inventoryState[id] = {
            ...cur,
            qty: q,
            status: q === 0 ? 'out_of_stock' : 'active',
            updatedAt: Date.now()
        };
        this.saveAndBroadcast();
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
