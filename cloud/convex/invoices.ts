import { ConvexError, v } from "convex/values";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/auth";
import { loadEffectiveSettings } from "./settings";
import { resolveRateCents } from "./lib/rates";
import { billableMs, type DeviceHeartbeat } from "./lib/sessions";
import { getStripe } from "./stripe";
import { ensureStripeCustomer } from "./customerSync";

const MS_PER_HOUR = 3_600_000;
// Single-query preview is bounded; the authoritative `generate` path paginates.
const PREVIEW_LIMIT = 10_000;
// Page size for the paginated hour computation inside the action.
const WINDOW_PAGE = 4_000;

function amountCentsFor(totalMs: number, rateCents: number): number {
	// Round to cents exactly once, over the total (never per session).
	return Math.round((totalMs * rateCents) / MS_PER_HOUR);
}

function toInvoiceStatus(
	stripeStatus: string | null,
): "open" | "paid" | "void" | "failed" {
	switch (stripeStatus) {
		case "paid":
			return "paid";
		case "void":
			return "void";
		case "uncollectible":
			return "failed";
		default:
			return "open"; // draft→finalized invoices report as "open"
	}
}

// ─── Preview (read-only) ────────────────────────────────────────────────────

export const previewUnbilled = query({
	args: { projectId: v.id("projects") },
	returns: v.object({
		hours: v.number(),
		amountCents: v.number(),
		rateCents: v.number(),
		currency: v.string(),
		heartbeatCount: v.number(),
		hasClient: v.boolean(),
		truncated: v.boolean(),
	}),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const project = await ctx.db.get(args.projectId);
		if (project === null || project.userId !== userId) {
			throw new ConvexError("Project not found");
		}
		const settings = await loadEffectiveSettings(ctx, userId);
		const client = project.clientId ? await ctx.db.get(project.clientId) : null;
		const rateCents = resolveRateCents(project, client, settings);
		const from = project.lastBilledSyncedAt ?? 0;

		const rows = await ctx.db
			.query("heartbeats")
			.withIndex("by_user_project_synced", (q) =>
				q.eq("userId", userId).eq("project", project.name).gt("syncedAt", from),
			)
			.take(PREVIEW_LIMIT + 1);
		const truncated = rows.length > PREVIEW_LIMIT;
		const used = truncated ? rows.slice(0, PREVIEW_LIMIT) : rows;

		const totalMs = billableMs(used, settings.idleThresholdMs);
		return {
			hours: totalMs / MS_PER_HOUR,
			amountCents: amountCentsFor(totalMs, rateCents),
			rateCents,
			currency: settings.currency,
			heartbeatCount: used.length,
			hasClient: project.clientId !== undefined,
			truncated,
		};
	},
});

// ─── Claim (transactional watermark advance) ────────────────────────────────

type GenerateResult = {
	status: "created" | "empty" | "error";
	invoiceId?: Id<"invoices">;
	amountCents?: number;
	hours?: number;
	hostedInvoiceUrl?: string;
	invoicePdfUrl?: string;
	message?: string;
};

type ClaimResult =
	| { empty: true }
	| {
		empty: false;
		invoiceId: Id<"invoices">;
		userId: string;
		projectName: string;
		projectDisplay: string;
		fromCursor: number;
		toCursor: number;
		rateCents: number;
		currency: string;
		idleThresholdMs: number;
		clientId: Id<"clients">;
		clientEmail: string;
		clientName: string;
		stripeCustomerId?: string;
	};

