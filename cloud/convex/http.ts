import { registerRoutes } from "@convex-dev/stripe";
import type {
	GenericActionCtx,
	GenericDataModel,
} from "convex/server";
import { httpRouter } from "convex/server";
import type Stripe from "stripe";
import { components, internal } from "./_generated/api";
import { authKit } from "./auth";

const http = httpRouter();

// Mounts the WorkOS webhook receiver at /workos/webhook so the component
// can sync user create/update/delete events into its user table.
authKit.registerRoutes(http);

// Reconcile a Stripe invoice event into our own `invoices` table (the source of
// truth). The component verifies the signature and syncs its internal tables
// first, then calls this. Keyed on the id we stamped into metadata, so a crash
// in `generate` after finalize (client already charged) still converges.
async function reconcileInvoice(
	ctx: GenericActionCtx<GenericDataModel>,
	event: Stripe.Event,
) {
	const invoice = event.data.object as Stripe.Invoice;
	await ctx.runMutation(internal.invoices.syncFromStripe, {
		ledgerInvoiceId: invoice.metadata?.ledgerInvoiceId ?? undefined,
		stripeInvoiceId: invoice.id ?? "",
		stripeStatus: invoice.status ?? null,
		hostedInvoiceUrl: invoice.hosted_invoice_url ?? undefined,
		invoicePdfUrl: invoice.invoice_pdf ?? undefined,
	});
}

// Reflect a Stripe `customer.*` edit/delete back into our `clients` table. The
// component syncs its own tables first, then calls this. `syncFromStripe` only
// touches clients we already know and NEVER schedules an outbound push, so this
// handler is the echo loop's dead end (see customerSync.ts).
async function reconcileCustomer(
	ctx: GenericActionCtx<GenericDataModel>,
	event: Stripe.Event,
) {
	const customer = event.data.object as Stripe.Customer;
	await ctx.runMutation(internal.customerSync.syncFromStripe, {
		ledgerClientId: customer.metadata?.ledgerClientId ?? undefined,
		stripeCustomerId: customer.id,
		name: customer.name ?? undefined,
		email: customer.email ?? undefined,
		deleted: event.type === "customer.deleted",
	});
}

// Single shared webhook endpoint (/stripe/webhook) and one STRIPE_WEBHOOK_SECRET.
registerRoutes(http, components.stripe, {
	events: {
		"invoice.finalized": reconcileInvoice,
		"invoice.paid": reconcileInvoice,
		"invoice.payment_failed": reconcileInvoice,
		"invoice.voided": reconcileInvoice,
		"customer.created": reconcileCustomer,
		"customer.updated": reconcileCustomer,
		"customer.deleted": reconcileCustomer,
	},
});

export default http;
