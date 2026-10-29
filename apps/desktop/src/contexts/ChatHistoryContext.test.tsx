import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// Pin the other two preview switches off, so only the interface latch moves.
mock.module("@/src/hooks/useAgentRowStyle.ts", () => ({
	useMessagingRows: () => false,
}));
mock.module("@/src/hooks/useSidebarChatPreview.ts", () => ({
	useSidebarChatPreview: () => [false, () => undefined],
}));
const { createRoot } = await import("react-dom/client");
const { useWantConversationPreview } = await import("./ChatHistoryContext.tsx");
const { useInterfaceActive } = await import(
	"@/src/interfaces/use-interface-active.ts"
);

const root = createRoot(document.createElement("div"));
const seen: boolean[] = [];

function Probe() {
	seen.push(useWantConversationPreview());
	return null;
}

afterAll(() => {
	act(() => root.unmount());
});

test("previews latch on when an interface is first shown and stay on (test 9)", async () => {
	useInterfaceActive.setState({ active: false, previewLatched: false });
	await act(async () => root.render(<Probe />));
	expect(seen.at(-1)).toBe(false);

	await act(async () => useInterfaceActive.getState().setActive(true));
	expect(seen.at(-1)).toBe(true);

	// Unmounting and remounting the interface keeps the list query as it is:
	// the value never flips back, so `fetchConversationList` is not re-created.
	const before = seen.length;
	await act(async () => useInterfaceActive.getState().setActive(false));
	await act(async () => useInterfaceActive.getState().setActive(true));
	expect(seen.slice(before).every(Boolean)).toBe(true);
	expect(seen.at(-1)).toBe(true);
});
