import { afterEach, describe, expect, it } from "bun:test";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import {
	ContentSealer,
	ContentSealLockedError,
	ContentSealOpenError,
	importContentKey,
	importContentKeys,
} from "../content-seal.ts";
import {
	loadYjsSnapshot,
	migrateLegacyYjsSnapshots,
	releaseAccountYjsSnapshots,
	type SnapshotBackend,
	setYjsSnapshotDependenciesForTests,
	storeYjsSnapshot,
} from "./yjs-persistence.ts";
import { RyuYjsProvider, releaseCollaborationAccount } from "./yjs-provider.ts";

const SECRET = "board minutes: acquisition of Northwind";

class MapBackend implements SnapshotBackend {
	readonly map = new Map<string, unknown>();
	failPutsFor: string | null = null;
	get(key: string) {
		return Promise.resolve(this.map.get(key));
	}
	put(key: string, value: unknown) {
		if (this.failPutsFor !== null && key.includes(this.failPutsFor)) {
			return Promise.reject(new Error("injected write failure"));
		}
		this.map.set(key, value);
		return Promise.resolve();
	}
	delete(key: string) {
		this.map.delete(key);
		return Promise.resolve();
	}
	keys() {
		return Promise.resolve([...this.map.keys()]);
	}
	/** Every byte on "disk", as text, for plaintext checks. */
	dump(): string {
		const decoder = new TextDecoder();
		let out = "";
		for (const [key, value] of this.map) {
			out += key;
			if (value instanceof ArrayBuffer) {
				out += decoder.decode(value);
			} else if (typeof value === "object" && value !== null) {
				for (const field of Object.values(value)) {
					out +=
						field instanceof Uint8Array ? decoder.decode(field) : String(field);
				}
			}
		}
		return out;
	}
}

function sealer(fill = 4): ContentSealer {
	return new ContentSealer(() =>
		importContentKey(new Uint8Array(32).fill(fill))
	);
}

/** A desktop sealer with retired keys (keys the app used earlier). */
function sealerWith(current: number, retired: number[]): ContentSealer {
	return new ContentSealer(() =>
		importContentKeys(
			new Uint8Array(32).fill(current),
			retired.map((fill) => new Uint8Array(32).fill(fill))
		)
	);
}

function docUpdate(text: string): Uint8Array {
	const doc = new Doc();
	doc.getText("body").insert(0, text);
	return encodeStateAsUpdate(doc);
}

function textOf(update: Uint8Array): string {
	const doc = new Doc();
	applyUpdate(doc, update);
	return doc.getText("body").toString();
}

let restore: (() => void) | null = null;
afterEach(() => {
	restore?.();
	restore = null;
});

function install(backend: MapBackend, next = sealer()) {
	restore = setYjsSnapshotDependenciesForTests({ backend, sealer: next });
}

