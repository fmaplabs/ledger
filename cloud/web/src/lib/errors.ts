import { ConvexError } from "convex/values";

// In production Convex redacts a thrown error's `message` to "Server Error";
// only a ConvexError's `data` payload reaches the client. Our functions throw
// ConvexError with a string message, so surface that — anything else (network
// failures, unexpected server errors) gets the caller's fallback.
export function errorMessage(err: unknown, fallback: string): string {
	if (err instanceof ConvexError && typeof err.data === "string") {
		return err.data;
	}
	return fallback;
}
