import { createFileRoute } from "@tanstack/react-router";
import { useAction, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { RangeSelector, WINDOWS } from "@/components/range-selector";
import { RevenueChart } from "@/components/revenue-chart";
import { TimeBarList } from "@/components/time-bar-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { UnbilledRepoTable } from "@/components/unbilled-repo-table";
import { api } from "@/convex-api";
import { formatCents } from "@/lib/money";

export const Route = createFileRoute("/_app/dashboard")({
	component: DashboardPage,
});

const STATUS_VARIANT: Record<
	string,
	"neutral" | "success" | "warning" | "destructive"
> = {
	draft: "neutral",
	open: "warning",
	paid: "success",
	void: "neutral",
	failed: "destructive",
};

function DashboardPage() {
	const summary = useQuery(api.revenue.summary, {});
	const series = useQuery(api.revenue.monthlySeries, {});
	const invoices = useQuery(api.invoices.list, {});
	const repo = useQuery(api.revenue.repoUnbilledBreakdown, {});
	// Default to the 1-week window (WINDOWS[1]); the selector drives re-queries.
	const [windowMs, setWindowMs] = useState(WINDOWS[1].ms);
	const activity = useQuery(api.revenue.activityByWindow, { windowMs });
	const refresh = useAction(api.projects.refreshUnbilledEstimates);
	const [refreshing, setRefreshing] = useState(false);

	const currency = summary?.currency ?? "usd";
	const money = (cents: number | undefined) =>
		cents === undefined ? "—" : formatCents(cents, currency);

	async function onRefresh() {
		setRefreshing(true);
		try {
			await refresh({});
		} finally {
			setRefreshing(false);
		}
	}

	return (
		<div>
			<PageHeader title="Dashboard" description="Your revenue at a glance.">
				<Button
					variant="outline"
					size="sm"
					onClick={onRefresh}
					disabled={refreshing}
				>
					<RefreshCw className={refreshing ? "animate-spin" : undefined} />
					{refreshing ? "Refreshing…" : "Refresh estimates"}
				</Button>
			</PageHeader>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard label="This month" value={money(summary?.thisMonthCents)} />
				<StatCard label="Year to date" value={money(summary?.yearToDateCents)} />
				<StatCard
					label="Unbilled pipeline"
					value={money(summary?.unbilledPipelineCents)}
					hint="Tracked but not yet invoiced"
				/>
				<StatCard
					label="Projected annual"
					value={money(summary?.projectedAnnualCents)}
					hint="Run-rate from the last 90 days"
				/>
			</div>

			<div className="mt-6 grid gap-4 lg:grid-cols-3">
				<Card className="lg:col-span-2">
					<CardHeader>
						<CardTitle>Revenue</CardTitle>
						<CardDescription>Paid invoices, last 12 months</CardDescription>
					</CardHeader>
					<CardContent>
						{series === undefined ? (
							<div className="h-48 animate-pulse rounded bg-muted" />
						) : (
							<RevenueChart data={series.months} currency={series.currency} />
						)}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Recent invoices</CardTitle>
						<CardDescription>Latest activity</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						{invoices === undefined ? (
							<p className="text-sm text-muted-foreground">Loading…</p>
						) : invoices.length === 0 ? (
							<p className="text-sm text-muted-foreground">No invoices yet.</p>
						) : (
							invoices.slice(0, 6).map((inv) => (
								<div
									key={inv._id}
									className="flex items-center justify-between gap-2"
								>
									<div className="min-w-0">
										<p className="truncate text-sm font-medium">
											{inv.clientName}
										</p>
										<p className="truncate text-xs text-muted-foreground">
											{inv.projectName}
										</p>
									</div>
									<div className="flex items-center gap-2">
										<span className="text-sm tabular-nums">
											{formatCents(inv.amountCents, inv.currency)}
										</span>
										<Badge variant={STATUS_VARIANT[inv.status] ?? "neutral"}>
											{inv.status}
										</Badge>
									</div>
								</div>
							))
						)}
					</CardContent>
				</Card>
			</div>

			<Card className="mt-4">
				<CardHeader>
					<CardTitle>Unbilled since last invoice</CardTitle>
					<CardDescription>
						Commits and time logged per repo since each client's last invoice
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-3">
					<UnbilledRepoTable rows={repo?.rows} />
					{repo?.rows.some((r) => r.truncated) ? (
						<p className="text-xs text-muted-foreground">
							Some repos have more history than shown; totals may be partial.
						</p>
					) : null}
				</CardContent>
			</Card>

			<div className="mt-6 flex flex-wrap items-center justify-between gap-3">
				<h2 className="font-heading text-lg font-semibold tracking-tight">
					Time tracked
				</h2>
				<RangeSelector value={windowMs} onChange={setWindowMs} />
			</div>

			<div className="mt-4 grid gap-4 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Time by client</CardTitle>
						<CardDescription>
							Billable hours in the selected window
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<TimeBarList
							data={
								activity
									? activity.byClient.map((c) => ({
											label: c.clientName,
											hours: c.hours,
										}))
									: undefined
							}
						/>
						{activity?.truncated ? (
							<p className="text-xs text-muted-foreground">
								Showing the most recent activity — narrow the window for exact
								totals.
							</p>
						) : null}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Time by device</CardTitle>
						<CardDescription>Hours and commits per device</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-3">
						<TimeBarList
							data={
								activity
									? activity.byDevice.map((d) => ({
											label: d.deviceName,
											hours: d.hours,
										}))
									: undefined
							}
							commitCounts={activity?.byDevice.map((d) => d.commitCount)}
						/>
						{activity?.truncated ? (
							<p className="text-xs text-muted-foreground">
								Showing the most recent activity — narrow the window for exact
								totals.
							</p>
						) : null}
					</CardContent>
				</Card>
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	hint,
}: {
	label: string;
	value: string;
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
