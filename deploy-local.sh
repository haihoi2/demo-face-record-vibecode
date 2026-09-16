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
  echo -e "${GREEN}✓ Đã tạo file .env thành công.${NC}"
else
  echo -e "${GREEN}✓ Sử dụng cấu hình từ file .env hiện có.${NC}"
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

# 6. Wait for service to become healthy
echo -e "\n${YELLOW}➜ Đang kiểm tra trạng thái khởi động của SmartFace Gateway (tối đa 40s)...${NC}"
ATTEMPTS=0
MAX_ATTEMPTS=20
HEALTHY=false

while [ $ATTEMPTS -lt $MAX_ATTEMPTS ]; do
  sleep 2
  ATTEMPTS=$((ATTEMPTS+1))
  
  if curl -s -f http://localhost:3000/api/health > /dev/null 2>&1; then
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
  echo -e "  🌐 Giao Diện Điều Khiển (Web App) : ${BLUE}http://localhost:3000${NC}"
  echo -e "  📹 Cấu Hình Camera Stream RTSP/UVC: ${BLUE}http://localhost:3000/#camera-streams${NC}"
  echo -e "  🏥 Kiểm Tra API Health           : ${BLUE}http://localhost:3000/api/health${NC}"
  echo -e "  🗄️ Trạng Thái Cơ Sở Dữ Liệu       : ${BLUE}http://localhost:3000/api/database/status${NC}"
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
