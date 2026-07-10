import type { GenericActionCtx, GenericQueryCtx } from "convex/server";
import { ConvexError } from "convex/values";
import type { DataModel } from "../_generated/dataModel";

// The authenticated user's id. We use WorkOS `identity.subject` (not
// `tokenIdentifier`) because the existing `heartbeats`/`devices` data — and
// every new billing table — is keyed by `subject`, and invoicing must join
// against heartbeats. Keep this the single source of the ownership key.
export async function requireUserId(ctx: {
	auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}): Promise<string> {
	const identity = await ctx.auth.getUserIdentity();
	if (identity === null) {
		throw new ConvexError("Not authenticated");
	}
	return identity.subject;
}

// Same as `requireUserId` but returns null instead of throwing — for read
// paths that render an empty state when signed out.
export async function getUserId(
	ctx: GenericQueryCtx<DataModel> | GenericActionCtx<DataModel>,
): Promise<string | null> {
	const identity = await ctx.auth.getUserIdentity();
	return identity?.subject ?? null;
}
