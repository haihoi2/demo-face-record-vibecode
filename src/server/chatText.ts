/**
 * Chat webhook body as plain text.
 *
 * The chat room renders an attachment as a quoted card whose text cannot be
 * selected or copied on the phone client (owner request, 2026-11-25). Every
 * outgoing chat message is therefore flattened to one `text` field:
 *
 *   <attachment titles> <first line of text>
 *   <attachment text lines>
 *   <remaining lines of text, e.g. the markdown link>
 *
 * Builders keep producing the structured `{ text, attachments }` shape; the
 * three send sites in server.ts flatten it right before logging and posting,
 * so the webhook log records exactly what was sent. Pure: no I/O.
 */

export interface ChatAttachment {
  title?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

export interface StructuredChatMessage {
  text: string;
  attachments?: ChatAttachment[];
}

/** The body that is posted to the chat webhook: text only, never attachments. */
export interface ChatTextPayload {
  text: string;
}

export function chatTextPayload(message: StructuredChatMessage): ChatTextPayload {
  const lines = String(message?.text ?? "").split("\n");
  const titles: string[] = [];
  const details: string[] = [];
  for (const a of Array.isArray(message?.attachments) ? message.attachments : []) {
    if (!a || typeof a !== "object") continue;
    if (typeof a.title === "string" && a.title.trim()) titles.push(a.title.trim());
    if (typeof a.text === "string") details.push(...a.text.split("\n"));
  }
  const head = [...titles, lines[0].trim()].filter(Boolean).join(" ");
  const text = [head, ...details, ...lines.slice(1)]
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
    .join("\n");
  return { text };
}
