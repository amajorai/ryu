// `useSettingReveal` with React's StrictMode on and off. The desktop app
// renders under StrictMode (src/main.tsx), which runs a component's mount
// effects twice in development; the unswept-b Chromium story does not, so this
// file covers what that story cannot: a reveal requested before the pane
// mounts is still flashed once under the double run, a request for the section
// already on screen is flashed, and a pane never claims a request meant for the
// other settings dialog or another section.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SettingsEntry } from "@/src/lib/settings-index.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act, createElement, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useSettingReveal } = await import("./useSettingReveal.ts");
const { clearSettingReveal, peekSettingReveal, requestSettingReveal } =
	await import("@/src/lib/settings-focus.ts");

const ROW_LABEL = "Reveal probe row";

function entryFor(
	dialog: SettingsEntry["dialog"],
	section: string
): SettingsEntry {
	return {
		dialog,
		group: "",
		id: `probe.${dialog}.${section}`,
		label: ROW_LABEL,
		section,
	};
}

/** Rows the shipping `flashSetting` animated, in order. */
let flashed: Element[] = [];
const originalAnimate = HTMLElement.prototype.animate;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function Pane({ section }: { section: string }) {
	const ref = useSettingReveal(section, "app");
	return createElement(
		"div",
		{ ref },
		createElement(
			"div",
			{ "data-slot": "item" },
			createElement("div", { "data-slot": "item-title" }, ROW_LABEL)
		)
	);
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	clearSettingReveal();
	flashed = [];
	HTMLElement.prototype.animate = function animate(this: HTMLElement) {
		flashed.push(this);
		return {} as Animation;
	};
	HTMLElement.prototype.scrollIntoView = () => undefined;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	clearSettingReveal();
	HTMLElement.prototype.animate = originalAnimate;
	HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

async function mountPane(section: string, strict: boolean): Promise<void> {
	const pane = createElement(Pane, { section });
	await act(async () => {
		root.render(strict ? createElement(StrictMode, null, pane) : pane);
	});
	// The reveal polls on animation frames; let a few run.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 60));
	});
}

function flashedRows(): string[] {
	return flashed.map((element) => element.getAttribute("data-slot") ?? "");
}

for (const strict of [false, true]) {
	const mode = strict ? "under StrictMode" : "without StrictMode";

	test(`a request made before the pane mounts is flashed exactly once ${mode}`, async () => {
		requestSettingReveal(entryFor("app", "appearance"));

		await mountPane("appearance", strict);

		expect(flashedRows()).toEqual(["item"]);
		expect(peekSettingReveal("appearance")).toBeNull();
	});

	test(`a request for the section already on screen is flashed ${mode}`, async () => {
		await mountPane("appearance", strict);
		expect(flashed).toHaveLength(0);

		await act(async () => {
			requestSettingReveal(entryFor("app", "appearance"));
			await new Promise((resolve) => setTimeout(resolve, 60));
		});

		expect(flashedRows()).toEqual(["item"]);
		expect(peekSettingReveal("appearance")).toBeNull();
	});

	test(`a request for the other dialog or another section is left pending ${mode}`, async () => {
		const gatewayRequest = entryFor("gateway", "privacy");
		requestSettingReveal(gatewayRequest);

		await mountPane("privacy", strict);

		expect(flashed).toHaveLength(0);
		expect(peekSettingReveal("privacy")).toBe(gatewayRequest);

		const otherSection = entryFor("app", "general");
		await act(async () => {
			requestSettingReveal(otherSection);
			await new Promise((resolve) => setTimeout(resolve, 60));
		});

		expect(flashed).toHaveLength(0);
		expect(peekSettingReveal("general")).toBe(otherSection);
	});
}
