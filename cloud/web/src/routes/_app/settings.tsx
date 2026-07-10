import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { api } from "@/convex-api";
import { CURRENCIES } from "@/lib/currencies";
import { errorMessage } from "@/lib/errors";
import { centsToInput, inputToCents } from "@/lib/money";

export const Route = createFileRoute("/_app/settings")({ component: SettingsPage });

function SettingsPage() {
	const settings = useQuery(api.settings.get, {});
	const update = useMutation(api.settings.update);

	const [rate, setRate] = useState("");
	const [currency, setCurrency] = useState("usd");
	const [idleMinutes, setIdleMinutes] = useState("15");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Seed the form once settings load.
	useEffect(() => {
		if (!settings) return;
		setRate(centsToInput(settings.defaultRateCents));
		setCurrency(settings.currency);
		setIdleMinutes(String(Math.round(settings.idleThresholdMs / 60_000)));
	}, [settings]);

	async function onSave(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		const defaultRateCents = inputToCents(rate);
		if (defaultRateCents === undefined) {
			setError("Enter a valid default rate.");
			return;
		}
		const minutes = Number.parseInt(idleMinutes, 10);
		if (Number.isNaN(minutes) || minutes <= 0) {
			setError("Idle timeout must be a positive number of minutes.");
			return;
		}
		setSaving(true);
		try {
			await update({
				defaultRateCents,
				currency,
				idleThresholdMs: minutes * 60_000,
			});
			setSaved(true);
			setTimeout(() => setSaved(false), 2000);
		} catch (err) {
			setError(errorMessage(err, "Failed to save."));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div>
			<PageHeader
				title="Settings"
				description="Defaults used when generating invoices."
			/>
			<Card className="max-w-xl">
				<CardContent>
					<form onSubmit={onSave} className="flex flex-col gap-5">
						<div className="flex flex-col gap-2">
							<Label htmlFor="rate">Default hourly rate</Label>
							<Input
								id="rate"
								inputMode="decimal"
								placeholder="100.00"
								value={rate}
								onChange={(e) => setRate(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Applied when a client and project have no rate of their own.
							</p>
						</div>

						<div className="flex flex-col gap-2">
							<Label htmlFor="currency">Currency</Label>
							<Select
								id="currency"
								value={currency}
								onChange={(e) => setCurrency(e.target.value)}
							>
								{CURRENCIES.map((c) => (
									<option key={c} value={c}>
										{c.toUpperCase()}
									</option>
								))}
							</Select>
						</div>

						<div className="flex flex-col gap-2">
							<Label htmlFor="idle">Idle timeout (minutes)</Label>
							<Input
								id="idle"
								inputMode="numeric"
								placeholder="15"
								value={idleMinutes}
								onChange={(e) => setIdleMinutes(e.target.value)}
							/>
							<p className="text-xs text-muted-foreground">
								Gaps longer than this split tracked time into separate sessions.
							</p>
						</div>

						{error ? (
							<p className="text-sm text-destructive" role="alert">
								{error}
							</p>
						) : null}

						<div className="flex items-center gap-3">
							<Button type="submit" disabled={saving || !settings}>
								{saving ? "Saving…" : "Save settings"}
							</Button>
							{saved ? (
								<span className="text-sm text-muted-foreground">Saved.</span>
							) : null}
						</div>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
