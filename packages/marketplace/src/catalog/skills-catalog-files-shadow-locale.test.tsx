import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../i18n/src/active-locale.ts";
import type { SkillDetail } from "./types.ts";

// The skill Files panel mounts @pierre/trees with search enabled. Its search
// field draws inside a shadow root the document's DOM localizer never enters,
// so the panel must carry the Pierre shadow-root localizer.
if (typeof document === "undefined") {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { SkillFilesPanel } = await import("./skills-catalog-section-files.tsx");
afterAll(async () => {
	await GlobalRegistrator.unregister();
});

const DE: Record<string, string> = {
	Options: "Optionen",
	"Search…": "Suchen…",
};

const runtime = {
	direction: "ltr" as const,
	locale: "de",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		const source = fallback ?? id;
		return formatMessage(DE[source] ?? source, values, "de");
	},
};

afterEach(() => {
	unregisterActiveI18nRuntime(runtime);
	document.body.innerHTML = "";
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const DETAIL = {
	card: { id: "acme/repo/thing", name: "Thing", slug: "thing", source: "acme" },
	description: null,
	files: [
		{ contents: "# Thing", path: "SKILL.md" },
		{ contents: "echo hi", path: "scripts/run.sh" },
	],
	metadata: {},
	readme: null,
	url: "https://example.com",
} as unknown as SkillDetail;

test("the skill file tree search placeholder follows the UI language", async () => {
	registerActiveI18nRuntime(runtime);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() =>
		root.render(
			createElement(SkillFilesPanel, {
				detail: DETAIL,
				loading: false,
				Markdown: ({ content }) => createElement("div", null, content),
				selectedId: "acme/repo/thing",
			})
		)
	);
	await settle();
	const shadow = container.querySelector("file-tree-container")?.shadowRoot;
	expect(shadow).toBeTruthy();
	const input = shadow?.querySelector("input[placeholder]");
	expect(input?.getAttribute("placeholder")).toBe("Suchen…");
	act(() => root.unmount());
});
