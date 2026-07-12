import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { ArrowLeft, Check, ExternalLink, Plus } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { TicketFormDialog } from "@/components/ticket-form-dialog";
import { TicketsSection } from "@/components/tickets-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/convex-api";
import { formatRate } from "@/lib/money";
import { formatHours } from "@/lib/time";

export const Route = createFileRoute("/_app/clients_/$clientId")({
	component: ClientDetailPage,
});

// Tile order + labels for the four hoursSummary windows.
const PERIODS = [
	{ key: "billingPeriod", label: "Current period" },
	{ key: "3m", label: "Last 3 months" },
	{ key: "6m", label: "Last 6 months" },
	{ key: "1y", label: "Last year" },
] as const;

function ClientDetailPage() {
	const { clientId } = Route.useParams();
	// Raw param: the query normalizes it and reads null for malformed ids.
	const client = useQuery(api.clients.get, { id: clientId });
	const settings = useQuery(api.settings.get, {});
	const currency = settings?.currency ?? "usd";
	// Skip-gated on `get` so a stale/foreign id never fires them.
	const hours = useQuery(
		api.clients.hoursSummary,
		client ? { clientId: client._id } : "skip",
	);
	const tickets = useQuery(
		api.tickets.listByClient,
		client ? { clientId: client._id } : "skip",
	);
	const [creating, setCreating] = useState(false);

	if (client === undefined) {
		return (
			<div className="flex flex-col gap-3">
				<div className="h-8 w-48 animate-pulse rounded bg-muted" />
				<div className="h-4 w-64 animate-pulse rounded bg-muted" />
				<div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{["s1", "s2", "s3", "s4"].map((k) => (
						<div key={k} className="h-24 animate-pulse rounded-xl bg-muted" />
					))}
				</div>
			</div>
		);
	}

	if (client === null) {
		return (
			<div>
				<PageHeader
					title="Client not found"
					description="This client doesn't exist or the link is stale."
				/>
				<Button asChild variant="outline" size="sm">
					<Link to="/clients">
						<ArrowLeft /> Back to clients
					</Link>
				</Button>
			</div>
		);
	}

	return (
		<div>
			<PageHeader title={client.name} description={client.email}>
				{client.rateCents !== undefined ? (
					<span className="text-sm text-muted-foreground">
						{formatRate(client.rateCents, currency)}
					</span>
				) : null}
				<StripeStatus client={client} />
				<Button size="sm" onClick={() => setCreating(true)}>
					<Plus /> New ticket
				</Button>
			</PageHeader>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				{PERIODS.map((p) => {
					const period = hours?.periods.find((x) => x.key === p.key);
					return (
						<HoursTile
							key={p.key}
							label={p.label}
							hint={
								p.key === "billingPeriod" && period
									? period.sinceMs === null
										? "all time"
										: `since ${new Date(period.sinceMs).toLocaleDateString()}`
									: undefined
							}
							trackedMs={period?.trackedMs}
							ticketMs={period?.ticketMs}
						/>
					);
				})}
			</div>
			{hours?.truncated ? (
				<p className="mt-2 text-xs text-muted-foreground">
					Totals cover the most recent activity only — history past the scan
					cap is excluded.
				</p>
			) : null}

			<h2 className="mt-6 mb-3 font-heading text-lg font-semibold tracking-tight">
				Tickets
			</h2>
			<TicketsSection tickets={tickets} showClient={false} />

			{creating ? (
				<TicketFormDialog
					defaultClientId={client._id}
					onClose={() => setCreating(false)}
				/>
			) : null}
		</div>
	);
}

/** One hours window, mirroring the dashboard's StatCard look. */
function HoursTile({
	label,
	hint,
	trackedMs,
	ticketMs,
}: {
	label: string;
	hint?: string;
	trackedMs: number | undefined;
	ticketMs: number | undefined;
}) {
	return (
		<Card>
			<CardContent className="flex flex-col gap-1 py-1">
				<span className="text-sm text-muted-foreground">{label}</span>
				<span className="font-heading text-2xl font-semibold tabular-nums tracking-tight">
					{trackedMs === undefined ? "—" : formatHours(trackedMs)}
				</span>
				{ticketMs !== undefined ? (
					<span className="text-xs text-muted-foreground">
						+ {formatHours(ticketMs)} ticketed
					</span>
				) : null}
				{hint ? (
					<span className="text-xs text-muted-foreground">{hint}</span>
				) : null}
			</CardContent>
		</Card>
	);
}

/** The synced/pending Stripe badge, presented exactly like the list page. */
function StripeStatus({
	client,
}: {
	client: { name: string; stripeSynced: boolean; stripeCustomerId?: string };
}) {
	return client.stripeSynced && client.stripeCustomerId ? (
		// Synced → link the badge to the Stripe dashboard. The mode-agnostic URL
		// resolves to the customer's own (test/live) mode.
		<a
			href={`https://dashboard.stripe.com/customers/${client.stripeCustomerId}`}
			target="_blank"
			rel="noreferrer"
			aria-label={`Open ${client.name} in Stripe`}
		>
			<Badge variant="success">
				<Check /> Synced <ExternalLink />
			</Badge>
		</a>
	) : (
		<Badge variant="neutral">Pending</Badge>
	);
}
