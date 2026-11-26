// Submitting the "How will you use this node?" step stores the answer as the
// declared personal or work use, and still hands the same input to the page.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { DECLARED_USE_KEY } = await import("@/src/hooks/useDeclaredUse.ts");
const { NodePersonalizationStep } = await import(
	"./NodePersonalizationStep.tsx"
);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let submitted: string[] = [];

beforeEach(() => {
	localStorage.clear();
	submitted = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	localStorage.clear();
});

async function submitWith(initialSetupKind: "personal" | "team") {
	await act(async () => {
		root.render(
			<NodePersonalizationStep
				initialSetupKind={initialSetupKind}
				onContinue={(input) => {
					submitted.push(input.setupKind);
				}}
			/>
		);
	});
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === "Continue"
	);
	if (!button) {
		throw new Error("Continue button not found");
	}
	await act(async () => {
		button.click();
	});
}

test("nothing is stored before the step is submitted", async () => {
	await act(async () => {
		root.render(
			<NodePersonalizationStep
				initialSetupKind="team"
				onContinue={() => undefined}
			/>
		);
	});
	expect(localStorage.getItem(DECLARED_USE_KEY)).toBeNull();
});

test("a team or company answer is stored as work use", async () => {
	await submitWith("team");
	expect(submitted).toEqual(["team"]);
	expect(localStorage.getItem(DECLARED_USE_KEY)).toBe("work");
});

test("a personal answer is stored as personal use and replaces an older answer", async () => {
	localStorage.setItem(DECLARED_USE_KEY, "work");
	await submitWith("personal");
	expect(submitted).toEqual(["personal"]);
	expect(localStorage.getItem(DECLARED_USE_KEY)).toBe("personal");
});
