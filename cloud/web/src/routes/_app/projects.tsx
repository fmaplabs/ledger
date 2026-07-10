import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { FileText, Pencil, Receipt } from "lucide-react";
import { useState } from "react";

import { GenerateInvoiceDialog } from "@/components/generate-invoice-dialog";
import { MobileCard, MobileCardList } from "@/components/mobile-card";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type Id } from "@/convex-api";
import { errorMessage } from "@/lib/errors";
import { centsToInput, formatRate, inputToCents } from "@/lib/money";
import { formatDurationMs } from "@/lib/time";

export const Route = createFileRoute("/_app/projects")({
	component: ProjectsPage,
});

type ProjectRow = {
	_id: Id<"projects">;
	name: string;
	displayName?: string;
	clientId?: Id<"clients">;
	clientName?: string;
	rateCents?: number;
	effectiveRateCents: number;
	unbilledMsCache?: number;
};

function ProjectsPage() {
	const projects = useQuery(api.projects.list, {});
	const settings = useQuery(api.settings.get, {});
	const currency = settings?.currency ?? "usd";
	const [editing, setEditing] = useState<ProjectRow | null>(null);
	const [generating, setGenerating] = useState<ProjectRow | null>(null);

	return (
		<div>
			<PageHeader
				title="Projects"
				description="Discovered from your tracked work. Assign each to a client to bill it."
			/>

			{/* Mobile: one card per project. */}
			<MobileCardList>
				{projects === undefined ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : projects.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No projects yet. They appear here once the CLI syncs tracked work.
					</p>
				) : (
					projects.map((p) => (
						<MobileCard
							key={p._id}
							title={p.displayName ?? p.name}
							subtitle={
								p.clientName ?? (
									<span className="text-muted-foreground">Unassigned</span>
								)
							}
							fields={[
								{
									label: "Rate",
									value: formatRate(p.effectiveRateCents, currency),
								},
								{
									label: "Unbilled",
									value: p.unbilledMsCache
										? formatDurationMs(p.unbilledMsCache)
										: "—",
								},
							]}
							actions={
								<ProjectActions
									project={p}
									onGenerate={() => setGenerating(p)}
									onEdit={() => setEditing(p)}
								/>
							}
						/>
					))
				)}
			</MobileCardList>

			{/* Desktop: full table. */}
			<Card className="hidden p-0 md:block">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Project</TableHead>
							<TableHead>Client</TableHead>
							<TableHead>Rate</TableHead>
							<TableHead>Unbilled</TableHead>
							<TableHead className="w-0" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{projects === undefined ? (
							<TableRow>
								<TableCell colSpan={5} className="text-muted-foreground">
									Loading…
								</TableCell>
							</TableRow>
						) : projects.length === 0 ? (
							<TableRow>
								<TableCell colSpan={5} className="text-muted-foreground">
									No projects yet. They appear here once the CLI syncs tracked
									work.
								</TableCell>
							</TableRow>
						) : (
							projects.map((p) => (
								<TableRow key={p._id}>
									<TableCell className="font-medium">
										{p.displayName ?? p.name}
									</TableCell>
									<TableCell>
										{p.clientName ?? (
											<span className="text-muted-foreground">Unassigned</span>
										)}
									</TableCell>
									<TableCell>
										{formatRate(p.effectiveRateCents, currency)}
									</TableCell>
									<TableCell className="text-muted-foreground">
										{p.unbilledMsCache
											? formatDurationMs(p.unbilledMsCache)
											: "—"}
									</TableCell>
									<TableCell>
										<div className="flex justify-end gap-1">
											<ProjectActions
												project={p}
												onGenerate={() => setGenerating(p)}
												onEdit={() => setEditing(p)}
											/>
										</div>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</Card>

			{editing ? (
				<ProjectDialog project={editing} onClose={() => setEditing(null)} />
			) : null}

			{generating ? (
				<GenerateInvoiceDialog
					projectId={generating._id}
					projectName={generating.displayName ?? generating.name}
					onClose={() => setGenerating(null)}
				/>
			) : null}
		</div>
	);
}

/** Per-project action buttons, shared by the table and mobile cards. */
function ProjectActions({
	project,
	onGenerate,
	onEdit,
}: {
	project: ProjectRow;
	onGenerate: () => void;
	onEdit: () => void;
}) {
	return (
		<>
			<Button asChild variant="ghost" size="sm">
				<Link to="/invoices" search={{ projectId: project._id }}>
					<FileText /> Invoices
				</Link>
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={!project.clientId}
				title={
					project.clientId ? undefined : "Assign a client before invoicing"
				}
				onClick={onGenerate}
			>
				<Receipt /> Generate
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={`Edit ${project.displayName ?? project.name}`}
				onClick={onEdit}
			>
				<Pencil />
			</Button>
		</>
	);
}

function ProjectDialog({
	project,
	onClose,
}: {
	project: ProjectRow;
	onClose: () => void;
}) {
	const clients = useQuery(api.clients.list, {});
	const update = useMutation(api.projects.update);
	const [displayName, setDisplayName] = useState(project.displayName ?? "");
	const [clientId, setClientId] = useState<string>(project.clientId ?? "");
	const [rate, setRate] = useState(centsToInput(project.rateCents));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setSaving(true);
		try {
			await update({
				id: project._id,
				clientId: clientId === "" ? null : (clientId as Id<"clients">),
				displayName: displayName.trim() === "" ? null : displayName,
				rateCents: inputToCents(rate) ?? null,
			});
			onClose();
		} catch (err) {
			setError(errorMessage(err, "Failed to save."));
			setSaving(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{project.name}</DialogTitle>
				</DialogHeader>
				<form onSubmit={onSubmit} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="project-client">Client</Label>
						<Select
							id="project-client"
							value={clientId}
							onChange={(e) => setClientId(e.target.value)}
						>
							<option value="">Unassigned</option>
							{(clients ?? []).map((c) => (
								<option key={c._id} value={c._id}>
									{c.name}
								</option>
							))}
						</Select>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="project-display">Display name (optional)</Label>
						<Input
							id="project-display"
							placeholder={project.name}
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="project-rate">Rate override (optional)</Label>
						<Input
							id="project-rate"
							inputMode="decimal"
							placeholder="Falls back to the client or global rate"
							value={rate}
							onChange={(e) => setRate(e.target.value)}
						/>
					</div>
					{error ? (
						<p className="text-sm text-destructive" role="alert">
							{error}
						</p>
					) : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
							disabled={saving}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={saving}>
							{saving ? "Saving…" : "Save"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
