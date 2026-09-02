import { describe, it, expect } from "vitest";
import { encodeTarget, paceToMetresPerSecond, parsePaceToSeconds } from "../src/workout/targets";

describe("pace conversion", () => {
  it("converts min/km to metres per second", () => {
    expect(paceToMetresPerSecond("4:00", "min/km")).toBe(4.1666667);
    expect(paceToMetresPerSecond("5:00", "min/km")).toBe(3.3333333);
  });

  it("matches the values Garmin's own client produced", () => {
    // Captured from a real Garmin web UI request: 5:50-6:00/km.
    expect(paceToMetresPerSecond("5:50", "min/km")).toBe(2.8571429);
    expect(paceToMetresPerSecond("6:00", "min/km")).toBe(2.7777778);
  });

  it("converts min/mi using statute miles", () => {
    expect(paceToMetresPerSecond("8:00", "min/mi")).toBe(3.3528);
  });

  it("rejects malformed pace rather than guessing", () => {
    expect(() => parsePaceToSeconds("4.30")).toThrow(/Invalid pace/);
    expect(() => parsePaceToSeconds("4:75")).toThrow(/Invalid pace/);
    expect(() => parsePaceToSeconds("fast")).toThrow(/Invalid pace/);
  });
});

describe("encodeTarget", () => {
  it("emits pace bounds descending in m/s, fast first", () => {
    // The pair follows display order (4:00 before 4:10), which inverts in m/s.
    const encoded = encodeTarget({ type: "pace", fast: "4:00", slow: "4:10", unit: "min/km" });
    expect(encoded.targetType.workoutTargetTypeKey).toBe("pace.zone");
    expect(encoded.targetType.workoutTargetTypeId).toBe(6);
    expect(encoded.targetValueOne).toBe(4.1666667);
    expect(encoded.targetValueTwo).toBe(4);
    expect(encoded.targetValueOne!).toBeGreaterThan(encoded.targetValueTwo!);
  });

  it("widens a single pace by 10 s, treating it as the fast edge", () => {
    const encoded = encodeTarget({ type: "pace", fast: "4:00", unit: "min/km" });
    expect(encoded.targetValueOne).toBe(4.1666667); // 4:00
    expect(encoded.targetValueTwo).toBe(4); // 4:10
  });

  it("rejects an inverted pace range", () => {
    expect(() =>
      encodeTarget({ type: "pace", fast: "5:00", slow: "4:00", unit: "min/km" })
    ).toThrow(/inverted/);
  });

  it("encodes a heart rate zone with zoneNumber and no bounds", () => {
    const encoded = encodeTarget({ type: "hrZone", zone: 3 });
    expect(encoded.targetType.workoutTargetTypeId).toBe(4);
    expect(encoded.zoneNumber).toBe(3);
    expect(encoded.targetValueOne).toBeUndefined();
  });

  it("encodes explicit bpm on heart.rate.zone with bounds and no zoneNumber", () => {
    // Regression: the old code invented {id: 2, key: "heart.rate.bpm"} and sent
    // no values at all. id 2 is power.zone; custom bpm rides on id 4.
    const encoded = encodeTarget({ type: "hrBpm", low: 130, high: 145 });
    expect(encoded.targetType.workoutTargetTypeKey).toBe("heart.rate.zone");
    expect(encoded.targetType.workoutTargetTypeId).toBe(4);
    expect(encoded.zoneNumber).toBeUndefined();
    expect(encoded.targetValueOne).toBe(130);
    expect(encoded.targetValueTwo).toBe(145);
  });

  it("encodes cadence ascending", () => {
    const encoded = encodeTarget({ type: "cadence", low: 175, high: 185 });
    expect(encoded.targetType.workoutTargetTypeId).toBe(3);
    expect(encoded.targetValueOne).toBe(175);
    expect(encoded.targetValueTwo).toBe(185);
  });

  it("defaults to no.target", () => {
    expect(encodeTarget(undefined).targetType.workoutTargetTypeKey).toBe("no.target");
    expect(encodeTarget({ type: "none" }).targetType.workoutTargetTypeId).toBe(1);
  });

  it("rejects an out-of-range heart rate zone", () => {
    expect(() => encodeTarget({ type: "hrZone", zone: 9 as any })).toThrow(/1-5/);
  });

  it("rejects a reversed bpm range", () => {
    expect(() => encodeTarget({ type: "hrBpm", low: 160, high: 140 })).toThrow(/must not exceed/);
  });

  it("encodes power on power.zone ascending, low first, with no zoneNumber", () => {
    // Verified by live round-trip against Garmin on 2026-09-02: targetValueOne
    // 200 / targetValueTwo 250 (ascending) and zoneNumber null came back
    // verbatim for a cycling workout.
    const encoded = encodeTarget({ type: "power", low: 200, high: 250 });
    expect(encoded.targetType.workoutTargetTypeId).toBe(2);
    expect(encoded.targetType.workoutTargetTypeKey).toBe("power.zone");
    expect(encoded.targetValueOne).toBe(200);
    expect(encoded.targetValueTwo).toBe(250);
    expect(encoded.zoneNumber).toBeUndefined();
  });

  it("rejects a reversed power range", () => {
    expect(() => encodeTarget({ type: "power", low: 250, high: 200 })).toThrow(/must not exceed/);
  });
});
