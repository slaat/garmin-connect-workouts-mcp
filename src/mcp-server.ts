#!/usr/bin/env node

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GarminAuth } from "./garmin-auth.js";
import { GarminClient } from "./garmin/client.js";
import { sportSchema, stepSchema, workoutDataSchema, type WorkoutData } from "./workout/types.js";

const server = new McpServer(
  { name: "garmin-connect-workouts", version: "1.1.2" },
  { capabilities: { tools: {} } }
);

const garminAuth = new GarminAuth();

const NEEDS_AUTH =
  "❌ Not authenticated with Garmin Connect. Run the 'authenticate_garmin' tool - it opens a browser for a normal Garmin login.";

const workoutIdField = z
  .number()
  .describe(
    "The numeric Garmin workout id, as returned by create_garmin_workout or listed by list_garmin_workouts."
  );
const stepsField = z
  .array(stepSchema)
  .min(1)
  .describe(
    "The ordered list of steps and repeat blocks that make up the workout, in the order they should be performed."
  );
const poolLengthField = workoutDataSchema.shape.poolLength;
const poolLengthUnitField = workoutDataSchema.shape.poolLengthUnit;
const nameField = z.string().describe("Workout name, shown in Garmin Connect and on the device.");

const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

async function withClient<T>(fn: (client: GarminClient) => Promise<T>) {
  const auth = await garminAuth.getValidAuth();
  if (!auth) return null;
  return fn(new GarminClient(auth));
}

/**
 * Wraps a tool handler so thrown errors surface as a `❌ message` text result,
 * matching this server's error format everywhere rather than the SDK's
 * default `isError: true` envelope.
 */
