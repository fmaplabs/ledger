import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { vi } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

declare global {
	interface ImportMeta {
		glob: (pattern: string) => Record<string, () => Promise<unknown>>;
	}
}

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

// `clients.create`/`update` schedule a Stripe customer push via
// `ctx.scheduler.runAfter(0, ...)`. convex-test runs that through a real
// `setTimeout`, so without intervention the job can fire after a test ends and
// trip its scheduler bookkeeping. These tests don't exercise Stripe, so park the
// timer with fake timers and drop it on teardown — the push never runs.
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

const asUser = (t: ReturnType<typeof convexTest>) =>
	t.withIdentity({ subject: "user-1" });

function pushRows(deviceId: string, rows: Array<Record<string, unknown>>) {
	return {
		deviceId,
		deviceName: `${deviceId}-name`,
		rows: rows.map((r, i) => ({
			uuid: `u${i}`,
			ts: 1_000,
			project: "foo",
			task: "main",
			isWrite: false,
			...r,
		})),
	};
}

describe("settings", () => {
	test("get returns defaults before any row exists", async () => {
		const t = convexTest(schema, modules);
		const s = await asUser(t).query(api.settings.get, {});
		expect(s).toEqual({
			defaultRateCents: 10_000,
			currency: "usd",
			idleThresholdMs: 15 * 60 * 1000,
		});
	});

	test("update upserts, then reflects in get", async () => {
		const t = convexTest(schema, modules);
		await asUser(t).mutation(api.settings.update, {
			defaultRateCents: 12_500,
			currency: "eur",
			idleThresholdMs: 600_000,
		});
		const s = await asUser(t).query(api.settings.get, {});
		expect(s).toEqual({
			defaultRateCents: 12_500,
			currency: "eur",
			idleThresholdMs: 600_000,
		});
	});

	test("rejects unsupported currency and negative rate", async () => {
		const t = convexTest(schema, modules);
		await expect(
			asUser(t).mutation(api.settings.update, {
				defaultRateCents: 10_000,
				currency: "jpy",
			}),
		).rejects.toThrow("Unsupported currency");
		await expect(
			asUser(t).mutation(api.settings.update, {
				defaultRateCents: -1,
				currency: "usd",
			}),
		).rejects.toThrow("non-negative");
	});
});

describe("clients", () => {
	test("create, list, update (incl. clearing rate), archive", async () => {
		const t = convexTest(schema, modules);
		const id = await asUser(t).mutation(api.clients.create, {
			name: "Acme",
			email: "ap@acme.test",
			rateCents: 15_000,
		});

		let clients = await asUser(t).query(api.clients.list, {});
		expect(clients).toEqual([
			{
				_id: id,
				name: "Acme",
				email: "ap@acme.test",
				rateCents: 15_000,
				stripeSynced: false,
			},
		]);

		await asUser(t).mutation(api.clients.update, { id, rateCents: null });
		clients = await asUser(t).query(api.clients.list, {});
		expect(clients[0].rateCents).toBeUndefined();

		await asUser(t).mutation(api.clients.archive, { id });
		clients = await asUser(t).query(api.clients.list, {});
		expect(clients).toEqual([]);
	});

	test("a user cannot update another user's client", async () => {
		const t = convexTest(schema, modules);
		const id = await asUser(t).mutation(api.clients.create, {
			name: "Acme",
			email: "ap@acme.test",
		});
		const asBob = t.withIdentity({ subject: "bob" });
		await expect(
			asBob.mutation(api.clients.update, { id, name: "Hijack" }),
		).rejects.toThrow("Client not found");
	});
});

describe("projects", () => {
	test("resolves effective rate: project override > client > default", async () => {
		const t = convexTest(schema, modules);
		// Auto-register project "foo" via a sync push.
		await asUser(t).mutation(api.sync.push, pushRows("device-a", [{}]));

		let projects = await asUser(t).query(api.projects.list, {});
		expect(projects).toHaveLength(1);
		const projectId = projects[0]._id;
		// No client, no override → global default.
		expect(projects[0].effectiveRateCents).toBe(10_000);

		// Assign a client whose rate is 20000.
		const clientId = await asUser(t).mutation(api.clients.create, {
			name: "Acme",
			email: "ap@acme.test",
			rateCents: 20_000,
		});
		await asUser(t).mutation(api.projects.update, { id: projectId, clientId });
		projects = await asUser(t).query(api.projects.list, {});
		expect(projects[0].clientName).toBe("Acme");
		expect(projects[0].effectiveRateCents).toBe(20_000);

		// Per-project override wins.
		await asUser(t).mutation(api.projects.update, {
			id: projectId,
			rateCents: 25_000,
		});
		projects = await asUser(t).query(api.projects.list, {});
		expect(projects[0].effectiveRateCents).toBe(25_000);

		// Clearing the override falls back to the client rate.
		await asUser(t).mutation(api.projects.update, {
			id: projectId,
			rateCents: null,
		});
		projects = await asUser(t).query(api.projects.list, {});
		expect(projects[0].effectiveRateCents).toBe(20_000);
	});
});
