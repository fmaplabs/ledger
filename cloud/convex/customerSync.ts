import { v } from "convex/values";
import type Stripe from "stripe";
import {
	type ActionCtx,
	internalAction,
	internalMutation,
	internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getStripe } from "./stripe";

// ─── Two-way customer sync: Convex `clients` ↔ Stripe Customers ──────────────
//
// Outbound (Convex → Stripe) is scheduled from the public `clients.create` /
// `clients.update` mutations (see clients.ts) into `pushToStripe`, the only
// place besides `invoices.generate` that talks to Stripe about customers.
//
// Inbound (Stripe → Convex) arrives via the `/stripe/webhook` handler in
// http.ts, which calls `syncFromStripe`. Inbound NEVER schedules an outbound
// push — that dead end is what structurally breaks the echo loop: our own
// outbound `customers.update` re-fires a `customer.updated` webhook, but the
// inbound no-op guard turns it into zero DB writes, so nothing re-fires.

// The subset of a client row the sync paths need. Shared by `getClientForSync`.
type ClientForSync = {
	_id: Id<"clients">;
	userId: string;
	name: string;
	email: string;
	stripeCustomerId?: string;
	archived?: boolean;
};

// Read one client fresh for the outbound push. Fresh read + scheduling only
// `{ clientId }` means the last push wins regardless of run order.
export const getClientForSync = internalQuery({
	args: { clientId: v.id("clients") },
	returns: v.union(
		v.null(),
		v.object({
			_id: v.id("clients"),
			userId: v.string(),
			name: v.string(),
			email: v.string(),
			stripeCustomerId: v.optional(v.string()),
			archived: v.optional(v.boolean()),
		}),
	),
	handler: async (ctx, args): Promise<ClientForSync | null> => {
		const client = await ctx.db.get(args.clientId);
		if (client === null) return null;
		return {
			_id: client._id,
			userId: client.userId,
			name: client.name,
			email: client.email,
			stripeCustomerId: client.stripeCustomerId,
			archived: client.archived,
		};
	},
});

// Create or update the Stripe Customer mirroring a client, and (on create) write
// the new `stripeCustomerId` back. Shared by `invoices.generate` and
// `pushToStripe` so both take the identical, byte-stable path.
//
// The create body is metadata-only so the `client:${id}` idempotency key stays
// byte-stable across retries (Stripe rejects a reused key with changed params);
// name/email are applied in a follow-up `update`. The `if (existing)` branch in
// callers plus the write-back is the primary dedupe — the key only guards the
// short window before the write-back lands.
export async function ensureStripeCustomer(
	stripe: Stripe,
	ctx: ActionCtx,
	args: {
		clientId: Id<"clients">;
		userId: string;
		name: string;
		email: string;
		existingStripeCustomerId?: string;
	},
): Promise<string> {
	const metadata = {
		ledgerClientId: args.clientId,
		ledgerUserId: args.userId,
	};

	if (args.existingStripeCustomerId) {
		await stripe.customers.update(args.existingStripeCustomerId, {
			name: args.name,
			email: args.email,
			metadata,
		});
		return args.existingStripeCustomerId;
	}

	const created = await stripe.customers.create(
		{ metadata },
		{ idempotencyKey: `client:${args.clientId}` },
	);
	await stripe.customers.update(created.id, {
		name: args.name,
		email: args.email,
	});
	// Write-back also stamps `stripeSyncedAt` (see invoices.attachCustomer).
	await ctx.runMutation(internal.invoices.attachCustomer, {
		clientId: args.clientId,
		stripeCustomerId: created.id,
	});
	return created.id;
}

// ─── Outbound (Convex → Stripe), scheduled from clients.create/update ────────

export const pushToStripe = internalAction({
	args: { clientId: v.id("clients") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const client: ClientForSync | null = await ctx.runQuery(
			internal.customerSync.getClientForSync,
			{ clientId: args.clientId },
		);
		// Deleted between schedule and run, or archived → nothing to push.
		if (client === null || client.archived) return null;

		// A failed push must not crash: the row is already written, and the next
		// edit re-schedules a push. Log so it is visible in the Convex dashboard.
		try {
			const stripe = getStripe();
			await ensureStripeCustomer(stripe, ctx, {
				clientId: client._id,
				userId: client.userId,
				name: client.name,
				email: client.email,
				existingStripeCustomerId: client.stripeCustomerId,
			});
		} catch (err) {
			console.error(
				`pushToStripe failed for client ${args.clientId}:`,
				err instanceof Error ? err.message : err,
			);
		}
		return null;
	},
});

// ─── Inbound (Stripe → Convex), from the customer.* webhook ──────────────────
//
// Never schedules an outbound push (breaks the echo loop). Only reflects edits
// to clients we already know — arbitrary Stripe customers are skipped, since
// the user opted into two-way sync, not importing every Stripe customer.
export const syncFromStripe = internalMutation({
	args: {
		ledgerClientId: v.optional(v.string()),
		stripeCustomerId: v.string(),
		name: v.optional(v.string()),
		email: v.optional(v.string()),
		deleted: v.boolean(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Resolve the known client. Prefer the id we stamped into Stripe metadata,
		// but cross-check its stored `stripeCustomerId` matches this event's
		// customer — stale/mismatched metadata falls through to the index.
		let client: Doc<"clients"> | null = null;
		if (args.ledgerClientId) {
			const byId = await ctx.db.get(args.ledgerClientId as Id<"clients">);
			if (byId !== null && byId.stripeCustomerId === args.stripeCustomerId) {
				client = byId;
			}
		}
		if (client === null) {
			client = await ctx.db
				.query("clients")
				.withIndex("by_stripe_customer", (q) =>
					q.eq("stripeCustomerId", args.stripeCustomerId),
				)
				.first();
		}
		// Unknown customer → skip (do not import arbitrary Stripe customers).
		if (client === null) return null;

		if (args.deleted) {
			// The Stripe customer is gone; drop the link. A later edit/invoice
			// re-creates a fresh customer (noted tradeoff).
			await ctx.db.patch(client._id, { stripeCustomerId: undefined });
			return null;
		}

		// Patch only what changed — the no-op guard avoids a redundant write that
		// would needlessly re-fire `useQuery` subscribers (and matters for the
		// echo loop: our own outbound update re-arrives here as a no-op).
		const patch: Partial<Doc<"clients">> = {};
		if (args.name !== undefined && args.name !== client.name) {
			patch.name = args.name;
		}
		if (args.email !== undefined && args.email !== client.email) {
			patch.email = args.email;
		}
		if (Object.keys(patch).length === 0) return null;

		await ctx.db.patch(client._id, patch);
		return null;
	},
});
