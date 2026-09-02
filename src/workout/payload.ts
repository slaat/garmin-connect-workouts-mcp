import { encodeDuration, ITERATIONS_CONDITION } from "./duration.js";
import { encodeTarget } from "./targets.js";
import type { Equipment, Intensity, Sport, Step, Stroke, WorkoutData } from "./types.js";

// Confirmed via live round-trip against Garmin on 2026-09-02: swimming is
// sportTypeId 4 - the account previously sent id 5, which Garmin stores as
// strength_training.
const SPORTS: Record<Sport, { sportTypeId: number; sportTypeKey: string; displayOrder: number }> = {
  running: { sportTypeId: 1, sportTypeKey: "running", displayOrder: 1 },
  cycling: { sportTypeId: 2, sportTypeKey: "cycling", displayOrder: 2 },
  swimming: { sportTypeId: 4, sportTypeKey: "swimming", displayOrder: 3 },
};

/**
 * Garmin's stroke table (step-level `strokeType`), confirmed via live
 * round-trip on 2026-09-02. displayOrder equals the id.
 */
const STROKE_TYPES: Record<Stroke, { strokeTypeId: number; strokeTypeKey: string; displayOrder: number }> = {
  any: { strokeTypeId: 1, strokeTypeKey: "any_stroke", displayOrder: 1 },
  backstroke: { strokeTypeId: 2, strokeTypeKey: "backstroke", displayOrder: 2 },
  breaststroke: { strokeTypeId: 3, strokeTypeKey: "breaststroke", displayOrder: 3 },
  drill: { strokeTypeId: 4, strokeTypeKey: "drill", displayOrder: 4 },
  fly: { strokeTypeId: 5, strokeTypeKey: "fly", displayOrder: 5 },
  free: { strokeTypeId: 6, strokeTypeKey: "free", displayOrder: 6 },
  im: { strokeTypeId: 7, strokeTypeKey: "individual_medley", displayOrder: 7 },
};

/**
 * Garmin's equipment table (step-level `equipmentType`), confirmed via live
 * round-trip on 2026-09-02. displayOrder equals the id.
 */
const EQUIPMENT_TYPES: Record<Equipment, { equipmentTypeId: number; equipmentTypeKey: string; displayOrder: number }> = {
  fins: { equipmentTypeId: 1, equipmentTypeKey: "fins", displayOrder: 1 },
  kickboard: { equipmentTypeId: 2, equipmentTypeKey: "kickboard", displayOrder: 2 },
  paddles: { equipmentTypeId: 3, equipmentTypeKey: "paddles", displayOrder: 3 },
  pull_buoy: { equipmentTypeId: 4, equipmentTypeKey: "pull_buoy", displayOrder: 4 },
  snorkel: { equipmentTypeId: 5, equipmentTypeKey: "snorkel", displayOrder: 5 },
};

/** Garmin's poolLengthUnit table, confirmed via live round-trip on 2026-09-02. */
const POOL_LENGTH_UNITS: Record<"m" | "yd", { unitId: number; unitKey: string; factor: number }> = {
  m: { unitId: 1, unitKey: "meter", factor: 100 },
  yd: { unitId: 230, unitKey: "yard", factor: 91.44 },
};

const STEP_TYPES: Record<Intensity | "repeat", { stepTypeId: number; stepTypeKey: string; displayOrder: number }> = {
  warmup: { stepTypeId: 1, stepTypeKey: "warmup", displayOrder: 1 },
  cooldown: { stepTypeId: 2, stepTypeKey: "cooldown", displayOrder: 2 },
  active: { stepTypeId: 3, stepTypeKey: "interval", displayOrder: 3 },
  rest: { stepTypeId: 4, stepTypeKey: "recovery", displayOrder: 4 },
  repeat: { stepTypeId: 6, stepTypeKey: "repeat", displayOrder: 6 },
};

/**
 * Build the Garmin create/update payload.
 *
 * stepIds only need to be unique - the server discards them and assigns its own
 * (the web client sends 1,2,4,5,6,3 against stepOrder 1..6). stepOrder carries
 * the actual sequence and runs as a single counter across nesting.
 */
export function buildWorkoutPayload(workout: WorkoutData) {
  const sport = SPORTS[workout.sport] ?? SPORTS.running;

  if (!workout.steps?.length) {
    throw new Error("A workout needs at least one step.");
  }

  validateSwimFields(workout);

  const counters = { stepId: 1, stepOrder: 1, childStepId: 1 };
  const workoutSteps = workout.steps.map((step) => encodeStep(step, counters));

  const result: any = {
    sportType: sport,
    subSportType: null,
    workoutName: workout.name,
    estimatedDistanceUnit: { unitKey: null },
    workoutSegments: [
      {
        segmentOrder: 1,
        sportType: sport,
        workoutSteps,
      },
    ],
    avgTrainingSpeed: averageTrainingSpeed(workoutSteps),
    estimatedDurationInSecs: 0,
    estimatedDistanceInMeters: 0,
    estimateType: null,
    isWheelchair: false,
  };

  if (workout.poolLength !== undefined) {
    result.poolLength = workout.poolLength;
    result.poolLengthUnit = POOL_LENGTH_UNITS[workout.poolLengthUnit ?? "m"];
  }

  return result;
}

