import { afterEach, describe, expect, test } from "bun:test";
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
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NodePersonalizationStep } = await import(
	"./NodePersonalizationStep.tsx"
);

type ContinueInput = Parameters<
	Parameters<typeof NodePersonalizationStep>[0]["onContinue"]
>[0];

const SAVED = {
	aboutOrganization: "",
	aboutYou: "I teach maths.",
	nickname: "",
	occupation: "",
};

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

async function mount(
	props: Partial<Parameters<typeof NodePersonalizationStep>[0]> = {}
) {
	const calls: ContinueInput[] = [];
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<NodePersonalizationStep
				initialSetupKind="personal"
				onContinue={(input) => calls.push(input)}
				{...props}
			/>
		);
	});
	return calls;
}

function buttonNamed(name: string): HTMLButtonElement {
	const match = [...document.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === name
	);
	if (!match) {
		throw new Error(`no ${name} button`);
	}
	return match;
}

async function click(name: string) {
	await act(async () => buttonNamed(name).click());
}

async function typeAboutYou(value: string) {
	const field = document.querySelector<HTMLTextAreaElement>(
		"#onboarding-personal-information"
	);
	if (!field) {
		throw new Error("no About you field");
	}
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value"
		)?.set;
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function dialogText() {
	return document.querySelector('[role="alertdialog"]')?.textContent ?? null;
}

describe("node setup About you prompt-cache confirmation", () => {
	test("an empty note continues without asking", async () => {
		const calls = await mount();
		await typeAboutYou("   ");
		await click("Continue");
		expect(dialogText()).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("adding a note where none was saved asks first", async () => {
		const calls = await mount();
		await typeAboutYou("Hello");
		await click("Continue");
		expect(dialogText()).toContain(
			"More about you is part of the system prompt for every thread on this node."
		);
		expect(calls).toEqual([]);
		await click("Apply now");
		expect(calls.map((call) => call.personalization.aboutYou)).toEqual([
			"Hello",
		]);
	});

	test("unchanged saved details continue without asking", async () => {
		const calls = await mount({ initialPersonalization: SAVED });
		await click("Continue");
		expect(dialogText()).toBeNull();
		expect(calls).toHaveLength(1);
	});

	test("changing saved details asks first; Cancel keeps them, Apply now saves", async () => {
		const calls = await mount({ initialPersonalization: SAVED });
		await typeAboutYou("I teach physics.");
		await click("Continue");
		expect(dialogText()).toContain("Apply now? This resets the prompt cache");
		expect(dialogText()).toContain(
			"More about you is part of the system prompt for every thread on this node."
		);
		expect(calls).toEqual([]);

		await click("Cancel");
		expect(dialogText()).toBeNull();
		expect(calls).toEqual([]);

		await click("Continue");
		await click("Apply now");
		expect(dialogText()).toBeNull();
		expect(calls.map((call) => call.personalization.aboutYou)).toEqual([
			"I teach physics.",
		]);
	});

	test("team setup never writes About you, so it never asks", async () => {
		const calls = await mount({
			initialPersonalization: SAVED,
			initialSetupKind: "team",
		});
		await click("Continue");
		expect(dialogText()).toBeNull();
		expect(calls.map((call) => call.setupKind)).toEqual(["team"]);
	});
});
