import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { requireUserId } from "./lib/auth";

// v1 supports only two-decimal currencies so an integer `cents` amount maps
// 1:1 to Stripe's minor unit. Zero-decimal currencies (JPY, KRW, …) are a
// deliberate follow-up.
export const SUPPORTED_CURRENCIES = [
	"usd",
	"eur",
	"gbp",
	"cad",
	"aud",
	"nzd",
	"chf",
	"sek",
	"nok",
	"dkk",
	"sgd",
	"hkd",
	"inr",
	"brl",
	"mxn",
	"zar",
	"pln",
] as const;

export const DEFAULT_RATE_CENTS = 10_000; // $100.00 / hour
export const DEFAULT_CURRENCY = "usd";
export const DEFAULT_IDLE_MS = 15 * 60 * 1000; // matches the Rust CLI default

export type EffectiveSettings = {
	defaultRateCents: number;
	currency: string;
	idleThresholdMs: number;
};

// The user's settings row folded onto sane defaults. Shared by rate resolution
// and invoice generation so there is one source of truth for the fallbacks.
export async function loadEffectiveSettings(
	ctx: QueryCtx,
	userId: string,
): Promise<EffectiveSettings> {
	const row = await ctx.db
		.query("settings")
		.withIndex("by_user", (q) => q.eq("userId", userId))
		.unique();
	return {
		defaultRateCents: row?.defaultRateCents ?? DEFAULT_RATE_CENTS,
		currency: row?.currency ?? DEFAULT_CURRENCY,
		idleThresholdMs: row?.idleThresholdMs ?? DEFAULT_IDLE_MS,
	};
}

export const get = query({
	args: {},
	returns: v.object({
		defaultRateCents: v.number(),
		currency: v.string(),
		idleThresholdMs: v.number(),
	}),
	handler: async (ctx) => {
		const userId = await requireUserId(ctx);
		return await loadEffectiveSettings(ctx, userId);
	},
});

export const update = mutation({
	args: {
		defaultRateCents: v.number(),
		currency: v.string(),
		idleThresholdMs: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const userId = await requireUserId(ctx);

		if (!Number.isInteger(args.defaultRateCents) || args.defaultRateCents < 0) {
			throw new ConvexError("defaultRateCents must be a non-negative integer");
		}
		if (!SUPPORTED_CURRENCIES.includes(args.currency as never)) {
			throw new ConvexError(`Unsupported currency: ${args.currency}`);
		}
		if (args.idleThresholdMs !== undefined && args.idleThresholdMs <= 0) {
			throw new ConvexError("idleThresholdMs must be positive");
		}

		const existing = await ctx.db
			.query("settings")
			.withIndex("by_user", (q) => q.eq("userId", userId))
			.unique();
		const fields = {
			defaultRateCents: args.defaultRateCents,
			currency: args.currency,
			idleThresholdMs: args.idleThresholdMs,
		};
		if (existing === null) {
			await ctx.db.insert("settings", { userId, ...fields });
		} else {
			await ctx.db.patch(existing._id, fields);
		}
		return null;
	},
});
