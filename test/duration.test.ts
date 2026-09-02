import { describe, it, expect } from "vitest";
import { encodeDuration } from "../src/workout/duration";

describe("encodeDuration", () => {
  it("encodes minutes as seconds, not metres", () => {
    // Regression for the headline duration bug: the old regex
    // /([\d.]+)\s*(km|m)/i matched "10 m" inside "10 min" and produced a
    // 10 metre step, silently, before the MM:SS branch could run.
    const encoded = encodeDuration({ type: "time", value: 10, unit: "min" });
    expect(encoded.endCondition.conditionTypeKey).toBe("time");
    expect(encoded.endConditionValue).toBe(600);
  });

  it("encodes seconds and hours", () => {
    expect(encodeDuration({ type: "time", value: 30, unit: "sec" }).endConditionValue).toBe(30);
    expect(encodeDuration({ type: "time", value: 1.5, unit: "hour" }).endConditionValue).toBe(5400);
  });

  it("encodes distance in metres", () => {
    expect(encodeDuration({ type: "distance", value: 1, unit: "km" }).endConditionValue).toBe(1000);
    expect(encodeDuration({ type: "distance", value: 400, unit: "m" }).endConditionValue).toBe(400);
    expect(encodeDuration({ type: "distance", value: 1, unit: "mi" }).endConditionValue).toBe(1609.34);
  });

  it("encodes the lap button with Garmin's placeholder value", () => {
    const encoded = encodeDuration({ type: "lapButton" });
    expect(encoded.endCondition.conditionTypeId).toBe(1);
    expect(encoded.endConditionValue).toBe(1000);
  });

  it("encodes a heart rate threshold with a comparison", () => {
    const encoded = encodeDuration({ type: "heartRate", bpm: 150, compare: "lt" });
    expect(encoded.endCondition.conditionTypeId).toBe(6);
    expect(encoded.endConditionValue).toBe(150);
    expect(encoded.endConditionCompare).toBe("lt");
  });

  it("rejects non-positive values", () => {
    expect(() => encodeDuration({ type: "time", value: 0, unit: "min" })).toThrow(/positive/);
    expect(() => encodeDuration({ type: "distance", value: -5, unit: "km" })).toThrow(/positive/);
  });
});
