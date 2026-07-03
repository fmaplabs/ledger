import type { ConvexQueryClient } from "@convex-dev/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import type { ConvexReactClient } from "convex/react";
import appCss from "../styles.css?url";

interface RouterContext {
	queryClient: QueryClient;
	convexClient: ConvexReactClient;
	convexQueryClient: ConvexQueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: "ledger",
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
	notFoundComponent: () => <div>Not Found</div>,
	beforeLoad: async (ctx) => {
		const auth = await getAuth();

		// During SSR only (the only time serverHttpClient exists),
		// set the WorkOS auth token to make HTTP queries with.
		if (auth.user) {
			ctx.context.convexQueryClient.serverHttpClient?.setAuth(auth.accessToken);
		}

		return { user: auth.user };
	},
});

function RootDocument({ children }: { children: React.ReactNode }) {
	// Auth + Convex providers are supplied by the router's `InnerWrap`
	// (AuthKitProvider → ConvexProviderWithAuth in router.tsx), so the
	// document shell only needs to render the app tree.
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
