import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { requireUserId } from "./lib/auth";

export const create = mutation({
	args: {
		externalId: v.string(),
		name: v.string(),
		description: v.optional(v.string()),
		clientId: v.id("clients"),
		// Integer milliseconds. The UI converts from minutes/hours on submit.
		totalTimeMs: v.number(),
		projectId: v.id("projects"),
	},
	returns: v.id("tickets"),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		if (args.name.trim() === "") throw new ConvexError("name is required");
		if (args.externalId.trim() === "") {
			throw new ConvexError("externalId is required");
		}
		if (!Number.isInteger(args.totalTimeMs) || args.totalTimeMs < 0) {
			throw new ConvexError("totalTimeMs must be a non-negative integer");
		}
		const client = await ctx.db.get(args.clientId);
		if (client === null || client.userId !== userId) {
			throw new ConvexError("Client not found");
		}
		const project = await ctx.db.get(args.projectId);
		if (project === null || project.userId !== userId) {
			throw new ConvexError("Project not found");
		}
		const existing = await ctx.db
			.query("tickets")
			.withIndex("by_user_external", (q) =>
				q.eq("userId", userId).eq("externalId", args.externalId),
			)
			.unique();
		if (existing !== null) {
			throw new ConvexError(
				"A ticket with this externalId already exists",
			);
		}
		return await ctx.db.insert("tickets", {
			userId,
			externalId: args.externalId,
			name: args.name.trim(),
			description: args.description,
			clientId: args.clientId,
			totalTimeMs: args.totalTimeMs,
			projectId: args.projectId,
		});
	},
});
