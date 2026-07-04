import { X } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// A slide-in panel built on the same Radix Dialog primitive as `dialog.tsx`.
// Used for the mobile navigation drawer; kept generic so it can host anything.
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

function SheetContent({
	className,
	children,
	side = "left",
	...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
	side?: "left" | "right";
}) {
	return (
		<SheetPrimitive.Portal>
			<SheetPrimitive.Overlay
				data-slot="sheet-overlay"
				className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
			/>
			<SheetPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed inset-y-0 z-50 flex h-full w-3/4 max-w-xs flex-col gap-6 border-border bg-card p-6 text-card-foreground shadow-lg",
					"data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300",
					side === "left"
						? "left-0 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left"
						: "right-0 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
					className,
				)}
				{...props}
			>
				{children}
				<SheetPrimitive.Close
					data-slot="sheet-close"
					className="absolute top-4 right-4 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
				>
					<X className="size-4" />
					<span className="sr-only">Close</span>
				</SheetPrimitive.Close>
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="sheet-header"
			className={cn("flex flex-col gap-1.5", className)}
			{...props}
		/>
	);
}

function SheetTitle({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
	return (
		<SheetPrimitive.Title
			data-slot="sheet-title"
			className={cn(
				"font-heading text-lg font-semibold tracking-tight",
				className,
			)}
			{...props}
		/>
	);
}

export {
	Sheet,
	SheetTrigger,
	SheetClose,
	SheetContent,
	SheetHeader,
	SheetTitle,
};
