import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
// This test drives commits with flushSync on purpose (to observe what lands
// before passive effects), so it runs outside act().
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);

// The sidebar and preference stores read the DOM on import.
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { SidebarProvider, useSidebar } = await import(
	"@ryu/ui/components/sidebar.tsx"
);
const { useCompactRail } = await import("./useCompactRail.ts");

let root: Root | null = null;
let originalMatchMedia: typeof window.matchMedia;

beforeEach(() => {
	originalMatchMedia = window.matchMedia;
	// A 900px window: below the 1024px compact breakpoint, above phone width.
	window.matchMedia = ((query: string) => ({
		addEventListener: () => undefined,
		matches: query.includes("1023px"),
		media: query,
		removeEventListener: () => undefined,
	})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	flushSync(() => root?.unmount());
	root = null;
	window.matchMedia = originalMatchMedia;
	document.body.innerHTML = "";
});

test("a narrow window folds the docked sidebar before the first paint", () => {
	const openStates: boolean[] = [];
	function Shell() {
		const { open } = useSidebar();
		useCompactRail(open);
		openStates.push(open);
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	// flushSync commits and runs layout effects, but leaves passive effects for
	// after paint. The fold must already have landed by then, or the workbench
	// paints a frame with the sidebar docked and its pane as an overlay.
	flushSync(() =>
		root?.render(
			<SidebarProvider defaultOpen>
				<Shell />
			</SidebarProvider>
		)
	);
	expect(openStates.at(0)).toBe(true);
	expect(openStates.at(-1)).toBe(false);
});
