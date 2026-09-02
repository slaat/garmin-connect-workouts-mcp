import type { Target } from "./types.js";

/**
 * When a caller gives a single pace instead of a range, treat it as the fast
 * edge and widen downwards: "4:00/km" becomes 4:00-4:10/km.
 */
export const PACE_TOLERANCE_SEC = 10;

const METRES_PER_UNIT = {
  "min/km": 1000,
  "min/mi": 1609.344,
} as const;

/**
 * Garmin's workoutTargetType table.
 *
 * `none`, `cadence`, `heartRate`, `pace` and `power` are all confirmed against
 * real payloads. `power` was verified by a live round-trip against Garmin on
 * 2026-09-02: a cycling workout with targetValueOne 200 / targetValueTwo 250
 * (ascending, low first) and zoneNumber null came back verbatim.
 */
const TARGET_TYPES = {
  none: { workoutTargetTypeId: 1, workoutTargetTypeKey: "no.target", displayOrder: 1 },
  cadence: { workoutTargetTypeId: 3, workoutTargetTypeKey: "cadence", displayOrder: 3 },
  heartRate: { workoutTargetTypeId: 4, workoutTargetTypeKey: "heart.rate.zone", displayOrder: 4 },
  power: { workoutTargetTypeId: 2, workoutTargetTypeKey: "power.zone", displayOrder: 2 },
  pace: { workoutTargetTypeId: 6, workoutTargetTypeKey: "pace.zone", displayOrder: 6 },
} as const;

export interface EncodedTarget {
  targetType: { workoutTargetTypeId: number; workoutTargetTypeKey: string; displayOrder: number };
  targetValueOne?: number;
  targetValueTwo?: number;
  zoneNumber?: number;
}

/** Parse "4:30" or "4:30.5" into seconds. Throws rather than guessing. */
export function parsePaceToSeconds(pace: string): number {
  const match = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(pace.trim());
  if (!match) {
    throw new Error(
      `Invalid pace "${pace}". Expected M:SS, e.g. "4:30".`
    );
  }
  return parseInt(match[1], 10) * 60 + parseFloat(match[2]);
}

/**
 * Convert a pace to Garmin's storage unit, metres per second.
 *
 * Rounded to 7 decimals because that is what the server itself returns: a
 * request carrying 2.8571428799999996 comes back as 2.8571429. Matching that
 * keeps golden-file comparisons against real payloads exact.
 */
export function paceToMetresPerSecond(pace: string, unit: "min/km" | "min/mi"): number {
  const seconds = parsePaceToSeconds(pace);
  if (seconds <= 0) {
    throw new Error(`Pace "${pace}" must be greater than zero.`);
  }
  return round7(METRES_PER_UNIT[unit] / seconds);
}

function round7(n: number): number {
  return Math.round(n * 1e7) / 1e7;
}

function assertRange(low: number, high: number, label: string) {
  if (low > high) {
    throw new Error(`${label}: low (${low}) must not exceed high (${high}).`);
  }
}

/**
 * Encode a target into the fields Garmin expects on a workout step.
 *
 * Ordering of targetValueOne/Two is per target type, not global: the pair
 * follows *display* order, low to high. Cadence displays as rpm so it runs
 * ascending (175, 185). Pace displays as time-per-distance, so the lower
 * displayed pace is the faster one - which inverts to the HIGHER m/s. Hence
 * pace is the one target that comes out descending.
 */
export function encodeTarget(target: Target | undefined): EncodedTarget {
  if (!target || target.type === "none") {
    return { targetType: TARGET_TYPES.none };
  }

  switch (target.type) {
    case "hrZone": {
      if (!Number.isInteger(target.zone) || target.zone < 1 || target.zone > 5) {
        throw new Error(`Heart rate zone must be 1-5, got ${target.zone}.`);
      }
      return { targetType: TARGET_TYPES.heartRate, zoneNumber: target.zone };
    }

    case "hrBpm": {
      assertRange(target.low, target.high, "Heart rate");
      // Custom BPM rides on the same target type as zones; the distinguishing
      // feature is value bounds instead of a zoneNumber.
      return {
        targetType: TARGET_TYPES.heartRate,
        targetValueOne: target.low,
        targetValueTwo: target.high,
      };
    }

    case "pace": {
      const fastMs = paceToMetresPerSecond(target.fast, target.unit);
      const slowMs = target.slow
        ? paceToMetresPerSecond(target.slow, target.unit)
        : round7(
            METRES_PER_UNIT[target.unit] /
              (parsePaceToSeconds(target.fast) + PACE_TOLERANCE_SEC)
          );

      if (slowMs > fastMs) {
        throw new Error(
          `Pace range is inverted: "${target.fast}" is slower than "${target.slow}".`
        );
      }
      return {
        targetType: TARGET_TYPES.pace,
        targetValueOne: fastMs,
        targetValueTwo: slowMs,
      };
    }

    case "power": {
      assertRange(target.low, target.high, "Power");
      return {
        targetType: TARGET_TYPES.power,
        targetValueOne: target.low,
        targetValueTwo: target.high,
      };
    }

    case "cadence": {
      assertRange(target.low, target.high, "Cadence");
      return {
        targetType: TARGET_TYPES.cadence,
        targetValueOne: target.low,
        targetValueTwo: target.high,
      };
    }
  }
}
