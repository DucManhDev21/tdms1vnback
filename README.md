# TDMS1VN Backend

Backend Express chạy trên Railway. `server.js` nằm ngay thư mục gốc để Railway dùng `npm start` -> `node server.js`.

## Files

- `server.js` — Express master app
- `services.js` — Provider services
- `order.js` — đặt đơn + transaction + refund
- `cron.js` — đồng bộ trạng thái đơn
- `deposit.js` — nạp tiền + Telegram
- `package.json` — dependencies
- `.env.example` — biến môi trường
- `firestore.rules` — rules Firestore

## Railway

Root Directory: `/`
Start Command: `npm start`
Node: 20+

Backend public health endpoint: `/health`.

Không commit `.env` hoặc credentials Firebase/Provider/Telegram thật.
