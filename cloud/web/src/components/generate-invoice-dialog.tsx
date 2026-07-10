import { useAction, useQuery } from "convex/react";
import { CheckCircle2, ExternalLink, FileText } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { api, type Id } from "@/convex-api";
import { errorMessage } from "@/lib/errors";
import { formatCents, formatRate } from "@/lib/money";

type GenerateResult = {
	status: "created" | "empty" | "error";
	amountCents?: number;
	hours?: number;
	hostedInvoiceUrl?: string;
	invoicePdfUrl?: string;
	message?: string;
};

export function GenerateInvoiceDialog({
	projectId,
	projectName,
	onClose,
}: {
	projectId: Id<"projects">;
	projectName: string;
	onClose: () => void;
}) {
	const preview = useQuery(api.invoices.previewUnbilled, { projectId });
	const generate = useAction(api.invoices.generate);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<GenerateResult | null>(null);

	const nothingToBill =
		preview !== undefined && (preview.amountCents <= 0 || preview.hours <= 0);

	async function onConfirm() {
		setBusy(true);
		try {
			const res = await generate({ projectId });
			setResult(res);
		} catch (err) {
			setResult({
				status: "error",
				message: errorMessage(err, "Failed to generate."),
			});
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Generate invoice</DialogTitle>
					<DialogDescription>
						Bills all unbilled hours for {projectName} and creates a Stripe
						invoice.
					</DialogDescription>
				</DialogHeader>

				{result ? (
					<ResultView result={result} onClose={onClose} />
				) : preview === undefined ? (
					<p className="text-sm text-muted-foreground">Calculating…</p>
				) : (
					<div className="flex flex-col gap-3">
						<dl className="grid grid-cols-2 gap-y-2 text-sm">
							<dt className="text-muted-foreground">Unbilled hours</dt>
							<dd className="text-right font-medium">
								{preview.hours.toFixed(2)}h
							</dd>
							<dt className="text-muted-foreground">Rate</dt>
							<dd className="text-right">
								{formatRate(preview.rateCents, preview.currency)}
							</dd>
							<dt className="text-muted-foreground">Total</dt>
							<dd className="text-right font-semibold">
								{formatCents(preview.amountCents, preview.currency)}
							</dd>
						</dl>
						{preview.truncated ? (
							<p className="text-xs text-muted-foreground">
								Preview is capped; the generated invoice will bill the exact
								total.
							</p>
						) : null}
						{nothingToBill ? (
							<p className="text-sm text-muted-foreground">
								No unbilled time to invoice right now.
							</p>
						) : null}
						<DialogFooter>
							<Button variant="outline" onClick={onClose} disabled={busy}>
								Cancel
							</Button>
							<Button onClick={onConfirm} disabled={busy || nothingToBill}>
								{busy ? "Generating…" : "Generate invoice"}
							</Button>
						</DialogFooter>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}

function ResultView({
	result,
	onClose,
}: {
	result: GenerateResult;
	onClose: () => void;
}) {
	if (result.status === "created") {
		return (
			<div className="flex flex-col gap-4">
				<div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
					<CheckCircle2 className="size-5" />
					<span className="font-medium">
						Invoice created
						{result.amountCents !== undefined
							? ` — ${formatCents(result.amountCents)}`
							: ""}
					</span>
				</div>
				<div className="flex flex-wrap gap-2">
					{result.invoicePdfUrl ? (
						<Button asChild variant="outline" size="sm">
							<a href={result.invoicePdfUrl} target="_blank" rel="noreferrer">
								<FileText /> View PDF
							</a>
						</Button>
					) : null}
					{result.hostedInvoiceUrl ? (
						<Button asChild variant="outline" size="sm">
							<a href={result.hostedInvoiceUrl} target="_blank" rel="noreferrer">
								Payment page <ExternalLink />
							</a>
						</Button>
					) : null}
				</div>
				<DialogFooter>
					<Button onClick={onClose}>Done</Button>
				</DialogFooter>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<p className="text-sm text-muted-foreground" role="alert">
				{result.status === "empty"
					? "There was no unbilled time to invoice."
					: (result.message ?? "Something went wrong generating the invoice.")}
			</p>
			<DialogFooter>
				<Button onClick={onClose}>Close</Button>
			</DialogFooter>
		</div>
	);
}
