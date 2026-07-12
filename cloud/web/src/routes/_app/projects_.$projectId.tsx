import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Plus } from "lucide-react";
import type * as React from "react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { TicketFormDialog } from "@/components/ticket-form-dialog";
import { TicketsSection } from "@/components/tickets-section";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/convex-api";
import { formatRate } from "@/lib/money";
import { formatDurationMs } from "@/lib/time";

export const Route = createFileRoute("/_app/projects_/$projectId")({
	component: ProjectDetailPage,
});

function ProjectDetailPage() {
	const { projectId } = Route.useParams();
	// Raw param: the query normalizes it and reads null for malformed ids.
	const project = useQuery(api.projects.get, { id: projectId });
	const settings = useQuery(api.settings.get, {});
	const currency = settings?.currency ?? "usd";
	// Skip-gated: never fires for a missing/foreign project.
	const tickets = useQuery(
		api.tickets.listByProject,
		project ? { projectId: project._id } : "skip",
	);
	const [creating, setCreating] = useState(false);

	if (project === undefined) {
		return (
			<div className="flex flex-col gap-6">
				<div className="h-8 w-64 animate-pulse rounded bg-muted" />
				<div className="grid gap-4 sm:grid-cols-3">
					{["s1", "s2", "s3"].map((k) => (
						<div key={k} className="h-24 animate-pulse rounded-xl bg-muted" />
					))}
				</div>
			</div>
		);
	}

	if (project === null) {
		return (
			<div>
				<PageHeader
					title="Project not found"
					description="This project doesn't exist or the link is stale."
				/>
				<Button asChild variant="outline">
					<Link to="/projects">Back to projects</Link>
				</Button>
			</div>
		);
	}

	return (
		<div>
			<PageHeader
				title={project.displayName ?? project.name}
				description={
					project.displayName && project.displayName !== project.name
						? project.name
						: undefined
				}
			>
				<Button size="sm" onClick={() => setCreating(true)}>
					<Plus /> New ticket
				</Button>
			</PageHeader>

			<div className="grid gap-4 sm:grid-cols-3">
				<InfoCard
					label="Client"
					value={
						project.clientId ? (
							<Link
								to="/clients/$clientId"
								params={{ clientId: project.clientId }}
								className="text-primary underline-offset-4 hover:underline"
							>
								{project.clientName ?? "View client"}
							</Link>
						) : (
							<span className="text-muted-foreground">Unassigned</span>
						)
					}
				/>
				<InfoCard
					label="Rate"
					value={formatRate(project.effectiveRateCents, currency)}
				/>
				<InfoCard
					label="Unbilled"
					value={formatDurationMs(project.unbilledMsCache ?? 0)}
					hint={
						project.unbilledCacheUpdatedAt
							? `Estimate as of ${new Date(
									project.unbilledCacheUpdatedAt,
								).toLocaleDateString()}`
							: "Estimate not computed yet"
					}
				/>
			</div>

			<div className="mt-8 flex flex-col gap-3">
				<h2 className="font-heading text-lg font-semibold tracking-tight">
					Tickets
				</h2>
				<TicketsSection tickets={tickets} showProject={false} />
			</div>

			{creating ? (
				<TicketFormDialog
					defaultProjectId={project._id}
					defaultClientId={project.clientId}
					onClose={() => setCreating(false)}
				/>
			) : null}
		</div>
	);
}

/** The dashboard `StatCard` pattern, with a ReactNode value so links drop in. */
function InfoCard({
	label,
	value,
	hint,
}: {
	label: string;
	value: React.ReactNode;
	hint?: string;
}) {
	return (
		<Card>
			<CardContent className="flex flex-col gap-1 py-1">
				<span className="text-sm text-muted-foreground">{label}</span>
				<span className="font-heading text-2xl font-semibold tabular-nums tracking-tight">
					{value}
				</span>
				{hint ? (
					<span className="text-xs text-muted-foreground">{hint}</span>
				) : null}
			</CardContent>
		</Card>
	);
}
