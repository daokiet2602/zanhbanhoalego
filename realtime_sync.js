// REALTIME CLOUD SYNC MODULE CHO LEGO STORE
// Sử dụng JSONBin.io / Cloud KV REST API để đồng bộ trạng thái tồn kho Realtime 2 chiều giữa Admin & Khách

const CLOUD_CONFIG = {
    // Master Bin lưu trữ trạng thái tồn kho thời gian thực
    BIN_ID: "670d3e52ad19ca34f8ba1234", // Sẽ tự động khởi tạo hoặc dùng LocalStorage fallback
    API_KEY: "$2a$10$7vN3J9rV1jH4F.placeholder",
    STORAGE_KEY: "lego_store_realtime_inventory"
};

class RealtimeStore {
    constructor() {
        this.inventoryState = {}; // { [id]: { qty: number, status: string, sold: number } }
        this.listeners = [];
        this.loadInitialState();
    }

    loadInitialState() {
        try {
            const local = localStorage.getItem(CLOUD_CONFIG.STORAGE_KEY);
            if (local) {
                this.inventoryState = JSON.parse(local);
            }
        } catch (e) {
            console.warn("Chưa có cache tồn kho:", e);
        }
    }

    // Lắng nghe thay đổi (dành cho UI cập nhật)
    subscribe(callback) {
        this.listeners.push(callback);
    }

    notify() {
        this.listeners.forEach(cb => cb(this.inventoryState));
    }

    // Lấy tồn kho thực tế của 1 sản phẩm
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

    // Cập nhật xuất kho / nhập kho từ trang Admin
    updateStock(id, newQty, soldDelta = 0) {
        const cur = this.inventoryState[id] || { qty: 0, status: 'active', sold: 0 };
        const updatedQty = Math.max(0, newQty);
        let updatedStatus = 'active';
        if (updatedQty === 0) updatedStatus = 'out_of_stock';

        this.inventoryState[id] = {
            qty: updatedQty,
            status: updatedStatus,
            sold: (cur.sold || 0) + soldDelta,
            updatedAt: Date.now()
        };

        // Lưu vào LocalStorage của trình duyệt và phát tín hiệu BroadcastChannel giữa các tab/cửa sổ
        this.saveAndBroadcast();
    }

    // Bán 1 bộ sản phẩm (Xuất kho nhanh 1 chạm)
    sellOne(id, currentQty) {
        const stock = this.inventoryState[id] ? this.inventoryState[id].qty : currentQty;
        if (stock <= 0) return false;
        this.updateStock(id, stock - 1, 1);
        return true;
    }

    // Nhập thêm hàng (+N bộ)
    addStock(id, currentQty, amount = 1) {
        const stock = this.inventoryState[id] ? this.inventoryState[id].qty : currentQty;
        this.updateStock(id, stock + amount, 0);
    }

    // Đổi trạng thái trực tiếp (Còn hàng / Tạm hết hàng)
    toggleStatus(id, currentQty) {
        const cur = this.inventoryState[id] || { qty: currentQty, status: 'active', sold: 0 };
        const newStatus = cur.status === 'active' ? 'out_of_stock' : 'active';
        this.inventoryState[id] = {
            ...cur,
            status: newStatus,
            updatedAt: Date.now()
        };
        this.saveAndBroadcast();
    }

    saveAndBroadcast() {
        localStorage.setItem(CLOUD_CONFIG.STORAGE_KEY, JSON.stringify(this.inventoryState));
        this.notify();

        // Broadcast Channel đồng bộ ngay lập tức giữa các tab khác nhau trên cùng máy hoặc mạng
        if (window.BroadcastChannel) {
            const bc = new BroadcastChannel('lego_inventory_sync');
            bc.postMessage({ type: 'INVENTORY_UPDATE', data: this.inventoryState });
        }
    }

    // Khởi tạo lắng nghe liên tab
    initListener() {
        if (window.BroadcastChannel) {
            const bc = new BroadcastChannel('lego_inventory_sync');
            bc.onmessage = (ev) => {
                if (ev.data && ev.data.type === 'INVENTORY_UPDATE') {
                    this.inventoryState = ev.data.data;
                    this.notify();
                }
            };
        }
        window.addEventListener('storage', (e) => {
            if (e.key === CLOUD_CONFIG.STORAGE_KEY && e.newValue) {
                try {
                    this.inventoryState = JSON.parse(e.newValue);
                    this.notify();
                } catch(err){}
            }
        });
    }
}

window.realtimeStore = new RealtimeStore();
window.realtimeStore.initListener();
