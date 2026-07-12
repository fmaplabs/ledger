import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { MobileCard, MobileCardList } from "@/components/mobile-card";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { formatDurationMs } from "@/lib/time";
import { cn } from "@/lib/utils";

// Explicit row shape (the RepoRow precedent) so this component doesn't depend
// on the ticket query modules' inferred types.
export type TicketRow = {
	_id: string;
	externalId: string;
	name: string;
	description?: string;
	clientId: string;
	clientName: string;
	projectId: string;
	projectName: string;
	totalTimeMs: number;
	createdAt: number;
};

const VIEWS = [
	{ key: "table", label: "Table" },
	{ key: "cards", label: "Cards" },
] as const;

type View = (typeof VIEWS)[number]["key"];

// A ticket list with a Table | Cards toggle. The tickets page shows both the
// client and project columns; the client/project detail pages hide their own
// via `showClient` / `showProject`. `undefined` tickets = loading skeleton.
export function TicketsSection({
	tickets,
	showClient = true,
	showProject = true,
}: {
	tickets: TicketRow[] | undefined;
	showClient?: boolean;
	showProject?: boolean;
}) {
	const [view, setView] = useState<View>("table");

	return (
		<section className="flex flex-col gap-3">
			<div className="flex justify-end">
				{/* Segmented view toggle, the RangeSelector pattern. */}
				<fieldset
					className="inline-flex gap-1 rounded-lg border bg-muted/40 p-1"
					aria-label="Tickets layout"
				>
					{VIEWS.map((v) => {
						const active = v.key === view;
						return (
							<Button
								key={v.key}
								type="button"
								size="xs"
								variant={active ? "default" : "ghost"}
								aria-pressed={active}
								onClick={() => setView(v.key)}
								className={cn(!active && "text-muted-foreground")}
							>
								{v.label}
							</Button>
						);
					})}
				</fieldset>
			</div>

			{tickets === undefined ? (
				<div className="flex flex-col gap-3">
					{["s1", "s2", "s3"].map((k) => (
						<div key={k} className="h-4 animate-pulse rounded bg-muted" />
					))}
				</div>
			) : tickets.length === 0 ? (
				<p className="text-sm text-muted-foreground">No tickets yet.</p>
			) : view === "table" ? (
				<TableView
					tickets={tickets}
					showClient={showClient}
					showProject={showProject}
				/>
			) : (
				<CardsView
					tickets={tickets}
					showClient={showClient}
					showProject={showProject}
				/>
			)}
		</section>
	);
}

type ViewProps = {
	tickets: TicketRow[];
	showClient: boolean;
	showProject: boolean;
};

function TableView({ tickets, showClient, showProject }: ViewProps) {
	return (
		<>
			{/* Mobile: one card per ticket. */}
			<MobileCardList>
				{tickets.map((t) => (
					<MobileCard
						key={t._id}
						title={t.name}
						subtitle={t.externalId}
						fields={[
							...(showClient
								? [
										{
											label: "Client",
											value: <ClientLink id={t.clientId} name={t.clientName} />,
										},
									]
								: []),
							...(showProject
								? [
										{
											label: "Project",
											value: (
												<ProjectLink id={t.projectId} name={t.projectName} />
											),
										},
									]
								: []),
							{ label: "Time", value: formatDurationMs(t.totalTimeMs) },
							{
								label: "Created",
								value: new Date(t.createdAt).toLocaleDateString(),
							},
						]}
					/>
				))}
			</MobileCardList>

			{/* Desktop: full table. */}
			<Card className="hidden p-0 md:block">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>External ID</TableHead>
							<TableHead>Name</TableHead>
							{showClient ? <TableHead>Client</TableHead> : null}
							{showProject ? <TableHead>Project</TableHead> : null}
							<TableHead>Time</TableHead>
							<TableHead>Created</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{tickets.map((t) => (
							<TableRow key={t._id}>
								<TableCell className="text-muted-foreground">
									{t.externalId}
								</TableCell>
								<TableCell className="font-medium">{t.name}</TableCell>
								{showClient ? (
									<TableCell>
										<ClientLink id={t.clientId} name={t.clientName} />
									</TableCell>
								) : null}
								{showProject ? (
									<TableCell>
										<ProjectLink id={t.projectId} name={t.projectName} />
									</TableCell>
								) : null}
								<TableCell className="tabular-nums">
									{formatDurationMs(t.totalTimeMs)}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{new Date(t.createdAt).toLocaleDateString()}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Card>
		</>
	);
}

function CardsView({ tickets, showClient, showProject }: ViewProps) {
	return (
		<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{tickets.map((t) => (
				<Card key={t._id} size="sm">
					<CardHeader>
						<CardTitle className="truncate">{t.name}</CardTitle>
						<CardDescription>{t.externalId}</CardDescription>
					</CardHeader>
					{t.description || showClient || showProject ? (
						<CardContent className="flex flex-col gap-1.5">
							{t.description ? (
								<p className="line-clamp-2 text-sm text-muted-foreground">
									{t.description}
								</p>
							) : null}
							{showClient ? (
								<p className="text-sm">
									<span className="text-muted-foreground">Client </span>
									<ClientLink id={t.clientId} name={t.clientName} />
								</p>
							) : null}
							{showProject ? (
								<p className="text-sm">
									<span className="text-muted-foreground">Project </span>
									<ProjectLink id={t.projectId} name={t.projectName} />
								</p>
							) : null}
						</CardContent>
					) : null}
					<CardFooter className="mt-auto justify-between border-t text-xs text-muted-foreground">
						<span className="tabular-nums">
							{formatDurationMs(t.totalTimeMs)}
						</span>
						<span>{new Date(t.createdAt).toLocaleDateString()}</span>
					</CardFooter>
				</Card>
			))}
		</div>
	);
}

function ClientLink({ id, name }: { id: string; name: string }) {
	return (
		<Link
			to="/clients/$clientId"
			params={{ clientId: id }}
			className="text-primary underline-offset-4 hover:underline"
		>
			{name}
		</Link>
	);
}

function ProjectLink({ id, name }: { id: string; name: string }) {
	return (
		<Link
			to="/projects/$projectId"
			params={{ projectId: id }}
			className="text-primary underline-offset-4 hover:underline"
		>
			{name}
		</Link>
	);
}
