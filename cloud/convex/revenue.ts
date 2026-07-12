import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/auth";
import { loadEffectiveSettings } from "./settings";
import { loadClientMap } from "./clients";
import { isSuccessfulInvoice } from "./lib/invoices";
import { resolveRateCents } from "./lib/rates";
import { billableMs } from "./lib/sessions";

const MS_PER_HOUR = 3_600_000;
const DAY_MS = 86_400_000;

// Reactive heartbeat scans are bounded (mirrors `previewUnbilled`): read up to
// LIMIT+1 rows, keep LIMIT, and flag `truncated` when the extra row is present.
// The repo card scans one project at a time; the window card scans everything
// synced in the window, so it gets the larger cap.
const REPO_SCAN_LIMIT = 10_000;
const WINDOW_LIMIT = 20_000;

// UTC month/year boundaries derived from a timestamp. `monthsAgo` may be
// negative to get a future month start (used for the upper bound of a bucket).
function monthStart(ms: number, monthsAgo = 0): number {
	const d = new Date(ms);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsAgo, 1);
}
function yearStart(ms: number): number {
	return Date.UTC(new Date(ms).getUTCFullYear(), 0, 1);
}
const monthLabel = new Intl.DateTimeFormat("en-US", {
	month: "short",
	timeZone: "UTC",
});

export const summary = query({
	args: {},
	returns: v.object({
		currency: v.string(),
		thisMonthCents: v.number(),
		yearToDateCents: v.number(),
		unbilledPipelineCents: v.number(),
		projectedAnnualCents: v.number(),
	}),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const settings = await loadEffectiveSettings(ctx, userId);
		const now = Date.now();
		const monthStartMs = monthStart(now);
		const yearStartMs = yearStart(now);
		const trailingStart = now - 90 * DAY_MS;

		const invoices = await ctx.db
			.query("invoices")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.take(1000);

		let thisMonth = 0;
		let ytd = 0;
		let trailing90 = 0;
		for (const inv of invoices) {
			if (inv.status !== "paid" || inv.paidAt === undefined) continue;
			if (inv.paidAt >= monthStartMs) thisMonth += inv.amountCents;
			if (inv.paidAt >= yearStartMs) ytd += inv.amountCents;
			if (inv.paidAt >= trailingStart) trailing90 += inv.amountCents;
		}
		// Annualize the trailing 90 days into a forward run-rate.
		const projectedAnnual = Math.round(trailing90 * (365 / 90));

		// Pipeline: value of tracked-but-uninvoiced time, from each project's
		// cached unbilled estimate × its resolved rate.
		const clientMap = await loadClientMap(ctx, userId);
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_user_name", (q) => q.eq("userId", userId))
			.take(500);
		let pipeline = 0;
		for (const p of projects) {
			if (p.archived) continue;
			const ms = p.unbilledMsCache ?? 0;
			if (ms <= 0) continue;
			const client = p.clientId ? clientMap.get(p.clientId) : undefined;
			const rate = resolveRateCents(p, client, settings);
			pipeline += Math.round((ms / MS_PER_HOUR) * rate);
		}

		return {
			currency: settings.currency,
			thisMonthCents: thisMonth,
			yearToDateCents: ytd,
			unbilledPipelineCents: pipeline,
			projectedAnnualCents: projectedAnnual,
		};
	},
});

export const monthlySeries = query({
	args: {},
	returns: v.object({
		currency: v.string(),
		months: v.array(v.object({ label: v.string(), cents: v.number() })),
	}),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const settings = await loadEffectiveSettings(ctx, userId);
		const now = Date.now();

		// 12 buckets, oldest first, ending with the current month.
		const buckets = [];
		for (let i = 11; i >= 0; i--) {
			const start = monthStart(now, i);
			const end = monthStart(now, i - 1); // next month's start
			buckets.push({ start, end, label: monthLabel.format(new Date(start)), cents: 0 });
		}

		const invoices = await ctx.db
			.query("invoices")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.take(1000);
		for (const inv of invoices) {
			if (inv.status !== "paid" || inv.paidAt === undefined) continue;
			for (const b of buckets) {
				if (inv.paidAt >= b.start && inv.paidAt < b.end) {
					b.cents += inv.amountCents;
					break;
				}
			}
		}

		return {
			currency: settings.currency,
			months: buckets.map((b) => ({ label: b.label, cents: b.cents })),
		};
	},
});

// Distinct non-null commit hashes across a set of heartbeats. A "commit" is a
// heartbeat stamped by the git post-commit hook; the same hash repeats across
// the heartbeats of one commit, so we count the set, not the rows.
function countCommits(rows: readonly Doc<"heartbeats">[]): number {
	const hashes = new Set<string>();
	for (const r of rows) {
		if (r.commitHash) hashes.add(r.commitHash);
	}
	return hashes.size;
}

