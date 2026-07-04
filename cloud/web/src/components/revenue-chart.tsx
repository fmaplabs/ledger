import { formatCents } from "@/lib/money";

// A dependency-free monthly-revenue bar chart. Data is encoded by bar height
// (not colour alone), each bar is individually labelled for screen readers, and
// the primary token clears AA contrast against the card in both themes.
export function RevenueChart({
	data,
	currency,
}: {
	data: { label: string; cents: number }[];
	currency: string;
}) {
	const max = Math.max(1, ...data.map((d) => d.cents));

	return (
		<div>
			<div className="flex h-48 items-end gap-1 border-b pb-px sm:gap-2">
				{data.map((d, i) => {
					const pct = d.cents <= 0 ? 0 : Math.max(3, (d.cents / max) * 100);
					return (
						<div
							key={`${d.label}-${i}`}
							className="flex h-full flex-1 items-end"
						>
							<div
								className="w-full rounded-t-sm bg-primary transition-[height]"
								style={{ height: `${pct}%` }}
								role="img"
								aria-label={`${d.label}: ${formatCents(d.cents, currency)}`}
								title={`${d.label}: ${formatCents(d.cents, currency)}`}
							/>
						</div>
					);
				})}
			</div>
			<div className="mt-2 flex gap-1 sm:gap-2">
				{data.map((d, i) => (
					<span
						key={`${d.label}-${i}`}
						className="flex-1 text-center text-xs text-muted-foreground"
					>
						{d.label}
					</span>
				))}
			</div>
		</div>
	);
}
