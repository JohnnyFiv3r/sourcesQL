import { z } from "zod";

/** Capacity labels describe the measured authority, never an inferred vendor entitlement. */
export const capacitySchema = z
  .object({
    resource: z.enum([
      "flight_compute",
      "search_model_budget",
      "hosted_capacity",
    ]),
    reason: z.enum([
      "operator_limit",
      "provider_limit",
      "account_configuration",
    ]),
    period: z.enum(["day", "month", "unknown"]),
    allowance: z.enum(["configured", "included", "unknown"]),
    resets_at: z.iso.datetime().optional(),
    limit: z.number().int().nonnegative().optional(),
    used: z.number().int().nonnegative().optional(),
    unit: z.enum(["seconds", "microusd"]).optional(),
  })
  .strict();
export type ResearchCapacity = z.infer<typeof capacitySchema>;

export const researchJobViewSchema = z
  .object({
    kind: z.literal("research_job_status"),
    job: z
      .object({
        job_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
        request_id: z.uuid(),
        status: z.enum([
          "queued",
          "dispatching",
          "running",
          "submission_unknown",
          "completed",
          "failed",
          "cancelled",
        ]),
        pending: z.boolean(),
        result_id: z
          .string()
          .regex(/^[A-Za-z0-9_-]{1,100}$/)
          .optional(),
        capacity: capacitySchema.optional(),
        can_resume: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type ResearchJobView = z.infer<typeof researchJobViewSchema>;

/** Reduce trusted backend receipts to the bounded app view; no query or credential text crosses here. */
export function researchJobView(rawReceipt: unknown): ResearchJobView {
  const receipt = z.record(z.string(), z.unknown()).parse(rawReceipt);
  const status = receipt.status;
  const capacity =
    receipt.capacity === undefined
      ? undefined
      : capacitySchema.parse(receipt.capacity);
  const pending =
    !["completed", "failed", "cancelled"].includes(String(status)) ||
    (status === "cancelled" && receipt.pending === true);
  return researchJobViewSchema.parse({
    kind: "research_job_status",
    job: {
      job_id: receipt.job_id,
      request_id: receipt.request_id,
      status,
      pending,
      ...(status === "completed" ? { result_id: receipt.result_id } : {}),
      ...(capacity ? { capacity } : {}),
      can_resume:
        status === "queued" && receipt.can_resume === true && !capacity,
    },
  });
}
