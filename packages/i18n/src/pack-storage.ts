import { LANGUAGE_PACK_STORAGE_KEY } from "./pack.ts";

// The browser-stored language pack choice, for runtimes without a host
// persistence adapter.

export function readStoredPackId(): string | null {
	try {
		return localStorage.getItem(LANGUAGE_PACK_STORAGE_KEY);
	} catch {
		return null;
	}
}

export function writeStoredPackId(value: string | null): void {
	try {
		if (value) {
			localStorage.setItem(LANGUAGE_PACK_STORAGE_KEY, value);
		} else {
			localStorage.removeItem(LANGUAGE_PACK_STORAGE_KEY);
		}
	} catch {
		// Private browsing and restricted webviews can deny storage. The in-memory
		// selection still works for the current session.
	}
}
