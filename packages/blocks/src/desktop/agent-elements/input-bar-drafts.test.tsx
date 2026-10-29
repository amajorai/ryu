import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

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

const { InputBar } = await import("./input-bar.tsx");

function Composer({ onSave }: { onSave: (text: string) => Promise<void> }) {
	const [text, setText] = useState("Unsent message");
	return (
		<InputBar
			draftControls={{
				items: [
					{ id: "saved", preview: "Saved message", text: "Saved message" },
				],
				onDelete: () => undefined,
				onSave,
			}}
			onChange={setText}
			onSend={() => undefined}
			onStop={() => undefined}
			status="ready"
			value={text}
		/>
	);
}

test("composer waits for saving and exposes persistence failures", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const pending = Promise.withResolvers<void>();
	await act(async () =>
		root.render(<Composer onSave={() => pending.promise} />)
	);
	try {
		const editor = container.querySelector("textarea");
		expect(editor?.value).toBe("Unsent message");
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>('[aria-label="Save draft"]')
				?.click();
		});
		expect(editor?.value).toBe("Unsent message");
		expect(
			container
				.querySelector('[aria-label="Saving draft"]')
				?.hasAttribute("disabled")
		).toBe(true);
		await act(async () => pending.reject(new Error("offline")));
		expect(editor?.value).toBe("Unsent message");
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"retry"
		);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
