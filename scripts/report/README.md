# Báo cáo độ chính xác theo tuần (`weekly-accuracy.ts`)

Tổng hợp `access_logs` + `stranger_resolutions` thành một file Markdown tiếng Việt
(Taiga #505). Chỉ in số liệu tổng hợp: không id, không tên, không ảnh, không embedding.

```bash
npx tsx scripts/report/weekly-accuracy.ts \
  --from 2026-10-27 --to 2026-11-02 \
  --compare-from 2026-10-13 --compare-to 2026-10-26 \
  --out docs/reports/2026-11-02.md
```

- `--from/--to`, `--compare-from/--compare-to`: ngày **địa phương** (Asia/Ho_Chi_Minh, UTC+7), tính cả hai đầu.
- Không có `--out` thì in ra stdout.
- Kết nối CSDL (chỉ đọc, `SET default_transaction_read_only = on`): `DATABASE_URL`, hoặc bộ biến `PG*`
  của libpq, hoặc `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` (+ `POSTGRES_HOST`, mặc định `postgres`).

## Chỉ số

Theo từng cổng (`gateId` entry/exit) và theo kỳ, kèm kỳ so sánh nếu có:

| Chỉ số | Cách tính |
|---|---|
| Lượt / ngày | số quyết định ÷ số ngày lịch trong kỳ |
| Từ chối % | DENIED ÷ tổng quyết định |
| 'mơ hồ' | reason chứa `mơ hồ`; in % theo lượt và % theo số từ chối |
| Sát ngưỡng | cosine trong reason (`cosine tốt nhất 0.512` hay `(cosine 0.508)`) ∈ [0.50, 0.55) |
| Độ trễ mở cửa | `timestamp − capturedAt` của lượt GRANTED, chỉ giữ 0–120 s; trung vị và p90 (nearest-rank) |
| Khung giờ cao điểm | 07:30–08:30 vào, 11:30–12:20 ra, 12:30–13:30 vào, 16:45–17:45 ra; **chỉ T2–T6**; "lượt / ngày" chia cho số ngày làm việc |
| Đã xem lại trong Cụm Người Lạ | lượt DENIED trong kỳ có id xuất hiện trong `stranger_resolutions.logIds` (bất kể thời điểm xử lý) |
| Lượt gộp (MERGE) | resolution `MERGE` có `resolvedAt` trong kỳ, quy đổi ra /tuần |

Bảng theo ngày: mỗi ngày địa phương một dòng cho từng cổng.

## Chạy trong Docker (host không có `node_modules`)

Ảnh `tester` đã chứa `scripts/`; gắn `docs/reports` để nhận file và cấp biến kết nối qua
`--env-file` của compose (không in thông tin đăng nhập ra màn hình):

```bash
docker build -q --target tester -t smartface-tests:wk .
docker run --rm --network smartface-network --env-file .env \
  -v "$PWD/docs/reports:/app/docs/reports" --entrypoint npx smartface-tests:wk \
  tsx scripts/report/weekly-accuracy.ts --from ... --to ... --out docs/reports/<to>.md
```

## Kiểm thử

Các hàm tổng hợp/định dạng nằm trong `weeklyReportHelpers.ts` (không I/O) và được kiểm bởi
`tests/weeklyReport.test.ts` trên dữ liệu tổng hợp giả lập.
