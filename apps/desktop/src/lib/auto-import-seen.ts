import type { ApiTarget } from "@/src/lib/api/client.ts";

// Legacy caches cannot establish which node/account acknowledged an import.
// Keep them intact, but never use them to suppress another owner's scan.
export async function autoImportSeenKey(
	namespace: string,
	target: ApiTarget
): Promise<string | null> {
	try {
		if (!globalThis.crypto?.subtle) return null;
		const identity = JSON.stringify([
			target.url.replace(/\/$/, ""),
			target.token ?? null,
			target.userJwt ?? null,
		]);
		const hash = await globalThis.crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(identity)
		);
		const digest = Array.from(new Uint8Array(hash), (byte) =>
			byte.toString(16).padStart(2, "0")
		).join("");
		return `${namespace}:authority-v2:${digest}`;
	} catch {
		return null;
	}
}
export function loadAutoImportSeen(
	key: string | null,
	fallback: Set<string>
): Set<string> {
	if (!key) return new Set(fallback);
	try {
		const raw: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
		return Array.isArray(raw)
			? new Set([
					...fallback,
					...raw.filter((item): item is string => typeof item === "string"),
				])
			: new Set(fallback);
	} catch {
		return new Set(fallback);
	}
}
export function saveAutoImportSeen(
	key: string | null,
	seen: Set<string>,
	fallback: Set<string>
): void {
	for (const id of seen) fallback.add(id);
	if (!key) return;
	try {
		localStorage.setItem(key, JSON.stringify([...seen]));
	} catch {
		/* Core deduplication remains authoritative if the local cache is unavailable. */
	}
}
