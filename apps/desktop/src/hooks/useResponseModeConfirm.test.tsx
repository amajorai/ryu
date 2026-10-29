import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Run separately: Happy DOM replaces browser globals for the whole process.
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
	value: true,
	configurable: true,
	writable: true,
});
Reflect.set(Element.prototype, "getAnimations", () => []);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { setInterfaceLevel } = await import("@/src/lib/interface-level.ts");
const { useResponseModeConfirm } = await import("./useResponseModeConfirm.tsx");

type Level = "simple" | "expert";

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
	setInterfaceLevel("simple", { applyPrefs: false });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

function Harness({ next, onApply }: { next: Level; onApply: () => void }) {
	const { confirmLevelChange, dialog } = useResponseModeConfirm();
	return (
		<>
			<button onClick={() => confirmLevelChange(next, onApply)} type="button">
				Switch
			</button>
			{dialog}
		</>
	);
}

async function mount(next: Level) {
	const applied: Level[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<Harness next={next} onApply={() => applied.push(next)} />);
	});
	return applied;
}

function buttonNamed(name: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === name
	);
}

async function click(name: string) {
	const button = buttonNamed(name);
	if (!button) {
		throw new Error(`no ${name} button`);
	}
	await act(async () => button.click());
}

function dialogText(): string | null {
	return document.querySelector('[role="alertdialog"]')?.textContent ?? null;
}

describe("response mode switch confirmation", () => {
	test("a switch that keeps the response mode applies without asking", async () => {
		const applied = await mount("simple");
		await click("Switch");
		expect(applied).toEqual(["simple"]);
		expect(dialogText()).toBeNull();
	});

	test("cancel leaves the mode unchanged", async () => {
		const applied = await mount("expert");
		await click("Switch");
		expect(dialogText()).toContain(
			"The response mode is part of the system prompt for every Ryu assistant thread."
		);
		expect(applied).toEqual([]);
		await click("Cancel");
		expect(applied).toEqual([]);
		expect(dialogText()).toBeNull();
	});

	test("Apply now runs the switch once", async () => {
		const applied = await mount("expert");
		await click("Switch");
		await click("Apply now");
		expect(applied).toEqual(["expert"]);
		expect(dialogText()).toBeNull();
	});

	test("switching back from Code asks too", async () => {
		setInterfaceLevel("expert", { applyPrefs: false });
		const applied = await mount("simple");
		await click("Switch");
		expect(dialogText()).toContain("Apply now? This resets the prompt cache");
		await click("Apply now");
		expect(applied).toEqual(["simple"]);
	});
});