describe("sealed Yjs snapshots", () => {
	it("stores no plaintext and loads it back for the same account", async () => {
		const backend = new MapBackend();
		install(backend);
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: true,
		});
		expect(backend.dump()).not.toContain("Northwind");
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		expect(loaded?.synced).toBe(true);
		expect(textOf(loaded?.update ?? new Uint8Array())).toBe(SECRET);
		expect(await loadYjsSnapshot("room-1", "user-b")).toBeNull();
	});

	it("does not open a record moved to another room", async () => {
		const backend = new MapBackend();
		install(backend);
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: true,
		});
		backend.map.set("v1:user-a:room-2", backend.map.get("v1:user-a:room-1"));
		await expect(loadYjsSnapshot("room-2", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		// Kept aside, not deleted.
		expect(backend.map.has("q1:v1:user-a:room-2")).toBe(true);
	});

	it("reads a legacy plaintext snapshot, reseals it and removes the plaintext", async () => {
		const backend = new MapBackend();
		install(backend);
		backend.map.set("room-legacy", docUpdate(SECRET).slice().buffer);
		const loaded = await loadYjsSnapshot("room-legacy", "user-a");
		expect(textOf(loaded?.update ?? new Uint8Array())).toBe(SECRET);
		expect(loaded?.synced).toBe(false);
		expect(backend.map.has("room-legacy")).toBe(false);
		expect(backend.dump()).not.toContain("Northwind");
		const again = await loadYjsSnapshot("room-legacy", "user-a");
		expect(textOf(again?.update ?? new Uint8Array())).toBe(SECRET);
	});

	it("keeps the plaintext when the sealed write fails", async () => {
		const backend = new MapBackend();
		install(backend);
		backend.map.set("room-legacy", docUpdate(SECRET).slice().buffer);
		backend.failPutsFor = "room-legacy";
		await expect(migrateLegacyYjsSnapshots("user-a")).rejects.toThrow(
			"injected"
		);
		expect(backend.map.get("room-legacy")).toBeInstanceOf(ArrayBuffer);
		backend.failPutsFor = null;
		expect(await migrateLegacyYjsSnapshots("user-a")).toBe(1);
		expect(await migrateLegacyYjsSnapshots("user-a")).toBe(0);
		expect(backend.dump()).not.toContain("Northwind");
	});

	it("merges a legacy snapshot into an existing sealed record instead of replacing it", async () => {
		const backend = new MapBackend();
		install(backend);
		// The current build holds an edit Core never received.
		await storeYjsSnapshot("room-1", docUpdate("unsynced edit"), {
			account: "user-a",
			synced: false,
		});
		// A downgraded build opened the room empty and wrote plaintext.
		backend.map.set("room-1", docUpdate("older build text").slice().buffer);

		expect(await migrateLegacyYjsSnapshots("user-a")).toBe(1);

		expect(backend.map.has("room-1")).toBe(false);
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		const text = textOf(loaded?.update ?? new Uint8Array());
		expect(text).toContain("unsynced edit");
		expect(text).toContain("older build text");
		expect(loaded?.synced).toBe(false);
		expect(backend.dump()).not.toContain("older build");
	});

	it("leaves a legacy snapshot and the sealed record untouched while locked", async () => {
		const backend = new MapBackend();
		install(backend);
		await storeYjsSnapshot("room-1", docUpdate("unsynced edit"), {
			account: "user-a",
			synced: false,
		});
		backend.map.set("room-1", docUpdate("older build text").slice().buffer);
		const before = [...backend.map.entries()];
		restore?.();
		install(
			backend,
			new ContentSealer(() => Promise.reject(new ContentSealLockedError()))
		);
		await expect(migrateLegacyYjsSnapshots("user-a")).rejects.toBeInstanceOf(
			ContentSealLockedError
		);
		expect([...backend.map.entries()]).toEqual(before);
	});

	it("stores the legacy snapshot when the existing record does not open", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate("other key"), {
			account: "user-a",
			synced: false,
		});
		const foreign = backend.map.get("v1:user-a:room-1");
		restore?.();
		install(backend, sealer(2));
		backend.map.set("room-1", docUpdate(SECRET).slice().buffer);
		expect(await migrateLegacyYjsSnapshots("user-a")).toBe(1);
		expect(backend.map.get("q1:v1:user-a:room-1")).toBe(foreign);
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		expect(textOf(loaded?.update ?? new Uint8Array())).toBe(SECRET);
	});

	it("merges a record a provider persisted while the sweep was sealing", async () => {
		const backend = new MapBackend();
		install(backend);
		backend.map.set("room-1", docUpdate("older build text").slice().buffer);
		const concurrent = new MapBackend();
		const restoreConcurrent = setYjsSnapshotDependenciesForTests({
			backend: concurrent,
		});
		await storeYjsSnapshot("room-1", docUpdate("provider edit"), {
			account: "user-a",
			synced: false,
		});
		restoreConcurrent();
		const persisted = concurrent.map.get("v1:user-a:room-1");
		let recordReads = 0;
		const originalGet = backend.get.bind(backend);
		backend.get = (key: string) => {
			if (key === "v1:user-a:room-1") {
				recordReads += 1;
				// The provider persists right after the sweep's first look.
				if (recordReads === 2) {
					backend.map.set(key, persisted);
				}
			}
			return originalGet(key);
		};

		expect(await migrateLegacyYjsSnapshots("user-a")).toBe(1);

		const loaded = await loadYjsSnapshot("room-1", "user-a");
		const text = textOf(loaded?.update ?? new Uint8Array());
		expect(text).toContain("provider edit");
		expect(text).toContain("older build text");
	});

	it("serves legacy edits next to a sealed record so a later persist keeps them", async () => {
		const backend = new MapBackend();
		install(backend);
		await storeYjsSnapshot("room-1", docUpdate("sealed text"), {
			account: "user-a",
			synced: true,
		});
		backend.map.set("room-1", docUpdate("offline edit").slice().buffer);

		// The provider loads before the startup sweep has run.
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		const doc = new Doc();
		applyUpdate(doc, loaded?.update ?? new Uint8Array());
		expect(loaded?.synced).toBe(false);
		// The sweep runs afterwards; then the provider persists its document.
		await migrateLegacyYjsSnapshots("user-a");
		await storeYjsSnapshot("room-1", encodeStateAsUpdate(doc), {
			account: "user-a",
			synced: false,
		});

		expect(backend.map.has("room-1")).toBe(false);
		const stored = await loadYjsSnapshot("room-1", "user-a");
		const text = textOf(stored?.update ?? new Uint8Array());
		expect(text).toContain("sealed text");
		expect(text).toContain("offline edit");
	});

	it("leaves everything in place while the key is locked", async () => {
		const backend = new MapBackend();
		install(backend);
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: false,
		});
		const before = [...backend.map.entries()];
		restore?.();
		install(
			backend,
			new ContentSealer(() => Promise.reject(new ContentSealLockedError()))
		);
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealLockedError
		);
		expect([...backend.map.entries()]).toEqual(before);
	});

	it("quarantines a snapshot sealed under another key instead of clearing it", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: true,
		});
		restore?.();
		install(backend, sealer(2));
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		expect(backend.map.has("q1:v1:user-a:room-1")).toBe(true);
		expect(await loadYjsSnapshot("room-1", "user-a")).toBeNull();
	});

	it("keeps every quarantined snapshot when the key changes twice", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: false,
		});
		const original = backend.map.get("v1:user-a:room-1");
		restore?.();
		install(backend, sealer(2));
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		await storeYjsSnapshot("room-1", docUpdate("interim"), {
			account: "user-a",
			synced: false,
		});
		const interim = backend.map.get("v1:user-a:room-1");
		restore?.();
		install(backend, sealer(3));
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		expect(backend.map.get("q1:v1:user-a:room-1")).toBe(original);
		expect(backend.map.get("q1:v1:user-a:room-1#1")).toBe(interim);
		expect(backend.map.has("v1:user-a:room-1")).toBe(false);
	});

	it("does not duplicate a record that is already quarantined", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: false,
		});
		const original = backend.map.get("v1:user-a:room-1");
		// An earlier move put the copy aside but stopped before deleting it.
		backend.map.set("q1:v1:user-a:room-1", structuredClone(original));
		restore?.();
		install(backend, sealer(2));
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		expect(backend.map.has("q1:v1:user-a:room-1#1")).toBe(false);
		expect(backend.map.has("v1:user-a:room-1")).toBe(false);
	});

	it("leaves the live record when the aside copy cannot be written", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: false,
		});
		restore?.();
		install(backend, sealer(2));
		backend.failPutsFor = "q1:";
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toThrow(
			"injected write failure"
		);
		expect(backend.map.has("v1:user-a:room-1")).toBe(true);
	});

	it("opens a snapshot sealed under a retired key and reseals it", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate(SECRET), {
			account: "user-a",
			synced: true,
		});
		restore?.();
		install(backend, sealerWith(2, [1]));
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		expect(textOf(loaded?.update ?? new Uint8Array())).toBe(SECRET);
		expect(loaded?.synced).toBe(true);
		expect(backend.map.has("q1:v1:user-a:room-1")).toBe(false);
		restore?.();
		install(backend, sealer(2));
		const resealed = await loadYjsSnapshot("room-1", "user-a");
		expect(textOf(resealed?.update ?? new Uint8Array())).toBe(SECRET);
		expect(resealed?.synced).toBe(true);
	});

	/** Key 1 stored `text`; a launch on key 2 (an older build) set it aside. */
	async function flipped(text: string, synced = false): Promise<MapBackend> {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate(text), {
			account: "user-a",
			synced,
		});
		restore?.();
		install(backend, sealer(2));
		// Sets the record aside (and reports it as not opening).
		await loadYjsSnapshot("room-1", "user-a").catch(() => null);
		restore?.();
		return backend;
	}

	it("restores a snapshot set aside under what is the current key again", async () => {
		const backend = await flipped(SECRET, true);
		expect(backend.map.has("q1:v1:user-a:room-1")).toBe(true);
		expect(backend.map.has("v1:user-a:room-1")).toBe(false);
		install(backend, sealerWith(1, [2]));
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		expect(textOf(loaded?.update ?? new Uint8Array())).toBe(SECRET);
		expect(loaded?.synced).toBe(true);
		expect(backend.map.has("q1:v1:user-a:room-1")).toBe(false);
		expect(backend.dump()).not.toContain("Northwind");
	});

	it("restores a snapshot set aside under a retired key, resealed", async () => {
		const backend = await flipped(SECRET);
		install(backend, sealerWith(2, [1]));
		expect(
			textOf(
				(await loadYjsSnapshot("room-1", "user-a"))?.update ?? new Uint8Array()
			)
		).toBe(SECRET);
		expect(backend.map.has("q1:v1:user-a:room-1")).toBe(false);
		restore?.();
		install(backend, sealer(2));
		expect(
			textOf(
				(await loadYjsSnapshot("room-1", "user-a"))?.update ?? new Uint8Array()
			)
		).toBe(SECRET);
	});

	it("merges a restored snapshot into the live record", async () => {
		const backend = await flipped("aside text");
		install(backend, sealer(2));
		await storeYjsSnapshot("room-1", docUpdate("live text"), {
			account: "user-a",
			synced: true,
		});
		restore?.();
		install(backend, sealerWith(2, [1]));
		const loaded = await loadYjsSnapshot("room-1", "user-a");
		const text = textOf(loaded?.update ?? new Uint8Array());
		expect(text).toContain("aside text");
		expect(text).toContain("live text");
		// The aside copy was never synced, so neither is the merge.
		expect(loaded?.synced).toBe(false);
		expect(backend.map.has("q1:v1:user-a:room-1")).toBe(false);
		// Idempotent: loading again changes nothing.
		const before = [...backend.map.entries()];
		await loadYjsSnapshot("room-1", "user-a");
		expect([...backend.map.entries()]).toEqual(before);
	});

	it("restores every numbered quarantine slot after two key changes", async () => {
		const backend = new MapBackend();
		install(backend, sealer(1));
		await storeYjsSnapshot("room-1", docUpdate("first"), {
			account: "user-a",
			synced: false,
		});
		restore?.();
		install(backend, sealer(2));
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		await storeYjsSnapshot("room-1", docUpdate("second"), {
			account: "user-a",
			synced: false,
		});
		restore?.();
		install(backend, sealer(3));
		await expect(loadYjsSnapshot("room-1", "user-a")).rejects.toBeInstanceOf(
			ContentSealOpenError
		);
		expect(backend.map.has("q1:v1:user-a:room-1#1")).toBe(true);
		restore?.();
		install(backend, sealerWith(3, [1, 2]));
		const text = textOf(
			(await loadYjsSnapshot("room-1", "user-a"))?.update ?? new Uint8Array()
		);
		expect(text).toContain("first");
		expect(text).toContain("second");
		expect(
			[...backend.map.keys()].filter((key) => key.startsWith("q1:"))
		).toEqual([]);
	});

	it("leaves a set-aside snapshot that still does not open", async () => {
		const backend = await flipped(SECRET);
		const aside = backend.map.get("q1:v1:user-a:room-1");
		install(backend, sealerWith(2, [9]));
		expect(await loadYjsSnapshot("room-1", "user-a")).toBeNull();
		expect(backend.map.get("q1:v1:user-a:room-1")).toBe(aside);
	});

	it("changes nothing while the key is locked", async () => {
		const backend = await flipped(SECRET);
		const before = [...backend.map.entries()];
		install(
			backend,
			new ContentSealer(() => Promise.reject(new ContentSealLockedError()))
		);
		expect(await loadYjsSnapshot("room-1", "user-a")).toBeNull();
		expect([...backend.map.entries()]).toEqual(before);
	});

	it("on sign-out clears synced snapshots and keeps unsynced ones", async () => {
		const backend = new MapBackend();
		install(backend);
		await storeYjsSnapshot("synced", docUpdate("a"), {
			account: "user-a",
			synced: true,
		});
		await storeYjsSnapshot("pending", docUpdate("b"), {
			account: "user-a",
			synced: false,
		});
		await storeYjsSnapshot("other", docUpdate("c"), {
			account: "user-b",
			synced: true,
		});
		expect(await releaseAccountYjsSnapshots("user-a")).toEqual({
			cleared: 1,
			kept: 1,
		});
		expect(backend.map.has("v1:user-a:synced")).toBe(false);
		expect(backend.map.has("v1:user-a:pending")).toBe(true);
		expect(backend.map.has("v1:user-b:other")).toBe(true);
	});

	it("flushes a live document's offline edits and keeps them at sign-out", async () => {
		const backend = new MapBackend();
		install(backend);
		const provider = new RyuYjsProvider({
			account: "user-a",
			roomId: "offline-room",
			target: {
				fetch: () => Promise.reject(new Error("offline")),
				url: "http://127.0.0.1:1",
				token: null,
				userJwt: null,
			},
		});
		provider.document.getText("body").insert(0, SECRET);
		expect(provider.hasUnsyncedChanges()).toBe(true);
		expect(await releaseCollaborationAccount("user-a", 0)).toEqual({
			cleared: 0,
			kept: 1,
		});
		const kept = await loadYjsSnapshot("offline-room", "user-a");
		expect(textOf(kept?.update ?? new Uint8Array())).toBe(SECRET);
		expect(backend.dump()).not.toContain("Northwind");
		provider.destroy();
	});
});
