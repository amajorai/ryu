// A failed Spaces file row under a non-English UI: the reason leads as a whole
// translated sentence and the converter's raw English stays as a separate,
// left-to-right isolated line the DOM localizer leaves alone.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { DocumentRow } = await import("./spaces-document-rows.tsx");
const { FilesTableSection } = await import("./spaces-files-table.tsx");

const CONVERTER_TEXT = "libreoffice is not installed — install it and retry";
const DE: Record<string, string> = {
	"The document reader couldn't read this file.":
		"Der Dokumentleser konnte diese Datei nicht lesen.",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

describe("a failed Spaces file row in German", () => {
	test("leads with the translated reason and isolates the raw detail", async () => {
		registerLiteralCatalogLoader((requested) =>
			requested.startsWith("de") ? DE : {}
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		mounted = { container, root };
		await act(async () => {
			root.render(
				<I18nProvider initialLocale="de" initialPackId={null}>
					<ul>
						<DocumentRow
							doc={{
								chunkCount: 1,
								id: "doc-1",
								indexMessage: CONVERTER_TEXT,
								indexReasonCode: "provider_error",
								indexState: "failed",
								title: "report.docx",
							}}
						/>
					</ul>
				</I18nProvider>
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		expect(container.textContent).toContain(
			"Der Dokumentleser konnte diese Datei nicht lesen."
		);
		const raw = container.querySelector('[data-ryu-i18n="off"] bdi');
		expect(raw?.getAttribute("dir")).toBe("ltr");
		expect(raw?.textContent).toBe(CONVERTER_TEXT);
	});

	test("the files table words Arabic rows from codes and isolates unknown detail", async () => {
		const AR: Record<string, string> = {
			"Couldn't read this file.": "تعذّرت قراءة هذا الملف.",
			"Reading this file stopped before it finished, for example because Ryu restarted. Upload it again to retry.":
				"توقفت قراءة هذا الملف قبل اكتمالها. ارفعه مرة أخرى لإعادة المحاولة.",
		};
		registerLiteralCatalogLoader((requested) =>
			requested.startsWith("ar") ? AR : {}
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		mounted = { container, root };
		const abandoned = "parse was abandoned (pending past its budget)";
		const unknown = "a future Core reason, still in English";
		await act(async () => {
			root.render(
				<I18nProvider initialLocale="ar" initialPackId={null}>
					<FilesTableSection
						documents={[
							{
								chunkCount: 0,
								id: "doc-a",
								indexMessage: abandoned,
								indexReasonCode: "pending_abandoned",
								indexState: "failed",
								title: "a.pdf",
							},
							{
								chunkCount: 0,
								id: "doc-b",
								indexMessage: unknown,
								indexReasonCode: "some_new_code",
								indexState: "failed",
								title: "b.pdf",
							},
						]}
						onQueryChange={() => undefined}
						query=""
					/>
				</I18nProvider>
			);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});
		const text = container.textContent ?? "";
		expect(text).toContain(
			"توقفت قراءة هذا الملف قبل اكتمالها. ارفعه مرة أخرى لإعادة المحاولة."
		);
		expect(text).toContain("تعذّرت قراءة هذا الملف.");
		// Core's English restatement of a known code is dropped, not shown raw.
		expect(text).not.toContain(abandoned);
		const raw = [...container.querySelectorAll('[data-ryu-i18n="off"] bdi')];
		// One isolated line per render site (the phone list and the wide table).
		expect(raw.map((node) => node.textContent)).toEqual([unknown, unknown]);
		for (const node of raw) {
			expect(node.getAttribute("dir")).toBe("ltr");
		}
	});
});