// Atomically claim everything unbilled for a project by advancing the project's
// `lastBilledSyncedAt` watermark (a single-document write — race-safe via OCC).
// Creates a draft invoice snapshotting the resolved rate. Hours/amount are filled
// in later by the action (they need a paginated read). Returns a sentinel when
// there is nothing new to bill so the action never creates a $0 Stripe invoice.
export const claimUnbilled = internalMutation({
	args: { projectId: v.id("projects") },
	returns: v.union(
		v.object({ empty: v.literal(true) }),
		v.object({
			empty: v.literal(false),
			invoiceId: v.id("invoices"),
			userId: v.string(),
			projectName: v.string(),
			projectDisplay: v.string(),
			fromCursor: v.number(),
			toCursor: v.number(),
			rateCents: v.number(),
			currency: v.string(),
			idleThresholdMs: v.number(),
			clientId: v.id("clients"),
			clientEmail: v.string(),
			clientName: v.string(),
			stripeCustomerId: v.optional(v.string()),
		}),
	),
	handler: async (ctx, args): Promise<ClaimResult> => {
		const userId = await requireUserId(ctx);
		const project = await ctx.db.get(args.projectId);
		if (project === null || project.userId !== userId) {
			throw new ConvexError("Project not found");
		}
		if (project.clientId === undefined) {
			throw new ConvexError("Assign this project to a client before invoicing.");
		}
		const client = await ctx.db.get(project.clientId);
		if (client === null || client.userId !== userId) {
			throw new ConvexError("Client not found");
		}
		const settings = await loadEffectiveSettings(ctx, userId);
		const rateCents = resolveRateCents(project, client, settings);
		const fromCursor = project.lastBilledSyncedAt ?? 0;

		// Newest unbilled syncedAt — the window's upper bound (inclusive).
		const newest = await ctx.db
			.query("heartbeats")
			.withIndex("by_user_project_synced", (q) =>
				q
					.eq("userId", userId)
					.eq("project", project.name)
					.gt("syncedAt", fromCursor),
			)
			.order("desc")
			.first();
		if (newest === null) {
			return { empty: true };
		}
		const toCursor = newest.syncedAt;

		const now = Date.now();
		const invoiceId = await ctx.db.insert("invoices", {
			userId,
			clientId: project.clientId,
			projectId: project._id,
			status: "draft",
			rateCentsSnapshot: rateCents,
			currency: settings.currency,
			hours: 0,
			amountCents: 0,
			periodStartSyncedAt: fromCursor,
			periodEndSyncedAt: toCursor,
			createdAt: now,
		});
		// The watermark advance is the lock: a concurrent claim conflicts here.
		await ctx.db.patch(project._id, { lastBilledSyncedAt: toCursor });

		return {
			empty: false,
			invoiceId,
			userId,
			projectName: project.name,
			projectDisplay: project.displayName ?? project.name,
			fromCursor,
			toCursor,
			rateCents,
			currency: settings.currency,
			idleThresholdMs: settings.idleThresholdMs,
			clientId: project.clientId,
			clientEmail: client.email,
			clientName: client.name,
			stripeCustomerId: client.stripeCustomerId,
		};
	},
});

