import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildWorkoutPayload } from "../src/workout/payload";
import type { WorkoutData } from "../src/workout/types";

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

/**
 * Helpers for comparing our encoder's output against a captured Garmin
 * payload. Comparisons run fixture -> output: we only check fields the
 * fixture actually carries, and ignore stepId (client placeholder) and key
 * order.
 */

// Our encoder rounds pace to 7 decimals; Garmin's own web client sends the
// unrounded float (e.g. 2.8571428799999996). null/undefined both mean "no
// value" and compare equal to each other.
function expectNumberClose(actual: number | null | undefined, expected: number | null | undefined) {
  const a = actual ?? null;
  const e = expected ?? null;
  if (a === null || e === null) {
    expect(a).toBe(e);
    return;
  }
  expect(Math.abs(a - e)).toBeLessThan(1e-6);
}

// Garmin sometimes stores zoneNumber as a string ("2"); null/undefined/absent
// all mean "no zone".
function expectZoneEqual(actual: unknown, expected: unknown) {
  const a = actual === null || actual === undefined ? null : Number(actual);
  const e = expected === null || expected === undefined ? null : Number(expected);
  expect(a).toBe(e);
}

function flattenSteps(steps: any[]): any[] {
  const flat: any[] = [];
  for (const s of steps) {
    flat.push(s);
    if (s.workoutSteps) flat.push(...flattenSteps(s.workoutSteps));
  }
  return flat;
}

function expectStepMatchesFixture(ours: any, fix: any) {
  expect(ours.type).toBe(fix.type);
  expect(ours.stepType.stepTypeId).toBe(fix.stepType.stepTypeId);
  expect(ours.stepType.stepTypeKey).toBe(fix.stepType.stepTypeKey);
  expect(ours.endCondition.conditionTypeId).toBe(fix.endCondition.conditionTypeId);
  expect(ours.endCondition.conditionTypeKey).toBe(fix.endCondition.conditionTypeKey);
  expect(ours.endConditionValue).toBe(fix.endConditionValue);
  // RepeatGroupDTO steps carry no targetType at all (neither in Garmin's
  // fixture nor in our own encoder output) - only ExecutableStepDTO steps do.
  if (fix.type !== "RepeatGroupDTO") {
    expect(ours.targetType.workoutTargetTypeId).toBe(fix.targetType.workoutTargetTypeId);
    expect(ours.targetType.workoutTargetTypeKey).toBe(fix.targetType.workoutTargetTypeKey);
    expectNumberClose(ours.targetValueOne, fix.targetValueOne);
    expectNumberClose(ours.targetValueTwo, fix.targetValueTwo);
    expectZoneEqual(ours.zoneNumber, fix.zoneNumber);
  }
  expect(ours.stepOrder).toBe(fix.stepOrder);

  if (fix.childStepId !== undefined && fix.childStepId !== null) {
    expect(ours.childStepId).toBe(fix.childStepId);
  }

  if (fix.type === "RepeatGroupDTO") {
    expect(ours.numberOfIterations).toBe(fix.numberOfIterations);
  }

  // strokeType/equipmentType are only present on ExecutableStepDTO steps.
  // Garmin echoes {id: 0, key: null} when unset; our encoder omits the field
  // entirely in that case, so both "absent" and "id 0" compare as unset.
  if (fix.strokeType !== undefined) {
    const oursId = ours.strokeType?.strokeTypeId ?? 0;
    const oursKey = ours.strokeType?.strokeTypeKey ?? null;
    expect(oursId).toBe(fix.strokeType.strokeTypeId);
    expect(oursKey).toBe(fix.strokeType.strokeTypeKey);
  }
  if (fix.equipmentType !== undefined) {
    const oursId = ours.equipmentType?.equipmentTypeId ?? 0;
    const oursKey = ours.equipmentType?.equipmentTypeKey ?? null;
    expect(oursId).toBe(fix.equipmentType.equipmentTypeId);
    expect(oursKey).toBe(fix.equipmentType.equipmentTypeKey);
  }
}

