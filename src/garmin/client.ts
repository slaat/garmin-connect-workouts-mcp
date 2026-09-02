import { GC_API_BASE, garminHeaders, type AuthData } from "../garmin-auth.js";
import { buildWorkoutPayload } from "../workout/payload.js";
import type { WorkoutData } from "../workout/types.js";

export interface WorkoutSummary {
  workoutId: number;
  workoutName: string;
  sportType?: { sportTypeKey: string };
  updatedDate?: string;
}

export class GarminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "GarminApiError";
  }
}

export class GarminClient {
  constructor(private auth: AuthData) {}

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const headers: Record<string, string> = garminHeaders(this.auth);
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const res = await fetch(`${GC_API_BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 401 and 403 both mean the session is gone: Garmin answers 403 for a
      // missing or stale CSRF token, which is the more common expiry mode here.
      if (res.status === 401 || res.status === 403) {
        throw new GarminApiError(
          "Garmin session expired. Please re-authenticate with the 'authenticate_garmin' tool.",
          res.status,
          body
        );
      }
      throw new GarminApiError(
        `Garmin API error ${res.status} ${res.statusText}`,
        res.status,
        body
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async createWorkout(workout: WorkoutData) {
    const payload = buildWorkoutPayload(workout);
    return this.request<{ workoutId: number; workoutName: string }>(
      "/workout-service/workout",
      { method: "POST", body: payload }
    );
  }

  async updateWorkout(workoutId: number, workout: WorkoutData) {
    const payload = { ...buildWorkoutPayload(workout), workoutId };
    return this.request<void>(`/workout-service/workout/${workoutId}`, {
      method: "PUT",
      body: payload,
    });
  }

  async listWorkouts(limit = 20, start = 1) {
    return this.request<WorkoutSummary[]>(
      `/workout-service/workouts?start=${start}&limit=${limit}&myWorkoutsOnly=true`
    );
  }

  async getWorkout(workoutId: number) {
    return this.request<any>(`/workout-service/workout/${workoutId}`);
  }

  async deleteWorkout(workoutId: number) {
    return this.request<void>(`/workout-service/workout/${workoutId}`, {
      method: "DELETE",
    });
  }

  /** Put a workout on the Garmin Connect calendar. `date` is YYYY-MM-DD. */
  async scheduleWorkout(workoutId: number, date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Schedule date must be YYYY-MM-DD, got "${date}".`);
    }
    return this.request<{ workoutScheduleId: number }>(
      `/workout-service/schedule/${workoutId}`,
      { method: "POST", body: { date } }
    );
  }

  static workoutUrl(workoutId: number | string) {
    return `https://connect.garmin.com/modern/workout/${workoutId}`;
  }
}
