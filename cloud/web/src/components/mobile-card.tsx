import type * as React from "react";

import { Card } from "@/components/ui/card";

/**
 * The phone-sized stand-in for a table row. Below `md`, the data tables on
 * Clients / Projects / Invoices render a list of these instead of a wide,
 * horizontally-scrolling table. `value` and `actions` accept ReactNode so
 * badges, links, and buttons drop straight in.
 */
export function MobileCard({
	title,
	subtitle,
	fields,
	actions,
}: {
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	fields: { label: string; value: React.ReactNode }[];
	actions?: React.ReactNode;
}) {
	return (
		<Card className="flex flex-col gap-3 p-4">
			<div className="min-w-0">
				<div className="truncate font-medium">{title}</div>
				{subtitle ? (
					<div className="truncate text-sm text-muted-foreground">
						{subtitle}
					</div>
				) : null}
			</div>
			<dl className="flex flex-col gap-1.5">
				{fields.map((f) => (
					<div
						key={f.label}
						className="flex items-center justify-between gap-3"
					>
						<dt className="text-sm text-muted-foreground">{f.label}</dt>
						<dd className="text-sm">{f.value}</dd>
					</div>
				))}
			</dl>
			{actions ? (
				<div className="flex flex-wrap items-center gap-1 border-t pt-3">
					{actions}
				</div>
			) : null}
		</Card>
	);
}

/** Vertical stack of {@link MobileCard}s, shown only below the `md` breakpoint. */
export function MobileCardList({ children }: { children: React.ReactNode }) {
	return <div className="flex flex-col gap-3 md:hidden">{children}</div>;
}
