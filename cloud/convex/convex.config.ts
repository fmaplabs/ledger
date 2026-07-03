import stripe from "@convex-dev/stripe/convex.config.js";
import workOSAuthKit from "@convex-dev/workos-authkit/convex.config";
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
	env: {
		WORKOS_CLIENT_ID: v.string(),
		WORKOS_API_KEY: v.string(),
		WORKOS_ENVIRONMENT_ID: v.string(),
		STRIPE_PUBLISHABLE_KEY: v.string(),
		STRIPE_SECRET_KEY: v.string(),
	},
});

app.use(workOSAuthKit);
app.use(stripe);

export default app;