// One page of heartbeats in the claimed window, minimal shape, for the action to
// accumulate and sessionize. Paginated to stay within the per-query read cap.
export const windowPage = internalQuery({
	args: {
		projectName: v.string(),
		fromCursor: v.number(),
		toCursor: v.number(),
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
					.gt("syncedAt", args.fromCursor)
					.lte("syncedAt", args.toCursor),
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

// ─── Mutations the action uses to persist Stripe results ────────────────────

export const attachCustomer = internalMutation({
	args: { clientId: v.id("clients"), stripeCustomerId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		// `stripeSyncedAt` records the last successful push, so the write-back
		// that first links the customer also stamps it.
		await ctx.db.patch(args.clientId, {
			stripeCustomerId: args.stripeCustomerId,
			stripeSyncedAt: Date.now(),
		});
		return null;
	},
});

export const attachStripe = internalMutation({
	args: {
		invoiceId: v.id("invoices"),
		stripeInvoiceId: v.string(),
		stripeCustomerId: v.string(),
		hostedInvoiceUrl: v.optional(v.string()),
		invoicePdfUrl: v.optional(v.string()),
		status: v.union(
			v.literal("open"),
			v.literal("paid"),
			v.literal("void"),
			v.literal("failed"),
		),
		hours: v.number(),
		amountCents: v.number(),
		heartbeatCount: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.invoiceId, {
			stripeInvoiceId: args.stripeInvoiceId,
			stripeCustomerId: args.stripeCustomerId,
			hostedInvoiceUrl: args.hostedInvoiceUrl,
			invoicePdfUrl: args.invoicePdfUrl,
			status: args.status,
			hours: args.hours,
			amountCents: args.amountCents,
			heartbeatCount: args.heartbeatCount,
			finalizedAt: Date.now(),
		});
		return null;
	},
});

// Mark a draft invoice failed and roll the project watermark back to before the
// claim — but only if nothing newer advanced it in the meantime.
export const failInvoice = internalMutation({
	args: {
		invoiceId: v.id("invoices"),
		projectId: v.id("projects"),
		fromCursor: v.number(),
		toCursor: v.number(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.patch(args.invoiceId, { status: "failed" });
		const project = await ctx.db.get(args.projectId);
		if (project && project.lastBilledSyncedAt === args.toCursor) {
			await ctx.db.patch(args.projectId, {
				lastBilledSyncedAt: args.fromCursor === 0 ? undefined : args.fromCursor,
			});
		}
		return null;
	},
});

// ─── Generate (action — the only place that talks to Stripe) ────────────────

export const generate = action({
	args: { projectId: v.id("projects") },
	returns: v.object({
		status: v.union(
			v.literal("created"),
			v.literal("empty"),
			v.literal("error"),
		),
		invoiceId: v.optional(v.id("invoices")),
		amountCents: v.optional(v.number()),
		hours: v.optional(v.number()),
		hostedInvoiceUrl: v.optional(v.string()),
		invoicePdfUrl: v.optional(v.string()),
		message: v.optional(v.string()),
	}),
	handler: async (ctx, args): Promise<GenerateResult> => {
		const claim: ClaimResult = await ctx.runMutation(
			internal.invoices.claimUnbilled,
			{ projectId: args.projectId },
		);
		if (claim.empty) {
			return { status: "empty" as const };
		}

		// Paginate the claimed window, accumulating heartbeats to sessionize.
		const rows: DeviceHeartbeat[] = [];
		let cursor: string | null = null;
		for (; ;) {
			const res: {
				page: DeviceHeartbeat[];
				isDone: boolean;
				continueCursor: string;
			} = await ctx.runQuery(internal.invoices.windowPage, {
				projectName: claim.projectName,
				fromCursor: claim.fromCursor,
				toCursor: claim.toCursor,
				cursor,
				numItems: WINDOW_PAGE,
			});
			rows.push(...res.page);
			if (res.isDone) break;
			cursor = res.continueCursor;
		}

		const totalMs = billableMs(rows, claim.idleThresholdMs);
		const amountCents = amountCentsFor(totalMs, claim.rateCents);
		const hours = totalMs / MS_PER_HOUR;

		// No billable time (e.g. only lone heartbeats): release and stop before
		// Stripe — a $0 finalized invoice would auto-pay and email the client.
		if (amountCents <= 0) {
			await ctx.runMutation(internal.invoices.failInvoice, {
				invoiceId: claim.invoiceId,
				projectId: args.projectId,
				fromCursor: claim.fromCursor,
				toCursor: claim.toCursor,
			});
			return { status: "empty" as const };
		}

		try {
			const stripe = getStripe();
			const ledgerInvoiceId = claim.invoiceId;

			// Same byte-stable create/update path the proactive push uses, so a
			// client first seen at invoice time and one already synced converge.
			const customerId = await ensureStripeCustomer(stripe, ctx, {
				clientId: claim.clientId,
				userId: claim.userId,
				name: claim.clientName,
				email: claim.clientEmail,
				existingStripeCustomerId: claim.stripeCustomerId,
			});

			const description = `${claim.projectDisplay} — ${hours.toFixed(2)} hours`;

			// Invoice first so the line item can be bound to it explicitly; exclude
			// stray pending items so only our line lands on this invoice.
			const invoice = await stripe.invoices.create(
				{
					customer: customerId,
					collection_method: "send_invoice",
					days_until_due: 30,
					pending_invoice_items_behavior: "exclude",
					currency: claim.currency,
					description,
					metadata: {
						ledgerInvoiceId,
						ledgerClientId: claim.clientId,
						ledgerProjectId: args.projectId,
					},
				},
				{ idempotencyKey: `invoice:${ledgerInvoiceId}` },
			);
			await stripe.invoiceItems.create(
				{
					customer: customerId,
					invoice: invoice.id,
					amount: amountCents,
					currency: claim.currency,
					description,
				},
				{ idempotencyKey: `item:${ledgerInvoiceId}` },
			);
			const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
			// Email the hosted invoice so the client can pay through Stripe.
			await stripe.invoices.sendInvoice(invoice.id);

			await ctx.runMutation(internal.invoices.attachStripe, {
				invoiceId: claim.invoiceId,
				stripeInvoiceId: finalized.id,
				stripeCustomerId: customerId,
				hostedInvoiceUrl: finalized.hosted_invoice_url ?? undefined,
				invoicePdfUrl: finalized.invoice_pdf ?? undefined,
				status: toInvoiceStatus(finalized.status),
				hours,
				amountCents,
				heartbeatCount: rows.length,
			});

			return {
				status: "created" as const,
				invoiceId: claim.invoiceId,
				amountCents,
				hours,
				hostedInvoiceUrl: finalized.hosted_invoice_url ?? undefined,
				invoicePdfUrl: finalized.invoice_pdf ?? undefined,
			};
		} catch (err) {
			await ctx.runMutation(internal.invoices.failInvoice, {
				invoiceId: claim.invoiceId,
				projectId: args.projectId,
				fromCursor: claim.fromCursor,
				toCursor: claim.toCursor,
			});
			return {
				status: "error" as const,
				message: err instanceof Error ? err.message : "Stripe request failed",
			};
		}
	},
});

// ─── Webhook reconciliation (no user context — internal only) ───────────────

export const syncFromStripe = internalMutation({
	args: {
		ledgerInvoiceId: v.optional(v.string()),
		stripeInvoiceId: v.string(),
		stripeStatus: v.union(v.string(), v.null()),
		hostedInvoiceUrl: v.optional(v.string()),
		invoicePdfUrl: v.optional(v.string()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		// Prefer the id we stamped into Stripe metadata; fall back to the global
		// stripe-invoice index for anything created out of band.
		let invoice: Doc<"invoices"> | null = null;
		if (args.ledgerInvoiceId) {
			invoice = await ctx.db.get(
				args.ledgerInvoiceId as Id<"invoices">,
			);
		}
		if (invoice === null) {
			invoice = await ctx.db
				.query("invoices")
				.withIndex("by_stripe_invoice", (q) =>
					q.eq("stripeInvoiceId", args.stripeInvoiceId),
				)
				.unique();
		}
		if (invoice === null) return null;

		const status = toInvoiceStatus(args.stripeStatus);
		const patch: Partial<Doc<"invoices">> = {
			stripeInvoiceId: args.stripeInvoiceId,
			status,
		};
		if (args.hostedInvoiceUrl) patch.hostedInvoiceUrl = args.hostedInvoiceUrl;
		if (args.invoicePdfUrl) patch.invoicePdfUrl = args.invoicePdfUrl;
		if (status === "paid" && invoice.paidAt === undefined) {
			patch.paidAt = Date.now();
		}
		// Any invoice event (finalized/paid/voided) implies the invoice left draft.
		if (invoice.finalizedAt === undefined) {
			patch.finalizedAt = Date.now();
		}
		await ctx.db.patch(invoice._id, patch);
		return null;
	},
});

// ─── Listing ────────────────────────────────────────────────────────────────

const invoiceView = v.object({
	_id: v.id("invoices"),
	clientName: v.string(),
	projectName: v.string(),
	status: v.string(),
	hours: v.number(),
	amountCents: v.number(),
	currency: v.string(),
	hostedInvoiceUrl: v.optional(v.string()),
	invoicePdfUrl: v.optional(v.string()),
	createdAt: v.number(),
	paidAt: v.optional(v.number()),
});

export const list = query({
	// Optional filters power reverse-nav (Client→invoices, Project→invoices).
	// `clientId` takes precedence over `projectId`; neither → all of the user's.
	args: {
		clientId: v.optional(v.id("clients")),
		projectId: v.optional(v.id("projects")),
	},
	returns: v.array(invoiceView),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const { clientId, projectId } = args;
		const filtered = clientId
			? ctx.db
					.query("invoices")
					.withIndex("by_user_client", (q) =>
						q.eq("userId", userId).eq("clientId", clientId),
					)
			: projectId
				? ctx.db
						.query("invoices")
						.withIndex("by_user_project", (q) =>
							q.eq("userId", userId).eq("projectId", projectId),
						)
				: ctx.db
						.query("invoices")
						.withIndex("by_user", (q) => q.eq("userId", userId));
		const invoices = await filtered.order("desc").take(500);

		const clientMap = new Map<Id<"clients">, string>();
		const projectMap = new Map<Id<"projects">, string>();
		for (const inv of invoices) {
			if (!clientMap.has(inv.clientId)) {
				const c = await ctx.db.get(inv.clientId);
				if (c) clientMap.set(inv.clientId, c.name);
			}
			if (!projectMap.has(inv.projectId)) {
				const p = await ctx.db.get(inv.projectId);
				if (p) projectMap.set(inv.projectId, p.displayName ?? p.name);
			}
		}

		return invoices.map((inv) => ({
			_id: inv._id,
			clientName: clientMap.get(inv.clientId) ?? "(deleted)",
			projectName: projectMap.get(inv.projectId) ?? "(deleted)",
			status: inv.status,
			hours: inv.hours,
			amountCents: inv.amountCents,
			currency: inv.currency,
			hostedInvoiceUrl: inv.hostedInvoiceUrl,
			invoicePdfUrl: inv.invoicePdfUrl,
			createdAt: inv.createdAt,
			paidAt: inv.paidAt,
		}));
	},
});

// Manual fallback for the out-of-band case (payment collected outside Stripe).
export const markPaid = mutation({
	args: { id: v.id("invoices") },
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);
		const invoice = await ctx.db.get(args.id);
		if (invoice === null || invoice.userId !== userId) {
			throw new ConvexError("Invoice not found");
		}
		await ctx.db.patch(args.id, { status: "paid", paidAt: Date.now() });
		return null;
	},
});
