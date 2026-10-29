/** UUIDs for stored resources, including sandboxed WebViews without randomUUID. */
export function createResourceId(): string {
	if (globalThis.crypto?.randomUUID) {
		return globalThis.crypto.randomUUID();
	}
	if (!globalThis.crypto?.getRandomValues) {
		throw new Error("Secure resource IDs are unavailable on this surface.");
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	if (!bytes.some((byte) => byte !== 0)) {
		throw new Error("Secure resource ID entropy is unavailable.");
	}
	bytes[6] = ((bytes[6] ?? 0) & 15) | 64;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
