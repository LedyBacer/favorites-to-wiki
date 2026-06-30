import { createHash } from "node:crypto";

export function hashMessageVersion(text: string | undefined, metadata: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify({ text: text ?? null, metadata }))
    .digest("hex");
}
