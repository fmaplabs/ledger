import { formatDurationMs } from "@/lib/time";

const MS_PER_HOUR = 3_600_000;

type Row = { label: string; hours: number };

// A horizontal bar list: one row per category, label on the left, a single-hue
// bar filling to the category's share of the max, and the formatted duration at
// the end. Horizontal (unlike the vertical RevenueChart) so long category names
// — client and device names — stay readable. One series, so no legend; the
// enclosing card's title names what the bars measure. `commitCounts` is an
// optional parallel array (device card only) that appends "· N commits".
export function TimeBarList({
	data,
	commitCounts,
	emptyLabel = "No activity in this window.",
}: {
	data: Row[] | undefined;
	commitCounts?: number[];
	emptyLabel?: string;
}) {
	if (data === undefined) {
		return (
			<div className="flex flex-col gap-3">
				{["s1", "s2", "s3"].map((k) => (
					<div key={k} className="h-4 animate-pulse rounded bg-muted" />
				))}
			</div>
		);
	}
	if (data.length === 0) {
		return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
	}

	// Two categories with no shared unit would be meaningless on one axis, but
	// here every bar is the same unit (hours), so a single max normalizes them.
	const max = Math.max(...data.map((d) => d.hours));
	const denom = max > 0 ? max : 1;

	return (
		<div className="flex flex-col gap-3">
			{data.map((d, i) => {
				const pct = d.hours <= 0 ? 0 : Math.max(3, (d.hours / denom) * 100);
				const commits = commitCounts?.[i];
				const duration = formatDurationMs(d.hours * MS_PER_HOUR);
				const value =
					commits === undefined
						? duration
						: `${duration} · ${commits} ${commits === 1 ? "commit" : "commits"}`;
				return (
					<div key={`${d.label}-${i}`} className="flex items-center gap-3">
						<span
							className="w-24 shrink-0 truncate text-sm sm:w-32"
							title={d.label}
						>
							{d.label}
						</span>
						<div className="flex h-2 flex-1 items-center">
							<div
								className="h-2 rounded-sm bg-primary transition-[width]"
								style={{ width: `${pct}%` }}
								role="img"
								aria-label={`${d.label}: ${value}`}
								title={`${d.label}: ${value}`}
							/>
						</div>
						<span className="shrink-0 whitespace-nowrap text-right text-sm tabular-nums text-muted-foreground">
							{value}
						</span>
					</div>
				);
			})}
		</div>
	);
}