/**
 * Swim-only fields (stroke/equipment on a step, poolLength/poolLengthUnit on
 * the workout) are rejected outright on a non-swimming workout, and a bare
 * poolLengthUnit without poolLength is rejected too - this codebase's
 * philosophy is to reject invalid input rather than silently drop it.
 */
function validateSwimFields(workout: WorkoutData) {
  if (workout.poolLengthUnit !== undefined && workout.poolLength === undefined) {
    throw new Error("poolLengthUnit was given without poolLength.");
  }

  if (workout.sport === "swimming") return;

  if (workout.poolLength !== undefined || workout.poolLengthUnit !== undefined) {
    throw new Error(
      `poolLength/poolLengthUnit are only valid for swimming workouts, got sport "${workout.sport}".`
    );
  }

  const walk = (steps: Step[]): void => {
    for (const step of steps) {
      if (step.kind === "repeat") {
        walk(step.steps);
        continue;
      }
      if (step.stroke !== undefined || step.equipment !== undefined) {
        throw new Error(
          `stroke/equipment are only valid on swimming steps, got sport "${workout.sport}".`
        );
      }
    }
  };
  walk(workout.steps);
}

interface Counters {
  stepId: number;
  stepOrder: number;
  childStepId: number;
}

function encodeStep(step: Step, counters: Counters, childStepId?: number): any {
  if (step.kind === "repeat") {
    return encodeRepeat(step, counters);
  }

  const { endCondition, endConditionValue, endConditionCompare } = encodeDuration(step.duration);
  const { targetType, targetValueOne, targetValueTwo, zoneNumber } = encodeTarget(step.target);

  const encoded: any = {
    stepId: counters.stepId++,
    stepOrder: counters.stepOrder++,
    stepType: STEP_TYPES[step.intensity] ?? STEP_TYPES.active,
    type: "ExecutableStepDTO",
    endCondition,
    endConditionValue,
    targetType,
  };

  if (endConditionCompare !== undefined) encoded.endConditionCompare = endConditionCompare;
  if (targetValueOne !== undefined) encoded.targetValueOne = targetValueOne;
  if (targetValueTwo !== undefined) encoded.targetValueTwo = targetValueTwo;
  if (zoneNumber !== undefined) encoded.zoneNumber = zoneNumber;
  if (childStepId !== undefined) encoded.childStepId = childStepId;
  // Garmin shows this on the watch; the old implementation declared a `notes`
  // field on its step type and then never sent it anywhere.
  if (step.notes) encoded.description = step.notes;
  if (step.name) encoded.stepName = step.name;
  if (step.stroke !== undefined) encoded.strokeType = STROKE_TYPES[step.stroke];
  if (step.equipment !== undefined) encoded.equipmentType = EQUIPMENT_TYPES[step.equipment];

  return encoded;
}

/**
 * NOTE: the RepeatGroupDTO shape is the one part of this encoder not yet
 * confirmed against a payload captured from Garmin's own client - the account
 * used for verification had no interval workout. It follows the structure
 * reported by several independent reverse-engineering efforts and round-trips
 * correctly through create-then-read, but treat it as the least certain code
 * here. See the spec, section 4.5.
 */
function encodeRepeat(step: Extract<Step, { kind: "repeat" }>, counters: Counters): any {
  if (!Number.isInteger(step.iterations) || step.iterations < 2) {
    throw new Error(`Repeat needs at least 2 iterations, got ${step.iterations}.`);
  }
  if (!step.steps?.length) {
    throw new Error("A repeat block needs at least one child step.");
  }

  const childStepId = counters.childStepId++;
  const group = {
    stepId: counters.stepId++,
    stepOrder: counters.stepOrder++,
    stepType: STEP_TYPES.repeat,
    type: "RepeatGroupDTO",
    childStepId,
    numberOfIterations: step.iterations,
    endCondition: ITERATIONS_CONDITION,
    endConditionValue: step.iterations,
    smartRepeat: false,
    skipLastRestStep: false,
    workoutSteps: step.steps.map((child) => encodeStep(child, counters, childStepId)),
  };

  return group;
}

/**
 * Garmin stores an average training speed per workout and uses it for its
 * duration estimate. The previous implementation hardcoded a constant lifted
 * from a captured request, which described someone else's workout.
 *
 * Derive it from whatever pace targets the workout actually contains, falling
 * back to a plausible easy-run pace when there are none.
 */
function averageTrainingSpeed(steps: any[]): number {
  const speeds: number[] = [];
  const walk = (list: any[]) => {
    for (const s of list) {
      if (s.workoutSteps) walk(s.workoutSteps);
      if (s.targetType?.workoutTargetTypeKey === "pace.zone" && s.targetValueOne && s.targetValueTwo) {
        speeds.push((s.targetValueOne + s.targetValueTwo) / 2);
      }
    }
  };
  walk(steps);

  if (!speeds.length) return 2.7777778; // 6:00/km
  return speeds.reduce((a, b) => a + b, 0) / speeds.length;
}
