import type { Doc } from "../_generated/dataModel";

// Statuses that advance the billing watermark: a successful generation marks
// its period as billed even if the invoice is later voided. `draft`/`failed`
// leave a row behind but bill nothing. Shared by the dashboard's unbilled
// breakdown and the client detail page's billing period so the two can never
// disagree about what has been billed.
export function isSuccessfulInvoice(inv: Doc<"invoices">): boolean {
	return (
		inv.status === "open" || inv.status === "paid" || inv.status === "void"
	);
}
