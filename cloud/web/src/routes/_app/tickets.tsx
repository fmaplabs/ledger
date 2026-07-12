import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "convex/react";
import { Plus } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { TicketFormDialog } from "@/components/ticket-form-dialog";
import { TicketsSection } from "@/components/tickets-section";
import { Button } from "@/components/ui/button";
import { api } from "@/convex-api";

export const Route = createFileRoute("/_app/tickets")({
	component: TicketsPage,
});

function TicketsPage() {
	const tickets = useQuery(api.tickets.list, {});
	const [creating, setCreating] = useState(false);

	return (
		<div>
			<PageHeader
				title="Tickets"
				description="Work items with declared time, attributed to a project and client."
			>
				<Button size="sm" onClick={() => setCreating(true)}>
					<Plus /> New ticket
				</Button>
			</PageHeader>

			<TicketsSection tickets={tickets} />

			{creating ? (
				<TicketFormDialog onClose={() => setCreating(false)} />
			) : null}
		</div>
	);
}
