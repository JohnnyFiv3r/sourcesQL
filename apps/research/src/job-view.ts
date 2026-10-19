import { z } from "zod";
import { usageNoticeSchema, usageNotices } from "./usage.js";

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
    services: z
      .array(
        z.enum(["motherduck", "exa", "brave", "serper", "deepseek", "openai"]),
      )
      .max(6)
      .refine((values) => new Set(values).size === values.length)
      .optional(),
    resets_at: z.iso.datetime().optional(),
    limit: z.number().int().nonnegative().optional(),
    used: z.number().int().nonnegative().optional(),
    unit: z.enum(["seconds", "microusd"]).optional(),
    limit_kind: z.enum(["credits", "rate", "spend", "unknown"]).optional(),
    http_status: z.union([z.literal(402), z.literal(429)]).optional(),
    retry_after_seconds: z.number().int().nonnegative().max(604800).optional(),
  })
  .strict();
export type ResearchCapacity = z.infer<typeof capacitySchema>;

export const researchJobViewSchema = z
  .object({
    kind: z.literal("research_job_status"),
    usageNotices: z.array(usageNoticeSchema).max(8).optional(),
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

const jobPresentationV1Schema = z
  .object({
    job_id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    capacity: capacitySchema.optional(),
    usageNotices: z.array(usageNoticeSchema).max(8).optional(),
  })
  .strict();

/** Restore optional presentation metadata without breaking published job cards. */
export function decodeResearchJobView(
  structured: unknown,
  meta?: unknown,
): ResearchJobView {
  const base = researchJobViewSchema.parse(structured);
  const envelope = z.record(z.string(), z.unknown()).safeParse(meta);
  const presentation = jobPresentationV1Schema.safeParse(
    envelope.success ? envelope.data.sourcesqlJobPresentationV1 : undefined,
  );
  if (!presentation.success || presentation.data.job_id !== base.job.job_id)
    return base;
  const { capacity, usageNotices } = presentation.data;
  return {
    ...base,
    ...(usageNotices === undefined ? {} : { usageNotices }),
    job: {
      ...base.job,
      ...(capacity === undefined ? {} : { capacity }),
    },
  };
}

/** Reduce trusted backend receipts to the bounded app view; no query or credential text crosses here. */
export function researchJobView(rawReceipt: unknown): ResearchJobView {
  const receipt = z.record(z.string(), z.unknown()).parse(rawReceipt);
  const status = receipt.status;
  const providerCapacity = capacitySchema.safeParse(
    receipt.provider_capacity_v1,
  );
  const capacity = providerCapacity.success
    ? providerCapacity.data
    : receipt.capacity === undefined
      ? undefined
      : capacitySchema.parse(receipt.capacity);
  const pending =
    !["completed", "failed", "cancelled"].includes(String(status)) ||
    (status === "cancelled" && receipt.pending === true);
  return researchJobViewSchema.parse({
    kind: "research_job_status",
    ...(receipt.usageNotices === undefined
      ? {}
      : { usageNotices: usageNotices(receipt.usageNotices) }),
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
