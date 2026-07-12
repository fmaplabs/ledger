import type * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
	return (
		<textarea
			data-slot="textarea"
			className={cn(
				"flex min-h-16 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs transition-colors outline-none",
				"placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
				"focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
				"disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
				"aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
				"dark:bg-input/30",
				className,
			)}
			{...props}
		/>
	);
}

export { Textarea };
