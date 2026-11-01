// Same-document localStorage writers broadcast a `storage` event themselves,
// because the browser only fires the native one in *other* documents. The
// broadcast must be a keyed `StorageEvent`: the sealed localStorage facade
// (content-seal.ts) also listens for `storage` and reads `event.key`. A bare
// `new Event("storage")` has no `key` at all (it threw in the facade's
// listener), and an unkeyed `StorageEvent` has `key === null`, which means
// "another window cleared all of storage" and would drop the sealed cache.

/** Tell this document's `storage` listeners that `key` was just written here. */
export function announceLocalStorageChange(key: string): void {
	if (globalThis.window === undefined) {
		return;
	}
	window.dispatchEvent(new StorageEvent("storage", { key }));
}
