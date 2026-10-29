import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { useDraftSave } from "./use-draft-save.ts";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

function Composer({ onSave }: { onSave: (text: string) => Promise<void> }) {
	const [text, setText] = useState("Unsent message");
	const { error, save, saving } = useDraftSave(text, setText, onSave);
	return (
		<>
			<output>{text}</output>
			<button disabled={saving} onClick={() => void save()} type="button">
				Save
			</button>
			<button onClick={() => setText("Newer edits")} type="button">
				Edit
			</button>
			{error && <p role="alert">{error}</p>}
		</>
	);
}

async function mount(onSave: (text: string) => Promise<void>) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(<Composer onSave={onSave} />));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

test("keeps text until persistence succeeds and prevents duplicate saves", async () => {
	const pending = Promise.withResolvers<void>();
	const saved: string[] = [];
	const { container, dispose } = await mount((text) => {
		saved.push(text);
		return pending.promise;
	});
	try {
		const button = container.querySelector("button");
		await act(async () => {
			button?.click();
			button?.click();
		});
		expect(saved).toEqual(["Unsent message"]);
		expect(container.querySelector("output")?.textContent).toBe(
			"Unsent message"
		);
		expect(button?.disabled).toBe(true);
		await act(async () => pending.resolve());
		expect(container.querySelector("output")?.textContent).toBe("");
		expect(button?.disabled).toBe(false);
	} finally {
		await dispose();
	}
});

test("retains text on failure, shows an error, and allows retry", async () => {
	let attempts = 0;
	const { container, dispose } = await mount(() => {
		attempts++;
		return attempts === 1
			? Promise.reject(new Error("offline"))
			: Promise.resolve();
	});
	try {
		await act(async () => container.querySelector("button")?.click());
		expect(container.querySelector("output")?.textContent).toBe(
			"Unsent message"
		);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"retry"
		);
		await act(async () => container.querySelector("button")?.click());
		expect(attempts).toBe(2);
		expect(container.querySelector("output")?.textContent).toBe("");
		expect(container.querySelector('[role="alert"]')).toBeNull();
	} finally {
		await dispose();
	}
});

test("does not clear edits made while a saved snapshot is in flight", async () => {
	const pending = Promise.withResolvers<void>();
	const { container, dispose } = await mount(() => pending.promise);
	try {
		await act(async () => container.querySelector("button")?.click());
		await act(async () => container.querySelectorAll("button")[1]?.click());
		await act(async () => pending.resolve());
		expect(container.querySelector("output")?.textContent).toBe("Newer edits");
		expect(container.querySelector('[role="alert"]')).toBeNull();
	} finally {
		await dispose();
	}
});
