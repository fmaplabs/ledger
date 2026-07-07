import { formatDurationMs } from "@/lib/time";
import { cn } from "@/lib/utils";

const MS_PER_HOUR = 3_600_000;

export type RepoRow = {
	project: string;
	displayName: string;
	clientName: string;
	commitCount: number;
	hours: number;
	sinceMs: number | null;
	truncated: boolean;
};

const sinceFmt = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	year: "numeric",
});

function sinceLabel(sinceMs: number | null): string {
	return sinceMs === null ? "all time" : `since ${sinceFmt.format(sinceMs)}`;
}

// A ranked list of repos (== projects) with unbilled activity since their
// client's last invoice. Each repo shows two independently-scaled inline bars:
// commits and hours are different units, so each normalizes to its own column
// max (never a shared axis) and gets its own hue + unit label. The client name
// and the "since" date sit alongside.
export function UnbilledRepoTable({ rows }: { rows: RepoRow[] | undefined }) {
	if (rows === undefined) {
		return (
			<div className="flex flex-col gap-4">
				{["s1", "s2", "s3"].map((k) => (
					<div key={k} className="h-10 animate-pulse rounded bg-muted" />
				))}
			</div>
		);
	}
	if (rows.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				Nothing unbilled — every assigned repo is up to date.
			</p>
		);
	}

	const maxCommits = Math.max(...rows.map((r) => r.commitCount));
	const maxHours = Math.max(...rows.map((r) => r.hours));

	return (
		<div className="flex flex-col divide-y">
			{rows.map((r) => {
				const since = sinceLabel(r.sinceMs);
				const hours = formatDurationMs(r.hours * MS_PER_HOUR);
				const commits = `${r.commitCount} ${r.commitCount === 1 ? "commit" : "commits"}`;
				return (
					<div
						key={r.project}
						className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
					>
						<div className="flex items-baseline justify-between gap-3">
							<p className="min-w-0 truncate text-sm font-medium">
								{r.displayName}
								<span className="ml-2 text-xs font-normal text-muted-foreground">
									{r.clientName}
								</span>
							</p>
							<span className="shrink-0 text-xs text-muted-foreground">
								{since}
							</span>
						</div>
						<div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
							<MetricBar
								barClass="bg-chart-2"
								pct={maxCommits > 0 ? (r.commitCount / maxCommits) * 100 : 0}
								value={commits}
								aria={`${r.displayName}: ${commits} ${since}`}
							/>
							<MetricBar
								barClass="bg-primary"
								pct={maxHours > 0 ? (r.hours / maxHours) * 100 : 0}
								value={hours}
								aria={`${r.displayName}: ${hours} logged ${since}`}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
}

function MetricBar({
	barClass,
	pct,
	value,
	aria,
}: {
	barClass: string;
	pct: number;
	value: string;
	aria: string;
}) {
	const width = pct <= 0 ? 0 : Math.max(3, pct);
	return (
		<div className="flex items-center gap-2">
			<div className="flex h-2 flex-1 items-center">
				<div
					className={cn("h-2 rounded-sm transition-[width]", barClass)}
					style={{ width: `${width}%` }}
					role="img"
					aria-label={aria}
					title={aria}
				/>
			</div>
			<span className="w-20 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">
				{value}
			</span>
		</div>
	);
}
