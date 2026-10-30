import { policyErrorHint } from "./policy-model.ts";

/** The refusal code a client error carries, if any. */
export function errorCode(error: unknown): string | null {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : null;
	}
	return null;
}

/** The HTTP status a client error carries, if any. */
export function errorStatus(error: unknown): number | null {
	if (typeof error === "object" && error !== null && "status" in error) {
		const status = Reflect.get(error, "status");
		return typeof status === "number" ? status : null;
	}
	return null;
}

export function policyErrorMessage(error: unknown, fallback: string): string {
	const hint = policyErrorHint(errorCode(error));
	if (hint) {
		return hint;
	}
	return error instanceof Error && error.message ? error.message : fallback;
}
