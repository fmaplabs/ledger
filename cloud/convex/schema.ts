import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Every row is owned by a WorkOS `identity.subject` string (`userId`). New
// billing tables follow the same `by_user_*` index convention as heartbeats.
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
		.index("by_user_synced", ["userId", "syncedAt"])
		// Billing reads all unbilled heartbeats for one project in `syncedAt`
		// order (syncedAt > project.lastBilledSyncedAt).
		.index("by_user_project_synced", ["userId", "project", "syncedAt"]),

	devices: defineTable({
		userId: v.string(),
		deviceId: v.string(),
		name: v.string(),
		lastSeenAt: v.number(),
	}).index("by_user_device", ["userId", "deviceId"]),

	// A billable customer. `rateCents` overrides the global default; a project's
	// own rate overrides this. `stripeCustomerId` is filled on first invoice or
	// by the proactive customer push; `stripeSyncedAt` records the last push.
	clients: defineTable({
		userId: v.string(),
		name: v.string(),
		email: v.string(),
		rateCents: v.optional(v.number()),
		stripeCustomerId: v.optional(v.string()),
		stripeSyncedAt: v.optional(v.number()),
		archived: v.optional(v.boolean()),
	})
		.index("by_user", ["userId"])
		.index("by_user_name", ["userId", "name"])
		// Global (no userId): the Stripe `customer.*` webhook has no user context
		// and Stripe ids are globally unique. Only internal webhook code reads it.
		// Mirrors `invoices.by_stripe_invoice`; tolerates the pre-push `undefined`.
		.index("by_stripe_customer", ["stripeCustomerId"]),

	// A project entity keyed by `name` == heartbeats.project (auto-registered on
	// sync). `lastBilledSyncedAt` is the billing watermark: heartbeats with a
	// larger `syncedAt` are unbilled. `unbilledMsCache` is a dashboard estimate.
	projects: defineTable({
		userId: v.string(),
		name: v.string(),
		displayName: v.optional(v.string()),
		clientId: v.optional(v.id("clients")),
		rateCents: v.optional(v.number()),
		lastBilledSyncedAt: v.optional(v.number()),
		unbilledMsCache: v.optional(v.number()),
		unbilledCacheUpdatedAt: v.optional(v.number()),
		archived: v.optional(v.boolean()),
	})
		.index("by_user_name", ["userId", "name"])
		.index("by_user_client", ["userId", "clientId"]),

	// One config row per user.
	settings: defineTable({
		userId: v.string(),
		defaultRateCents: v.number(),
		currency: v.string(),
		idleThresholdMs: v.optional(v.number()),
	}).index("by_user", ["userId"]),

	// A generated invoice. Money is stored in integer minor units (`cents`). The
	// resolved rate is snapshotted at claim time so later rate edits never
	// re-price a past invoice. `period*SyncedAt` records the billed watermark
	// window for audit. Stripe fields are written authoritatively by the webhook.
	invoices: defineTable({
		userId: v.string(),
		clientId: v.id("clients"),
		projectId: v.id("projects"),
		status: v.union(
			v.literal("draft"),
			v.literal("open"),
			v.literal("paid"),
			v.literal("void"),
			v.literal("failed"),
		),
		stripeInvoiceId: v.optional(v.string()),
		stripeCustomerId: v.optional(v.string()),
		hostedInvoiceUrl: v.optional(v.string()),
		invoicePdfUrl: v.optional(v.string()),
		rateCentsSnapshot: v.number(),
		currency: v.string(),
		hours: v.number(),
		amountCents: v.number(),
		periodStartSyncedAt: v.number(),
		periodEndSyncedAt: v.number(),
		heartbeatCount: v.optional(v.number()),
		createdAt: v.number(),
		finalizedAt: v.optional(v.number()),
		paidAt: v.optional(v.number()),
	})
		.index("by_user", ["userId"])
		.index("by_user_status", ["userId", "status"])
		.index("by_user_project", ["userId", "projectId"])
		// Client → invoices reverse lookup (Project → invoices uses by_user_project).
		.index("by_user_client", ["userId", "clientId"])
		// Global (no userId): the Stripe webhook has no user context and Stripe
		// ids are globally unique. Tolerates the pre-finalize `undefined`.
		.index("by_stripe_invoice", ["stripeInvoiceId"]),
	// A manually-declared unit of billable work for a client. `totalTimeMs` is
	// the declared duration in integer milliseconds — same unit as
	// `unbilledMsCache`/`idleThresholdMs`, so ticket time feeds the existing
	// ms → hours → cents billing math with no unit conversion. `externalId` is
	// the id in the external tracker; unique per user (enforced in the mutation).
	tickets: defineTable({
		userId: v.string(),
		externalId: v.string(),
		description: v.optional(v.string()),
		clientId: v.id("clients"),
		totalTimeMs: v.number(),
		projectId: v.id("projects"),
		name: v.string(),
	})
		// `by_user` orders by _creationTime within a user: list pages read the
		// newest 500 with a desc scan, so growth past the cap drops OLD rows.
		.index("by_user", ["userId"])
		.index("by_user_external", ["userId", "externalId"])
		.index("by_user_client", ["userId", "clientId"])
		.index("by_user_project", ["userId", "projectId"]),
});
