import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// import.meta.glob is provided by Vite at runtime; the convex/ tsconfig
// has no vite/client types, so declare just what's used.
declare global {
	interface ImportMeta {
		glob: (pattern: string) => Record<string, () => Promise<unknown>>;
	}
}

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Wide enough that a pair of heartbeats 1h apart collapses into one session,
// so every seeded pair below contributes exactly 1h of billable time.
const IDLE_MS = 2 * HOUR_MS;

type Fixtures = {
	clientId: Id<"clients">;
	projectAId: Id<"projects">;
	projectA: string;
	projectBId: Id<"projects">;
	projectB: string;
};

// Settings (known idle threshold) + one client with two projects, seeded
// directly: projects have no public create mutation and clients.create
// schedules a Stripe push we don't want running in these tests.
async function seedClient(
	t: ReturnType<typeof convexTest>,
	subject: string,
): Promise<Fixtures> {
	return await t.run(async (ctx) => {
		await ctx.db.insert("settings", {
			userId: subject,
			defaultRateCents: 10_000,
			currency: "usd",
			idleThresholdMs: IDLE_MS,
		});
		const clientId = await ctx.db.insert("clients", {
			userId: subject,
			name: `client-of-${subject}`,
			email: `${subject}@example.com`,
		});
		const projectA = `proj-a-of-${subject}`;
		const projectB = `proj-b-of-${subject}`;
		const projectAId = await ctx.db.insert("projects", {
			userId: subject,
			name: projectA,
			clientId,
		});
		const projectBId = await ctx.db.insert("projects", {
			userId: subject,
			name: projectB,
			clientId,
		});
		return { clientId, projectAId, projectA, projectBId, projectB };
	});
}

let uuidCounter = 0;

// Two heartbeats 1h apart (within IDLE_MS) → one session of exactly 1h.
async function seedSessionPair(
	t: ReturnType<typeof convexTest>,
	opts: { userId: string; deviceId: string; project: string; startTs: number },
) {
	await t.run(async (ctx) => {
		for (const ts of [opts.startTs, opts.startTs + HOUR_MS]) {
			await ctx.db.insert("heartbeats", {
				userId: opts.userId,
				deviceId: opts.deviceId,
				uuid: `hb-${uuidCounter++}`,
				ts,
				project: opts.project,
				task: "main",
				isWrite: false,
				syncedAt: ts,
			});
		}
	});
}

async function seedTicket(
	t: ReturnType<typeof convexTest>,
	opts: {
		userId: string;
		clientId: Id<"clients">;
		projectId: Id<"projects">;
		externalId: string;
		totalTimeMs: number;
	},
) {
	await t.run(async (ctx) => {
		await ctx.db.insert("tickets", {
			userId: opts.userId,
			externalId: opts.externalId,
			name: `ticket ${opts.externalId}`,
			clientId: opts.clientId,
			projectId: opts.projectId,
			totalTimeMs: opts.totalTimeMs,
		});
	});
}

describe("clients.get", () => {
	test("returns the client view for its owner", async () => {
		const t = convexTest(schema, modules);
		const fx = await seedClient(t, "user-1");
		const asUser = t.withIdentity({ subject: "user-1" });

		const client = await asUser.query(api.clients.get, { id: fx.clientId });
		expect(client).toEqual({
			_id: fx.clientId,
			name: "client-of-user-1",
			email: "user-1@example.com",
			stripeSynced: false,
		});
	});

	test("returns null for a foreign client", async () => {
		const t = convexTest(schema, modules);
		const theirs = await seedClient(t, "user-2");
		const asUser = t.withIdentity({ subject: "user-1" });

		const client = await asUser.query(api.clients.get, {
			id: theirs.clientId,
		});
		expect(client).toBeNull();
	});

	test("still returns an archived client — its tickets keep linking here", async () => {
		const t = convexTest(schema, modules);
		const fx = await seedClient(t, "user-1");
		const asUser = t.withIdentity({ subject: "user-1" });

		await asUser.mutation(api.clients.archive, { id: fx.clientId });
		const client = await asUser.query(api.clients.get, { id: fx.clientId });
		expect(client).toMatchObject({ _id: fx.clientId });
	});

	test("returns null (not a validation error) for a malformed id", async () => {
		const t = convexTest(schema, modules);
		await seedClient(t, "user-1");
		const asUser = t.withIdentity({ subject: "user-1" });

		const client = await asUser.query(api.clients.get, { id: "not-an-id" });
		expect(client).toBeNull();
	});
});

