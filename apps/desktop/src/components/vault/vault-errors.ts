// Readable messages for vault API failures. Core errors look like
// `vault_denied: the `read` capability is required on `default/API_KEY``; the
// code prefix is for programs, so the page shows only the sentence.

import { isStepUpRequired } from "@/lib/step-up.ts";
import { controlPlaneRefusalMessage } from "@/src/lib/access-refusal.ts";
import { ApiError } from "@/src/lib/api/client.ts";

const CODE_PREFIX = /^vault_[a-z_]+:\s*/;

export function vaultErrorMessage<TError>(
	error: TError,
	fallback: string
): string {
	if (error instanceof ApiError) {
		const refusal = controlPlaneRefusalMessage(error);
		if (refusal) {
			return refusal;
		}
		if (error.serverMessage) {
			const text = error.serverMessage.replace(CODE_PREFIX, "");
			return text.charAt(0).toUpperCase() + text.slice(1);
		}
		if (error.status === 403) {
			return "You do not have access to do that.";
		}
		return fallback;
	}
	return error instanceof Error && error.message ? error.message : fallback;
}

export function isForbidden<TError>(error: TError): boolean {
	return error instanceof ApiError && error.status === 403;
}

export function isStaleVersion<TError>(error: TError): boolean {
	return error instanceof ApiError && error.status === 409;
}

/** Core's pass-through of the control plane's `org.credentials` step-up refusal. */
export function isVaultStepUpRequired<TError>(error: TError): boolean {
	return (
		error instanceof ApiError &&
		error.status === 403 &&
		isStepUpRequired(error.body)
	);
}

/** `useStepUp().guard`, narrowed to the scope a shared plaintext read needs. */
export type VaultStepUpGuard = <T>(
	scope: "org.credentials",
	action: () => Promise<T>
) => Promise<T | null>;

/**
 * Run a reveal or export of shared values. When the control plane asks for a
 * step-up (no organization or team node vouched for this request: a personal
 * or remote node, or an active forwarding tunnel), confirm it's you and read
 * once more. Resolves `null` when the prompt is dismissed: nothing was read.
 * Any other failure is rethrown unchanged.
 */
export async function readWithStepUp<T>(
	guard: VaultStepUpGuard,
	read: () => Promise<T>
): Promise<T | null> {
	try {
		return await read();
	} catch (error) {
		if (!isVaultStepUpRequired(error)) {
			throw error;
		}
		return await guard("org.credentials", read);
	}
}
