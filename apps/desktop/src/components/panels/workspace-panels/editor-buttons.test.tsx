import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The stores read localStorage on import, so load them after the DOM exists.
const { createRoot } = await import("react-dom/client");
const { AppSurfaceProvider } = await import(
	"@/src/contexts/app-surface-context.tsx"
);
const { useWorkspaceStore } = await import("@/src/store/useWorkspaceStore.ts");
const { EditorButtonGroup } = await import("./editor-buttons.tsx");

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
	// The native editor probe answers that VS Code is installed.
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: (command: string) =>
			Promise.resolve(
				command === "get_editor_availability"
					? [{ id: "vscode", available: true }]
					: null
			),
		transformCallback: () => 1,
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

test("the open-in-editor button is named by the editor's action, once", async () => {
	useWorkspaceStore.setState({ defaultFileOpener: "vscode" });
	await act(async () => {
		root?.render(
			<AppSurfaceProvider surface="desktop">
				<EditorButtonGroup folder="/fixture/project" />
			</AppSurfaceProvider>
		);
		await Promise.resolve();
	});
	const names = [...document.querySelectorAll("button[aria-label]")].map(
		(button) => button.getAttribute("aria-label")
	);
	expect(names).toEqual(["Open in VS Code", "Choose editor"]);
});
