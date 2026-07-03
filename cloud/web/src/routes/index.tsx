import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@workos/authkit-tanstack-react-start/client";
import { SignInScreen } from "@/components/sign-in-screen";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	// `user` is resolved server-side in the root route's `beforeLoad`
	// (via getAuth()), so the correct view renders during SSR — no flash.
	const { user } = Route.useRouteContext();

	if (!user) {
		return <SignInScreen />;
	}

	return <Dashboard />;
}

function Dashboard() {
	const { user } = Route.useRouteContext();
	const { signOut } = useAuth();

	return (
		<div className="min-h-svh">
			<header className="flex items-center justify-between border-b px-6 py-4">
				<span className="font-heading text-lg font-semibold tracking-tight">
					ledger
				</span>
				<div className="flex items-center gap-3">
					<span className="text-sm text-muted-foreground">{user?.email}</span>
					<Button variant="outline" size="sm" onClick={() => signOut()}>
						Sign out
					</Button>
				</div>
			</header>
			<main className="p-6">
				<h1 className="font-heading text-2xl font-semibold tracking-tight">
					Welcome{user?.firstName ? `, ${user.firstName}` : ""}
				</h1>
				<p className="mt-2 text-muted-foreground">
					You're signed in. Your dashboard will live here.
				</p>
			</main>
		</div>
	);
}
