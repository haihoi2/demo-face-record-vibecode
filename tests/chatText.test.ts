/**
 * Chat webhook body is text only (owner request 2026-11-25: an attachment
 * renders as a card that cannot be copied in the phone chat client).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chatTextPayload } from "../src/server/chatText";
import { presenceAlertPayload, presenceHealthPayload } from "../src/server/presence/alerts";

describe("chatTextPayload", () => {
  it("recognised employee: the gate title leads the same line, nothing else is sent", () => {
    const p = chatTextPayload({ text: "Hai Vo (NV-4457) - 13:12:09 25/11/2026", attachments: [{ title: "[[CỔNG RA]]" }] });
    assert.deepEqual(p, { text: "[[CỔNG RA]] Hai Vo (NV-4457) - 13:12:09 25/11/2026" });
  });

  it("stranger alert: title + alert line, details, then the link", () => {
    const p = chatTextPayload({
      text: "🚨 Phát hiện người lạ tại Cửa Chính - 13:12:50 25/11/2026\n[Xem cụm ảnh người lạ](https://gw.example/#strangers/LOG-1)",
      attachments: [
        {
          title: "[[CẢNH BÁO NGƯỜI LẠ]]",
          title_link: "https://gw.example/#strangers/LOG-1",
          text: "Số khuôn mặt không xác định: 2\nMã nhật ký: LOG-1\nCửa giữ trạng thái KHÓA. Không có quyền ra vào nào được cấp.",
        },
      ],
    });
    assert.deepEqual(Object.keys(p), ["text"]);
    assert.deepEqual(p.text.split("\n"), [
      "[[CẢNH BÁO NGƯỜI LẠ]] 🚨 Phát hiện người lạ tại Cửa Chính - 13:12:50 25/11/2026",
      "Số khuôn mặt không xác định: 2",
      "Mã nhật ký: LOG-1",
      "Cửa giữ trạng thái KHÓA. Không có quyền ra vào nào được cấp.",
      "[Xem cụm ảnh người lạ](https://gw.example/#strangers/LOG-1)",
    ]);
  });

  it("presence messages keep every line of the former attachment", () => {
    const batch = {
      gateId: "entry",
      events: [{ id: "PE-1", gateId: "entry", startedAt: "2026-10-04T23:20:15Z", inViewMs: 4200, peakPersons: 1 } as any],
    };
    const p = chatTextPayload(presenceAlertPayload(batch as any, "Cổng vào", "https://gw.example/#presence"));
    assert.deepEqual(Object.keys(p), ["text"]);
    assert.match(p.text, /^Cảnh báo hiện diện \(không thấy khuôn mặt\) 🚶 Có người ngoài giờ tại Cổng vào/);
    assert.match(p.text, /Mã sự kiện: PE-1/);
    assert.match(p.text, /không thay đổi trạng thái cửa/);
    assert.match(p.text, /\n\[Mở bảng Hiện diện\]\(https:\/\/gw\.example\/#presence\)$/);

    const h = chatTextPayload(presenceHealthPayload("offline", "Cổng vào", "2026-10-04T23:20:15Z", ""));
    assert.match(h.text, /^Tình trạng phát hiện người ⚠️ /);
    assert.match(h.text, /\nKiểm tra luồng camera/);
  });

  it("tolerates no attachments, blank titles and blank lines; never emits attachments", () => {
    assert.deepEqual(chatTextPayload({ text: "a\n\nb" }), { text: "a\nb" });
    assert.deepEqual(chatTextPayload({ text: "a", attachments: [{ title: "  " }, null as any, { text: "c\n" }] }), { text: "a\nc" });
    assert.deepEqual(chatTextPayload({ text: "", attachments: [{ title: "T" }] }), { text: "T" });
  });
});

describe("server.ts posts text-only chat bodies", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "server.ts"), "utf8");

  it("no send site builds an attachments array for the wire any more", () => {
    // The only `attachments` left are the structured inputs handed to chatTextPayload
    // and the optional field on old log records.
    const wire = source.match(/body: JSON\.stringify\(payload\)/g) || [];
    assert.equal(wire.length, 3, "expected the three chat send sites (employee, stranger, channel)");
    const flattened = source.match(/const payload = chatTextPayload\(/g) || [];
    assert.equal(flattened.length, 3, "every chat send site must flatten its message with chatTextPayload");
  });
});
