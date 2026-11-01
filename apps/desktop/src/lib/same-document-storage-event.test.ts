import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterEach, describe, expect, test } from "bun:test";
import { setTabLayout } from "../hooks/useTabLayout.ts";
import { sealedLocalStorage } from "./content-seal.ts";
import { announceLocalStorageChange } from "./same-document-storage-event.ts";

const listeners: Array<(event: Event) => void> = [];

function capture(): Event[] {
	const seen: Event[] = [];
	const listener = (event: Event) => {
		seen.push(event);
	};
	listeners.push(listener);
	window.addEventListener("storage", listener);
	return seen;
}

afterEach(() => {
	for (const listener of listeners.splice(0)) {
		window.removeEventListener("storage", listener);
	}
	localStorage.clear();
});

describe("same-document storage broadcast", () => {
	test("is a StorageEvent that names the written key", () => {
		const seen = capture();
		announceLocalStorageChange("ryu_tab_layout");
		expect(seen).toHaveLength(1);
		const [event] = seen;
		expect(event).toBeInstanceOf(StorageEvent);
		// `null` would read as "another window cleared all storage".
		expect((event as StorageEvent).key).toBe("ryu_tab_layout");
	});

	test("preference setters broadcast their own key", () => {
		const seen = capture();
		setTabLayout("scroll");
		expect(seen.map((event) => (event as StorageEvent).key)).toEqual([
			"ryu_tab_layout",
		]);
	});

	test("the sealed facade's listener handles the broadcast without throwing", async () => {
		// hydrateSealedLocalStorage forwards every `storage` event's key here. A
		// bare `new Event("storage")` passed `undefined` and rejected with a
		// TypeError on each preference write.
		const seen = capture();
		setTabLayout("canvas");
		const [event] = seen as StorageEvent[];
		expect(event?.key).toBe("ryu_tab_layout");
		await expect(
			sealedLocalStorage.applyExternalChange(
				event?.key ?? "",
				event?.newValue ?? null
			)
		).resolves.toBeUndefined();
	});
});
