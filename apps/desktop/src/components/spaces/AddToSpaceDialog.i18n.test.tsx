import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { Space } from "@/src/lib/api/spaces.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function spaceFixture(id: string, name: string, system: boolean): Space {
	return {
		createdAt: 1,
		description: null,
		documentCount: 0,
		icon: null,
		id,
		name,
		retrievalMode: "vector",
		system,
		updatedAt: 1,
	};
}

const spaces: Space[] = [
	spaceFixture("uploads", "Uploads", true),
	spaceFixture("renamed", "Artifacts", false),
];

mock.module("@/src/contexts/SpacesContext.tsx", () => ({
	useSpacesContext: () => ({
		createDatabase: async () => "db",
		createPage: async () => "page",
		spaces,
	}),
}));
mock.module("@/src/contexts/TabsContext.tsx", () => ({
	useTabSelector: <TResult,>(
		selector: (state: { openTab: () => void }) => TResult
	) => selector({ openTab: () => undefined }),
}));
mock.module("@/src/hooks/useSpaceFileUpload.ts", () => ({
	useSpaceFileUpload: () => ({
		onFilesAdded: () => undefined,
		onRemove: () => undefined,
		onRetry: () => undefined,
		queue: [],
		reset: () => undefined,
		uploading: false,
	}),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AddToSpaceDialog } = await import("./AddToSpaceDialog.tsx");

const JA: Record<string, string> = {
	"Add to {spaceName}": "{spaceName}に追加",
	Artifacts: "成果物",
	Uploads: "アップロード",
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

test("a Japanese dialog names the seeded Uploads Space in Japanese", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<AddToSpaceDialog onClose={() => undefined} open spaceId="uploads" />
			</I18nProvider>
		);
		await Promise.resolve();
	});

	const text = document.body.textContent ?? "";
	expect(text).toContain("アップロードに追加");
	expect(text).not.toContain("Uploads");
});

test("a Space that is not a system Space keeps its stored name", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<AddToSpaceDialog onClose={() => undefined} open spaceId="renamed" />
			</I18nProvider>
		);
		await Promise.resolve();
	});

	const text = document.body.textContent ?? "";
	expect(text).toContain("Artifactsに追加");
	expect(text).not.toContain("成果物");
});