function safe<Args extends any[]>(
  handler: (...args: Args) => Promise<ReturnType<typeof text>>
): (...args: Args) => Promise<ReturnType<typeof text>> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return text(`❌ ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

server.registerTool(
  "create_garmin_workout",
  {
    description:
      "Create a new structured workout in Garmin Connect from typed steps: durations, pace/HR/power/cadence targets, repeat blocks for intervals, and swim-specific stroke/equipment/pool-length fields. Use to add a workout; to change one that exists, use update_garmin_workout instead. Returns the new workoutId and a Connect link. Returns a re-auth message, not an exception, if no valid session exists. Example: [{kind:'step', intensity:'warmup', duration:{type:'time', value:10, unit:'min'}}, {kind:'repeat', iterations:5, steps:[...]}].",
    inputSchema: {
      name: nameField,
      sport: sportSchema
        .default("running")
        .describe(
          "Sport for this workout: running, cycling, or swimming. Governs which target types apply and whether stroke/equipment/poolLength are used. Defaults to running."
        ),
      steps: stepsField,
      poolLength: poolLengthField,
      poolLengthUnit: poolLengthUnitField,
    },
    annotations: { title: "Create Garmin workout" },
  },
  safe(async (args) => {
    const workout = args as WorkoutData;
    const result = await withClient((c) => c.createWorkout(workout));
    if (!result) return text(NEEDS_AUTH);
    return text(
      `✅ Created **${result.workoutName}** (ID: ${result.workoutId})\n\n🔗 ${GarminClient.workoutUrl(result.workoutId)}\n\nSync your device to pick it up.`
    );
  })
);

server.registerTool(
  "list_garmin_workouts",
  {
    description:
      "List workouts stored in the Garmin Connect account, most recent first, with each workout's name, sport, and workoutId. Use this to find a workoutId to pass to get_garmin_workout, update_garmin_workout, delete_garmin_workout, or schedule_garmin_workout. Read-only. If no valid session exists, returns a message asking you to run authenticate_garmin rather than throwing.",
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .default(20)
        .describe("Maximum number of workouts to return, most recent first. Defaults to 20, capped at 100."),
    },
    annotations: { title: "List Garmin workouts", readOnlyHint: true, idempotentHint: true },
  },
  safe(async (args) => {
    const list = await withClient((c) => c.listWorkouts(args.limit ?? 20));
    if (!list) return text(NEEDS_AUTH);
    if (!list.length) return text("No workouts found.");
    return text(
      list
        .map(
          (w) =>
            `- **${w.workoutName}** (${w.sportType?.sportTypeKey ?? "?"}) — ID ${w.workoutId}`
        )
        .join("\n")
    );
  })
);

server.registerTool(
  "get_garmin_workout",
  {
    description:
      "Fetch the complete stored structure (all steps, targets, repeat blocks) of one workout by its workoutId, as raw JSON. Use this to inspect a workout, or to get its full contents before calling update_garmin_workout, which replaces the entire workout rather than patching it. Read-only. If no valid session exists, returns a message asking you to run authenticate_garmin rather than throwing.",
    inputSchema: { workoutId: workoutIdField },
    annotations: { title: "Get Garmin workout", readOnlyHint: true, idempotentHint: true },
  },
  safe(async (args) => {
    const workout = await withClient((c) => c.getWorkout(args.workoutId));
    if (!workout) return text(NEEDS_AUTH);
    return text("```json\n" + JSON.stringify(workout, null, 2) + "\n```");
  })
);

server.registerTool(
  "update_garmin_workout",
  {
    description:
      "Replace the entire contents (name, sport, steps, pool settings) of an existing workout, identified by workoutId, keeping its id. This is a full overwrite, not a partial patch - fields you omit are dropped. Call get_garmin_workout first to see the current contents before changing them. If no valid session exists, returns a message asking you to run authenticate_garmin rather than throwing.",
    inputSchema: {
      workoutId: workoutIdField,
      name: nameField,
      sport: sportSchema.describe(
        "Sport for this workout: running, cycling, or swimming. Governs which target types apply and whether stroke/equipment/poolLength are used."
      ),
      steps: stepsField,
      poolLength: poolLengthField,
      poolLengthUnit: poolLengthUnitField,
    },
    annotations: { title: "Update Garmin workout", idempotentHint: true },
  },
  safe(async (args) => {
    const { workoutId, ...workout } = args;
    const done = await withClient(async (c) => {
      await c.updateWorkout(workoutId, workout as WorkoutData);
      return true;
    });
    if (!done) return text(NEEDS_AUTH);
    return text(`✅ Updated workout ${workoutId}\n\n🔗 ${GarminClient.workoutUrl(workoutId)}`);
  })
);

server.registerTool(
  "delete_garmin_workout",
  {
    description:
      "Permanently delete a workout from Garmin Connect by workoutId. This is irreversible - there is no undo or trash. Use list_garmin_workouts or get_garmin_workout first to confirm you have the right workoutId. If no valid session exists, returns a message asking you to run authenticate_garmin rather than throwing.",
    inputSchema: { workoutId: workoutIdField },
    annotations: { title: "Delete Garmin workout", destructiveHint: true },
  },
  safe(async (args) => {
    const done = await withClient(async (c) => {
      await c.deleteWorkout(args.workoutId);
      return true;
    });
    if (!done) return text(NEEDS_AUTH);
    return text(`🗑️ Deleted workout ${args.workoutId}`);
  })
);

server.registerTool(
  "schedule_garmin_workout",
  {
    description:
      "Put an existing workout on the Garmin Connect calendar for a specific date, so it appears as a planned session and can sync to a device. Requires a workoutId already created via create_garmin_workout or found via list_garmin_workouts - this tool does not create workouts. If no valid session exists, returns a message asking you to run authenticate_garmin rather than throwing.",
    inputSchema: {
      workoutId: workoutIdField,
      date: z.string().describe("Calendar date to schedule the workout on, in YYYY-MM-DD format, e.g. '2026-09-15'."),
    },
    annotations: { title: "Schedule Garmin workout" },
  },
  safe(async (args) => {
    const done = await withClient(async (c) => {
      await c.scheduleWorkout(args.workoutId, args.date);
      return true;
    });
    if (!done) return text(NEEDS_AUTH);
    return text(`📅 Scheduled workout ${args.workoutId} for ${args.date}`);
  })
);

server.registerTool(
  "check_garmin_auth",
  {
    description:
      "Probe whether the stored Garmin Connect session is still valid, using a cheap authenticated request rather than a local expiry check (Garmin's session cookie does not carry a reliable expiry). Use this first when unsure whether the other tools will work. Returns a message telling you to run authenticate_garmin if the session is missing or has expired; never throws.",
    annotations: { title: "Check Garmin auth", readOnlyHint: true, idempotentHint: true },
  },
  safe(async () => {
    const auth = await garminAuth.getValidAuth();
    return text(
      auth
        ? `✅ Garmin session is valid (captured ${new Date(auth.capturedAt).toLocaleString()}).`
        : NEEDS_AUTH
    );
  })
);

server.registerTool(
  "authenticate_garmin",
  {
    description:
      "Authenticate with Garmin Connect by opening a real browser window at connect.garmin.com for you to log in normally, then capture and store only the resulting session cookies and CSRF token (never your password). Run this whenever check_garmin_auth reports no valid session, or any other tool returns its 'not authenticated' message. Requires a local display; will not work in a headless-only environment.",
    annotations: { title: "Authenticate with Garmin" },
  },
  safe(async () => {
    const auth = await garminAuth.authenticate();
    return text(
      auth
        ? "✅ Authenticated with Garmin Connect. You can now create workouts."
        : "❌ Authentication failed. Make sure you can reach Garmin Connect in a browser."
    );
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Garmin Connect Workouts MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
