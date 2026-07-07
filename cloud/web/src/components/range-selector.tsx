import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 3_600_000;

export type TimeWindow = { key: string; label: string; ms: number };

// The selectable lookback windows, shortest first. Months/years use fixed
// 30/365-day spans — these drive a rolling `now - ms` cutoff, not a calendar
// boundary, so approximate day counts are exactly what we want.
export const WINDOWS: TimeWindow[] = [
	{ key: "24h", label: "24h", ms: DAY_MS },
	{ key: "1w", label: "1w", ms: 7 * DAY_MS },
	{ key: "1m", label: "1m", ms: 30 * DAY_MS },
	{ key: "3m", label: "3m", ms: 90 * DAY_MS },
	{ key: "6m", label: "6m", ms: 180 * DAY_MS },
	{ key: "1y", label: "1y", ms: 365 * DAY_MS },
];

// A segmented control over WINDOWS. The active window is filled (primary); the
// rest are quiet ghosts. `value`/`onChange` speak in milliseconds so the parent
// can pass the chosen span straight to the query.
export function RangeSelector({
	value,
	onChange,
}: {
	value: number;
	onChange: (ms: number) => void;
}) {
	return (
		// A <fieldset> is the semantic grouping element; each button is a toggle
		// (aria-pressed) and only one window is active at a time.
		<fieldset
			className="inline-flex flex-wrap gap-1 rounded-lg border bg-muted/40 p-1"
			aria-label="Time window"
		>
			{WINDOWS.map((w) => {
				const active = w.ms === value;
				return (
					<Button
						key={w.key}
						type="button"
						size="xs"
						variant={active ? "default" : "ghost"}
						aria-pressed={active}
						onClick={() => onChange(w.ms)}
						className={cn("tabular-nums", !active && "text-muted-foreground")}
					>
						{w.label}
					</Button>
				);
			})}
		</fieldset>
	);
}
