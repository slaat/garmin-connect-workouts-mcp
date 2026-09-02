import { z } from "zod";

/**
 * The workout model this server accepts.
 *
 * Everything is explicitly typed and unit-tagged. Free-text parsing ("10 min",
 * "Zone 3", "4:30/km") is deliberately not supported here - that shape of
 * input is how three separate silent-failure bugs got in: a pace target that
 * parsed and was then discarded, a BPM target with no values, and "10 min"
 * matching a distance pattern and becoming a 10 metre step. None of those are
 * representable in this schema.
 *
 * These are zod schemas rather than plain TypeScript types because the MCP
 * tool definitions need runtime validation *and* the descriptive text below
 * is what the calling LLM reads to construct valid steps. The exported type
 * aliases (`Duration`, `Target`, `Step`, `WorkoutData`, `Intensity`) are
 * derived with `z.infer` so the rest of the codebase (encoders, tests) still
 * imports plain TypeScript types.
 */

export const sportSchema = z.enum(["running", "cycling", "swimming"]);
export type Sport = z.infer<typeof sportSchema>;

export const intensitySchema = z.enum(["warmup", "active", "rest", "cooldown"]);
export type Intensity = z.infer<typeof intensitySchema>;

export const durationSchema = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("time"),
      value: z.number().describe("e.g. 10"),
      unit: z.enum(["sec", "min", "hour"]),
    }),
    z.object({
      type: z.literal("distance"),
      value: z.number().describe("e.g. 1.5"),
      unit: z.enum(["m", "km", "mi"]),
    }),
    z.object({
      type: z.literal("lapButton"),
    }),
    z.object({
      type: z.literal("calories"),
      value: z.number(),
    }),
    z
      .object({
        type: z.literal("heartRate"),
        bpm: z.number(),
        compare: z
          .enum(["lt", "gt"])
          .describe("End when HR is below (lt) or above (gt) bpm."),
      })
      .describe("End when heart rate crosses a threshold, e.g. warm up until HR > 130."),
  ])
  .describe("How the step ends.");
export type Duration = z.infer<typeof durationSchema>;

export const targetSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }),
    z
      .object({
        type: z.literal("hrZone"),
        zone: z.number().int().min(1).max(5),
      })
      .describe("Zone 1 recovery, 2 aerobic/base, 3 tempo, 4 threshold, 5 VO2max."),
    z
      .object({
        type: z.literal("hrBpm"),
        low: z.number(),
        high: z.number(),
      })
      .describe("Explicit heart rate range in bpm."),
    z
      .object({
        type: z.literal("pace"),
        fast: z.string().describe("M:SS, e.g. '4:00'"),
        slow: z
          .string()
          .optional()
          .describe("M:SS. Optional - if omitted, 10 s/unit slower than `fast` is used."),
        unit: z.enum(["min/km", "min/mi"]),
      })
      .describe(
        "Pace range. `fast` is the quicker bound. A single pace is widened by 10 s."
      ),
    z
      .object({
        type: z.literal("power"),
        low: z.number(),
        high: z.number(),
      })
      .describe("Cycling power in watts."),
    z
      .object({
        type: z.literal("cadence"),
        low: z.number(),
        high: z.number(),
      })
      .describe("Cadence range (rpm / spm)."),
  ])
  .describe("Intensity target for the step. Omit or use {type:'none'} for no target.");
export type Target = z.infer<typeof targetSchema>;

/**
 * `Step` is recursive (a repeat block contains steps, which may themselves be
 * repeat blocks), so the schema and the TS type are declared by hand and tied
 * together with `z.lazy` rather than derived purely through `z.infer` -
 * zod can't infer a self-referential discriminated union's element type on
 * its own.
 */
export const strokeSchema = z.enum([
  "any",
  "backstroke",
  "breaststroke",
  "drill",
  "fly",
  "free",
  "im",
]);
export type Stroke = z.infer<typeof strokeSchema>;

export const equipmentSchema = z.enum([
  "fins",
  "kickboard",
  "paddles",
  "pull_buoy",
  "snorkel",
]);
export type Equipment = z.infer<typeof equipmentSchema>;

export interface SingleStep {
  kind: "step";
  name?: string;
  intensity: Intensity;
  duration: Duration;
  target?: Target;
  notes?: string;
  stroke?: Stroke;
  equipment?: Equipment;
}

export interface RepeatStep {
  kind: "repeat";
  iterations: number;
  steps: Step[];
}

export type Step = SingleStep | RepeatStep;

const singleStepSchema = z.object({
  kind: z.literal("step"),
  name: z.string().optional().describe("Shown on the watch, e.g. 'Threshold 1'."),
  intensity: intensitySchema,
  duration: durationSchema,
  target: targetSchema.optional(),
  notes: z.string().optional().describe("Free-text note shown on the watch."),
  stroke: strokeSchema
    .optional()
    .describe(
      "Swimming only - the stroke for this step. 'any' = any stroke, 'im' = individual medley. Only valid when the workout's sport is 'swimming'."
    ),
  equipment: equipmentSchema
    .optional()
    .describe(
      "Swimming only - equipment used for this step (fins, kickboard, paddles, pull_buoy, snorkel). Only valid when the workout's sport is 'swimming'."
    ),
});

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    singleStepSchema,
    z
      .object({
        kind: z.literal("repeat"),
        iterations: z.number().int().min(2),
        steps: z
          .array(stepSchema)
          .min(1)
          .describe("Steps repeated as a block, e.g. an interval plus its recovery."),
      })
      .describe(
        "A real interval block. Prefer this over repeating steps by hand - the watch then shows a rep counter."
      ),
  ])
);

export const workoutDataSchema = z.object({
  name: z.string(),
  sport: sportSchema.default("running"),
  steps: z.array(stepSchema).min(1),
  poolLength: z
    .number()
    .positive()
    .optional()
    .describe(
      "Swimming only - pool length for this workout, e.g. 25. Only valid when sport is 'swimming'."
    ),
  poolLengthUnit: z
    .enum(["m", "yd"])
    .optional()
    .describe(
      "Swimming only - unit for poolLength. Defaults to 'm' when poolLength is given without a unit."
    ),
});
export type WorkoutData = z.infer<typeof workoutDataSchema>;
