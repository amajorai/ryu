import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { SpaceImportRecord } from "@/src/lib/api/space-imports.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ImportHistorySection } = await import("./history.tsx");

// Core stores import failures as English text; the history row matches the
// sentence and renders it from the catalog (the DOM localizer is off here, so
// the component itself must translate), and maps the wire status to a label.
const JA: Record<string, string> = {
	Failed: "失敗",
	Running: "実行中",
	"The file is empty.": "ファイルが空です。",
	"The document parser failed on this file.":
		"ドキュメントパーサーがこのファイルの処理に失敗しました。",
	"{count, plural, one {Skipped # source:} other {Skipped # sources:}}":
		"{count} 件のソースをスキップしました:",
	Completed: "完了",
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

function record(
	overrides: Partial<SpaceImportRecord> & Pick<SpaceImportRecord, "id">
): SpaceImportRecord {
	return {
		byteSize: 0,
		completedAt: null,
		createdAt: 1_700_000_000_000,
		destinationKind: "page",
		itemCount: 0,
		message: null,
		resultDocuments: [],
		sourceFormat: "zip",
		sourceName: "archive.zip",
		sourceType: "file",
		spaceId: "space-1",
		status: "failed",
		updatedAt: 1_700_000_000_000,
		...overrides,
	};
}

const DE: Record<string, string> = {
	Failed: "Fehlgeschlagen",
	"The ZIP archive has more than {limit} entries.":
		"Das ZIP-Archiv hat mehr als {limit} Einträge.",
};

const AR: Record<string, string> = {
	Completed: "مكتمل",
	"{count, plural, one {Skipped # source:} other {Skipped # sources:}}":
		"{count, plural, zero {لم يتم تخطي أي مصدر:} one {تم تخطي مصدر واحد:} two {تم تخطي مصدرين:} few {تم تخطي # مصادر:} many {تم تخطي # مصدرًا:} other {تم تخطي # مصدر:}}",
	"This file format cannot be imported.": "لا يمكن استيراد تنسيق هذا الملف.",
	"The table has no header row.": "لا يحتوي الجدول على صف عناوين.",
};

function renderJa(imports: SpaceImportRecord[]): Promise<HTMLElement> {
	return renderIn("ja", JA, imports);
}

async function renderIn(
	language: string,
	catalog: Record<string, string>,
	imports: SpaceImportRecord[]
): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith(language) ? catalog : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={language}
				initialPackId={null}
			>
				<ImportHistorySection
					historyError={null}
					imports={imports}
					onOpenDocument={() => undefined}
					onRefresh={() => undefined}
				/>
			</I18nProvider>
		);
	});
	return container;
}

test("a Japanese history row shows a translated failure and status badge", async () => {
	const container = await renderJa([
		record({
			id: "a",
			message:
				"notes.csv: delimited file is empty; report.pdf: provider_error: Docling failed",
		}),
		record({ id: "b", message: null, status: "running" }),
	]);
	const text = container.textContent ?? "";
	expect(text).toContain("失敗");
	expect(text).toContain("実行中");
	expect(text).not.toContain("running");
	expect(text).toContain("ファイルが空です。");
	expect(text).toContain(
		"ドキュメントパーサーがこのファイルの処理に失敗しました。"
	);
	expect(text).not.toContain("provider_error");
	// File names and provider detail stay as written, outside the localizer.
	const untranslated = [
		...container.querySelectorAll('[data-ryu-i18n="off"]'),
	].map((node) => node.textContent);
	expect(untranslated).toContain("notes.csv");
	expect(untranslated).toContain("Docling failed");
});

test("a partial import shows the plural Skipped heading", async () => {
	const container = await renderJa([
		record({
			id: "c",
			itemCount: 3,
			message: "Skipped notes.csv: delimited file is empty",
			status: "completed",
		}),
	]);
	expect(container.textContent).toContain("1 件のソースをスキップしました:");
	expect(container.textContent).toContain("ファイルが空です。");
});

test("a stored message that matches no sentence still renders as written", async () => {
	const container = await renderJa([
		record({ id: "d", message: "Notion refused the token" }),
	]);
	expect(container.textContent).toContain("Notion refused the token");
});

test("a German row formats the entry limit with the German group separator", async () => {
	const container = await renderIn("de", DE, [
		record({ id: "e", message: "ZIP contains more than 10000 entries" }),
	]);
	expect(container.textContent).toContain("Fehlgeschlagen");
	expect(container.textContent).toContain(
		"Das ZIP-Archiv hat mehr als 10.000 Einträge."
	);
});

test("an Arabic partial import uses the dual plural form", async () => {
	const container = await renderIn("ar", AR, [
		record({
			id: "f",
			message:
				"Skipped a.xyz: unsupported import format; b.csv: table has no header row",
			status: "completed",
		}),
	]);
	const text = container.textContent ?? "";
	expect(text).toContain("مكتمل");
	expect(text).toContain("تم تخطي مصدرين:");
	expect(text).toContain("لا يمكن استيراد تنسيق هذا الملف.");
	expect(text).toContain("لا يحتوي الجدول على صف عناوين.");
	expect(text).not.toContain("Skipped");
});
