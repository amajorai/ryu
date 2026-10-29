import "./setup-dom.ts";

import { afterAll, expect, mock, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Evaluator } from "../../src/lib/api/gateway.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let saved: Evaluator | undefined;
mock.module("@/src/lib/api/gateway.ts", () => ({
	saveCustomEvaluator: (
		_target: Parameters<
			typeof import("../../src/lib/api/gateway.ts").saveCustomEvaluator
		>[0],
		evaluator: Evaluator
	) => {
		saved = evaluator;
		return Promise.resolve();
	},
}));
const { EvaluatorEditorDialog } = await import(
	"../../src/components/evaluators/EvaluatorEditorDialog.tsx"
);

afterAll(() => mock.restore());

const TARGET = { url: "http://localhost", token: null };

function renderEditor(mode: "judge" | "code", open: boolean): ReactElement {
	return (
		<EvaluatorEditorDialog
			existingCustom={[]}
			existingIds={[]}
			mode={mode}
			onOpenChange={() => undefined}
			onSaved={() => undefined}
			open={open}
			target={TARGET}
		/>
	);
}

async function typeInto(selector: string, value: string): Promise<void> {
	const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
		selector
	);
	if (!field) {
		throw new Error(`No field matches ${selector}`);
	}
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		// happy-dom lacks the `input` event support React's change plugin probes
		// for, so it falls back to focus and key events; send all of them.
		field.focus();
		field.dispatchEvent(new Event("focusin", { bubbles: true }));
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(
			new KeyboardEvent("keyup", { bubbles: true, key: "k" })
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	});
}

function saveButton(): HTMLButtonElement | undefined {
	return Array.from(
		document.querySelectorAll<HTMLButtonElement>("button")
	).find((button) => button.textContent?.includes("Save evaluator"));
}

test("Code editor saves Core-only definitions without unsupported Gateway actions", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(
				<EvaluatorEditorDialog
					existingCustom={[]}
					existingIds={[]}
					mode="code"
					onOpenChange={() => undefined}
					onSaved={() => undefined}
					open
					target={{ url: "http://localhost", token: null }}
				/>
			);
		});
		expect(document.querySelector("#ev-inline")).toBeNull();
		// A code evaluator keeps no offline scoring settings, so it asks for no
		// pass threshold.
		expect(document.querySelectorAll("#ev-threshold")).toHaveLength(0);
		const input = document.querySelector<HTMLInputElement>("#ev-name");
		expect(input).not.toBeNull();
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value"
			)?.set;
			input?.focus();
			input?.dispatchEvent(new Event("focusin", { bubbles: true }));
			setter?.call(input, "Local code check");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
			input?.dispatchEvent(
				new KeyboardEvent("keyup", { bubbles: true, key: "k" })
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		});
		const save = Array.from(
			document.querySelectorAll<HTMLButtonElement>("button")
		).find((button) => button.textContent?.includes("Save evaluator"));
		expect(save?.disabled).toBe(false);
		await act(async () => save?.click());
		expect(saved?.capabilities).toEqual({ inline: false, offline: false });
		expect(saved?.inline).toBeNull();
		expect(saved?.offline).toBeNull();
		expect(saved?.impl.kind).toBe("code");
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

test("an invalid threshold left in the judge editor neither shows nor blocks a code evaluator opened next", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(renderEditor("judge", true));
		});
		await typeInto("#ev-name", "Tone judge");
		await typeInto("#ev-rubric", "Penalise rude replies.");
		expect(document.querySelectorAll("#ev-threshold")).toHaveLength(1);
		expect(saveButton()?.disabled).toBe(false);
		await typeInto("#ev-threshold", "abc");
		// A judge stores its threshold, so an invalid one still blocks Save.
		expect(saveButton()?.disabled).toBe(true);

		// Cancel, then open the code editor: the dialog keeps its state until a
		// save, so the mistyped threshold is still held while no field shows it.
		await act(async () => {
			root.render(renderEditor("judge", false));
		});
		await act(async () => {
			root.render(renderEditor("code", true));
		});
		expect(document.querySelectorAll("#ev-threshold")).toHaveLength(0);
		await typeInto("#ev-name", "Local code check");
		expect(saveButton()?.disabled).toBe(false);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
