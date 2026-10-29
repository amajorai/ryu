import { ApiError } from "./client.ts";

/** Replace internal Core API paths with a useful action-level retry message. */
export function repositoryCreationErrorMessage<TError>(error: TError): string {
	if (error instanceof ApiError) {
		if (error.status === 401) {
			return "Sign in to GitHub on the active node and try again.";
		}
		if (error.status === 403) {
			return "The active node cannot create this GitHub repository. Check the GitHub account permissions.";
		}
		if (error.status >= 500) {
			return "GitHub is temporarily unavailable. Try again.";
		}
		return `Could not create the GitHub repository (HTTP ${error.status}). Try again.`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return "Could not create the GitHub repository. Try again.";
}
