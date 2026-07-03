import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
	// One row per heartbeat, owned by the (userId, deviceId) that recorded it.
	// `syncedAt` is the server clock at the push that last wrote the row — it
	// is the pull cursor, so it must never come from a client clock.
	heartbeats: defineTable({
		userId: v.string(), // WorkOS identity.subject
		deviceId: v.string(),
		uuid: v.string(),
		ts: v.number(),
		project: v.string(),
		task: v.string(),
		file: v.optional(v.string()),
		isWrite: v.boolean(),
		commitHash: v.optional(v.string()),
		syncedAt: v.number(),
	})
		.index("by_user_uuid", ["userId", "uuid"])
		.index("by_user_synced", ["userId", "syncedAt"]),

	devices: defineTable({
		userId: v.string(),
		deviceId: v.string(),
		name: v.string(),
		lastSeenAt: v.number(),
	}).index("by_user_device", ["userId", "deviceId"]),
});
