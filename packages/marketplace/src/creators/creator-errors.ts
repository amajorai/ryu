import { errorText } from "@ryu/i18n/error-text";

export const SEARCH_DEBOUNCE_MS = 250;

// Rejections arrive unchanged from the native Promise catch callback.
export type CreatorServiceRejection = Parameters<
	NonNullable<Parameters<Promise<void>["catch"]>[0]>
>[0];

export function errorMessage(
	cause: CreatorServiceRejection,
	fallback: string
): string {
	return errorText(cause, fallback);
}

export function isAbort(cause: CreatorServiceRejection): boolean {
	return cause instanceof DOMException && cause.name === "AbortError";
}
