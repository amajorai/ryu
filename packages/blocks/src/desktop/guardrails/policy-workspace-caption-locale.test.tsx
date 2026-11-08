// The Guardrails policy list caption under a non-English UI. It is one whole
// catalog message, so it must read in the UI language instead of an English
// string joined from two separately translated sentences.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PolicyWorkspaceClient } from "./policy-workspace.tsx";

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

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { PolicyWorkspace } = await import("./policy-workspace.tsx");

const CAPTION =
	"Ryu platform, then organization, team, member, key and agent. Each scope can only tighten what the scopes above it set. Unassigned policies enforce nothing.";
const CAPTION_JA =
	"Ryu プラットフォーム、組織、チーム、メンバー、キー、エージェントの順です。各スコープは上位のスコープの設定を厳しくすることしかできません。未割り当てのポリシーは何も適用しません。";

const client: PolicyWorkspaceClient = {
	archive: async () => null,
	assign: async () => {
		throw new Error("not used");
	},
	create: async () => {
		throw new Error("not used");
	},
	list: async () => [],
	preview: async () => {
		throw new Error("not used");
	},
	unassign: async () => null,
	update: async () => {
		throw new Error("not used");
	},
};

const options = { agent: [], key: [], member: [], org: [], team: [] };
const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function renderIn(locale: string): Promise<string> {
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<PolicyWorkspace
					canEdit
					client={client}
					orgKey="org"
					runWrite={(action) => action()}
					scopeOptions={options}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return mount.textContent ?? "";
}

test("the policy list caption is one whole message in English", async () => {
	const text = await renderIn("en");
	expect(text).toContain(CAPTION);
});

test("the policy list caption reads in Japanese under ja", async () => {
	registerLiteralCatalogLoader(() => ({ [CAPTION]: CAPTION_JA }));
	const text = await renderIn("ja");
	expect(text).toContain(CAPTION_JA);
	expect(text).not.toContain("Unassigned policies enforce nothing");
	expect(text).not.toContain("Each scope can only tighten");
});
