import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Landing screen for unauthenticated visitors. AuthKit hosts the actual
 * credential entry, so the button is a full-page navigation to `/sign-in`
 * (the server route that redirects to the WorkOS hosted sign-in page).
 */
export function SignInScreen() {
	return (
		<main className="grid min-h-svh place-items-center bg-background p-6">
			<Card className="w-full max-w-sm">
				<CardContent className="flex flex-col items-center gap-6 py-2 text-center">
					<div className="flex flex-col items-center gap-3">
						<div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
							<Clock className="size-6" />
						</div>
						<div className="space-y-1">
							<h1 className="font-heading text-xl font-semibold tracking-tight">
								ledger
							</h1>
							<p className="text-sm text-muted-foreground">
								Sign in to view your dashboard
							</p>
						</div>
					</div>
					<Button asChild size="lg" className="w-full">
						{/* Plain anchor (not <Link>) forces a full navigation so the
						    server route can issue the 307 redirect to WorkOS. */}
						<a href="/sign-in">Sign in with AuthKit</a>
					</Button>
				</CardContent>
			</Card>
		</main>
	);
}
