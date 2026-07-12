import { mutation, query, type QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireUserId } from "./lib/auth";
import { loadClientMap } from "./clients";

const ticketView = v.object({
	_id: v.id("tickets"),
	externalId: v.string(),
	name: v.string(),
	description: v.optional(v.string()),
	clientId: v.id("clients"),
	clientName: v.string(),
	projectId: v.id("projects"),
	projectName: v.string(),
	totalTimeMs: v.number(),
	createdAt: v.number(),
});

// Joins client/project names onto raw ticket rows. Callers scan their index
// `.order("desc")`, so rows arrive newest-first already (each index here ends
// in _creationTime once the eq prefix is fixed). A dangling join (row beyond
// the 500-row map caps, or a hard-deleted parent) renders a placeholder
// rather than throwing — list pages must not crash on one bad row.
async function toTicketViews(
	ctx: QueryCtx,
	userId: string,
	tickets: Doc<"tickets">[],
) {
	const [clientMap, projects] = await Promise.all([
		loadClientMap(ctx, userId),
		ctx.db
			.query("projects")
			.withIndex("by_user_name", (q) => q.eq("userId", userId))
			.take(500),
	]);
	const projectNames = new Map(
		projects.map((p) => [p._id, p.displayName ?? p.name] as const),
	);
	return tickets.map((t) => ({
			_id: t._id,
			externalId: t.externalId,
			name: t.name,
			description: t.description,
			clientId: t.clientId,
			clientName: clientMap.get(t.clientId)?.name ?? "(unknown client)",
			projectId: t.projectId,
			projectName: projectNames.get(t.projectId) ?? "(unknown project)",
			totalTimeMs: t.totalTimeMs,
			createdAt: t._creationTime,
		}));
}

export const list = query({
	args: {},
	returns: v.array(ticketView),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		// Desc on `by_user` = newest-first by _creationTime, so growth past the
		// cap drops the oldest rows, never a just-created ticket.
		const tickets = await ctx.db
			.query("tickets")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.order("desc")
			.take(500);
		return await toTicketViews(ctx, userId, tickets);
	},
});

export const listByClient = query({
	args: { clientId: v.id("clients") },
	returns: v.array(ticketView),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const client = await ctx.db.get(args.clientId);
		if (client === null || client.userId !== userId) {
			throw new ConvexError("Client not found");
		}
		const tickets = await ctx.db
			.query("tickets")
			.withIndex("by_user_client", (q) =>
				q.eq("userId", userId).eq("clientId", args.clientId),
			)
			.order("desc")
			.take(500);
		return await toTicketViews(ctx, userId, tickets);
	},
});

export const listByProject = query({
	args: { projectId: v.id("projects") },
	returns: v.array(ticketView),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const project = await ctx.db.get(args.projectId);
		if (project === null || project.userId !== userId) {
			throw new ConvexError("Project not found");
		}
		const tickets = await ctx.db
			.query("tickets")
			.withIndex("by_user_project", (q) =>
				q.eq("userId", userId).eq("projectId", args.projectId),
			)
			.order("desc")
			.take(500);
		return await toTicketViews(ctx, userId, tickets);
	},
});

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
