import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// A slider's value readout follows the reader's number format: "1,50" under
// German, not the ASCII "1.50" a hand-written toFixed would show.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { BackdropControls } = await import("./backdrop-controls.tsx");
type Definition = Parameters<typeof BackdropControls>[0]["definition"];

const DEFINITION = {
	animated: true,
	category: "gradient",
	description: "Test backdrop",
	id: "readout-test",
	label: "Readout test",
	params: [
		{
			default: 1.5,
			key: "speed",
			kind: "number",
			label: "Speed",
			max: 4,
			min: 0,
			step: 0.05,
		},
		{
			default: 12,
			key: "count",
			kind: "number",
			label: "Count",
			max: 40,
			min: 1,
			step: 1,
		},
	],
	render: { kind: "css", style: {} },
} as unknown as Definition;

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function readouts(locale: string): Promise<string[]> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<BackdropControls
					definition={DEFINITION}
					onChange={() => undefined}
					params={{ count: 12, speed: 1.5 }}
				/>
			</I18nProvider>
		);
	});
	return [...container.querySelectorAll("span.tabular-nums")].map(
		(node) => node.textContent ?? ""
	);
}

test("slider readouts use the German decimal comma", async () => {
	expect(await readouts("de")).toEqual(["1,50", "12"]);
});

test("slider readouts keep the English decimal point", async () => {
	expect(await readouts("en")).toEqual(["1.50", "12"]);
});
