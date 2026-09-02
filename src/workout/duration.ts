import type { Duration } from "./types.js";

/** Garmin's endCondition table, confirmed against live payloads. */
const CONDITIONS = {
  lapButton: { conditionTypeId: 1, conditionTypeKey: "lap.button", displayOrder: 1, displayable: true },
  time: { conditionTypeId: 2, conditionTypeKey: "time", displayOrder: 2, displayable: true },
  distance: { conditionTypeId: 3, conditionTypeKey: "distance", displayOrder: 3, displayable: true },
  calories: { conditionTypeId: 4, conditionTypeKey: "calories", displayOrder: 4, displayable: true },
  heartRate: { conditionTypeId: 6, conditionTypeKey: "heart.rate", displayOrder: 6, displayable: true },
  iterations: { conditionTypeId: 7, conditionTypeKey: "iterations", displayOrder: 7, displayable: false },
} as const;

export const ITERATIONS_CONDITION = CONDITIONS.iterations;

const SECONDS_PER = { sec: 1, min: 60, hour: 3600 } as const;
const METRES_PER = { m: 1, km: 1000, mi: 1609.344 } as const;

export interface EncodedDuration {
  endCondition: {
    conditionTypeId: number;
    conditionTypeKey: string;
    displayOrder: number;
    displayable: boolean;
  };
  endConditionValue: number;
  endConditionCompare?: "lt" | "gt";
}

/**
 * Encode a step's end condition.
 *
 * Units are carried on the value rather than parsed out of a string. The old
 * implementation matched /([\d.]+)\s*(km|m)/i against free text, so "10 min"
 * fell through `km` to `m`, matched "10 m", and produced a 10 metre step -
 * silently, and before the MM:SS branch could ever run.
 */
export function encodeDuration(duration: Duration): EncodedDuration {
  switch (duration.type) {
    case "lapButton":
      // Garmin sends 1000 here; the value is ignored for lap.button steps.
      return { endCondition: CONDITIONS.lapButton, endConditionValue: 1000 };

    case "time": {
      assertPositive(duration.value, "Duration");
      return {
        endCondition: CONDITIONS.time,
        endConditionValue: Math.round(duration.value * SECONDS_PER[duration.unit]),
      };
    }

    case "distance": {
      assertPositive(duration.value, "Distance");
      return {
        endCondition: CONDITIONS.distance,
        endConditionValue: round2(duration.value * METRES_PER[duration.unit]),
      };
    }

    case "calories": {
      assertPositive(duration.value, "Calories");
      return {
        endCondition: CONDITIONS.calories,
        endConditionValue: Math.round(duration.value),
      };
    }

    case "heartRate": {
      assertPositive(duration.bpm, "Heart rate");
      return {
        endCondition: CONDITIONS.heartRate,
        endConditionValue: Math.round(duration.bpm),
        endConditionCompare: duration.compare,
      };
    }
  }
}

function assertPositive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number, got ${value}.`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
