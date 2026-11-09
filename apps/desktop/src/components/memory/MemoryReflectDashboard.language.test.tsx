import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { messageIdForLiteral } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Keep Bun's own network stack across DOM registration: the dashboard talks to
// a real HTTP peer below, not a mocked API module.
const nativeFetch = globalThis.fetch;
const NativeResponse = globalThis.Response;
const NativeAbortController = globalThis.AbortController;
const NativeAbortSignal = globalThis.AbortSignal;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
globalThis.fetch = nativeFetch;
globalThis.AbortController = NativeAbortController;
globalThis.AbortSignal = NativeAbortSignal;
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { MemoryReflectDashboard } = await import("./MemoryReflectDashboard.tsx");

const TITLE = "Workflow continuity";
const DETAIL =
	"Multiple conversations share a workspace, branch, or agent workflow label.";
const JA_TITLE = "ワークフローの継続性";
const JA_DETAIL =
	"複数の会話がワークスペース、ブランチ、またはエージェントのワークフローラベルを共有しています。";

const TOPIC_PLURAL = "{count, plural, one {# message} other {# messages}}";

const pack: LanguagePack = {
	baseLocale: "en",
	direction: "ltr",
	id: "test/ja",
	locale: "ja",
	messages: {
		[messageIdForLiteral(TITLE)]: JA_TITLE,
		[messageIdForLiteral(DETAIL)]: JA_DETAIL,
		[messageIdForLiteral("Active days")]: "アクティブな日数",
		[messageIdForLiteral(TOPIC_PLURAL)]:
			"{count, plural, other {# 件のメッセージ}}",
	},
	name: "Japanese",
	schemaVersion: 1,
	version: "1.0.0",
};

// Core's Reflect projection: one AI-fluency observation, in English.
const core = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api/memory/reflect/settings") {
			return NativeResponse.json({ settings: {} });
		}
		if (pathname === "/api/memory/reflect") {
			return NativeResponse.json({
				activity: [{ count: 4, label: "Active days", trend: null }],
				generated_at: 1,
				insights: [{ body: DETAIL, id: "workflow-continuity", title: TITLE }],
				period: "7d",
				topics: [{ count: 2, name: "Travel planning", summary: "1 messages" }],
			});
		}
		return new NativeResponse("not found", { status: 404 });
	},
});

afterAll(() => {
	core.stop(true);
});

describe("MemoryReflectDashboard under a Japanese pack", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		container.remove();
	});

	it("renders Core's English insight title and detail in the UI language", async () => {
		await act(async () => {
			root.render(
				<I18nProvider
					autoLocalizeDom={false}
					initialPackId={pack.id}
					manageDocument={false}
					packs={[pack]}
				>
					<MemoryReflectDashboard
						target={{ token: null, url: core.url.origin }}
					/>
				</I18nProvider>
			);
		});
		for (let attempt = 0; attempt < 50; attempt += 1) {
			if (container.textContent?.includes(JA_TITLE)) {
				break;
			}
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			});
		}
		expect(container.textContent).toContain(JA_TITLE);
		expect(container.textContent).toContain(JA_DETAIL);
		expect(container.textContent).not.toContain(TITLE);
		expect(container.textContent).toContain("アクティブな日数");
		expect(container.textContent).not.toContain("Active days");
		expect(container.textContent).toContain("1 件のメッセージ");
		expect(container.textContent).not.toContain("1 messages");
	});
});
