import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import * as React from "react";

import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";

const NAV = [
	{ to: "/dashboard", label: "Dashboard" },
	{ to: "/clients", label: "Clients" },
	{ to: "/projects", label: "Projects" },
	{ to: "/tickets", label: "Tickets" },
	{ to: "/invoices", label: "Invoices" },
	{ to: "/settings", label: "Settings" },
] as const;

export function AppShell({
	email,
	onSignOut,
	children,
}: {
	email?: string;
	onSignOut: () => void;
	children: React.ReactNode;
}) {
	// Controlled so tapping a nav link inside the drawer dismisses it, rather
	// than leaving the menu covering the page we just routed to.
	const [menuOpen, setMenuOpen] = React.useState(false);

	return (
		<div className="min-h-svh bg-background">
			<header className="border-b">
				<div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
					<div className="flex items-center gap-6">
						<span className="font-heading text-lg font-semibold tracking-tight">
							ledger
						</span>
						{/* Desktop: inline nav. Hidden on phones in favour of the drawer. */}
						<nav className="hidden items-center gap-1 md:flex">
							{NAV.map((item) => (
								<Link
									key={item.to}
									to={item.to}
									className="rounded-md px-3 py-1.5 text-sm font-medium transition-colors"
									activeProps={{ className: "bg-muted text-foreground" }}
									inactiveProps={{
										className:
											"text-muted-foreground hover:bg-muted hover:text-foreground",
									}}
								>
									{item.label}
								</Link>
							))}
						</nav>
					</div>

					{/* Desktop: email + sign out inline. */}
					<div className="hidden items-center gap-3 md:flex">
						{email ? (
							<span className="text-sm text-muted-foreground">{email}</span>
						) : null}
						<ModeToggle />
						<Button variant="outline" size="sm" onClick={onSignOut}>
							Sign out
						</Button>
					</div>

					{/* Mobile: hamburger opens the nav drawer. */}
					<Sheet open={menuOpen} onOpenChange={setMenuOpen}>
						<SheetTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="md:hidden"
								aria-label="Open menu"
							>
								<Menu />
							</Button>
						</SheetTrigger>
						<SheetContent side="left" className="w-72">
							<SheetHeader>
								<SheetTitle>ledger</SheetTitle>
							</SheetHeader>
							<nav className="flex flex-col gap-1">
								{NAV.map((item) => (
									<Link
										key={item.to}
										to={item.to}
										onClick={() => setMenuOpen(false)}
										className="rounded-md px-3 py-2 text-sm font-medium transition-colors"
										activeProps={{ className: "bg-muted text-foreground" }}
										inactiveProps={{
											className:
												"text-muted-foreground hover:bg-muted hover:text-foreground",
										}}
									>
										{item.label}
									</Link>
								))}
							</nav>
							<div className="mt-auto flex flex-col gap-3 border-t pt-4">
								{email ? (
									<span className="truncate text-sm text-muted-foreground">
										{email}
									</span>
								) : null}
								<ModeToggle />
								<Button variant="outline" size="sm" onClick={onSignOut}>
									Sign out
								</Button>
							</div>
						</SheetContent>
					</Sheet>
				</div>
			</header>
			<main className="mx-auto max-w-6xl p-4 sm:p-6">{children}</main>
		</div>
	);
}