describe("clients.hoursSummary", () => {
	test("never invoiced: unions tracked time across projects/devices; windows bucket by ts", async () => {
		const t = convexTest(schema, modules);
		const fx = await seedClient(t, "user-1");
		const asUser = t.withIdentity({ subject: "user-1" });
		const now = Date.now();

		// Two same-wall-clock sessions on different devices AND projects — the
		// combined union must count this hour once, not twice.
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-1",
			project: fx.projectA,
			startTs: now - 10 * DAY_MS,
		});
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-2",
			project: fx.projectB,
			startTs: now - 10 * DAY_MS,
		});
		// One session per trailing window, days away from every boundary.
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-1",
			project: fx.projectA,
			startTs: now - 60 * DAY_MS, // inside 3m
		});
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-2",
			project: fx.projectB,
			startTs: now - 120 * DAY_MS, // inside 6m only
		});
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-1",
			project: fx.projectA,
			startTs: now - 300 * DAY_MS, // inside 1y only
		});
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-1",
			project: fx.projectA,
			startTs: now - 400 * DAY_MS, // outside 1y; all-history billing period only
		});

		await seedTicket(t, {
			userId: "user-1",
			clientId: fx.clientId,
			projectId: fx.projectAId,
			externalId: "T-1",
			totalTimeMs: 2 * HOUR_MS,
		});
		await seedTicket(t, {
			userId: "user-1",
			clientId: fx.clientId,
			projectId: fx.projectBId,
			externalId: "T-2",
			totalTimeMs: 3 * HOUR_MS,
		});

		const summary = await asUser.query(api.clients.hoursSummary, {
			clientId: fx.clientId,
		});

		expect(summary.truncated).toBe(false);
		expect(summary.periods.map((p) => p.key)).toEqual([
			"billingPeriod",
			"3m",
			"6m",
			"1y",
		]);
		const [billing, m3, m6, y1] = summary.periods;

		// Never invoiced → all history: the overlap counts once (1h), plus one
		// hour each at 60/120/300/400 days back.
		expect(billing.sinceMs).toBeNull();
		expect(billing.trackedMs).toBe(5 * HOUR_MS);
		expect(m3.trackedMs).toBe(2 * HOUR_MS);
		expect(m6.trackedMs).toBe(3 * HOUR_MS);
		expect(y1.trackedMs).toBe(4 * HOUR_MS);

		// Trailing cutoffs are anchored at the handler's `now`, a hair after
		// the test's — assert the window, not exact equality.
		expect(m3.sinceMs).toBeGreaterThanOrEqual(now - 90 * DAY_MS);
		expect(m3.sinceMs).toBeLessThan(now - 89 * DAY_MS);
		expect(m6.sinceMs).toBeGreaterThanOrEqual(now - 180 * DAY_MS);
		expect(y1.sinceMs).toBeGreaterThanOrEqual(now - 365 * DAY_MS);

		// Tickets get their real insert-time _creationTime, which is inside
		// every window (and a null billing cutoff counts all tickets).
		for (const p of summary.periods) {
			expect(p.ticketMs).toBe(5 * HOUR_MS);
		}
	});

	test("an open invoice's createdAt is the billing-period watermark; draft is ignored", async () => {
		const t = convexTest(schema, modules);
		const fx = await seedClient(t, "user-1");
		const asUser = t.withIdentity({ subject: "user-1" });
		const now = Date.now();
		const cutoff = now - 30 * DAY_MS;

		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-1",
			project: fx.projectA,
			startTs: now - 10 * DAY_MS, // after the watermark
		});
		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-2",
			project: fx.projectB,
			startTs: now - 60 * DAY_MS, // before the watermark, inside 3m
		});

		await t.run(async (ctx) => {
			const invoice = {
				userId: "user-1",
				clientId: fx.clientId,
				projectId: fx.projectAId,
				rateCentsSnapshot: 10_000,
				currency: "usd",
				hours: 1,
				amountCents: 10_000,
				periodStartSyncedAt: 0,
				periodEndSyncedAt: cutoff,
			};
			await ctx.db.insert("invoices", {
				...invoice,
				status: "open",
				createdAt: cutoff,
			});
			// A later draft must NOT move the watermark: it billed nothing.
			await ctx.db.insert("invoices", {
				...invoice,
				status: "draft",
				createdAt: now - 5 * DAY_MS,
			});
		});

		await seedTicket(t, {
			userId: "user-1",
			clientId: fx.clientId,
			projectId: fx.projectAId,
			externalId: "T-1",
			totalTimeMs: 2 * HOUR_MS,
		});

		const summary = await asUser.query(api.clients.hoursSummary, {
			clientId: fx.clientId,
		});
		const [billing, m3] = summary.periods;

		expect(billing.sinceMs).toBe(cutoff);
		expect(billing.trackedMs).toBe(1 * HOUR_MS);
		expect(m3.trackedMs).toBe(2 * HOUR_MS);
		// The ticket was created now, after the watermark.
		expect(billing.ticketMs).toBe(2 * HOUR_MS);
		expect(summary.truncated).toBe(false);
	});

	test("tickets bucket by _creationTime: a future watermark excludes them from the billing period", async () => {
		// Ticket _creationTime is assigned at insert (it can't be back-dated),
		// so a watermark ahead of "now" is the one hand-checkable way to see
		// the billing period exclude a ticket while the windows keep it.
		const t = convexTest(schema, modules);
		const fx = await seedClient(t, "user-1");
		const asUser = t.withIdentity({ subject: "user-1" });
		const now = Date.now();
		const cutoff = now + 5 * 60_000; // 5 minutes ahead

		await seedSessionPair(t, {
			userId: "user-1",
			deviceId: "device-1",
			project: fx.projectA,
			startTs: now - 10 * DAY_MS,
		});
		await t.run(async (ctx) => {
			await ctx.db.insert("invoices", {
				userId: "user-1",
				clientId: fx.clientId,
				projectId: fx.projectAId,
				status: "paid",
				rateCentsSnapshot: 10_000,
				currency: "usd",
				hours: 1,
				amountCents: 10_000,
				periodStartSyncedAt: 0,
				periodEndSyncedAt: cutoff,
				createdAt: cutoff,
				paidAt: cutoff,
			});
		});
		await seedTicket(t, {
			userId: "user-1",
			clientId: fx.clientId,
			projectId: fx.projectAId,
			externalId: "T-1",
			totalTimeMs: 2 * HOUR_MS,
		});

		const summary = await asUser.query(api.clients.hoursSummary, {
			clientId: fx.clientId,
		});
		const [billing, m3] = summary.periods;

		expect(billing.sinceMs).toBe(cutoff);
		expect(billing.trackedMs).toBe(0);
		expect(billing.ticketMs).toBe(0);
		expect(m3.trackedMs).toBe(1 * HOUR_MS);
		expect(m3.ticketMs).toBe(2 * HOUR_MS);
	});

	test("rejects a foreign client", async () => {
		const t = convexTest(schema, modules);
		const theirs = await seedClient(t, "user-2");
		const asUser = t.withIdentity({ subject: "user-1" });
		await expect(
			asUser.query(api.clients.hoursSummary, { clientId: theirs.clientId }),
		).rejects.toThrow("Client not found");
	});

	test("rejects unauthenticated callers", async () => {
		const t = convexTest(schema, modules);
		const fx = await seedClient(t, "user-1");
		await expect(
			t.query(api.clients.hoursSummary, { clientId: fx.clientId }),
		).rejects.toThrow("Not authenticated");
	});
});
