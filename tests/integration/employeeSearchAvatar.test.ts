/** Merge picker avatars (2026-10-07): the employee search says whether a photo exists, never sends it. */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { api, createTempEmployee, deleteEmployee } from "./helpers";

const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("employee search for the merge picker", () => {
  const ids: string[] = [];
  after(async () => { for (const id of ids) await deleteEmployee(id); });

  it("reports hasPhoto and never carries the photo; the avatar loads from the photo route", async () => {
    const tag = `Avatar${Date.now()}`;
    const withPhoto = await createTempEmployee({ name: `${tag} Có Ảnh`, photoUrl: png1x1 } as any);
    const remote = await createTempEmployee({ name: `${tag} Ảnh Ngoài`, photoUrl: "https://example.com/p.jpg" } as any);
    ids.push(withPhoto.id, remote.id);
    const res = await api<any>(`/api/strangers/search-employees?q=${encodeURIComponent(tag)}`);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.doesNotMatch(res.text, /photoUrl|data:image|example\.com/);
    const byId = new Map(res.body.employees.map((e: any) => [e.id, e]));
    assert.equal((byId.get(withPhoto.id) as any)?.hasPhoto, true);
    assert.equal((byId.get(remote.id) as any)?.hasPhoto, false, "a remote URL is never fetched, so no avatar");
    const photo = await api(`/api/employees/${encodeURIComponent(withPhoto.id)}/photo`);
    assert.equal(photo.status, 200);
  });
});
