// WorkOS AuthKit via Convex's Custom JWT providers (not plain OIDC):
// AuthKit access tokens carry iss = https://api.workos.com/user_management/
// <client id> and no aud claim, so the OIDC provider shape (which insists on
// aud === applicationID) can't validate them. Shape follows
// https://docs.convex.dev/auth/authkit — set WORKOS_CLIENT_ID on the
// deployment (manual step 10 of stage 12).

// auth.config.ts is evaluated at push time where process.env exists, but the
// convex/ tsconfig has no Node types — declare just what's used.
declare const process: { env: Record<string, string | undefined> };

const clientId = process.env.WORKOS_CLIENT_ID;

export default {
	providers: [
		{
			type: "customJwt",
			issuer: "https://api.workos.com/",
			algorithm: "RS256",
			jwks: `https://api.workos.com/sso/jwks/${clientId}`,
			applicationID: clientId,
		},
		{
			type: "customJwt",
			issuer: `https://api.workos.com/user_management/${clientId}`,
			algorithm: "RS256",
			jwks: `https://api.workos.com/sso/jwks/${clientId}`,
		},
	],
};
