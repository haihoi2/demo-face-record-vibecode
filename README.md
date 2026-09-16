# Hệ Thống Điểm Danh Khuôn Mặt AI & Điều Khiển Khóa Thông Minh (SmartLock Gateway)

Hệ thống nhận diện khuôn mặt nhân viên đa đối tượng thời gian thực theo mô hình **local-first** (ưu tiên mô hình cục bộ/on-prem, tùy chọn Google Gemini fallback), tự động điều khiển khóa cửa thông minh (Smart Lock API), ghi nhận lịch sử chấm công Vào/Ra, đồng bộ thông báo thời gian thực qua Server-Sent Events (SSE) và gửi Webhook tích hợp trực tiếp vào **Eton Chat Room**.

Toàn bộ dữ liệu của phần Backend được lưu trữ bền vững với hỗ trợ **PostgreSQL (qua Docker Compose)** hoặc **SQLite 3 (`data/smartface.db`)**, không bị mất mát khi khởi động lại máy chủ hoặc nâng cấp hệ thống.

---

## 📑 Mục Lục
1. [Kiến Trúc Lưu Trữ Dữ Liệu (PostgreSQL & SQLite)](#-kiến-trúc-lưu-trữ-dữ-liệu)
2. [Cấu Trúc Bảng Dữ Liệu](#-cấu-trúc-bảng-dữ-liệu)
3. [Yêu Cầu Hệ Thống (Prerequisites)](#-yêu-cầu-hệ-thống)
4. [Hướng Dẫn Cài Đặt & Chạy Môi Trường Phát Triển (Dev)](#-hướng-dẫn-chạy-môi-trường-phát-triển)
5. [Hướng Dẫn Biên Dịch (Build Production)](#-hướng-dẫn-biên-dịch-build-production)
6. [Hướng Dẫn Deploy Production](#-hướng-dẫn-deploy-production)
   - [Cách 1: Deploy trên Máy Chủ Linux/Ubuntu với PM2](#cách-1-deploy-trực-tiếp-bằng-pm2-khuyên-dùng-cho-vps)
  - [Cách 2: Deploy Bằng Docker Compose với PostgreSQL (Backend Database)](#cách-2-deploy-bằng-docker-compose-với-postgresql-backend-database)
  - [Cách 3: Frontend Netlify + Backend Render](#cách-3-frontend-netlify--backend-render)
  - [Cách 4: Cấu Hình Nginx Reverse Proxy & SSL (HTTPS)](#cách-4-cấu-hình-nginx-reverse-proxy--ssl-https)
7. [Sao Lưu (Backup) & Phục Hồi (Restore) Database](#-sao-lưu-và-phục-hồi-cơ-sở-dữ-liệu)
8. [Tích Hợp Webhook Eton Chat Room](#-tích-hợp-webhook-eton-chat-room)
9. [API Kiểm Tra Trạng Thái Database](#-api-kiểm-tra-trạng-thái-database)

---

## 🗄️ Kiến Trúc Lưu Trữ Dữ Liệu

Hệ thống hỗ trợ cơ chế lưu trữ phân tầng linh hoạt giữa **PostgreSQL** (cho triển khai quy mô phân tán, Docker Compose, Cloud SQL) và **SQLite 3** (cho triển khai nhúng gọn nhẹ):

* **PostgreSQL (Khuyên dùng cho Docker Compose & Doanh Nghiệp)**:
  - Tự động kích hoạt khi biến môi trường `DATABASE_URL` được cấu hình (ví dụ: `postgresql://user:pass@postgres:5432/smartface_db`).
  - Dữ liệu được lưu trữ trong volume Docker độc lập `postgres_data`, đảm bảo khả năng mở rộng, backup định kỳ qua `pg_dump` và tính toàn vẹn dữ liệu ACID.
  - Tự động nạp cấu trúc bảng qua file `init-db.sql`.
* **SQLite 3 Native Node.js 22+ (`node:sqlite`) (Chế độ mặc định độc lập)**:
  - Tích hợp sẵn trong runtime Node.js, không cần cài đặt thêm phần mềm database ngoài.
  - Vị trí file dữ liệu: `./data/smartface.db` (tự động tạo thư mục `data/` và khởi tạo bảng khi khởi chạy lần đầu).
* **Cơ chế Fallback an toàn**:
  - Nếu chạy trên phiên bản Node cũ hơn chưa hỗ trợ `node:sqlite`, hệ thống tự động kích hoạt bộ lưu trữ tệp atomic JSON (`data/smartface_data.json`) để ứng dụng luôn hoạt động thông suốt.
* **Đồng bộ song song**: Khi kết nối PostgreSQL thành công, hệ thống tự động ghi nhận song song các thao tác vào PostgreSQL, sẵn sàng chuyển đổi linh hoạt mà không làm gián đoạn hệ thống.

---

## 📊 Cấu Trúc Bảng Dữ Liệu

Cơ sở dữ liệu quản lý 6 bảng cơ bản:

| Tên Bảng | Mô Tả | Các Trường Chính |
| :--- | :--- | :--- |
| `employees` | Danh sách nhân viên & khuôn mặt | `id`, `name`, `employeeCode` (UNIQUE), `department`, `position`, `photoUrl`, `registeredAt`, `accessLevel` |
| `access_logs` | Nhật ký chấm công & mở khóa Vào/Ra | `id`, `timestamp`, `type` (ENTRY/EXIT), `status` (GRANTED/DENIED), `employeeId`, `employeeName`, `employeeCode`, `department`, `confidence`, `livenessScore`, `lockAction`, `doorName`, `reason` |
| `smart_lock_state` | Trạng thái chốt khóa thông minh | `lockId`, `doorName`, `state` (LOCKED/UNLOCKED), `isLocked`, `batteryLevel`, `signalDbm`, `firmwareVersion`, `lastActionAt`, `lastActionBy`, `autoRelockSeconds`, `status` |
| `webhook_config` | Cấu hình Eton Chat Room Webhook | `id`, `enabled`, `url`, `gateInTitle`, `gateOutTitle`, `includeEmployeeCode` |
| `webhook_logs` | Lịch sử bản tin Webhook đã phát | `id`, `timestamp`, `url`, `method`, `payload`, `statusCode`, `statusText`, `responseBody`, `success`, `error`, `scanType`, `userName` |
| `mobile_notifications` | Thông báo đẩy cho ứng dụng di động | `id`, `title`, `body`, `timestamp`, `type`, `read`, `employeeId`, `employeeName` |

---

## 💻 Yêu Cầu Hệ Thống

* **Hệ điều hành**: Linux (Ubuntu 20.04+, Debian 11+), macOS hoặc Windows 10/11.
* **Node.js**: Phiên bản **Node.js >= 22.0.0 LTS** (khuyên dùng để sử dụng Native SQLite).
* **Package Manager**: npm (đi kèm Node.js).
* **Camera / Webcam**: Hỗ trợ độ phân giải tối thiểu 720p để nhận diện khuôn mặt qua trình duyệt.
* **Khóa cửa**: Khóa cửa thông minh có kết nối mạng (Zigbee Gateway / Wi-Fi API) hoặc mô phỏng qua SmartLock Gateway tích hợp.

---

## 🚀 Hướng Dẫn Chạy Môi Trường Phát Triển

### 1. Tải mã nguồn và cài đặt thư viện
```bash
git clone <URL_REPOSITORY>
cd <THU_MUC_DU_AN>
npm install
```

### 2. Cấu hình biến môi trường
Tạo file `.env` từ mẫu `.env.example`:
```bash
cp .env.example .env
```

Chỉnh sửa nội dung file `.env`:
```env
# Port ứng dụng cục bộ (Render tự cấp PORT khi deploy)
PORT=3000

# Thư mục lưu SQLite cục bộ/persistent disk
DATA_DIR="./data"

# Trusted frontend origins gọi backend Render
CORS_ALLOWED_ORIGINS="http://localhost:3000,https://your-site.netlify.app"

# Server-side Eton webhook endpoint
ETON_WEBHOOK_URL="https://chat-room.eton.vn/hooks/YOUR_WEBHOOK_TOKEN"

# Frontend gọi backend cùng origin khi để trống.
# Trên Netlify, gán thành URL Render backend.
VITE_API_BASE_URL=""

# Luồng nhận diện: local | google | auto
FACE_RECOGNITION_PROVIDER="local"

# Tên mô hình cục bộ hiển thị trong log / API status
LOCAL_FACE_RECOGNITION_MODEL="local-exact-match"

# URL dịch vụ nhận diện nội bộ/on-prem (nếu có)
LOCAL_FACE_RECOGNITION_URL="http://127.0.0.1:8000/recognize"

# Tùy chọn fallback sang Google Gemini
GEMINI_API_KEY="MY_GEMINI_API_KEY"
GOOGLE_GEMINI_MODEL="gemini-3.8-flash"
```

### 3. Chạy ứng dụng ở chế độ Dev
```bash
npm run dev
```
Truy cập trình duyệt tại: **`http://localhost:3000`**

Khi khởi động, server sẽ hiển thị log:
```text
[SQLite] Đã kết nối cơ sở dữ liệu SQLite thành công tại: /path/to/data/smartface.db
Server running on http://localhost:3000
```

---

## 📦 Hướng Dẫn Biên Dịch (Build Production)

Lệnh build thực hiện 2 nhiệm vụ trong một bước duy nhất:
1. Biên dịch giao diện React TypeScript bằng **Vite** vào thư mục `dist/`.
2. Đóng gói toàn bộ mã nguồn máy chủ Express & Database SQLite bằng **esbuild** thành file duy nhất `dist/server.cjs`.

Chạy lệnh build:
```bash
npm run build
```

Hoặc build riêng từng phần:
```bash
npm run build:client   # chỉ build frontend cho Netlify
npm run build:server   # chỉ build backend cho Render
```

Sau khi hoàn tất, cấu trúc thư mục phát hành sẽ bao gồm:
```text
dist/
├── index.html       # Single Page Application
├── assets/          # JS, CSS, Media đóng gói
├── server.cjs       # Node.js bundled backend server
└── server.cjs.map   # Sourcemap hỗ trợ debug
data/
└── smartface.db     # Cơ sở dữ liệu SQLite bền vững
```

Kiểm tra chạy thử file đã build:
```bash
npm start
# Tương đương: node dist/server.cjs
```

---

## 🌐 Hướng Dẫn Deploy Production

### Cách 1: Deploy Trực Tiếp Bằng PM2 (Khuyên dùng cho VPS)

**PM2** là trình quản lý tiến trình chuyên dụng cho Node.js, tự động khởi động lại ứng dụng nếu gặp sự cố và khởi động cùng hệ thống khi reboot máy chủ.

#### Bước 1: Cài đặt PM2 toàn cục
```bash
sudo npm install -g pm2
```

#### Bước 2: Build dự án
```bash
npm run build
```

#### Bước 3: Tạo file cấu hình `ecosystem.config.cjs`
Tạo file `ecosystem.config.cjs` tại thư mục gốc:
```javascript
module.exports = {
  apps: [
    {
      name: "smartface-gateway",
      script: "dist/server.cjs",
      instances: 1, // Chạy 1 instance vì SQLite là file-based database
      autorestart: true,
      watch: false,
      max_memory_restart: "800M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        DATA_DIR: "./data",
        FACE_RECOGNITION_PROVIDER: "local",
        LOCAL_FACE_RECOGNITION_MODEL: "local-exact-match",
        LOCAL_FACE_RECOGNITION_URL: "http://127.0.0.1:8000/recognize",
        GEMINI_API_KEY: "MY_GEMINI_API_KEY",
        GOOGLE_GEMINI_MODEL: "gemini-3.8-flash"
      }
    }
  ]
};
```

#### Bước 4: Khởi chạy và lưu cấu hình PM2
```bash
# Khởi chạy ứng dụng
pm2 start ecosystem.config.cjs

# Lưu danh sách tiến trình tự khởi động cùng OS
pm2 save
pm2 startup
```

Các lệnh quản trị tiện ích:
```bash
pm2 status              # Xem trạng thái
pm2 logs smartface-gateway  # Xem log thời gian thực
pm2 restart smartface-gateway # Khởi động lại
```

---

### Cách 2: Deploy Bằng Docker Compose với PostgreSQL (Backend Database)

Hệ thống hỗ trợ cơ chế lưu trữ phân tầng doanh nghiệp với **PostgreSQL 16** chạy qua Docker Compose, đồng thời duy trì volume dự phòng cho SQLite. Mọi thay đổi dữ liệu nhân viên, lịch sử chấm công, cấu hình webhook và thông báo tức thời được lưu trực tiếp vào cơ sở dữ liệu PostgreSQL (`smartface_db`).

#### 1. Kiến trúc dịch vụ Docker Compose:
- **`smartface-postgres`**: Container PostgreSQL 16 Alpine, cấu hình volume bền vững `postgres_data` và tự động nạp bảng khởi tạo qua `init-db.sql`.
- **`smartface-lock-gateway`**: Container ứng dụng Node.js, tự động kết nối qua mạng nội bộ Docker `smartface-network` với biến môi trường `DATABASE_URL`. Container tự kiểm tra trạng thái sức khỏe (`service_healthy`) của Postgres trước khi khởi động.

#### 2. Cấu hình biến môi trường (`.env`):
Tạo hoặc cập nhật file `.env` trên thư mục gốc:
```env
# Google Gemini API Key cho nhận diện khuôn mặt
GEMINI_API_KEY=MY_GEMINI_API_KEY

# Cấu hình tài khoản PostgreSQL
POSTGRES_USER=smartface_user
POSTGRES_PASSWORD=smartface_secret_pass
POSTGRES_DB=smartface_db
POSTGRES_PORT=5432

# Chuỗi kết nối Database URL
DATABASE_URL=postgresql://smartface_user:smartface_secret_pass@postgres:5432/smartface_db
```

#### 3. Cấu hình file `docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: smartface-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-smartface_user}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-smartface_secret_pass}
      POSTGRES_DB: ${POSTGRES_DB:-smartface_db}
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-db.sql:/docker-entrypoint-initdb.d/init-db.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-smartface_user} -d ${POSTGRES_DB:-smartface_db}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - smartface-network

  smartface-app:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: smartface-lock-gateway
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - PORT=3000
      - GEMINI_API_KEY=${GEMINI_API_KEY:-}
      - DATABASE_URL=postgresql://${POSTGRES_USER:-smartface_user}:${POSTGRES_PASSWORD:-smartface_secret_pass}@postgres:5432/${POSTGRES_DB:-smartface_db}
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    networks:
      - smartface-network

volumes:
  postgres_data:
    driver: local

networks:
  smartface-network:
    driver: bridge
```

#### 4. Khởi chạy với Docker Compose (1 lệnh duy nhất):
```bash
# Đặt biến môi trường nếu có
export VITE_API_BASE_URL=""
export FACE_RECOGNITION_PROVIDER="local"
export LOCAL_FACE_RECOGNITION_MODEL="local-exact-match"
export LOCAL_FACE_RECOGNITION_URL="http://127.0.0.1:8000/recognize"
export GEMINI_API_KEY="MY_GEMINI_API_KEY"

# Build image và khởi động toàn bộ dịch vụ (PostgreSQL + SmartFace App)
docker compose up -d --build
```

#### 5. Kiểm tra trạng thái và log kết nối:
```bash
# Xem danh sách container và tình trạng healthcheck
docker compose ps

# Xem log kết nối cơ sở dữ liệu của ứng dụng
docker compose logs -f smartface-app
```
Khi ứng dụng khởi động thành công với PostgreSQL, bạn sẽ thấy log:
```text
[PostgreSQL] Đã kết nối cơ sở dữ liệu PostgreSQL thành công!
[PostgreSQL] Các bảng dữ liệu đã sẵn sàng trên PostgreSQL!
Server running on http://localhost:3000
```

#### 6. Thao tác sao lưu (Backup) và phục hồi (Restore) PostgreSQL:
```bash
# Sao lưu dữ liệu ra file SQL
docker compose exec -t postgres pg_dump -U smartface_user -d smartface_db > smartface_backup.sql

# Phục hồi dữ liệu từ file SQL
cat smartface_backup.sql | docker compose exec -T postgres psql -U smartface_user -d smartface_db
```

---

### Cách 3: Frontend Netlify + Backend Render

Repository đã kèm sẵn:
- `netlify.toml`
- `render.yaml`

#### Netlify
- Build command: `npm run build:client`
- Publish directory: `dist`
- Environment variable:
  - `VITE_API_BASE_URL=https://your-render-service.onrender.com`

#### Render
- Build command: `npm ci && npm run build`
- Start command: `npm run start`
- Root directory: thư mục gốc repository
- Environment variables:
  - `PORT` (Render tự cấp)
  - `DATA_DIR=/var/data/smartface`
  - `CORS_ALLOWED_ORIGINS=https://your-site.netlify.app`
  - `ETON_WEBHOOK_URL=https://chat-room.eton.vn/hooks/YOUR_WEBHOOK_TOKEN`
  - `FACE_RECOGNITION_PROVIDER=local`
  - `LOCAL_FACE_RECOGNITION_MODEL=local-exact-match`
  - `LOCAL_FACE_RECOGNITION_URL=http://127.0.0.1:8000/recognize` (nếu có dịch vụ local)
  - `GEMINI_API_KEY` và `GOOGLE_GEMINI_MODEL` nếu bật fallback Google

#### Persistent Disk trên Render
- Gắn persistent disk vào service
- mount path đề xuất: `/var/data`
- giữ `DATA_DIR=/var/data/smartface`

Khi tách Netlify/Render, frontend sẽ gọi backend qua `VITE_API_BASE_URL` thay vì dùng đường dẫn tương đối `/api/...`, và SSE cũng sẽ kết nối về Render backend.

---

### Cách 4: Cấu Hình Nginx Reverse Proxy & SSL (HTTPS)

Trình duyệt yêu cầu kết nối an toàn **HTTPS** để cho phép người dùng cấp quyền truy cập Camera/Webcam (`navigator.mediaDevices.getUserMedia`). Dưới đây là cấu hình Nginx tiêu chuẩn:

#### Bước 1: Cài đặt Nginx & Certbot
```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

#### Bước 2: Tạo cấu hình Virtual Host Nginx
Tạo file cấu hình: `/etc/nginx/sites-available/smartface.conf`:
```nginx
server {
    server_name smartface.yourcompany.com;

    # Cho phép tải ảnh khuôn mặt base64 dung lượng lớn
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Cấu hình WebSocket và Server-Sent Events (SSE)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # Tối ưu cho luồng SSE thông báo thời gian thực
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
```

Kích hoạt site và khởi động lại Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/smartface.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

#### Bước 3: Cấp chứng chỉ SSL miễn phí qua Let's Encrypt
```bash
sudo certbot --nginx -d smartface.yourcompany.com
```

---

## 💾 Sao Lưu và Phục Hồi Cơ Sở Dữ Liệu (PostgreSQL & SQLite)

### A. Đối với PostgreSQL (Triển khai Docker Compose)

#### 1. Sao lưu dữ liệu PostgreSQL (`pg_dump`):
```bash
# Tạo bản sao lưu toàn bộ cơ sở dữ liệu có gắn ngày giờ
docker compose exec -t postgres pg_dump -U smartface_user -d smartface_db > data/smartface_pg_$(date +%Y%m%d_%H%M%S).sql
```

#### 2. Phục hồi dữ liệu PostgreSQL (`psql`):
```bash
# Phục hồi dữ liệu từ bản sao lưu SQL
cat data/smartface_pg_YYYYMMDD_HHMMSS.sql | docker compose exec -T postgres psql -U smartface_user -d smartface_db
```

#### 3. Thiết lập Cronjob tự động sao lưu PostgreSQL mỗi ngày:
```bash
0 2 * * * cd /duong-dan/du-an && docker compose exec -t postgres pg_dump -U smartface_user -d smartface_db > data/backup_pg_$(date +\%Y\%m\%d).sql && find data/backup_pg_*.sql -mtime +30 -delete
```

---

### B. Đối với SQLite 3 (Triển khai File-based)

#### 1. Sao lưu tự động định kỳ (Hot Backup không gián đoạn dịch vụ):
```bash
sqlite3 data/smartface.db ".backup 'data/smartface_backup_$(date +%Y%m%d_%H%M%S).db'"
```

#### 2. Phục hồi dữ liệu SQLite:
```bash
# 1. Dừng ứng dụng
pm2 stop smartface-gateway # hoặc: docker compose stop smartface-app

# 2. Thay thế file cơ sở dữ liệu
cp data/smartface_backup_YYYYMMDD.db data/smartface.db

# 3. Khởi động lại ứng dụng
pm2 start smartface-gateway # hoặc: docker compose start smartface-app
```

---

## 🔗 Tích Hợp Webhook Eton Chat Room

Hệ thống hỗ trợ gửi thông báo điểm danh tự động vào kênh Chat Room của Eton:
* **Địa chỉ mặc định**: `https://chat-room.eton.vn/hooks/6aa4dfb6928518a18ba27a13/mguNArZoWHY7AegnWFw7d7TwyfnoT4JZWpmwvxtLmfi7iGuY`
* **Định dạng Payload chuẩn Eton**:
```json
{
  "text": "Nguyễn Hoàng Minh (NV-1082) - 16:30:00 12/09/2026",
  "attachments": [
    {
      "title": "[[CỔNG VÀO]]"
    }
  ]
}
```
* **Chế độ phát trực tiếp từ trình duyệt (Direct Browser Delivery)**: Bỏ qua hạn chế CORS để các máy quét đặt trong mạng VPN/Intranet nội bộ của Eton có thể phát lệnh thông suốt.

---

## 📡 Danh Mục API Endpoints & Nhận Diện Khuôn Mặt

Hệ thống cung cấp đầy đủ các cổng API RESTful để tích hợp cùng camera AI, đầu đọc khuôn mặt hoặc hệ thống kiểm soát cửa bên ngoài:

### 1. Cổng Nhận Diện Khuôn Mặt & Điều Khiển Khóa (`/api/recognize-face`)

Hỗ trợ các phương thức **POST**, **GET** và **OPTIONS** (bao gồm alias `/recognize-face`, `/api/face/recognize` và `/api/face-recognize`):

#### A. Gửi ảnh nhận diện và tự động mở cửa (POST)

**Endpoint:** `POST /api/recognize-face`  
**Headers:** `Content-Type: application/json`

**Body mẫu (Gửi ảnh camera thực tế):**
```json
{
  "imageBase64": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
  "scanType": "ENTRY"
}
```
* `imageBase64`: Chuỗi ảnh Base64 (hỗ trợ cả Data URL hoặc chuỗi raw base64, tối đa 50MB).
* `scanType`: `"ENTRY"` (Cổng Vào) hoặc `"EXIT"` (Cổng Ra).

**Body mẫu (Kiểm thử nhanh không cần ảnh):**
```json
{
  "testEmployeeId": "NV-1082",
  "scanType": "ENTRY"
}
```
*(Hỗ trợ `testEmployeeId`: Mã nhân viên `NV-1082`, ID, hoặc `"MULTI_EMPLOYEES"` để mô phỏng nhận diện đồng thời nhiều người).*

**Response mẫu (Thành công - Mở khóa tự động):**
```json
{
  "recognized": true,
  "employee": {
    "id": "EMP-001",
    "name": "Nguyễn Hoàng Minh",
    "employeeCode": "NV-1082",
    "department": "Phòng Kỹ Thuật AI",
    "position": "Trưởng nhóm AI"
  },
  "detectedFaces": [
    {
      "box2d": [170, 270, 730, 730],
      "employeeName": "Nguyễn Hoàng Minh",
      "confidence": 98,
      "livenessScore": 99,
      "recognized": true
    }
  ],
  "totalFacesDetected": 1,
  "lockUnlocked": true,
  "message": "Xác thực thành công nhân viên Nguyễn Hoàng Minh. Mở khóa cửa!"
}
```

#### B. Kiểm tra trạng thái cổng API & Cấu hình (GET)

Khi truy cập từ trình duyệt hoặc kiểm tra Health Check:

**Request:** `GET /api/recognize-face`

**Response mẫu:**
```json
{
  "success": true,
  "status": "online",
  "endpoint": "/api/recognize-face",
  "supportedMethods": ["POST", "GET", "OPTIONS"],
  "message": "Endpoint nhận diện khuôn mặt sẵn sàng tiếp nhận yêu cầu POST.",
  "systemInfo": {
    "registeredEmployeesCount": 4,
    "smartLockDoor": "Cửa Chính Trụ Sở - Cổng A",
    "lockState": "UNLOCKED",
    "isLocked": false,
    "batteryLevel": 96
  }
}
```

---

## 👥 Danh Sách REST API Nhân Viên & Hệ Thống

Hệ thống hỗ trợ đầy đủ các endpoint RESTful với cơ chế route aliases linh hoạt (chấp nhận cả có tiền tố `/api/` hoặc gọi trực tiếp):

### 1. Lấy danh sách nhân viên (`GET /api/employees`)
* **Endpoint:** `GET /api/employees` (Aliases: `/api/employees/`, `/employees`, `/employees/`, `/api/employee`)
* **Mô tả:** Trả về danh sách tất cả nhân viên đã đăng ký khuôn mặt trong cơ sở dữ liệu SQLite.
* **Curl kiểm tra:**
  ```bash
  curl -X GET http://localhost:3000/api/employees
  ```
* **Response mẫu:**
  ```json
  [
    {
      "id": "EMP-001",
      "name": "Nguyễn Hoàng Minh",
      "employeeCode": "NV-1082",
      "department": "Phòng Kỹ Thuật AI",
      "position": "Trưởng nhóm AI",
      "photoUrl": "https://...",
      "registeredAt": "2026-09-01T08:30:00.000Z",
      "accessLevel": "ALL_ACCESS"
    }
  ]
  ```

### 2. Thêm nhân viên mới (`POST /api/employees`)
* **Endpoint:** `POST /api/employees` (Aliases: `/employees`)
* **Content-Type:** `application/json`
* **Body:**
  ```json
  {
    "name": "Trần Văn An",
    "employeeCode": "NV-5501",
    "department": "Phòng Công Nghệ Thông Tin",
    "position": "Kỹ sư Phần mềm",
    "photoUrl": "data:image/jpeg;base64,...",
    "accessLevel": "ALL_ACCESS"
  }
  ```

### 3. Xóa nhân viên (`DELETE /api/employees/:id`)
* **Endpoint:** `DELETE /api/employees/:id` (Aliases: `/employees/:id`)

### 4. Lấy lịch sử vào ra (`GET /api/logs`)
* **Endpoint:** `GET /api/logs` (Aliases: `/logs`, `/api/access-logs`)

### 5. Kiểm tra trạng thái khóa thông minh (`GET /api/lock/status`)
* **Endpoint:** `GET /api/lock/status` (Aliases: `/lock/status`, `/api/status`, `/status`)

### 6. Lấy thông báo di động (`GET /api/notifications`)
* **Endpoint:** `GET /api/notifications` (Aliases: `/notifications`)

### 7. Luồng sự kiện thời gian thực (`GET /api/events`)
* **Endpoint:** `GET /api/events` (Aliases: `/events`, `/api/stream`, `/stream`)
* **Giao thức:** Server-Sent Events (SSE) đẩy dữ liệu tự động khi có sự kiện mở cửa, chấm công, chuông báo.


---

## 🔍 API Kiểm Tra Trạng Thái Database

Bạn có thể kiểm tra loại database engine, kích thước file và số lượng bản ghi bất kỳ lúc nào qua endpoint:

**Request:**
```http
GET /api/system/db-info HTTP/1.1
Host: localhost:3000
```

**Response mẫu (Chế độ PostgreSQL qua Docker Compose):**
```json
{
  "success": true,
  "storage": {
    "engine": "PostgreSQL (Docker/External) + SQLite 3 (Node.js native DatabaseSync)",
    "postgresConnected": true,
    "sqlitePath": "/app/data/smartface.db",
    "sizeBytes": 57344,
    "sizeFormatted": "56.00 KB"
  },
  "counts": {
    "employees": 3,
    "accessLogs": 24,
    "notifications": 12,
    "webhookLogs": 8
  }
}
```

---

## 🛡️ Bản Quyền & Giấy Phép
Dự án được xây dựng và tối ưu cho môi trường doanh nghiệp. Toàn bộ mã nguồn mở và dễ dàng mở rộng theo các chuẩn kết nối phần cứng khóa thông minh và camera IP RTSP.