describe("buildWorkoutPayload", () => {
  it("builds the segment envelope", () => {
    const payload = buildWorkoutPayload({
      name: "Easy run",
      sport: "running",
      steps: [
        { kind: "step", intensity: "active", duration: { type: "time", value: 30, unit: "min" } },
      ],
    });
    expect(payload.workoutName).toBe("Easy run");
    expect(payload.sportType.sportTypeKey).toBe("running");
    expect(payload.workoutSegments).toHaveLength(1);
    expect(payload.workoutSegments[0].workoutSteps).toHaveLength(1);
  });

  it("rejects an empty workout", () => {
    expect(() =>
      buildWorkoutPayload({ name: "x", sport: "running", steps: [] })
    ).toThrow(/at least one step/);
  });

  it("maps notes to Garmin's description field", () => {
    // Regression: `notes` was declared on the step type and never sent.
    const payload = buildWorkoutPayload({
      name: "x",
      sport: "running",
      steps: [
        {
          kind: "step",
          intensity: "active",
          duration: { type: "lapButton" },
          notes: "keep it smooth",
        },
      ],
    });
    expect(payload.workoutSegments[0].workoutSteps[0].description).toBe("keep it smooth");
  });

  it("derives avgTrainingSpeed from pace targets instead of a hardcoded constant", () => {
    const payload = buildWorkoutPayload({
      name: "x",
      sport: "running",
      steps: [
        {
          kind: "step",
          intensity: "active",
          duration: { type: "distance", value: 1, unit: "km" },
          target: { type: "pace", fast: "4:00", slow: "4:10", unit: "min/km" },
        },
      ],
    });
    // Midpoint of 4.1666667 and 4.
    expect(payload.avgTrainingSpeed).toBeCloseTo(4.0833334, 6);
    expect(payload.avgTrainingSpeed).not.toBe(3.0727914832080057);
  });
});

describe("repeat groups", () => {
  const workout: WorkoutData = {
    name: "4x1km",
    sport: "running",
    steps: [
      { kind: "step", intensity: "warmup", duration: { type: "time", value: 10, unit: "min" } },
      {
        kind: "repeat",
        iterations: 4,
        steps: [
          {
            kind: "step",
            intensity: "active",
            duration: { type: "distance", value: 1, unit: "km" },
            target: { type: "pace", fast: "4:00", unit: "min/km" },
          },
          { kind: "step", intensity: "rest", duration: { type: "time", value: 2, unit: "min" } },
        ],
      },
      { kind: "step", intensity: "cooldown", duration: { type: "time", value: 10, unit: "min" } },
    ],
  };

  it("emits a RepeatGroupDTO rather than flattening the block", () => {
    const steps = buildWorkoutPayload(workout).workoutSegments[0].workoutSteps;
    // Old behaviour produced 10 flat steps; correct output is 3 top-level ones.
    expect(steps).toHaveLength(3);
    const group = steps[1];
    expect(group.type).toBe("RepeatGroupDTO");
    expect(group.stepType.stepTypeKey).toBe("repeat");
    expect(group.stepType.stepTypeId).toBe(6);
    expect(group.numberOfIterations).toBe(4);
    expect(group.endCondition.conditionTypeKey).toBe("iterations");
    expect(group.endConditionValue).toBe(4);
    expect(group.smartRepeat).toBe(false);
    expect(group.workoutSteps).toHaveLength(2);
  });

  it("tags children with their group's childStepId", () => {
    const group = buildWorkoutPayload(workout).workoutSegments[0].workoutSteps[1];
    expect(group.childStepId).toBe(1);
    for (const child of group.workoutSteps) {
      expect(child.childStepId).toBe(group.childStepId);
    }
  });

  it("runs stepOrder as one counter across nesting, and keeps stepIds unique", () => {
    const steps = buildWorkoutPayload(workout).workoutSegments[0].workoutSteps;
    const flat: any[] = [];
    const walk = (list: any[]) => {
      for (const s of list) {
        flat.push(s);
        if (s.workoutSteps) walk(s.workoutSteps);
      }
    };
    walk(steps);
    expect(flat.map((s) => s.stepOrder)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(flat.map((s) => s.stepId)).size).toBe(flat.length);
  });

  it("rejects a degenerate repeat", () => {
    expect(() =>
      buildWorkoutPayload({
        name: "x",
        sport: "running",
        steps: [{ kind: "repeat", iterations: 1, steps: [] }],
      })
    ).toThrow(/at least 2 iterations/);
  });
});

