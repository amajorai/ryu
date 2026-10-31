import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RefObject } from "react";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let releaseEditor: () => void = () => undefined;
const editorReady = new Promise<void>((resolve) => {
	releaseEditor = resolve;
});

// A stand-in for the Plate editor whose chunk resolves only when the test says.
mock.module("./composer-editor.tsx", async () => {
	await editorReady;
	return {
		ComposerEditor: ({
			editorRef,
		}: {
			editorRef?: RefObject<HTMLDivElement | null>;
		}) => (
			<div
				contentEditable
				data-testid="live-editor"
				ref={editorRef}
				suppressContentEditableWarning
				tabIndex={-1}
			/>
		),
	};
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LazyComposerEditor } = await import("./composer-editor-lazy.tsx");

afterAll(async () => {
	mock.restore();
	await GlobalRegistrator.unregister();
});

test("a focus request made while the editor loads lands on the live editor", async () => {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const editorRef: RefObject<HTMLDivElement | null> = { current: null };

	await act(async () => {
		root.render(
			<LazyComposerEditor
				editorRef={editorRef}
				markdown=""
				onChange={() => undefined}
				placeholder="Message"
			/>
		);
	});

	const fallback = container.querySelector<HTMLDivElement>(
		'[data-slot="composer-editor-fallback"]'
	);
	expect(fallback?.textContent).toBe("Message");
	expect(editorRef.current).toBe(fallback);
	editorRef.current?.focus();
	expect(document.activeElement).toBe(fallback);

	await act(async () => {
		releaseEditor();
		await editorReady;
	});
	await act(async () => {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	});

	const live = container.querySelector<HTMLDivElement>(
		'[data-testid="live-editor"]'
	);
	expect(live).not.toBeNull();
	expect(editorRef.current).toBe(live);
	expect(document.activeElement).toBe(live);

	await act(async () => root.unmount());
	container.remove();
});
