import { z } from "zod";

/** Reference allowances describe sourcesQL activity, never the account's remaining balance. */
export const usageNoticeSchema = z
  .object({
    id: z.string().min(1).max(160),
    service: z.enum(["exa", "motherduck"]),
    period: z.enum(["day", "month"]),
    period_start: z.iso.datetime(),
    period_end: z.iso.datetime(),
    used: z.number().int().nonnegative(),
    allowance: z.number().int().nonnegative(),
    unit: z.enum(["microusd", "seconds"]),
    basis: z.literal("estimated"),
    scope: z.literal("sourcesql"),
    blocking: z.literal(false),
  })
  .strict();
export type UsageNotice = z.infer<typeof usageNoticeSchema>;

export function usageNotices(value: unknown): UsageNotice[] {
  const parsed = z.array(usageNoticeSchema).max(8).safeParse(value);
  return parsed.success ? parsed.data : [];
}
