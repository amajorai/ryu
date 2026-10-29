import { expect, test } from "bun:test";
import {
	initializeTabTransfer,
	readTabTransfer,
	type TabTransfer,
} from "./tab-transfer.ts";

test("normal startup skips IPC; detached startup claims once before repeated Layout reads", async () => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "window");
	const transfer: TabTransfer = {
		version: 1,
		tab: {
			id: "draft-tab",
			path: "/chat",
			title: "Research",
			initialPrompt: "Private unsent draft",
		},
	};
	const calls: string[] = [];
	const renderer = {
		location: { search: "" },
		__TAURI_INTERNALS__: {
			invoke: (command: string) => {
				calls.push(command);
				return Promise.resolve(transfer);
			},
			transformCallback: () => 1,
		},
	};
	Object.defineProperty(globalThis, "window", {
		value: renderer,
		configurable: true,
	});
	try {
		await initializeTabTransfer();
		expect(calls).toEqual([]);
		expect(readTabTransfer()).toBeUndefined();
		renderer.location.search = "?window=tab&detached=1";
		await Promise.all([initializeTabTransfer(), initializeTabTransfer()]);
		expect(calls).toEqual(["claim_tab_transfer"]);
		expect(readTabTransfer()).toEqual(transfer);
		expect(readTabTransfer()).toBe(readTabTransfer());
		await initializeTabTransfer();
		expect(calls).toHaveLength(1);
		expect(renderer).not.toHaveProperty("__RYU_TAB_TRANSFER__");
	} finally {
		if (original) {
			Object.defineProperty(globalThis, "window", original);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	}
});
