import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ExternalLink, FileText, X } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type Id } from "@/convex-api";
import { formatCents } from "@/lib/money";

// Optional reverse-nav filters, arriving as `?clientId=` / `?projectId=` from
// the Clients and Projects pages. Kept as loose strings here; the Convex `list`
// query validates them as real ids (a bad id simply matches nothing).
type InvoiceSearch = { clientId?: string; projectId?: string };

export const Route = createFileRoute("/_app/invoices")({
	component: InvoicesPage,
	validateSearch: (search: Record<string, unknown>): InvoiceSearch => ({
		clientId: typeof search.clientId === "string" ? search.clientId : undefined,
		projectId:
			typeof search.projectId === "string" ? search.projectId : undefined,
	}),
});

const STATUS: Record<
	string,
	{ label: string; variant: "neutral" | "success" | "warning" | "destructive" }
> = {
	draft: { label: "Draft", variant: "neutral" },
	open: { label: "Awaiting payment", variant: "warning" },
	paid: { label: "Paid", variant: "success" },
	void: { label: "Void", variant: "neutral" },
	failed: { label: "Failed", variant: "destructive" },
};

const dateFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

function InvoicesPage() {
	const { clientId, projectId } = Route.useSearch();
	const invoices = useQuery(api.invoices.list, {
		clientId: clientId as Id<"clients"> | undefined,
		projectId: projectId as Id<"projects"> | undefined,
	});

	const isFiltered = clientId !== undefined || projectId !== undefined;
	// All rows in a filtered list share one client/project, so the first row
	// names the filter; fall back generically when the list is still empty.
	const filterName = clientId
		? (invoices?.[0]?.clientName ?? "this client")
		: (invoices?.[0]?.projectName ?? "this project");

	return (
		<div>
			<PageHeader
				title="Invoices"
				description="Generated with Stripe. Open the PDF or send clients to the hosted payment page."
			/>

			{isFiltered ? (
				<div className="mb-4 flex items-center gap-2">
					<Badge variant="neutral">Invoices for {filterName}</Badge>
					<Button asChild variant="ghost" size="sm">
						<Link to="/invoices" search={{}}>
							<X /> Clear filter
						</Link>
					</Button>
				</div>
			) : null}

			<Card className="p-0">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Client</TableHead>
							<TableHead>Project</TableHead>
							<TableHead>Hours</TableHead>
							<TableHead>Amount</TableHead>
							<TableHead>Status</TableHead>
							<TableHead>Created</TableHead>
							<TableHead className="w-0" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{invoices === undefined ? (
							<TableRow>
								<TableCell colSpan={7} className="text-muted-foreground">
									Loading…
								</TableCell>
							</TableRow>
						) : invoices.length === 0 ? (
							<TableRow>
								<TableCell colSpan={7} className="text-muted-foreground">
									No invoices yet. Generate one from a project.
								</TableCell>
							</TableRow>
						) : (
							invoices.map((inv) => {
								const status = STATUS[inv.status] ?? {
									label: inv.status,
									variant: "neutral" as const,
								};
								return (
									<TableRow key={inv._id}>
										<TableCell className="font-medium">
											{inv.clientName}
										</TableCell>
										<TableCell className="text-muted-foreground">
											{inv.projectName}
										</TableCell>
										<TableCell>{inv.hours.toFixed(2)}h</TableCell>
										<TableCell>
											{formatCents(inv.amountCents, inv.currency)}
										</TableCell>
										<TableCell>
											<Badge variant={status.variant}>{status.label}</Badge>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{dateFmt.format(inv.createdAt)}
										</TableCell>
										<TableCell>
											<div className="flex justify-end gap-1">
												{inv.invoicePdfUrl ? (
													<Button asChild variant="ghost" size="sm">
														<a
															href={inv.invoicePdfUrl}
															target="_blank"
															rel="noreferrer"
														>
															<FileText /> PDF
														</a>
													</Button>
												) : null}
												{inv.hostedInvoiceUrl && inv.status !== "paid" ? (
													<Button asChild variant="outline" size="sm">
														<a
															href={inv.hostedInvoiceUrl}
															target="_blank"
															rel="noreferrer"
														>
															Pay <ExternalLink />
														</a>
													</Button>
												) : null}
											</div>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</Card>
		</div>
	);
}
