import { expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let seed: (text: string) => void = () => undefined;
const pendingSeed = new Promise<string>((resolve) => {
	seed = resolve;
});
mock.module("../../../../apps-store/quests/ui/src/bridge.ts", () => ({
	listQuests: async () => [],
	getScratchpad: () => pendingSeed,
	setScratchpad: async () => undefined,
	acceptSuggestion: async () => ({}),
	dismissSuggestion: async () => ({}),
	captureItem: async () => ({}),
	completeQuest: async () => ({}),
	createQuest: async () => ({}),
	deleteQuest: async () => undefined,
	dismissQuest: async () => ({}),
	judgeQuest: async () => ({}),
	pinItem: async () => ({}),
	updateQuest: async () => ({}),
	useItem: async () => ({}),
}));
const { useQuests } = await import(
	"../../../../apps-store/quests/ui/src/useQuests.ts"
);
let latest: ReturnType<typeof useQuests>;
function Reader() {
	latest = useQuests();
	return null;
}
test("a late initial scratchpad read cannot overwrite text already saved by the user", async () => {
	const root = createRoot(document.createElement("div"));
	try {
		await act(async () => root.render(<Reader />));
		await act(async () => {
			await latest.saveScratchpad("New draft");
		});
		await act(async () => seed("Old text"));
		expect(latest.scratchpad).toBe("New draft");
		expect(latest.savingScratchpad).toBe(false);
	} finally {
		await act(async () => root.unmount());
	}
});
