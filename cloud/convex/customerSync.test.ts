import { beforeEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

declare global {
	interface ImportMeta {
		glob: (pattern: string) => Record<string, () => Promise<unknown>>;
	}
}

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const USER = "user-1";

// Insert a client row directly (bypassing `clients.create`, which would schedule
// an outbound `pushToStripe` that hits real Stripe). These tests drive
// `syncFromStripe` — the inbound webhook path — in isolation.
async function seedClient(
	t: ReturnType<typeof convexTest>,
	args: { name: string; email: string; stripeCustomerId?: string },
): Promise<Id<"clients">> {
	return await t.run(async (ctx) =>
		ctx.db.insert("clients", {
			userId: USER,
			name: args.name,
			email: args.email,
			stripeCustomerId: args.stripeCustomerId,
		}),
	);
}

let t: ReturnType<typeof convexTest>;
beforeEach(() => {
	t = convexTest(schema, modules);
});

describe("syncFromStripe (customer inbound)", () => {
	test("matches by metadata ledgerClientId (with stripeCustomerId cross-check)", async () => {
		const id = await seedClient(t, {
			name: "Old Name",
			email: "old@acme.test",
			stripeCustomerId: "cus_known",
		});

		await t.mutation(internal.customerSync.syncFromStripe, {
			ledgerClientId: id,
			stripeCustomerId: "cus_known",
			name: "New Name",
			email: "new@acme.test",
			deleted: false,
		});

		const client = await t.run(async (ctx) => ctx.db.get(id));
		expect(client?.name).toBe("New Name");
		expect(client?.email).toBe("new@acme.test");
	});

	test("cross-check rejects stale metadata and falls back to the index", async () => {
		// Metadata points at clientA, but the event's customer id belongs to
		// clientB. The cross-check must reject A and update B instead.
		const clientA = await seedClient(t, {
			name: "A",
			email: "a@acme.test",
			stripeCustomerId: "cus_A",
		});
		const clientB = await seedClient(t, {
			name: "B",
			email: "b@acme.test",
			stripeCustomerId: "cus_B",
		});

		await t.mutation(internal.customerSync.syncFromStripe, {
			ledgerClientId: clientA, // stale — A is linked to cus_A, not cus_B
			stripeCustomerId: "cus_B",
			name: "B Updated",
			email: "b2@acme.test",
			deleted: false,
		});

		const { a, b } = await t.run(async (ctx) => ({
			a: await ctx.db.get(clientA),
			b: await ctx.db.get(clientB),
		}));
		expect(a?.name).toBe("A"); // untouched
		expect(b?.name).toBe("B Updated"); // resolved via the index
		expect(b?.email).toBe("b2@acme.test");
	});

	test("matches by the by_stripe_customer index when metadata is absent", async () => {
		const id = await seedClient(t, {
			name: "Indexed",
			email: "idx@acme.test",
			stripeCustomerId: "cus_idx",
		});

		await t.mutation(internal.customerSync.syncFromStripe, {
			ledgerClientId: undefined,
			stripeCustomerId: "cus_idx",
			name: "Indexed Renamed",
			email: "idx@acme.test",
			deleted: false,
		});

		const client = await t.run(async (ctx) => ctx.db.get(id));
		expect(client?.name).toBe("Indexed Renamed");
	});

	test("skips an unknown customer (no import of arbitrary Stripe customers)", async () => {
		const id = await seedClient(t, {
			name: "Existing",
			email: "existing@acme.test",
			stripeCustomerId: "cus_existing",
		});

		await t.mutation(internal.customerSync.syncFromStripe, {
			ledgerClientId: undefined,
			stripeCustomerId: "cus_unknown", // no client has this id
			name: "Should Not Apply",
			email: "nope@acme.test",
			deleted: false,
		});

		const all = await t.run(async (ctx) =>
			ctx.db.query("clients").collect(),
		);
		expect(all).toHaveLength(1); // nothing created
		expect(all[0]._id).toBe(id);
		expect(all[0].name).toBe("Existing"); // nothing changed
	});

	test("is a no-op when name and email already match", async () => {
		const id = await seedClient(t, {
			name: "Same",
			email: "same@acme.test",
			stripeCustomerId: "cus_noop",
		});

		await t.mutation(internal.customerSync.syncFromStripe, {
			ledgerClientId: id,
			stripeCustomerId: "cus_noop",
			name: "Same",
			email: "same@acme.test",
			deleted: false,
		});

		const client = await t.run(async (ctx) => ctx.db.get(id));
		expect(client?.name).toBe("Same");
		expect(client?.email).toBe("same@acme.test");
		// The no-op guard writes nothing, so `stripeSyncedAt` stays absent.
		expect(client?.stripeSyncedAt).toBeUndefined();
	});

	test("clears stripeCustomerId on customer.deleted", async () => {
		const id = await seedClient(t, {
			name: "ToDelete",
			email: "del@acme.test",
			stripeCustomerId: "cus_del",
		});

		await t.mutation(internal.customerSync.syncFromStripe, {
			ledgerClientId: id,
			stripeCustomerId: "cus_del",
			name: undefined,
			email: undefined,
			deleted: true,
		});

		const client = await t.run(async (ctx) => ctx.db.get(id));
		expect(client?.stripeCustomerId).toBeUndefined();
		// The row itself survives — only the Stripe link is dropped.
		expect(client?.name).toBe("ToDelete");
	});
});
