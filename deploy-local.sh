#!/usr/bin/env bash
# =============================================================================
# Automated Local Deployment Script for AI SmartFace & SmartLock Gateway
# =============================================================================
set -e

# Color definitions
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}=====================================================================${NC}"
echo -e "${BLUE}  AI Smart Face & SmartLock Gateway - Local Machine Deployment      ${NC}"
echo -e "${BLUE}=====================================================================${NC}"

# 1. Verify Docker is installed
if ! command -v docker &> /dev/null; then
  echo -e "${RED}[ERROR] Docker chưa được cài đặt trên máy tính của bạn.${NC}"
  echo -e "Vui lòng cài đặt Docker Desktop hoặc Docker Engine trước khi tiếp tục: https://docs.docker.com/get-docker/"
  exit 1
fi

# 2. Verify Docker Compose is available
if ! docker compose version &> /dev/null; then
  echo -e "${RED}[ERROR] Docker Compose plugin chưa được cài đặt.${NC}"
  exit 1
fi

echo -e "${GREEN}✓ Đã phát hiện Docker & Docker Compose: $(docker compose version --short)${NC}"

# 3. Create persistent data directory if it doesn't exist
if [ ! -d "./data" ]; then
  echo -e "${YELLOW}➜ Tạo thư mục lưu trữ dữ liệu bền vững ./data...${NC}"
  mkdir -p ./data
fi

# 4. Check for .env file
if [ ! -f ".env" ]; then
  echo -e "${YELLOW}➜ Chưa có file .env, sao chép từ .env.example...${NC}"
  cp .env.example .env
  # The container runs as a non-root user; ./data is bind-mounted, so the
  # in-container uid/gid must match the host owner of ./data (build args).
  sed -i "s/^APP_UID=.*/APP_UID=$(id -u)/; s/^APP_GID=.*/APP_GID=$(id -g)/" .env
  echo -e "${GREEN}✓ Đã tạo file .env thành công (APP_UID=$(id -u), APP_GID=$(id -g) khớp với user hiện tại).${NC}"
else
  echo -e "${GREEN}✓ Sử dụng cấu hình từ file .env hiện có.${NC}"
fi

# 4b. Warn when the in-container uid/gid will not match the owner of ./data
ENV_UID=$(grep -E '^APP_UID=' .env | tail -1 | cut -d= -f2 | tr -d '"' )
ENV_GID=$(grep -E '^APP_GID=' .env | tail -1 | cut -d= -f2 | tr -d '"' )
DATA_UID=$(stat -c %u ./data 2>/dev/null || echo "?")
DATA_GID=$(stat -c %g ./data 2>/dev/null || echo "?")
if [ "${ENV_UID:-1000}" != "$DATA_UID" ] || [ "${ENV_GID:-1000}" != "$DATA_GID" ]; then
  echo -e "${YELLOW}[CẢNH BÁO] ./data thuộc uid:gid ${DATA_UID}:${DATA_GID} nhưng .env đặt APP_UID=${ENV_UID:-1000} APP_GID=${ENV_GID:-1000}.${NC}"
  echo -e "${YELLOW}           SQLite trong container sẽ báo 'attempt to write a readonly database'. Sửa APP_UID/APP_GID trong .env rồi chạy lại.${NC}"
fi

# 5. Build and launch Docker Compose services
echo -e "\n${BLUE}➜ Đang kiểm tra cổng cơ sở dữ liệu và cấu hình PostgreSQL 18...${NC}"

# Check if port 5432 is already bound by a local PostgreSQL service on host
HOST_PG_RUNNING=false
if command -v nc &> /dev/null && nc -z 127.0.0.1 5432 2>/dev/null; then
  HOST_PG_RUNNING=true
elif command -v lsof &> /dev/null && lsof -i :5432 &> /dev/null; then
  HOST_PG_RUNNING=true
fi

if [ "$HOST_PG_RUNNING" = true ]; then
  echo -e "${YELLOW}ℹ Phát hiện cổng 5432 đang được sử dụng bởi PostgreSQL 18 cài sẵn trên máy chủ (Host).${NC}"
  echo -e "${YELLOW}➜ Khởi động container SmartFace App kết nối tới PostgreSQL 18 của máy Host (host.docker.internal)...${NC}"
  docker compose up -d --build smartface-app
else
  echo -e "${GREEN}✓ Khởi động toàn bộ cụm dịch vụ với PostgreSQL 18 container qua Docker Compose...${NC}"
  docker compose up -d --build
fi

# Published host port (APP_PORT in .env; compose default 8080). The container itself listens on 3000.
APP_PORT_VALUE=$(grep -E '^APP_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"')
APP_PORT_VALUE=${APP_PORT_VALUE:-8080}
# 6. Wait for service to become healthy
echo -e "\n${YELLOW}➜ Đang kiểm tra trạng thái khởi động của SmartFace Gateway (tối đa 40s)...${NC}"
ATTEMPTS=0
MAX_ATTEMPTS=20
HEALTHY=false

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  sleep 2
  ATTEMPTS=$((ATTEMPTS+1))
  
  if curl -s -f http://localhost:${APP_PORT_VALUE}/api/health > /dev/null 2>&1; then
    HEALTHY=true
    break
  fi
  echo -n "."
done

echo ""
if [ "$HEALTHY" = true ]; then
  echo -e "${GREEN}=====================================================================${NC}"
  echo -e "${GREEN}  ✓ TRIỂN KHAI THÀNH CÔNG TRÊN MÁY CỤC BỘ (LOCAL MACHINE)!            ${NC}"
  echo -e "${GREEN}=====================================================================${NC}"
  echo -e "Truy cập ứng dụng tại các địa chỉ sau:"
  echo -e "  🌐 Giao Diện Điều Khiển (Web App) : ${BLUE}http://localhost:${APP_PORT_VALUE}${NC}"
  echo -e "  📹 Cấu Hình Camera Stream RTSP/UVC: ${BLUE}http://localhost:${APP_PORT_VALUE}/#camera-streams${NC}"
  echo -e "  🏥 Kiểm Tra API Health           : ${BLUE}http://localhost:${APP_PORT_VALUE}/api/health${NC}"
  echo -e "  🗄️ Trạng Thái Cơ Sở Dữ Liệu       : ${BLUE}http://localhost:${APP_PORT_VALUE}/api/database/status${NC}"
  echo -e ""
  echo -e "Các lệnh quản lý thường dùng:"
  echo -e "  - Xem log thời gian thực : ${YELLOW}docker compose logs -f smartface-app${NC}"
  echo -e "  - Tạm dừng dịch vụ        : ${YELLOW}docker compose stop${NC}"
  echo -e "  - Tắt hoàn toàn dịch vụ   : ${YELLOW}docker compose down${NC}"
  echo -e "  - Khởi động lại dịch vụ   : ${YELLOW}docker compose restart smartface-app${NC}"
else
  echo -e "${YELLOW}[CẢNH BÁO] Container đã khởi động nhưng chưa phản hồi endpoint /api/health.${NC}"
  echo -e "Bạn có thể kiểm tra log container bằng lệnh:"
  echo -e "  ${BLUE}docker compose logs smartface-app${NC}"
fi
