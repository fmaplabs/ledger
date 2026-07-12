import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUserId } from "./lib/auth";
import { loadEffectiveSettings } from "./settings";
import { isSuccessfulInvoice } from "./lib/invoices";
import {
	collapseIntoSessions,
	unionLengthMs,
	type Interval,
	type SessionHeartbeat,
} from "./lib/sessions";

// What the UI needs. Sync status is now user-relevant (badge + a link to the
// Stripe dashboard customer), so we surface a derived `stripeSynced` flag and
// the raw `stripeCustomerId`; `archived` stays internal.
const clientView = v.object({
	_id: v.id("clients"),
	name: v.string(),
	email: v.string(),
	rateCents: v.optional(v.number()),
	stripeSynced: v.boolean(),
	stripeCustomerId: v.optional(v.string()),
});

function toClientView(c: Doc<"clients">) {
	return {
		_id: c._id,
		name: c.name,
		email: c.email,
		rateCents: c.rateCents,
		stripeSynced: c.stripeCustomerId !== undefined,
		stripeCustomerId: c.stripeCustomerId,
	};
}

function assertRate(rateCents: number | null | undefined) {
	if (
		typeof rateCents === "number" &&
		(!Number.isInteger(rateCents) || rateCents < 0)
	) {
		throw new ConvexError("rateCents must be a non-negative integer");
	}
}

export const list = query({
	args: {},
	returns: v.array(clientView),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const clients = await ctx.db
			.query("clients")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.take(500);
		return clients
			.filter((c) => !c.archived)
			.sort((a, b) => a.name.localeCompare(b.name))
			.map(toClientView);
	},
});

export const get = query({
	// The raw route param, not v.id: a malformed URL must read as null (the
	// "not found" page), not throw an ArgumentValidationError into the router.
	args: { id: v.string() },
	returns: v.union(clientView, v.null()),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const id = ctx.db.normalizeId("clients", args.id);
		const client = id === null ? null : await ctx.db.get(id);
		// Missing and foreign read as null so the detail page renders "not
		// found" on a stale URL. Archived clients stay reachable: their tickets
		// still link here, and a live-looking link must not dead-end.
		if (client === null || client.userId !== userId) {
			return null;
		}
		return toClientView(client);
	},
});

export const create = mutation({
	args: {
		name: v.string(),
		email: v.string(),
		rateCents: v.optional(v.number()),
	},
	returns: v.id("clients"),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		if (args.name.trim() === "") throw new ConvexError("name is required");
		assertRate(args.rateCents);
		const id = await ctx.db.insert("clients", {
			userId,
			name: args.name.trim(),
			email: args.email.trim(),
			rateCents: args.rateCents,
		});
		// Proactively mirror the new client to Stripe. Scheduled from this public
		// mutation only — the inbound webhook sync never schedules a push, which
		// is what structurally breaks the echo loop.
		await ctx.scheduler.runAfter(0, internal.customerSync.pushToStripe, {
			clientId: id,
		});
		return id;
	},
});

export const update = mutation({
	args: {
		id: v.id("clients"),
		name: v.optional(v.string()),
		email: v.optional(v.string()),
		// null clears the override so the client falls back to the global default.
		rateCents: v.optional(v.union(v.number(), v.null())),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const client = await ctx.db.get(args.id);
		if (client === null || client.userId !== userId) {
			throw new ConvexError("Client not found");
		}
		assertRate(args.rateCents);

		const patch: Partial<{
			name: string;
			email: string;
			rateCents: number | undefined;
		}> = {};
		if (args.name !== undefined) patch.name = args.name.trim();
		if (args.email !== undefined) patch.email = args.email.trim();
		if (args.rateCents !== undefined) {
			patch.rateCents = args.rateCents === null ? undefined : args.rateCents;
		}
		await ctx.db.patch(args.id, patch);
		// Push edits to Stripe. Idempotent, so it is fine to fire even when only
		// `rateCents` changed (rate isn't mirrored, so the push is a no-op there).
		await ctx.scheduler.runAfter(0, internal.customerSync.pushToStripe, {
			clientId: args.id,
		});
		return null;
	},
});

export const archive = mutation({
	args: { id: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const client = await ctx.db.get(args.id);
		if (client === null || client.userId !== userId) {
			throw new ConvexError("Client not found");
		}
		// Asymmetry vs create/update: archiving does NOT push. Leaving the Stripe
		// customer in place is the standard, non-destructive choice (deleting it
		// would orphan its invoice history); a `customer.deleted` in Stripe is
		// handled inbound by clearing `stripeCustomerId`, not by us pushing.
		await ctx.db.patch(args.id, { archived: true });
		return null;
	},
});

// ─── Hours summary (client detail page) ──────────────────────────────────────

const DAY_MS = 86_400_000;
// Same bounded-reactive-scan cap as `revenue.repoUnbilledBreakdown`.
const HOURS_SCAN_LIMIT = 10_000;

