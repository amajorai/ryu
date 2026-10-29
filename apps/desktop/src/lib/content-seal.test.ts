import { describe, expect, it } from "bun:test";
import {
	ContentSealer,
	ContentSealLockedError,
	ContentSealOpenError,
	contentKeyId,
	importContentKey,
	importContentKeys,
	isSealedBytesRecord,
	isSealedLocalKey,
	LOCAL_KID_MARKER_KEY,
	LOCAL_QUARANTINE_PREFIX,
	looksContentSealed,
	mergePromptSuites,
	parseDesktopContentKeys,
	retrySealedLocalUnlock,
	SealedLocalStorage,
	sealedLocalSlot,
} from "./content-seal.ts";

const TEXT = "quarterly plan: hire two designers";

function fixedSealer(fill = 7): ContentSealer {
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

describe("content sealer", () => {
	it("seals text that does not carry the plaintext and opens it", async () => {
		const sealer = fixedSealer();
		const sealed = await sealer.sealText("local-storage", "suite", "a1", TEXT);
		expect(looksContentSealed(sealed)).toBe(true);
		expect(sealed).not.toContain("quarterly");
		expect(atob(sealed.slice("wenc:v1:".length))).not.toContain("quarterly");
		expect(await sealer.openText("local-storage", "suite", "a1", sealed)).toBe(
			TEXT
		);
	});

	it("binds a value to its store, purpose and id", async () => {
		const sealer = fixedSealer();
		const sealed = await sealer.sealText("local-storage", "suite", "a1", TEXT);
		await expect(
			sealer.openText("local-storage", "suite", "a2", sealed)
		).rejects.toBeInstanceOf(ContentSealOpenError);
		await expect(
			sealer.openText("local-storage", "tabs", "a1", sealed)
		).rejects.toBeInstanceOf(ContentSealOpenError);
		await expect(
			sealer.openText("collaboration", "suite", "a1", sealed)
		).rejects.toBeInstanceOf(ContentSealOpenError);
		await expect(
			fixedSealer(8).openText("local-storage", "suite", "a1", sealed)
		).rejects.toBeInstanceOf(ContentSealOpenError);
		await expect(
			sealer.openText("local-storage", "suite", "a1", TEXT)
		).rejects.toBeInstanceOf(ContentSealOpenError);
	});

	it("seals bytes into a record with the key id", async () => {
		const sealer = fixedSealer();
		const bytes = new TextEncoder().encode(TEXT);
		const record = await sealer.sealBytes(
			"collaboration",
			"snapshot",
			"r",
			bytes
		);
		expect(isSealedBytesRecord(record)).toBe(true);
		expect(record.kid).toBe(await sealer.kid("collaboration"));
		expect(new TextDecoder().decode(record.ct)).not.toContain("quarterly");
		expect(
			await sealer.openBytes("collaboration", "snapshot", "r", record)
		).toEqual(bytes);
		await expect(
			sealer.openBytes("collaboration", "snapshot", "other", record)
		).rejects.toBeInstanceOf(ContentSealOpenError);
	});

	it("gives different keys different ids and the same key the same id", async () => {
		const a = await importContentKey(new Uint8Array(32).fill(1));
		const b = await importContentKey(new Uint8Array(32).fill(1));
		const c = await importContentKey(new Uint8Array(32).fill(2));
		expect(a.kid).toBe(b.kid);
		expect(a.kid).not.toBe(c.kid);
		expect(a.kid).toMatch(/^[0-9a-f]{16}$/);
		expect(await contentKeyId(a.key)).toBe(a.kid);
		expect(a.key.extractable).toBe(false);
	});

	it("zeroes the raw key bytes after import", async () => {
		const raw = new Uint8Array(32).fill(9);
		await importContentKey(raw);
		expect(raw.every((byte) => byte === 0)).toBe(true);
		await expect(importContentKey(new Uint8Array(16))).rejects.toBeInstanceOf(
			ContentSealLockedError
		);
	});

	it("reads the desktop answer with retired keys, and the bare key of an older build", () => {
		const bare = parseDesktopContentKeys(new Array(32).fill(1));
		expect(bare.key).toEqual(new Uint8Array(32).fill(1));
		expect(bare.retired).toEqual([]);
		const wire = {
			key: new Array(32).fill(1),
			retired: [new Array(32).fill(2), "junk"],
		};
		const keys = parseDesktopContentKeys(wire);
		expect(keys.key).toEqual(new Uint8Array(32).fill(1));
		expect(keys.retired).toEqual([new Uint8Array(32).fill(2)]);
		// The IPC copies are zeroed too.
		expect(wire.key.every((byte) => byte === 0)).toBe(true);
		for (const malformed of [{ retired: [] }, "key", 7, {}]) {
			expect(() => parseDesktopContentKeys(malformed)).toThrow(
				ContentSealLockedError
			);
		}
	});

	it("imports retired keys non-extractable, zeroed, deduplicated and skipping bad ones", async () => {
		const raw = new Uint8Array(32).fill(1);
		const retired = [
			new Uint8Array(32).fill(2),
			new Uint8Array(32).fill(1),
			new Uint8Array(32).fill(2),
			new Uint8Array(5).fill(3),
		];
		const keys = await importContentKeys(raw, retired);
		expect(keys.retired?.length).toBe(1);
		expect(keys.retired?.[0]?.kid).toBe(
			(await importContentKey(new Uint8Array(32).fill(2))).kid
		);
		expect(keys.retired?.[0]?.key.extractable).toBe(false);
		expect(raw.every((byte) => byte === 0)).toBe(true);
		for (const bytes of retired) {
			expect(bytes.every((byte) => byte === 0)).toBe(true);
		}
	});

	it("opens values sealed under a retired key and says they are stale", async () => {
		const old = fixedSealer(1);
		const text = await old.sealText("local-storage", "p", "i", TEXT);
		const bytes = await old.sealBytes(
			"collaboration",
			"s",
			"r",
			new TextEncoder().encode(TEXT)
		);
		const desktop = sealerWith(2, [1]);
		expect(await desktop.retiredKids("local-storage")).toEqual([
			await old.kid("local-storage"),
		]);
		expect(
			await desktop.openTextEntry("local-storage", "p", "i", text)
		).toEqual({ stale: true, value: TEXT });
		const opened = await desktop.openBytesEntry(
			"collaboration",
			"s",
			"r",
			bytes
		);
		expect(opened.stale).toBe(true);
		expect(new TextDecoder().decode(opened.value)).toBe(TEXT);
		const fresh = await desktop.sealText("local-storage", "p", "i", TEXT);
		expect(
			await desktop.openTextEntry("local-storage", "p", "i", fresh)
		).toEqual({ stale: false, value: TEXT });
		// Retired keys never seal, and still bind the associated data.
		await expect(
			old.openText("local-storage", "p", "i", fresh)
		).rejects.toThrow(ContentSealOpenError);
		await expect(
			desktop.openText("local-storage", "p", "other", text)
		).rejects.toBeInstanceOf(ContentSealOpenError);
	});

	it("reports a locked key and retries it on the next call", async () => {
		let calls = 0;
		const sealer = new ContentSealer(() => {
			calls += 1;
			if (calls === 1) {
				return Promise.reject(new ContentSealLockedError());
			}
			return importContentKey(new Uint8Array(32).fill(3));
		});
		await expect(
			sealer.sealText("local-storage", "p", "i", TEXT)
		).rejects.toBeInstanceOf(ContentSealLockedError);
		expect(
			looksContentSealed(await sealer.sealText("local-storage", "p", "i", TEXT))
		).toBe(true);
		expect(calls).toBe(2);
	});
});

class MemoryStorage implements Storage {
	readonly map = new Map<string, string>();
	failWrites = false;
	get length() {
		return this.map.size;
	}
	clear() {
		this.map.clear();
	}
	getItem(key: string) {
		return this.map.get(key) ?? null;
	}
	key(index: number) {
		return [...this.map.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.map.delete(key);
	}
	setItem(key: string, value: string) {
		if (this.failWrites) {
			throw new Error("QuotaExceededError");
		}
		this.map.set(key, value);
	}
	dump() {
		return [...this.map.entries()].flat().join("\n");
	}
}

/** A sealer whose sealing waits on `gate` (a slow key or crypto call). */
function gatedSealer(gate: Promise<void>): ContentSealer {
	class GatedSealer extends ContentSealer {
		override async sealText(
			...args: Parameters<ContentSealer["sealText"]>
		): Promise<string> {
			await gate;
			return super.sealText(...args);
		}
	}
	return new GatedSealer(() => importContentKey(new Uint8Array(32).fill(7)));
}

const SUITE_KEY = "prompt-studio-tests:agent-1";
const SUITE = JSON.stringify({ rows: [{ vars: { q: "salary of Jane Doe" } }] });

describe("sealed localStorage", () => {
	it("seals legacy plaintext under its own slot and serves it from memory", async () => {
		const disk = new MemoryStorage();
		disk.setItem(SUITE_KEY, SUITE);
		disk.setItem("ryu_oidc_user", '{"email":"jane@example.com"}');
		disk.setItem("ryu_theme", "dark");
		const store = new SealedLocalStorage(fixedSealer(), () => disk);
		await store.hydrate();
		expect(store.getItem(SUITE_KEY)).toBe(SUITE);
		expect(store.getItem("ryu_oidc_user")).toContain("jane@example.com");
		expect(disk.dump()).not.toContain("Jane Doe");
		expect(disk.dump()).not.toContain("jane@example.com");
		expect(
			looksContentSealed(disk.getItem(sealedLocalSlot(SUITE_KEY)) ?? "")
		).toBe(true);
		// An older build reading the plain key finds nothing to misparse.
		expect(disk.getItem(SUITE_KEY)).toBeNull();
		// Not sealed: everything else passes through.
		expect(disk.getItem("ryu_theme")).toBe("dark");
		expect(store.getItem("ryu_theme")).toBe("dark");
		// A fresh process reads the sealed values back.
		const next = new SealedLocalStorage(fixedSealer(), () => disk);
		await next.hydrate();
		expect(next.getItem(SUITE_KEY)).toBe(SUITE);
	});

	it("keeps the plaintext when the sealed write fails, and retries", async () => {
		const disk = new MemoryStorage();
		disk.setItem(SUITE_KEY, SUITE);
		disk.failWrites = true;
		const store = new SealedLocalStorage(fixedSealer(), () => disk);
		await store.hydrate();
		expect(disk.getItem(SUITE_KEY)).toBe(SUITE);
		expect(store.getItem(SUITE_KEY)).toBe(SUITE);
		disk.failWrites = false;
		await store.flush();
		expect(disk.dump()).not.toContain("Jane Doe");
		await store.flush();
		expect(store.getItem(SUITE_KEY)).toBe(SUITE);
	});

	it("writes nothing while locked and seals once the key is back", async () => {
		const disk = new MemoryStorage();
		let locked = true;
		const sealer = new ContentSealer(() =>
			locked
				? Promise.reject(new ContentSealLockedError())
				: importContentKey(new Uint8Array(32).fill(7))
		);
		const store = new SealedLocalStorage(sealer, () => disk);
		await store.hydrate();
		store.setItem("ryu:bot-feed-engagement:v1", '{"comment":"great idea"}');
		await store.flush();
		expect(disk.getItem("ryu:bot-feed-engagement:v1")).toBeNull();
		expect(store.getItem("ryu:bot-feed-engagement:v1")).toContain("great idea");
		locked = false;
		await store.flush();
		expect(
			looksContentSealed(
				disk.getItem(sealedLocalSlot("ryu:bot-feed-engagement:v1")) ?? ""
			)
		).toBe(true);
		expect(disk.dump()).not.toContain("great idea");
	});

	it("does not overwrite or clear values it cannot read while locked", async () => {
		const disk = new MemoryStorage();
		const writer = new SealedLocalStorage(fixedSealer(), () => disk);
		await writer.hydrate();
		writer.setItem(SUITE_KEY, SUITE);
		await writer.flush();
		const sealed = disk.getItem(sealedLocalSlot(SUITE_KEY));
		let locked = true;
		const reader = new SealedLocalStorage(
			new ContentSealer(() =>
				locked
					? Promise.reject(new ContentSealLockedError())
					: importContentKey(new Uint8Array(32).fill(7))
			),
			() => disk
		);
		await reader.hydrate();
		expect(reader.isLocked()).toBe(true);
		expect(reader.getItem(SUITE_KEY)).toBeNull();
		expect(disk.getItem(sealedLocalSlot(SUITE_KEY))).toBe(sealed);
		locked = false;
		await reader.flush();
		expect(reader.getItem(SUITE_KEY)).toBe(SUITE);
	});

	it("retries a locked key at startup so the first read sees the stored value", async () => {
		const disk = new MemoryStorage();
		const writer = new SealedLocalStorage(fixedSealer(), () => disk);
		await writer.hydrate();
		writer.setItem(SUITE_KEY, SUITE);
		await writer.flush();
		let locked = true;
		const reader = new SealedLocalStorage(
			new ContentSealer(() =>
				locked
					? Promise.reject(new ContentSealLockedError())
					: importContentKey(new Uint8Array(32).fill(7))
			),
			() => disk
		);
		await reader.hydrate();
		expect(reader.isLocked()).toBe(true);
		const waits: number[] = [];
		await retrySealedLocalUnlock(reader, [10, 20, 40], (ms) => {
			waits.push(ms);
			// The key opens during the second wait.
			locked = waits.length < 2;
			return Promise.resolve();
		});
		expect(waits).toEqual([10, 20]);
		expect(reader.isLocked()).toBe(false);
		expect(reader.getItem(SUITE_KEY)).toBe(SUITE);
		// Nothing was set aside: the stored value stayed live.
		expect(reader.quarantinedKeys()).toEqual([]);
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`)).toBeNull();
	});

	it("gives up after the last retry and leaves a locked key's values untouched", async () => {
		const disk = new MemoryStorage();
		const writer = new SealedLocalStorage(fixedSealer(), () => disk);
		await writer.hydrate();
		writer.setItem(SUITE_KEY, SUITE);
		await writer.flush();
		const sealed = disk.getItem(sealedLocalSlot(SUITE_KEY));
		const reader = new SealedLocalStorage(
			new ContentSealer(() => Promise.reject(new ContentSealLockedError())),
			() => disk
		);
		await reader.hydrate();
		const waits: number[] = [];
		await retrySealedLocalUnlock(reader, [1, 2], (ms) => {
			waits.push(ms);
			return Promise.resolve();
		});
		expect(waits).toEqual([1, 2]);
		expect(reader.isLocked()).toBe(true);
		expect(disk.getItem(sealedLocalSlot(SUITE_KEY))).toBe(sealed);
	});

	it("keeps an unread value aside when it is written over while locked", async () => {
		const disk = new MemoryStorage();
		const writer = new SealedLocalStorage(fixedSealer(), () => disk);
		await writer.hydrate();
		writer.setItem(SUITE_KEY, SUITE);
		await writer.flush();
		const sealed = disk.getItem(sealedLocalSlot(SUITE_KEY));
		let locked = true;
		const reader = new SealedLocalStorage(
			new ContentSealer(() =>
				locked
					? Promise.reject(new ContentSealLockedError())
					: importContentKey(new Uint8Array(32).fill(7))
			),
			() => disk
		);
		await reader.hydrate();
		reader.setItem(SUITE_KEY, "{}");
		await reader.flush();
		expect(disk.getItem(sealedLocalSlot(SUITE_KEY))).toBe(sealed);
		locked = false;
		await reader.flush();
		expect(reader.getItem(SUITE_KEY)).toBe("{}");
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`)).toBe(sealed);
		expect(
			looksContentSealed(disk.getItem(sealedLocalSlot(SUITE_KEY)) ?? "")
		).toBe(true);
	});

	it("quarantines values sealed under another key instead of clearing them", async () => {
		const disk = new MemoryStorage();
		const first = new SealedLocalStorage(fixedSealer(1), () => disk);
		await first.hydrate();
		first.setItem(SUITE_KEY, SUITE);
		await first.flush();
		const sealed = disk.getItem(sealedLocalSlot(SUITE_KEY));
		const second = new SealedLocalStorage(fixedSealer(2), () => disk);
		await second.hydrate();
		expect(second.getItem(SUITE_KEY)).toBeNull();
		expect(second.quarantinedKeys()).toEqual([SUITE_KEY]);
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`)).toBe(sealed);
		second.setItem(SUITE_KEY, "{}");
		await second.flush();
		expect(disk.getItem(LOCAL_KID_MARKER_KEY)).toBe(
			await fixedSealer(2).kid("local-storage")
		);
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`)).toBe(sealed);
	});

	it("binds each value to its key", async () => {
		const disk = new MemoryStorage();
		const store = new SealedLocalStorage(fixedSealer(), () => disk);
		await store.hydrate();
		store.setItem("ryu_session_tabs", '{"tabs":[{"title":"Payroll"}]}');
		await store.flush();
		disk.setItem(
			sealedLocalSlot("ryu_workbench_layout_v2"),
			disk.getItem(sealedLocalSlot("ryu_session_tabs")) ?? ""
		);
		const next = new SealedLocalStorage(fixedSealer(), () => disk);
		await next.hydrate();
		expect(next.getItem("ryu_workbench_layout_v2")).toBeNull();
		expect(next.getItem("ryu_session_tabs")).toContain("Payroll");
	});

	it("knows which keys are sealed", () => {
		expect(isSealedLocalKey("ryu_session_tabs")).toBe(true);
		expect(isSealedLocalKey("prompt-studio-tests:x")).toBe(true);
		expect(isSealedLocalKey(sealedLocalSlot("ryu_session_tabs"))).toBe(true);
		expect(isSealedLocalKey("ryu_theme")).toBe(false);
	});

	it("forgets cached and pending values when storage is cleared behind it", async () => {
		const disk = new MemoryStorage();
		const sealer = new ContentSealer(() =>
			Promise.reject(new ContentSealLockedError())
		);
		const store = new SealedLocalStorage(sealer, () => disk);
		await store.hydrate();
		store.setItem("ryu_session_tabs", '{"tabs":["/chat/secret"]}');
		expect(store.getItem("ryu_session_tabs")).toContain("secret");
		// A reset ("deep clean") or another window clears raw localStorage.
		disk.clear();
		expect(store.getItem("ryu_session_tabs")).toBeNull();
		await store.flush();
		expect(disk.getItem("ryu_session_tabs")).toBeNull();
	});

	it("keeps a migrated suite when an older build writes the plain key again", async () => {
		const disk = new MemoryStorage();
		const suite = JSON.stringify({
			judgeModel: "judge-a",
			rows: [{ id: "r1", input: "salary of Jane Doe" }],
		});
		disk.setItem(SUITE_KEY, suite);
		const store = new SealedLocalStorage(fixedSealer(), () => disk);
		await store.hydrate();
		expect(disk.getItem(SUITE_KEY)).toBeNull();
		// A stale tab of the older build finds no suite and saves an empty one,
		// then adds a row of its own.
		const stale = JSON.stringify({
			judgeModel: "",
			rows: [{ id: "r2", input: "added by the old tab" }],
		});
		disk.setItem(SUITE_KEY, stale);
		await store.applyExternalChange(SUITE_KEY, stale);
		const merged = JSON.parse(store.getItem(SUITE_KEY) ?? "{}");
		expect(merged.judgeModel).toBe("judge-a");
		expect(merged.rows.map((row: { id: string }) => row.id)).toEqual([
			"r2",
			"r1",
		]);
		expect(disk.getItem(SUITE_KEY)).toBeNull();
		expect(disk.dump()).not.toContain("old tab");
		// A fresh process reads the merged value back.
		const next = new SealedLocalStorage(fixedSealer(), () => disk);
		await next.hydrate();
		expect(next.getItem(SUITE_KEY)).toContain("Jane Doe");
		expect(next.getItem(SUITE_KEY)).toContain("old tab");
	});

	it("prefers an older build's newer value and keeps the sealed one aside", async () => {
		const disk = new MemoryStorage();
		const store = new SealedLocalStorage(fixedSealer(), () => disk);
		await store.hydrate();
		store.setItem("ryu_session_tabs", '{"tabs":["/chat/payroll"]}');
		await store.flush();
		const sealed = disk.getItem(sealedLocalSlot("ryu_session_tabs"));
		disk.setItem("ryu_session_tabs", '{"tabs":["/library"]}');
		const next = new SealedLocalStorage(fixedSealer(), () => disk);
		await next.hydrate();
		expect(next.getItem("ryu_session_tabs")).toBe('{"tabs":["/library"]}');
		expect(disk.getItem("ryu_session_tabs")).toBeNull();
		expect(
			disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs#superseded`)
		).toBe(sealed);
		expect(disk.dump()).not.toContain("payroll");
	});

	it("leaves the plain key when an older build rewrote it before the sealed write", async () => {
		const disk = new MemoryStorage();
		disk.setItem(SUITE_KEY, SUITE);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const store = new SealedLocalStorage(gatedSealer(gate), () => disk);
		const hydration = store.hydrate();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const rewritten = JSON.stringify({ rows: [{ id: "x", input: "newer" }] });
		disk.setItem(SUITE_KEY, rewritten);
		release();
		await hydration;
		// The rewrite is still there, and is folded in on its storage event.
		expect(disk.getItem(SUITE_KEY)).toBe(rewritten);
		await store.applyExternalChange(SUITE_KEY, rewritten);
		expect(disk.getItem(SUITE_KEY)).toBeNull();
		expect(store.getItem(SUITE_KEY)).toContain("Jane Doe");
		expect(store.getItem(SUITE_KEY)).toContain("newer");
	});

	it("does not overwrite another window's write with a stale reseal", async () => {
		const disk = new MemoryStorage();
		disk.setItem(SUITE_KEY, SUITE);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Window B queued the plaintext and is still sealing it (a slow Tauri
		// invoke, an IndexedDB open and first-use key generation).
		const windowB = new SealedLocalStorage(gatedSealer(gate), () => disk);
		const hydrationB = windowB.hydrate();
		await new Promise((resolve) => setTimeout(resolve, 0));
		// Window A hydrates, then saves a newer suite.
		const windowA = new SealedLocalStorage(fixedSealer(), () => disk);
		await windowA.hydrate();
		windowA.setItem(SUITE_KEY, '{"rows":[{"id":"a","input":"from A"}]}');
		await windowA.flush();
		release();
		await hydrationB;
		const reader = new SealedLocalStorage(fixedSealer(), () => disk);
		await reader.hydrate();
		expect(reader.getItem(SUITE_KEY)).toContain("from A");
		expect(windowB.getItem(SUITE_KEY)).toContain("from A");
	});

	it("moves a value sealed in place by an earlier build to its slot", async () => {
		const disk = new MemoryStorage();
		const writer = new SealedLocalStorage(fixedSealer(), () => disk);
		await writer.hydrate();
		writer.setItem(SUITE_KEY, SUITE);
		await writer.flush();
		const sealed = disk.getItem(sealedLocalSlot(SUITE_KEY)) ?? "";
		disk.removeItem(sealedLocalSlot(SUITE_KEY));
		disk.setItem(SUITE_KEY, sealed);
		const next = new SealedLocalStorage(fixedSealer(), () => disk);
		await next.hydrate();
		expect(next.getItem(SUITE_KEY)).toBe(SUITE);
		expect(disk.getItem(SUITE_KEY)).toBeNull();
		expect(disk.getItem(sealedLocalSlot(SUITE_KEY))).toBe(sealed);
	});

	it("merges suites by row id with the preferred fields on top", () => {
		const merged = JSON.parse(
			mergePromptSuites(
				'{"judgeModel":"j","repeat":2,"rows":[{"id":"1"},{"id":"2"}]}',
				'{"judgeModel":"","rows":[{"id":"2","input":"new"},{"id":"3"}]}'
			) ?? "null"
		);
		expect(merged.judgeModel).toBe("j");
		expect(merged.repeat).toBe(2);
		expect(merged.rows).toEqual([
			{ id: "2", input: "new" },
			{ id: "3" },
			{ id: "1" },
		]);
		expect(mergePromptSuites("not json", "{}")).toBeNull();
	});

	it("opens values under a retired key and reseals them under the current one", async () => {
		const disk = new MemoryStorage();
		const before = new SealedLocalStorage(fixedSealer(1), () => disk);
		await before.hydrate();
		before.setItem("ryu_session_tabs", '{"tabs":["/chat/payroll"]}');
		await before.flush();
		const old = disk.getItem(sealedLocalSlot("ryu_session_tabs"));
		const after = new SealedLocalStorage(sealerWith(2, [1]), () => disk);
		await after.hydrate();
		expect(after.getItem("ryu_session_tabs")).toContain("payroll");
		expect(after.quarantinedKeys()).toEqual([]);
		const resealed = disk.getItem(sealedLocalSlot("ryu_session_tabs")) ?? "";
		expect(resealed).not.toBe(old);
		expect(
			await fixedSealer(2).openText(
				"local-storage",
				"value",
				"ryu_session_tabs",
				resealed
			)
		).toContain("payroll");
		expect(disk.getItem(LOCAL_KID_MARKER_KEY)).toBe(
			await fixedSealer(2).kid("local-storage")
		);
	});

	/** Key 1 wrote `values`; a launch on key 2 (an older build) set them aside. */
	async function flippedDisk(values: Record<string, string>) {
		const disk = new MemoryStorage();
		const first = new SealedLocalStorage(fixedSealer(1), () => disk);
		await first.hydrate();
		for (const [key, value] of Object.entries(values)) {
			first.setItem(key, value);
		}
		await first.flush();
		const flipped = new SealedLocalStorage(fixedSealer(2), () => disk);
		await flipped.hydrate();
		flipped.setItem("ryu_oidc_user", '{"name":"during the flip"}');
		await flipped.flush();
		return disk;
	}

	it("restores values set aside under what is the current key again", async () => {
		const disk = await flippedDisk({ ryu_session_tabs: '{"tabs":["/a"]}' });
		expect(disk.getItem(sealedLocalSlot("ryu_session_tabs"))).toBeNull();
		expect(
			disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)
		).not.toBeNull();
		const back = new SealedLocalStorage(sealerWith(1, [2]), () => disk);
		await back.hydrate();
		expect(back.getItem("ryu_session_tabs")).toBe('{"tabs":["/a"]}');
		expect(back.getItem("ryu_oidc_user")).toContain("during the flip");
		expect(
			disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)
		).toBeNull();
		const next = new SealedLocalStorage(fixedSealer(1), () => disk);
		await next.hydrate();
		expect(next.getItem("ryu_session_tabs")).toBe('{"tabs":["/a"]}');
		expect(next.getItem("ryu_oidc_user")).toContain("during the flip");
	});

	it("restores values set aside under a retired key, resealed", async () => {
		const disk = await flippedDisk({ ryu_session_tabs: '{"tabs":["/a"]}' });
		const pinned = new SealedLocalStorage(sealerWith(2, [1]), () => disk);
		await pinned.hydrate();
		expect(pinned.getItem("ryu_session_tabs")).toBe('{"tabs":["/a"]}');
		expect(
			disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)
		).toBeNull();
		const next = new SealedLocalStorage(fixedSealer(2), () => disk);
		await next.hydrate();
		expect(next.getItem("ryu_session_tabs")).toBe('{"tabs":["/a"]}');
	});

	it("merges a restored suite into the live one and leaves keys without a merge", async () => {
		const disk = await flippedDisk({
			[SUITE_KEY]: '{"rows":[{"id":"r1","input":"before"}]}',
			ryu_session_tabs: '{"tabs":["/before"]}',
		});
		const live = new SealedLocalStorage(fixedSealer(2), () => disk);
		await live.hydrate();
		live.setItem(SUITE_KEY, '{"rows":[{"id":"r2","input":"after"}]}');
		live.setItem("ryu_session_tabs", '{"tabs":["/after"]}');
		await live.flush();
		const tabsAside = disk.getItem(
			`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`
		);

		const pinned = new SealedLocalStorage(sealerWith(2, [1]), () => disk);
		await pinned.hydrate();
		const suite = JSON.parse(pinned.getItem(SUITE_KEY) ?? "{}");
		expect(suite.rows.map((row: { id: string }) => row.id)).toEqual([
			"r2",
			"r1",
		]);
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`)).toBeNull();
		expect(pinned.getItem("ryu_session_tabs")).toBe('{"tabs":["/after"]}');
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)).toBe(
			tabsAside
		);
		// Idempotent: a second run changes nothing.
		const before = disk.dump();
		const again = new SealedLocalStorage(sealerWith(2, [1]), () => disk);
		await again.hydrate();
		expect(again.getItem(SUITE_KEY)).toContain("before");
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)).toBe(
			tabsAside
		);
		expect(disk.dump()).toBe(before);
	});

	it("restores every numbered quarantine slot of a key", async () => {
		const disk = new MemoryStorage();
		const old = fixedSealer(1);
		const aside = async (input: string) =>
			old.sealText(
				"local-storage",
				"value",
				SUITE_KEY,
				JSON.stringify({ rows: [{ id: input, input }] })
			);
		disk.setItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`, await aside("q0"));
		disk.setItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}#1`, await aside("q1"));
		disk.setItem(
			`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}#superseded`,
			await aside("qs")
		);
		const store = new SealedLocalStorage(sealerWith(2, [1]), () => disk);
		await store.hydrate();
		const suite = JSON.parse(store.getItem(SUITE_KEY) ?? "{}");
		expect(suite.rows.map((row: { id: string }) => row.id).sort()).toEqual([
			"q0",
			"q1",
		]);
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}`)).toBeNull();
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}#1`)).toBeNull();
		// The superseded copy was replaced on purpose: it is not restored.
		expect(
			disk.getItem(`${LOCAL_QUARANTINE_PREFIX}${SUITE_KEY}#superseded`)
		).not.toBeNull();
	});

	it("leaves set-aside values that still do not open", async () => {
		const disk = await flippedDisk({ ryu_session_tabs: '{"tabs":["/a"]}' });
		const aside = disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`);
		const other = new SealedLocalStorage(sealerWith(2, [9]), () => disk);
		await other.hydrate();
		expect(other.getItem("ryu_session_tabs")).toBeNull();
		expect(disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)).toBe(
			aside
		);
	});

	it("changes nothing while the key is locked", async () => {
		const disk = await flippedDisk({ ryu_session_tabs: '{"tabs":["/a"]}' });
		const before = disk.dump();
		let locked = true;
		const store = new SealedLocalStorage(
			new ContentSealer(() =>
				locked
					? Promise.reject(new ContentSealLockedError())
					: importContentKeys(new Uint8Array(32).fill(1), [
							new Uint8Array(32).fill(2),
						])
			),
			() => disk
		);
		await store.hydrate();
		await store.flush();
		expect(disk.dump()).toBe(before);
		locked = false;
		await store.flush();
		expect(store.getItem("ryu_session_tabs")).toBe('{"tabs":["/a"]}');
		expect(
			disk.getItem(`${LOCAL_QUARANTINE_PREFIX}ryu_session_tabs`)
		).toBeNull();
	});

	it("passes through on a host with no key store at all", async () => {
		const disk = new MemoryStorage();
		const store = new SealedLocalStorage(
			fixedSealer(),
			() => disk,
			() => false
		);
		await store.hydrate();
		store.setItem("ryu_session_tabs", "{}");
		expect(disk.getItem("ryu_session_tabs")).toBe("{}");
		expect(store.getItem("ryu_session_tabs")).toBe("{}");
	});
});
