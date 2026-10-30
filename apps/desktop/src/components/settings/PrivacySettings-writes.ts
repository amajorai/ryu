// apps/desktop/src/components/settings/PrivacySettings-writes.ts
//
// Per-node tracking of in-flight privacy preference writes.

// Preferences belong to the physical node. An already-issued write can still
// settle after credentials change; a new authority must read after that ACK.
export type PrivacyMutation = () => Promise<unknown>;
export const privacyWrites = new Map<string, Set<Promise<void>>>();
export function trackPrivacyWrite(
	url: string,
	write: PrivacyMutation
): Promise<void> {
	const pending = privacyWrites.get(url) ?? new Set<Promise<void>>();
	privacyWrites.set(url, pending);
	const operation = Promise.resolve().then(async () => {
		await write();
	});
	pending.add(operation);
	const complete = () => {
		pending.delete(operation);
		if (pending.size === 0 && privacyWrites.get(url) === pending) {
			privacyWrites.delete(url);
		}
	};
	void operation.then(complete, complete);
	return operation;
}
export async function waitPrivacyWrites(url: string) {
	while (privacyWrites.get(url)?.size) {
		await Promise.allSettled(privacyWrites.get(url)!);
	}
}
