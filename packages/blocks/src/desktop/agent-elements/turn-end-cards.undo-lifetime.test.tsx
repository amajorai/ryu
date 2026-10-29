import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
	FileEditUndoPlan,
	FileEditsTurnEndCard,
} from "./turn-end-cards.ts";
if (typeof document === "undefined") GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);
const { TurnEndCards } = await import("./turn-end-cards.tsx");
const plan: FileEditUndoPlan = {
	kind: "text-replacements",
	edits: [
		{ kind: "replace", path: "src/a.ts", before: "before", after: "after" },
	],
};
const card: FileEditsTurnEndCard = {
	id: "same-turn",
	kind: "file-edits",
	files: [{ path: "src/a.ts", insertions: 1, deletions: 1 }],
	undoPlan: plan,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
async function render(onUndo: (plan: FileEditUndoPlan) => Promise<void>) {
	await act(async () =>
		root.render(<TurnEndCards cards={[card]} onUndoFileEdits={onUndo} />)
	);
}
function button(label: string, scope: ParentNode = document) {
	const node = Array.from(
		scope.querySelectorAll<HTMLButtonElement>("button")
	).find((b) => b.textContent?.trim() === label);
	if (!node) throw new Error(`Actual visible Undo control missing: ${label}`);
	return node;
}
async function click(label: string) {
	await act(async () => button(label).click());
}
async function start() {
	await click("Undo");
	await click("Undo changes");
}
for (const transition of ["B", "ABA"] as const)
	for (const accepted of [true, false]) {
		test(`held old Undo ${accepted ? "accepted" : "refused"} cannot publish completion/error into ${transition} same-id turn`, async () => {
			let settle: (() => void) | undefined;
			const gate = new Promise<void>((resolve, reject) => {
				settle = () =>
					accepted ? resolve() : reject(new Error("Old A reversal refused"));
			});
			const calls: FileEditUndoPlan[] = [];
			const old = async (p: FileEditUndoPlan) => {
				calls.push(p);
				await gate;
			};
			await render(old);
			await start();
			expect(button("Undoing…").disabled).toBe(true);
			expect(calls).toEqual([plan]);
			const b = async () => {};
			await render(b);
			expect(document.querySelector('[role="alertdialog"]')).toBeNull();
			expect(button("Undo", container).disabled).toBe(false);
			if (transition === "ABA") {
				// Fresh callback owner returned to A; the first A must remain retired.
				await render(async () => {});
			}
			if (!settle) throw new Error("Actual old operation gate is absent");
			await act(async () => {
				settle?.();
				await gate.catch(() => {});
			});
			expect(document.querySelector('[role="alert"]')).toBeNull();
			expect(document.body.textContent).not.toContain("Old A reversal refused");
			expect(container.textContent).not.toContain("Undone");
			expect(button("Undo", container).disabled).toBe(false);
			expect(calls).toEqual([plan]);
		});
	}
test("current Undo acknowledgment marks the exact current turn completed", async () => {
	const calls: FileEditUndoPlan[] = [];
	await render(async (p) => {
		calls.push(p);
	});
	await start();
	expect(calls).toEqual([plan]);
	expect(button("Undone", container).disabled).toBe(true);
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});
test("current refusal preserves exact error and explicit retry; pending blocks duplicate activation", async () => {
	const calls: FileEditUndoPlan[] = [];
	await render(async (p) => {
		calls.push(p);
		if (calls.length === 1)
			throw new Error("Current edit changed; no files changed");
	});
	await start();
	expect(document.querySelector('[role="alert"]')?.textContent).toBe(
		"Current edit changed; no files changed"
	);
	expect(button("Undo changes").disabled).toBe(false);
	await click("Undo changes");
	expect(calls).toEqual([plan, plan]);
	expect(button("Undone", container).disabled).toBe(true);
});

test("same-owner rerender with refreshed plan objects retains pending authority and blocks duplicate Undo", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const calls: FileEditUndoPlan[] = [];
	const current = async (p: FileEditUndoPlan) => {
		calls.push(p);
		await gate;
	};
	await render(current);
	await start();
	await act(async () =>
		root.render(
			<TurnEndCards
				cards={[
					{
						...card,
						files: [...card.files],
						undoPlan: { ...plan, edits: [...plan.edits] },
					},
				]}
				onUndoFileEdits={current}
			/>
		)
	);
	expect(button("Undoing…").disabled).toBe(true);
	await click("Undoing…");
	expect(calls).toEqual([plan]);
	if (!release) throw new Error("Actual pending current Undo is absent");
	await act(async () => {
		release?.();
		await gate;
	});
	expect(button("Undone", container).disabled).toBe(true);
	expect(document.querySelector('[role="alertdialog"]')).toBeNull();
});

test("physically unmounted turn cannot publish a late refused Undo error into a replacement turn", async () => {
	let reject: (() => void) | undefined;
	const gate = new Promise<void>((_, refuse) => {
		reject = () => refuse(new Error("Detached old Undo refusal"));
	});
	await render(async () => gate);
	await start();
	await act(async () => root.render(null));
	await render(async () => {});
	if (!reject) throw new Error("Actual pending detached Undo is absent");
	await act(async () => {
		reject?.();
		await gate.catch(() => {});
	});
	expect(document.querySelector('[role="alert"]')).toBeNull();
	expect(document.body.textContent).not.toContain("Detached old Undo refusal");
	expect(button("Undo", container).disabled).toBe(false);
});
