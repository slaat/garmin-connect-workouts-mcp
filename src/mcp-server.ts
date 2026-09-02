#!/usr/bin/env node

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GarminAuth } from "./garmin-auth.js";
import { GarminClient } from "./garmin/client.js";
import { sportSchema, stepSchema, type WorkoutData } from "./workout/types.js";

const server = new McpServer(
  { name: "garmin-connect-workouts", version: "1.0.1" },
  { capabilities: { tools: {} } }
);

const garminAuth = new GarminAuth();

const NEEDS_AUTH =
  "❌ Not authenticated with Garmin Connect. Run the 'authenticate_garmin' tool - it opens a browser for a normal Garmin login.";

const workoutIdField = z.number().describe("The Garmin workout id.");
const stepsField = z
  .array(stepSchema)
  .min(1)
  .describe("The ordered list of steps and repeat blocks that make up the workout.");

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
      "Create a structured workout in Garmin Connect. Supports pace, heart-rate zone, explicit bpm, power and cadence targets, and real repeat blocks for intervals.",
    inputSchema: {
      name: z.string().describe("Workout name."),
      sport: sportSchema.default("running"),
      steps: stepsField,
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
    description: "List workouts in the Garmin Connect account.",
    inputSchema: {
      limit: z.number().int().positive().max(100).default(20).describe("Max workouts to return."),
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
    description: "Fetch the full structure of one workout.",
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
    description: "Replace an existing workout's contents, keeping its id.",
    inputSchema: {
      workoutId: workoutIdField,
      name: z.string().describe("Workout name."),
      sport: sportSchema,
      steps: stepsField,
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
    description: "Delete a workout.",
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
    description: "Put a workout on the Garmin Connect calendar for a date.",
    inputSchema: {
      workoutId: workoutIdField,
      date: z.string().describe("YYYY-MM-DD"),
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
    description: "Check whether the stored Garmin session still works.",
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
    description: "Authenticate with Garmin Connect (opens a browser).",
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