describe("swimming", () => {
  it("encodes the swimming sport as id 4, displayOrder 3", () => {
    // Regression: this account previously sent id 5, which Garmin stores as
    // strength_training. Confirmed by live round-trip on 2026-09-02.
    const payload = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
    });
    expect(payload.sportType.sportTypeId).toBe(4);
    expect(payload.sportType.sportTypeKey).toBe("swimming");
    expect(payload.sportType.displayOrder).toBe(3);
    expect(payload.workoutSegments[0].sportType.sportTypeId).toBe(4);
  });

  const strokeCases: Array<[string, number, string]> = [
    ["any", 1, "any_stroke"],
    ["backstroke", 2, "backstroke"],
    ["breaststroke", 3, "breaststroke"],
    ["drill", 4, "drill"],
    ["fly", 5, "fly"],
    ["free", 6, "free"],
    ["im", 7, "individual_medley"],
  ];

  it.each(strokeCases)("maps stroke %s to strokeTypeId %d / key %s", (stroke, id, key) => {
    const payload = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      steps: [
        {
          kind: "step",
          intensity: "active",
          duration: { type: "distance", value: 100, unit: "m" },
          stroke: stroke as any,
        },
      ],
    });
    const step = payload.workoutSegments[0].workoutSteps[0];
    expect(step.strokeType.strokeTypeId).toBe(id);
    expect(step.strokeType.strokeTypeKey).toBe(key);
  });

  const equipmentCases: Array<[string, number, string]> = [
    ["fins", 1, "fins"],
    ["kickboard", 2, "kickboard"],
    ["paddles", 3, "paddles"],
    ["pull_buoy", 4, "pull_buoy"],
    ["snorkel", 5, "snorkel"],
  ];

  it.each(equipmentCases)("maps equipment %s to equipmentTypeId %d / key %s", (equipment, id, key) => {
    const payload = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      steps: [
        {
          kind: "step",
          intensity: "active",
          duration: { type: "distance", value: 100, unit: "m" },
          equipment: equipment as any,
        },
      ],
    });
    const step = payload.workoutSegments[0].workoutSteps[0];
    expect(step.equipmentType.equipmentTypeId).toBe(id);
    expect(step.equipmentType.equipmentTypeKey).toBe(key);
  });

  it("omits strokeType/equipmentType entirely when unset", () => {
    const payload = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
    });
    const step = payload.workoutSegments[0].workoutSteps[0];
    expect(step.strokeType).toBeUndefined();
    expect(step.equipmentType).toBeUndefined();
  });

  it("encodes poolLength in meters with the full unit object", () => {
    const payload: any = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      poolLength: 25,
      poolLengthUnit: "m",
      steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
    });
    expect(payload.poolLength).toBe(25);
    expect(payload.poolLengthUnit).toEqual({ unitId: 1, unitKey: "meter", factor: 100 });
  });

  it("encodes poolLength in yards with the full unit object", () => {
    const payload: any = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      poolLength: 25,
      poolLengthUnit: "yd",
      steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
    });
    expect(payload.poolLength).toBe(25);
    expect(payload.poolLengthUnit).toEqual({ unitId: 230, unitKey: "yard", factor: 91.44 });
  });

  it("defaults poolLengthUnit to meters when omitted", () => {
    const payload: any = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      poolLength: 50,
      steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
    });
    expect(payload.poolLengthUnit).toEqual({ unitId: 1, unitKey: "meter", factor: 100 });
  });

  it("omits poolLength/poolLengthUnit entirely when unset", () => {
    const payload: any = buildWorkoutPayload({
      name: "Swim",
      sport: "swimming",
      steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
    });
    expect(payload.poolLength).toBeUndefined();
    expect(payload.poolLengthUnit).toBeUndefined();
  });

  it("rejects stroke on a non-swimming (running) step", () => {
    expect(() =>
      buildWorkoutPayload({
        name: "x",
        sport: "running",
        steps: [
          {
            kind: "step",
            intensity: "active",
            duration: { type: "time", value: 10, unit: "min" },
            stroke: "free",
          },
        ],
      })
    ).toThrow(/only valid on swimming steps/);
  });

  it("rejects equipment on a non-swimming (running) step", () => {
    expect(() =>
      buildWorkoutPayload({
        name: "x",
        sport: "running",
        steps: [
          {
            kind: "step",
            intensity: "active",
            duration: { type: "time", value: 10, unit: "min" },
            equipment: "kickboard",
          },
        ],
      })
    ).toThrow(/only valid on swimming steps/);
  });

  it("rejects poolLength on a cycling workout", () => {
    expect(() =>
      buildWorkoutPayload({
        name: "x",
        sport: "cycling",
        poolLength: 25,
        steps: [{ kind: "step", intensity: "active", duration: { type: "time", value: 10, unit: "min" } }],
      })
    ).toThrow(/only valid for swimming workouts/);
  });

  it("rejects poolLengthUnit without poolLength", () => {
    expect(() =>
      buildWorkoutPayload({
        name: "x",
        sport: "swimming",
        poolLengthUnit: "yd",
        steps: [{ kind: "step", intensity: "active", duration: { type: "distance", value: 100, unit: "m" } }],
      })
    ).toThrow(/poolLengthUnit was given without poolLength/);
  });

  it("checks swim fields on steps nested inside a repeat block too", () => {
    expect(() =>
      buildWorkoutPayload({
        name: "x",
        sport: "running",
        steps: [
          {
            kind: "repeat",
            iterations: 2,
            steps: [
              {
                kind: "step",
                intensity: "active",
                duration: { type: "time", value: 1, unit: "min" },
                stroke: "free",
              },
            ],
          },
        ],
      })
    ).toThrow(/only valid on swimming steps/);
  });
});

