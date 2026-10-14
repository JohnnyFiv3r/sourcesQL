import { timingSafeEqual } from "node:crypto";
import type { Snapshot } from "../src/schema.js";
import { isPrivateSnapshot } from "../src/schema.js";
export type AccessPolicy = {
  mode: "fixture-anonymous" | "protected";
  principal: string;
  allowPrivateDisclosure: boolean;
};
export function bearerMatches(
  header: string | undefined,
  token: string,
): boolean {
  const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(value),
    b = Buffer.from(token);
  return !!token && a.length === b.length && timingSafeEqual(a, b);
}
export function authorizeSnapshot(snapshot: Snapshot, policy?: AccessPolicy) {
  if (!policy) return;
  if (isPrivateSnapshot(snapshot) && !policy.allowPrivateDisclosure)
    throw new Error(
      "Private host disclosure is not authorized by this server policy.",
    );
  if (policy.mode === "fixture-anonymous") {
    const synthetic =
      snapshot.dataClassification === "synthetic_fixture" ||
      (!snapshot.schemaVersion &&
        snapshot.rows.every(
          (r) =>
            r.sourceUrl?.startsWith("https://example.com/") &&
            r.verificationNote.toLowerCase().includes("synthetic"),
        ));
    if (!synthetic)
      throw new Error(
        "Anonymous fixture mode accepts synthetic fixture data only. Configure protected mode for other data.",
      );
  }
}
