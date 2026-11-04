// The blocked-move error reaches the toast as `error.message`, so it must
// already be in the reader's language when moveTabToWindow throws it.
import { afterEach, expect, mock, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../packages/i18n/src/active-locale.ts";

const BLOCKED =
	"This tab changed while its new window was opening. Your latest edits are still in the original window.";
const BLOCKED_JA =
	"新しいウィンドウを開いている間にこのタブが変更されました。最新の編集は元のウィンドウに残っています。";

let duringOpen: (() => void) | null = null;
const realTauri = await import("@/src/lib/tauri-ready.ts");
mock.module("@/src/lib/tauri-ready.ts", () => ({
	...realTauri,
	invokeWhenReady: async () => {
		duringOpen?.();
		return true;
	},
}));

const { moveTabToWindow } = await import("./move-tab-window.ts");
const { registerTabSnapshot } = await import("./tab-transfer.ts");

const runtime = {
	direction: "ltr" as const,
	locale: "ja",
	translate(source: string, values?: MessageValuesInput, fallback?: string) {
		const key = fallback ?? source;
		return formatMessage(key === BLOCKED ? BLOCKED_JA : key, values, "ja");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(runtime);
	duringOpen = null;
});

test("under ja the blocked-move error message is translated", async () => {
	registerActiveI18nRuntime(runtime);
	let draft = "first";
	const release = registerTabSnapshot("pane-ja", () => ({
		initialPrompt: draft,
	}));
	try {
		duringOpen = () => {
			draft = "typed while opening";
		};
		const error = await moveTabToWindow({
			id: "pane-ja",
			path: "/chat",
			title: "Draft",
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(BLOCKED_JA);
	} finally {
		release();
	}
});