describe("golden file: matches what Garmin itself stores", () => {
  it("reproduces Garmin's own web-client running workout, step by step", () => {
    // garmin-ui-create-running.json is a verbatim POST body captured from
    // Garmin's web client: warmup by lap button, a 1km interval at
    // 5:50-6:00/km pace, 30 min in HR zone 2, an interval bounded by HR<150
    // targeting 175-185 cadence, a 1km cooldown, then a lap-button cooldown.
    // This is the equivalent structured input for that exact workout.
    const uiRequest = fixture("garmin-ui-create-running.json");

    const workout: WorkoutData = {
      name: "Run Workout",
      sport: "running",
      steps: [
        { kind: "step", intensity: "warmup", duration: { type: "lapButton" } },
        {
          kind: "step",
          intensity: "active",
          duration: { type: "distance", value: 1, unit: "km" },
          target: { type: "pace", fast: "5:50", slow: "6:00", unit: "min/km" },
        },
        {
          kind: "step",
          intensity: "active",
          duration: { type: "time", value: 30, unit: "min" },
          target: { type: "hrZone", zone: 2 },
        },
        {
          kind: "step",
          intensity: "active",
          duration: { type: "heartRate", bpm: 150, compare: "lt" },
          target: { type: "cadence", low: 175, high: 185 },
        },
        { kind: "step", intensity: "cooldown", duration: { type: "distance", value: 1, unit: "km" } },
        { kind: "step", intensity: "cooldown", duration: { type: "lapButton" } },
      ],
    };

    const payload = buildWorkoutPayload(workout);

    expect(payload.sportType.sportTypeKey).toBe(uiRequest.sportType.sportTypeKey);
    expect(payload.estimatedDistanceUnit).toEqual(uiRequest.estimatedDistanceUnit);
    expect(payload.workoutSegments).toHaveLength(uiRequest.workoutSegments.length);
    expect(payload.workoutSegments[0].workoutSteps).toHaveLength(
      uiRequest.workoutSegments[0].workoutSteps.length
    );

    const ours = flattenSteps(payload.workoutSegments[0].workoutSteps);
    const theirs = flattenSteps(uiRequest.workoutSegments[0].workoutSteps);
    expect(ours).toHaveLength(theirs.length);

    theirs.forEach((fix: any, i: number) => expectStepMatchesFixture(ours[i], fix));
  });

  it("server-normalized round-trip of an encoder-created workout: pace, cadence and bpm targets", () => {
    // garmin-roundtrip-repeat.json is what Garmin's server stored (and
    // returned on GET) for a workout this encoder created and POSTed - i.e.
    // it inspects Garmin's own normalization of our output, not the other
    // way around.
    const stored = fixture("garmin-roundtrip-repeat.json");
    const steps = stored.workoutSegments[0].workoutSteps;

    const group = steps.find((s: any) => s.type === "RepeatGroupDTO");
    expect(group.numberOfIterations).toBe(4);
    expect(group.endCondition.conditionTypeKey).toBe("iterations");

    const pace = group.workoutSteps.find(
      (s: any) => s.targetType.workoutTargetTypeKey === "pace.zone"
    );
    expect(pace.targetValueOne).toBe(4.1666667);
    expect(pace.targetValueTwo).toBe(4);

    const bpm = group.workoutSteps.find(
      (s: any) => s.targetType.workoutTargetTypeKey === "heart.rate.zone"
    );
    expect(bpm.targetValueOne).toBe(130);
    expect(bpm.targetValueTwo).toBe(145);
    // We omit zoneNumber entirely for a bpm range; Garmin stores that as an
    // explicit null. Both mean "this is a range, not a zone".
    expect(bpm.zoneNumber).toBeNull();

    const cadence = steps.find((s: any) => s.targetType?.workoutTargetTypeKey === "cadence");
    expect(cadence.targetValueOne).toBe(175);
    expect(cadence.targetValueTwo).toBe(185);
  });

  it("server-normalized round-trip of a swim workout: sport id 4, strokes, equipment, pool length", () => {
    // garmin-roundtrip-swim.json is what Garmin's server stored (and returned
    // on GET) for a swim workout this encoder created and POSTed via live
    // round-trip on 2026-09-02: warmup 200m any stroke, 4x(100m free +
    // 30s rest with a kickboard), 100m breaststroke cooldown, pool length
    // 25m.
    const stored = fixture("garmin-roundtrip-swim.json");

    const workout: WorkoutData = {
      name: "Swim technique 4x100",
      sport: "swimming",
      poolLength: 25,
      poolLengthUnit: "m",
      steps: [
        {
          kind: "step",
          intensity: "warmup",
          duration: { type: "distance", value: 200, unit: "m" },
          stroke: "any",
        },
        {
          kind: "repeat",
          iterations: 4,
          steps: [
            {
              kind: "step",
              intensity: "active",
              duration: { type: "distance", value: 100, unit: "m" },
              stroke: "free",
            },
            {
              kind: "step",
              intensity: "rest",
              duration: { type: "time", value: 30, unit: "sec" },
              equipment: "kickboard",
            },
          ],
        },
        {
          kind: "step",
          intensity: "cooldown",
          duration: { type: "distance", value: 100, unit: "m" },
          stroke: "breaststroke",
        },
      ],
    };

    const payload: any = buildWorkoutPayload(workout);

    expect(payload.sportType.sportTypeId).toBe(stored.sportType.sportTypeId);
    expect(payload.sportType.sportTypeKey).toBe(stored.sportType.sportTypeKey);
    expect(payload.sportType.displayOrder).toBe(stored.sportType.displayOrder);
    expect(payload.poolLength).toBe(stored.poolLength);
    expect(payload.poolLengthUnit).toEqual(stored.poolLengthUnit);

    const ours = flattenSteps(payload.workoutSegments[0].workoutSteps);
    const theirs = flattenSteps(stored.workoutSegments[0].workoutSteps);
    expect(ours).toHaveLength(theirs.length);

    theirs.forEach((fix: any, i: number) => expectStepMatchesFixture(ours[i], fix));

    // Explicit per-step spot checks, since strokeType/equipmentType are only
    // checked in expectStepMatchesFixture when the fixture carries them.
    expect(ours[0].strokeType).toEqual({ strokeTypeId: 1, strokeTypeKey: "any_stroke", displayOrder: 1 });
    const intervalStep = ours.find((s: any) => s.stepType.stepTypeKey === "interval");
    expect(intervalStep.strokeType).toEqual({ strokeTypeId: 6, strokeTypeKey: "free", displayOrder: 6 });
    const restStep = ours.find((s: any) => s.stepType.stepTypeKey === "recovery");
    expect(restStep.equipmentType).toEqual({ equipmentTypeId: 2, equipmentTypeKey: "kickboard", displayOrder: 2 });
    const cooldownStep = ours.find((s: any) => s.stepType.stepTypeKey === "cooldown");
    expect(cooldownStep.strokeType).toEqual({ strokeTypeId: 3, strokeTypeKey: "breaststroke", displayOrder: 3 });
  });
});
