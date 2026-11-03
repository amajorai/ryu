import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { FileAnnotationViewer } = await import("./FileAnnotationViewer.tsx");

// The native binary read rejects with a code, never an English sentence. The
// DOM localizer is off, so the viewer itself must word the code.
const DE: Record<string, string> = {
	"This file is too large to annotate here.":
		"Diese Datei ist zu groß, um sie hier zu kommentieren.",
	"This file could not be read.": "Diese Datei konnte nicht gelesen werden.",
};

const roots: Root[] = [];
let rejection: unknown = "file_too_large";

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("de") ? DE : {}));
	Reflect.set(window, "__TAURI_INTERNALS__", {
		invoke: () => Promise.reject(rejection),
		transformCallback: () => 0,
	});
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
	Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function renderViewer(): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="de"
				initialPackId={null}
			>
				<FileAnnotationViewer
					folder="/work"
					notes={[]}
					onClose={() => undefined}
					onNotesChange={() => undefined}
					onOpenExternally={() => undefined}
					path="big.log"
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	return container;
}

test("a file_too_large rejection renders the German sentence", async () => {
	rejection = "file_too_large";
	const container = await renderViewer();
	const alert = container.querySelector('[role="alert"]');
	expect(alert?.textContent).toBe(
		"Diese Datei ist zu groß, um sie hier zu kommentieren."
	);
	expect(container.textContent).not.toContain("8 MiB");
});

test("an io rejection renders the German sentence and keeps the OS text as detail", async () => {
	rejection = "io:No such file or directory (os error 2)";
	const container = await renderViewer();
	expect(container.querySelector('[role="alert"]')?.textContent).toBe(
		"Diese Datei konnte nicht gelesen werden."
	);
	const detail = container.querySelector('[data-ryu-i18n="off"]');
	expect(detail?.textContent).toBe("No such file or directory (os error 2)");
});
