import { z } from "zod";

const fieldKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (value) => !["constructor", "prototype", "__proto__"].includes(value),
  );
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const answerIntentSchema = z
  .object({
    question: z.string().min(1).max(2000).optional(),
    row_unit: z.string().min(1).max(200),
    fields: z
      .array(
        z
          .object({ key: fieldKey, meaning: z.string().min(1).max(500) })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .refine(
    (intent) =>
      new Set(intent.fields.map((f) => f.key)).size === intent.fields.length,
  )
  .refine(
    (intent) =>
      new TextEncoder().encode(JSON.stringify(intent)).length <= 24576,
  );

export const queryFeedbackSchema = z
  .object({
    schema_version: z.literal(1),
    advisory: z.literal(true),
    query_sha256: hash,
    parameters_sha256: hash,
    input_pins_sha256: hash,
    description_status: z.enum(["available", "unavailable"]),
    description: z
      .object({
        summary: z.string().max(2400),
        steps: z
          .array(
            z
              .object({
                scope: z.string().max(160),
                kind: z.string().max(64),
                text: z.string().max(1200),
                sql: z.string().max(2000).optional(),
              })
              .strict(),
          )
          .max(48),
        omitted_steps: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    intent_status: z.enum(["provided", "not_provided", "invalid"]),
    answer_intent: answerIntentSchema.optional(),
    output_columns: z.array(fieldKey).max(128),
    missing_intended_fields: z.array(fieldKey).max(32),
    result_observations: z
      .object({
        row_count: z.number().int().nonnegative(),
        null_cells: z
          .array(
            z
              .object({ key: fieldKey, count: z.number().int().nonnegative() })
              .strict(),
          )
          .max(128),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const invalid = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (
      (value.description_status === "available") !==
      Boolean(value.description)
    )
      invalid("Description status must match retained details");
    if ((value.intent_status === "provided") !== Boolean(value.answer_intent))
      invalid("Intent status must match retained intent");
    const outputs = new Set(value.output_columns);
    if (outputs.size !== value.output_columns.length)
      invalid("Output columns must be unique");
    const missing = (value.answer_intent?.fields ?? [])
      .map((field) => field.key)
      .filter((field) => !outputs.has(field));
    if (
      JSON.stringify(missing) !== JSON.stringify(value.missing_intended_fields)
    )
      invalid("Missing-field observations must match the declared intent");
    const observations = value.result_observations;
    if (
      observations &&
      (new Set(observations.null_cells.map((field) => field.key)).size !==
        observations.null_cells.length ||
        observations.null_cells.some(
          (field) =>
            !outputs.has(field.key) || field.count > observations.row_count,
        ))
    )
      invalid("Cell counts must reference returned columns and rows");
    if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
      invalid("Feedback exceeds its bounded metadata allowance");
  });

export type QueryFeedback = z.infer<typeof queryFeedbackSchema>;