// Per-repo (== per-project) unbilled commits + hours since the client's last
// invoice was generated. "Since" is the most recent successful invoice's
// `createdAt` for the project's client — heartbeats with `ts >= cutoff` count.
export const repoUnbilledBreakdown = query({
	args: {},
	returns: v.object({
		rows: v.array(
			v.object({
				project: v.string(),
				displayName: v.string(),
				clientName: v.string(),
				commitCount: v.number(),
				hours: v.number(),
				sinceMs: v.union(v.number(), v.null()),
				truncated: v.boolean(),
			}),
		),
	}),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		const settings = await loadEffectiveSettings(ctx, userId);
		const clientMap = await loadClientMap(ctx, userId);

		// Only projects with a client can map to a client invoice; unassigned or
		// archived projects have no "since last invoice" cutoff to report.
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_user_name", (q) => q.eq("userId", userId))
			.take(500);
		const kept = projects.filter(
			(p) => !p.archived && p.clientId !== undefined,
		);

		// client → most recent successful invoice `createdAt`. `draft`/`failed`
		// are skipped: a failed generation leaves a row behind but bills nothing.
		const invoices = await ctx.db
			.query("invoices")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.take(1000);
		const clientLastInvoice = new Map<Id<"clients">, number>();
		for (const inv of invoices) {
			if (!isSuccessfulInvoice(inv)) continue;
			const prev = clientLastInvoice.get(inv.clientId);
			if (prev === undefined || inv.createdAt > prev) {
				clientLastInvoice.set(inv.clientId, inv.createdAt);
			}
		}

		const rows = [];
		for (const project of kept) {
			// `kept` filtered out undefined clientId, so this cast is safe.
			const clientId = project.clientId as Id<"clients">;
			const sinceMs = clientLastInvoice.get(clientId) ?? null;
			const cutoff = sinceMs ?? 0;

			// syncedAt >= ts for every row, so {ts >= cutoff} ⊆ {syncedAt >= cutoff}:
			// scan the indexed superset, then narrow by ts in JS (no ts index needed).
			const scanned = await ctx.db
				.query("heartbeats")
				.withIndex("by_user_project_synced", (q) =>
					q
						.eq("userId", userId)
						.eq("project", project.name)
						.gte("syncedAt", cutoff),
				)
				.take(REPO_SCAN_LIMIT + 1);
			const truncated = scanned.length > REPO_SCAN_LIMIT;
			const used = truncated ? scanned.slice(0, REPO_SCAN_LIMIT) : scanned;
			const inWindow = used.filter((r) => r.ts >= cutoff);

			rows.push({
				project: project.name,
				displayName: project.displayName ?? project.name,
				clientName: clientMap.get(clientId)?.name ?? "(unknown client)",
				commitCount: countCommits(inWindow),
				hours: billableMs(inWindow, settings.idleThresholdMs) / MS_PER_HOUR,
				sinceMs,
				truncated,
			});
		}

		// Rank by unbilled hours, and only surface repos with something unbilled —
		// a fully-billed repo has nothing to show on an "unbilled" card.
		return {
			rows: rows
				.filter((r) => r.commitCount > 0 || r.hours > 0)
				.sort((a, b) => b.hours - a.hours),
		};
	},
});

// Time (and, per device, commits) logged within a rolling window, grouped by
// client and by device. One heartbeat scan feeds both breakdowns.
export const activityByWindow = query({
	args: { windowMs: v.number() },
	returns: v.object({
		byClient: v.array(
			v.object({ clientName: v.string(), hours: v.number() }),
		),
		byDevice: v.array(
			v.object({
				deviceName: v.string(),
				hours: v.number(),
				commitCount: v.number(),
			}),
		),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const settings = await loadEffectiveSettings(ctx, userId);
		const clientMap = await loadClientMap(ctx, userId);
		const cutoff = Date.now() - args.windowMs;

		// One scan for both breakdowns. Ordered newest-synced first so that a
		// truncated window keeps the *most recent* rows (the "showing most recent"
		// note the UI surfaces), not the oldest.
		const scanned = await ctx.db
			.query("heartbeats")
			.withIndex("by_user_synced", (q) =>
				q.eq("userId", userId).gte("syncedAt", cutoff),
			)
			.order("desc")
			.take(WINDOW_LIMIT + 1);
		const truncated = scanned.length > WINDOW_LIMIT;
		const used = truncated ? scanned.slice(0, WINDOW_LIMIT) : scanned;
		const rows = used.filter((r) => r.ts >= cutoff);

		// project name → clientId, for the client rollup.
		const projects = await ctx.db
			.query("projects")
			.withIndex("by_user_name", (q) => q.eq("userId", userId))
			.take(500);
		const projectClient = new Map<string, Id<"clients">>();
		for (const p of projects) {
			if (p.clientId !== undefined) projectClient.set(p.name, p.clientId);
		}

		// Group by client (name), folding project-less activity into "Unassigned".
		const clientGroups = new Map<string, Doc<"heartbeats">[]>();
		for (const r of rows) {
			const clientId = projectClient.get(r.project);
			const name = clientId
				? (clientMap.get(clientId)?.name ?? "(unknown client)")
				: "Unassigned";
			const group = clientGroups.get(name);
			if (group === undefined) clientGroups.set(name, [r]);
			else group.push(r);
		}
		const byClient = [...clientGroups.entries()]
			.map(([clientName, hbs]) => ({
				clientName,
				hours: billableMs(hbs, settings.idleThresholdMs) / MS_PER_HOUR,
			}))
			.sort((a, b) => b.hours - a.hours);

		// Group by device.
		const deviceGroups = new Map<string, Doc<"heartbeats">[]>();
		for (const r of rows) {
			const group = deviceGroups.get(r.deviceId);
			if (group === undefined) deviceGroups.set(r.deviceId, [r]);
			else group.push(r);
		}
		// deviceId → name; unnamed devices fall back to the raw id.
		const devices = await ctx.db
			.query("devices")
			.withIndex("by_user_device", (q) => q.eq("userId", userId))
			.take(500);
		const deviceName = new Map<string, string>();
		for (const d of devices) deviceName.set(d.deviceId, d.name);
		const byDevice = [...deviceGroups.entries()]
			.map(([deviceId, hbs]) => ({
				deviceName: deviceName.get(deviceId) ?? deviceId,
				hours: billableMs(hbs, settings.idleThresholdMs) / MS_PER_HOUR,
				commitCount: countCommits(hbs),
			}))
			.sort((a, b) => b.hours - a.hours);

		return { byClient, byDevice, truncated };
	},
});