// Tracked + ticketed time for one client over the current billing period and
// trailing 3 mo / 6 mo / 1 yr windows. Tracked hours use the invoicing math
// (`billableMs`), run ONCE over the combined heartbeats of all the client's
// projects so concurrent multi-project/multi-device time counts once. Ticket
// hours are declared `totalTimeMs`, bucketed by ticket `_creationTime` — kept
// separate because summing the two would double-count declared tracked work.
export const hoursSummary = query({
	args: { clientId: v.id("clients") },
	returns: v.object({
		periods: v.array(
			v.object({
				key: v.union(
					v.literal("billingPeriod"),
					v.literal("3m"),
					v.literal("6m"),
					v.literal("1y"),
				),
				// Cutoff timestamp; null only for a never-invoiced billing period.
				sinceMs: v.union(v.number(), v.null()),
				trackedMs: v.number(),
				ticketMs: v.number(),
			}),
		),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const client = await ctx.db.get(args.clientId);
		if (client === null || client.userId !== userId) {
			throw new ConvexError("Client not found");
		}
		const settings = await loadEffectiveSettings(ctx, userId);
		const now = Date.now();

		// Billing-period cutoff: most recent successful invoice's `createdAt` —
		// the `repoUnbilledBreakdown` watermark semantics. Desc scan so the cap
		// keeps the newest rows: the max we want is near the front, not past
		// row 1000 of an ascending scan.
		const invoices = await ctx.db
			.query("invoices")
			.withIndex("by_user_client", (q) =>
				q.eq("userId", userId).eq("clientId", args.clientId),
			)
			.order("desc")
			.take(1000);
		let billingCutoff: number | null = null;
		for (const inv of invoices) {
			if (!isSuccessfulInvoice(inv)) continue;
			if (billingCutoff === null || inv.createdAt > billingCutoff) {
				billingCutoff = inv.createdAt;
			}
		}

		const periods = [
			{ key: "billingPeriod" as const, sinceMs: billingCutoff },
			{ key: "3m" as const, sinceMs: now - 90 * DAY_MS },
			{ key: "6m" as const, sinceMs: now - 180 * DAY_MS },
			{ key: "1y" as const, sinceMs: now - 365 * DAY_MS },
		];

		const projects = await ctx.db
			.query("projects")
			.withIndex("by_user_client", (q) =>
				q.eq("userId", userId).eq("clientId", args.clientId),
			)
			.take(500);

		// One scan per project covering the widest period, drawing on a SINGLE
		// shared row budget: per-project caps would multiply past Convex's
		// per-query document read limit on a client with several heavy projects.
		// syncedAt >= ts for every row, so {ts >= cutoff} ⊆ {syncedAt >=
		// cutoff}: scan the indexed superset, then narrow by ts per period in
		// JS. Ordered newest-synced first so a truncated scan keeps the *most
		// recent* rows — the windows are anchored at now (the `activityByWindow`
		// precedent).
		const minCutoff = Math.min(billingCutoff ?? 0, now - 365 * DAY_MS);
		let truncated = false;
		const heartbeats: Doc<"heartbeats">[] = [];
		let budget = HOURS_SCAN_LIMIT;
		for (const project of projects) {
			if (budget <= 0) {
				truncated = true;
				break;
			}
			const scanned = await ctx.db
				.query("heartbeats")
				.withIndex("by_user_project_synced", (q) =>
					q
						.eq("userId", userId)
						.eq("project", project.name)
						.gte("syncedAt", minCutoff),
				)
				.order("desc")
				.take(budget + 1);
			if (scanned.length > budget) truncated = true;
			const kept = scanned.slice(0, budget);
			heartbeats.push(...kept);
			budget -= kept.length;
		}

		// Desc so the cap keeps the newest tickets — the ones inside the
		// now-anchored windows. Overflow folds into the same `truncated` flag.
		const ticketScan = await ctx.db
			.query("tickets")
			.withIndex("by_user_client", (q) =>
				q.eq("userId", userId).eq("clientId", args.clientId),
			)
			.order("desc")
			.take(501);
		if (ticketScan.length > 500) truncated = true;
		const tickets = ticketScan.slice(0, 500);

		// Group by device and sort ascending ONCE; each period then sessionizes
		// its suffix of the pre-sorted streams instead of `billableMs`
		// re-partitioning and re-sorting the same rows four times.
		const byDevice = new Map<string, SessionHeartbeat[]>();
		for (const hb of heartbeats) {
			let stream = byDevice.get(hb.deviceId);
			if (stream === undefined) {
				stream = [];
				byDevice.set(hb.deviceId, stream);
			}
			stream.push({ ts: hb.ts, project: hb.project, task: hb.task });
		}
		for (const stream of byDevice.values()) {
			stream.sort((a, b) => a.ts - b.ts);
		}
		const trackedMsSince = (cutoff: number): number => {
			const intervals: Interval[] = [];
			for (const stream of byDevice.values()) {
				// Ascending streams make the window a suffix.
				const start = stream.findIndex((hb) => hb.ts >= cutoff);
				if (start === -1) continue;
				const rows = start === 0 ? stream : stream.slice(start);
				for (const s of collapseIntoSessions(rows, settings.idleThresholdMs)) {
					intervals.push({ start: s.start, end: s.end });
				}
			}
			return unionLengthMs(intervals);
		};

		return {
			periods: periods.map(({ key, sinceMs }) => {
				const cutoff = sinceMs ?? 0;
				let ticketMs = 0;
				for (const ticket of tickets) {
					if (ticket._creationTime >= cutoff) ticketMs += ticket.totalTimeMs;
				}
				return {
					key,
					sinceMs,
					trackedMs: trackedMsSince(cutoff),
					ticketMs,
				};
			}),
			truncated,
		};
	},
});

export type ClientInfo = {
	name: string;
	email: string;
	rateCents?: number;
	stripeCustomerId?: string;
};

// This user's clients as an id→info map, for joins (projects/invoices/revenue)
// without an N+1 of `ctx.db.get`. Bounded to the same cap as `list`.
export async function loadClientMap(
	ctx: QueryCtx,
	userId: string,
): Promise<Map<Id<"clients">, ClientInfo>> {
	const clients = await ctx.db
		.query("clients")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.take(500);
	const map = new Map<Id<"clients">, ClientInfo>();
	for (const c of clients) {
		map.set(c._id, {
			name: c.name,
			email: c.email,
			rateCents: c.rateCents,
			stripeCustomerId: c.stripeCustomerId,
		});
	}
	return map;
}
