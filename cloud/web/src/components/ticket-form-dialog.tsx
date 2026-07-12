import { useMutation, useQuery } from "convex/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { api, type Id } from "@/convex-api";
import { errorMessage } from "@/lib/errors";

export function TicketFormDialog({
	defaultProjectId,
	defaultClientId,
	onClose,
}: {
	defaultProjectId?: Id<"projects">;
	defaultClientId?: Id<"clients">;
	onClose: () => void;
}) {
	const projects = useQuery(api.projects.list, {});
	const clients = useQuery(api.clients.list, {});
	const create = useMutation(api.tickets.create);
	const [name, setName] = useState("");
	const [externalId, setExternalId] = useState("");
	const [description, setDescription] = useState("");
	const [projectId, setProjectId] = useState<string>(defaultProjectId ?? "");
	const [clientId, setClientId] = useState<string>(defaultClientId ?? "");
	const [hours, setHours] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function onProjectChange(e: React.ChangeEvent<HTMLSelectElement>) {
		const id = e.target.value;
		setProjectId(id);
		// Mirror the project's client into the client select so the common case
		// needs no second pick — still user-changeable (some projects have none).
		const project = (projects ?? []).find((p) => p._id === id);
		if (project?.clientId) setClientId(project.clientId);
	}

	async function onSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (name.trim() === "" || externalId.trim() === "") {
			setError("Name and external ID are required.");
			return;
		}
		if (projectId === "" || clientId === "") {
			setError("Project and client are required.");
			return;
		}
		const h = Number(hours);
		if (hours.trim() === "" || !Number.isFinite(h) || h < 0) {
			setError("Time spent must be a non-negative number of hours.");
			return;
		}
		setSaving(true);
		try {
			await create({
				externalId,
				name,
				description: description || undefined,
				clientId: clientId as Id<"clients">,
				projectId: projectId as Id<"projects">,
				totalTimeMs: Math.round(h * 3_600_000),
			});
			onClose();
		} catch (err) {
			setError(errorMessage(err, "Failed to create ticket."));
			setSaving(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New ticket</DialogTitle>
				</DialogHeader>
				<form onSubmit={onSubmit} className="flex flex-col gap-4">
					<div className="flex flex-col gap-2">
						<Label htmlFor="ticket-name">Name</Label>
						<Input
							id="ticket-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoFocus
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ticket-external-id">External ID</Label>
						<Input
							id="ticket-external-id"
							placeholder="GH-123 / PROJ-456"
							value={externalId}
							onChange={(e) => setExternalId(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ticket-description">Description (optional)</Label>
						<Textarea
							id="ticket-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ticket-project">Project</Label>
						<Select
							id="ticket-project"
							value={projectId}
							onChange={onProjectChange}
						>
							<option value="">Select a project</option>
							{(projects ?? []).map((p) => (
								<option key={p._id} value={p._id}>
									{p.displayName ?? p.name}
								</option>
							))}
						</Select>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ticket-client">Client</Label>
						<Select
							id="ticket-client"
							value={clientId}
							onChange={(e) => setClientId(e.target.value)}
						>
							<option value="">Select a client</option>
							{(clients ?? []).map((c) => (
								<option key={c._id} value={c._id}>
									{c.name}
								</option>
							))}
						</Select>
					</div>
					<div className="flex flex-col gap-2">
						<Label htmlFor="ticket-hours">Time spent (hours)</Label>
						<Input
							id="ticket-hours"
							inputMode="decimal"
							placeholder="1.5"
							value={hours}
							onChange={(e) => setHours(e.target.value)}
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
