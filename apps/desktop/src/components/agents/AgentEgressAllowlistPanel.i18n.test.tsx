// Core's allowlist refusals reach the panel as English sentences; the panel
// shows them translated through `tl()` (the extractor catalogs them as sent).
// The DOM localizer is off, so only the panel's own lookup can translate.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}

import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { ApiTarget } from "@/src/lib/api/client.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const target: ApiTarget = {
	url: "https://egress-allowlist-i18n.fixture",
	token: "egress-token",
	userJwt: null,
};
mock.module("@/src/hooks/useActiveNode.ts", () => ({
	useActiveNode: () => target,
}));
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentEgressAllowlistPanel } = await import(
	"./AgentEgressAllowlistPanel.tsx"
);

const INVALID_SITE =
	"Each allowed site must be a host name such as example.com, or *.example.com for its subdomains.";
const STORE_UNREADABLE = "the agent egress allowlists could not be read";
const NOT_SAVED = "The agent's allowed sites were not saved.";

// Stub ja pack: the generated catalog is not consulted.
const JA: Record<string, string> = {
	[INVALID_SITE]:
		"許可するサイトは example.com のようなホスト名か、サブドメインを含める場合は *.example.com にしてください。",
	[STORE_UNREADABLE]: "エージェントの許可サイトの一覧を読み込めませんでした",
	[NOT_SAVED]: "エージェントの許可サイトは保存されませんでした。",
};

const PATH = "/api/agents/agent-1/egress-allowlist";
const originalFetch = globalThis.fetch;
let answer: (method: string) => Response;
let root: Root;
let container: HTMLDivElement;

async function until(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) {
			throw new Error(
				`Allowlist panel did not settle: ${container.textContent}`
			);
		}
		await act(async () => {
			await Bun.sleep(5);
		});
	}
}

async function renderInJapanese(): Promise<void> {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<AgentEgressAllowlistPanel agentId="agent-1" />
			</I18nProvider>
		)
	);
}

function alertText(): string {
	return container.querySelector('[role="alert"]')?.textContent ?? "";
}

beforeEach(() => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	answer = () => Response.json({ agent_id: "agent-1", allowlist: null });
	globalThis.fetch = Object.assign(
		(input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname !== PATH) {
				return Promise.resolve(
					Response.json({ error: "not in fixture" }, { status: 404 })
				);
			}
			return Promise.resolve(answer(init?.method ?? "GET"));
		},
		{ preconnect: originalFetch.preconnect }
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	registerLiteralCatalogLoader(null);
});

afterAll(() => {
	globalThis.fetch = originalFetch;
});

test("Core's refusal of a site is shown in Japanese", async () => {
	answer = (method) =>
		method === "PUT"
			? Response.json({ error: INVALID_SITE }, { status: 400 })
			: Response.json({ agent_id: "agent-1", allowlist: ["example.com"] });
	await renderInJapanese();
	await until(() => container.querySelector("textarea") !== null);
	const field = container.querySelector("textarea");
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		setter?.call(field, "example.com/path");
		field?.dispatchEvent(new Event("input", { bubbles: true }));
	});
	const save = [...container.querySelectorAll("button")].find(
		(button) => button.textContent?.includes("Save allowed sites") === true
	);
	await act(async () => save?.click());
	await until(() => alertText() !== "");
	expect(alertText()).toBe(JA[INVALID_SITE] ?? "");
});

test("a load failure shows Core's sentence in Japanese", async () => {
	answer = () => Response.json({ error: STORE_UNREADABLE }, { status: 503 });
	await renderInJapanese();
	await until(() => alertText() !== "");
	expect(alertText()).toBe(JA[STORE_UNREADABLE] ?? "");
});
