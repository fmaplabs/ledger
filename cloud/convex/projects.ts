import { ConvexError, v } from "convex/values";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/auth";
import { loadClientMap } from "./clients";
import { loadEffectiveSettings } from "./settings";
import { resolveRateCents } from "./lib/rates";
import { billableMs, type DeviceHeartbeat } from "./lib/sessions";

const projectView = v.object({
	_id: v.id("projects"),
	name: v.string(),
	displayName: v.optional(v.string()),
	clientId: v.optional(v.id("clients")),
	clientName: v.optional(v.string()),
	rateCents: v.optional(v.number()), // the per-project override, if set
	effectiveRateCents: v.number(), // resolved: project ?? client ?? default
	unbilledMsCache: v.optional(v.number()),
	unbilledCacheUpdatedAt: v.optional(v.number()),
});

export const list = query({
	args: {},
	returns: v.array(projectView),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const [settings, clientMap] = await Promise.all([
			loadEffectiveSettings(ctx, userId),
			loadClientMap(ctx, userId),
		]);
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_user_name", (q) => q.eq("userId", userId))
			.take(500);

		return projects
			.filter((p) => !p.archived)
			.sort((a, b) =>
				(a.displayName ?? a.name).localeCompare(b.displayName ?? b.name),
			)
			.map((p) => {
				const client = p.clientId ? clientMap.get(p.clientId) : undefined;
				return {
					_id: p._id,
					name: p.name,
					displayName: p.displayName,
					clientId: p.clientId,
					clientName: client?.name,
					rateCents: p.rateCents,
					effectiveRateCents: resolveRateCents(p, client, settings),
					unbilledMsCache: p.unbilledMsCache,
					unbilledCacheUpdatedAt: p.unbilledCacheUpdatedAt,
				};
			});
	},
});

export const update = mutation({
	args: {
		id: v.id("projects"),
		// null unassigns / clears the field.
		clientId: v.optional(v.union(v.id("clients"), v.null())),
		displayName: v.optional(v.union(v.string(), v.null())),
		rateCents: v.optional(v.union(v.number(), v.null())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const project = await ctx.db.get(args.id);
		if (project === null || project.userId !== userId) {
			throw new ConvexError("Project not found");
		}
		if (
			typeof args.rateCents === "number" &&
			(!Number.isInteger(args.rateCents) || args.rateCents < 0)
		) {
			throw new ConvexError("rateCents must be a non-negative integer");
		}
		if (args.clientId != null) {
			const client = await ctx.db.get(args.clientId);
			if (client === null || client.userId !== userId) {
				throw new ConvexError("Client not found");
			}
		}

		const patch: Partial<{
			clientId: (typeof project)["clientId"];
			displayName: string | undefined;
			rateCents: number | undefined;
		}> = {};
		if (args.clientId !== undefined) {
			patch.clientId = args.clientId === null ? undefined : args.clientId;
		}
		if (args.displayName !== undefined) {
			const trimmed = args.displayName?.trim();
			patch.displayName = trimmed ? trimmed : undefined;
		}
		if (args.rateCents !== undefined) {
			patch.rateCents = args.rateCents === null ? undefined : args.rateCents;
		}
		await ctx.db.patch(args.id, patch);
		return null;
	},
});

export const archive = mutation({
	args: { id: v.id("projects") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const project = await ctx.db.get(args.id);
		if (project === null || project.userId !== userId) {
			throw new ConvexError("Project not found");
		}
		await ctx.db.patch(args.id, { archived: true });
		return null;
	},
});

// ─── Unbilled-estimate cache (powers the dashboard pipeline figure) ──────────
// Sessionizing every project's heartbeats is too heavy for a reactive query, so
// it runs on demand in an action and caches the result on each project row.

const WINDOW_PAGE = 4_000;

export const listForEstimate = internalQuery({
	args: {},
	returns: v.object({
		idleThresholdMs: v.number(),
		projects: v.array(
			v.object({
				_id: v.id("projects"),
				name: v.string(),
				lastBilledSyncedAt: v.optional(v.number()),
			}),
		),
	}),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const settings = await loadEffectiveSettings(ctx, userId);
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_user_name", (q) => q.eq("userId", userId))
			.take(500);
		return {
			idleThresholdMs: settings.idleThresholdMs,
			projects: projects
				.filter((p) => !p.archived)
				.map((p) => ({
					_id: p._id,
					name: p.name,
					lastBilledSyncedAt: p.lastBilledSyncedAt,
				})),
		};
	},
});

export const unbilledPage = internalQuery({
	args: {
		projectName: v.string(),
		fromCursor: v.number(),
		cursor: v.union(v.string(), v.null()),
		numItems: v.number(),
	},
	returns: v.object({
		page: v.array(
			v.object({
				deviceId: v.string(),
				ts: v.number(),
				project: v.string(),
				task: v.string(),
			}),
		),
		isDone: v.boolean(),
		continueCursor: v.string(),
	}),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const result = await ctx.db
			.query("heartbeats")
			.withIndex("by_user_project_synced", (q) =>
				q
					.eq("userId", userId)
					.eq("project", args.projectName)
					.gt("syncedAt", args.fromCursor),
			)
			.paginate({ cursor: args.cursor, numItems: args.numItems });
		return {
			page: result.page.map((r) => ({
				deviceId: r.deviceId,
				ts: r.ts,
				project: r.project,
				task: r.task,
			})),
			isDone: result.isDone,
			continueCursor: result.continueCursor,
		};
	},
});

export const setUnbilledCache = internalMutation({
	args: { projectId: v.id("projects"), ms: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const project = await ctx.db.get(args.projectId);
		if (project === null || project.userId !== userId) return null;
		await ctx.db.patch(args.projectId, {
			unbilledMsCache: args.ms,
			unbilledCacheUpdatedAt: Date.now(),
		});
		return null;
	},
});

// Recompute each project's unbilled-time estimate. Called on demand from the
// dashboard (and worth calling after `invoices.generate`).
export const refreshUnbilledEstimates = action({
	args: {},
	returns: v.object({ updated: v.number() }),
	handler: async (ctx): Promise<{ updated: number }> => {
		const { idleThresholdMs, projects }: {
			idleThresholdMs: number;
			projects: Array<{
				_id: import("./_generated/dataModel").Id<"projects">;
				name: string;
				lastBilledSyncedAt?: number;
			}>;
		} = await ctx.runQuery(internal.projects.listForEstimate, {});

		for (const p of projects) {
			const from = p.lastBilledSyncedAt ?? 0;
			const rows: DeviceHeartbeat[] = [];
			let cursor: string | null = null;
			for (;;) {
				const res: {
					page: DeviceHeartbeat[];
					isDone: boolean;
					continueCursor: string;
				} = await ctx.runQuery(internal.projects.unbilledPage, {
					projectName: p.name,
					fromCursor: from,
					cursor,
					numItems: WINDOW_PAGE,
				});
				rows.push(...res.page);
				if (res.isDone) break;
				cursor = res.continueCursor;
			}
			await ctx.runMutation(internal.projects.setUnbilledCache, {
				projectId: p._id,
				ms: billableMs(rows, idleThresholdMs),
			});
		}
		return { updated: projects.length };
	},
});
