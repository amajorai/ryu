import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VersionHistory, type VersionSource } from "./VersionHistory.tsx";
if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
});
function held() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function source(
	scope: object,
	overrides: Partial<VersionSource> = {}
): VersionSource {
	return {
		scope,
		list: async () => [
			{ id: "checkpoint", createdAt: 1, label: "Immutable checkpoint" },
		],
		getValue: async () => "Saved line",
		restore: async () => {},
		snapshot: async () => {},
		...overrides,
	};
}
async function render(
	value: VersionSource,
	current = "Draft line",
	onRestored = () => {}
) {
	if (!root) {
		const host = document.createElement("div");
		document.body.append(host);
		root = createRoot(host);
	}
	await act(async () => {
		root!.render(
			<VersionHistory
				source={value}
				currentValue={current}
				onRestored={onRestored}
			/>
		);
	});
}
function button(name: string): HTMLButtonElement {
	const item = Array.from(document.querySelectorAll("button")).find((b) =>
		b.textContent?.trim().startsWith(name)
	);
	if (!item) throw Error("Missing button " + name);
	return item;
}
async function click(name: string) {
	await act(async () => button(name).click());
}
test("same-resource draft and callback replacements retain open diff and do not refetch history", async () => {
	const scope = {};
	let lists = 0;
	const list = async () => {
		lists++;
		return [{ id: "checkpoint", createdAt: 1, label: "Immutable checkpoint" }];
	};
	await render(source(scope, { list }));
	await click("History");
	await click("Diff");
	expect(document.querySelector("pre")?.textContent).toContain("Saved line");
	expect(lists).toBe(1);
	await render(source(scope, { list }), "Edited line");
	expect(document.querySelector("pre")?.textContent).toContain("Saved line");
	expect(document.querySelector("pre")?.textContent).toContain("Edited line");
	expect(button("Restore").disabled).toBe(false);
	expect(lists).toBe(1);
});
test("same-resource callback refresh while restore is held preserves pending and accepts its current completion", async () => {
	const scope = {};
	const pending = held();
	let restored = 0;
	await render(
		source(scope, { restore: () => pending.promise }),
		"Draft",
		() => restored++
	);
	await click("History");
	await click("Restore");
	expect(button("Restore").disabled).toBe(true);
	await render(source(scope), "Edited draft", () => restored++);
	expect(button("Restore").disabled).toBe(true);
	expect(document.body.textContent).toContain("Immutable checkpoint");
	expect(restored).toBe(0);
	await act(async () => pending.resolve());
	expect(restored).toBe(1);
	expect(document.body.textContent).not.toContain("Immutable checkpoint");
});
test("a held A restore cannot close B history or unlock B's own pending restore", async () => {
	const a = held(),
		b = held();
	let restored = 0;
	await render(source({}, { restore: () => a.promise }), "A", () => restored++);
	await click("History");
	await click("Restore");
	await render(source({}, { restore: () => b.promise }), "B", () => restored++);
	expect(button("Restore").disabled).toBe(false);
	await click("Restore");
	expect(button("Restore").disabled).toBe(true);
	await act(async () => a.resolve());
	expect(restored).toBe(0);
	expect(button("Restore").disabled).toBe(true);
	expect(document.body.textContent).toContain("Immutable checkpoint");
	await act(async () => b.resolve());
	expect(restored).toBe(1);
});
test("A to B to A gives a new generation even when the semantic scope object is reused", async () => {
	const scopeA = {},
		scopeB = {},
		old = held(),
		current = held();
	let restored = 0;
	await render(
		source(scopeA, { restore: () => old.promise }),
		"A",
		() => restored++
	);
	await click("History");
	await click("Restore");
	await render(source(scopeB), "B", () => restored++);
	await render(
		source(scopeA, { restore: () => current.promise }),
		"A again",
		() => restored++
	);
	await click("Restore");
	expect(button("Restore").disabled).toBe(true);
	await act(async () => old.reject(Error("Old authority refused")));
	expect(button("Restore").disabled).toBe(true);
	expect(document.body.textContent).not.toContain("Old authority refused");
	expect(restored).toBe(0);
	await act(async () => current.resolve());
	expect(restored).toBe(1);
});
test("current refusal stays inline across a draft refresh and explicit retry completes", async () => {
	const scope = {};
	let attempts = 0,
		restored = 0;
	const restore = async () => {
		attempts++;
		if (attempts === 1) throw Error("Current restore refused");
	};
	await render(source(scope, { restore }), "Draft", () => restored++);
	await click("History");
	await click("Restore");
	expect(document.body.textContent).toContain("Current restore refused");
	expect(button("Restore").disabled).toBe(false);
	await render(
		source(scope, { restore }),
		"Unsaved changed draft",
		() => restored++
	);
	expect(document.body.textContent).toContain("Current restore refused");
	await click("Restore");
	expect(attempts).toBe(2);
	expect(restored).toBe(1);
});
