import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import type { Agent } from "@/src/lib/api/agents.ts";

// happy-dom swaps the global Response; the loopback server needs Bun's own.
const NativeResponse = globalThis.Response;
if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentPassportPanel } = await import("./AgentPassportPanel.tsx");

// Stub catalog: the real translations land with the catalog merge. The DOM
// localizer is off, so only the panel's own translator can produce these.
const JA: Record<string, string> = {
	"Read + write": "読み取り/書き込み",
	"Read only": "読み取り専用",
};

// A loopback Core with an empty audit ledger keeps the panel network-free.
const core = Bun.serve({
	fetch: () =>
		NativeResponse.json(
			{ count: 0, entries: [], reachable: true },
			{
				headers: {
					"access-control-allow-headers": "*",
					"access-control-allow-origin": "*",
				},
			}
		),
	hostname: "127.0.0.1",
	port: 0,
});
const LOCAL_TARGET = { token: null, url: `http://127.0.0.1:${core.port}` };

afterAll(() => {
	core.stop(true);
});

function detailedAgent(writeEnabled: boolean): Agent {
	return {
		accountAccess: null,
		builtIn: false,
		canCreateAgents: null,
		chatModel: null,
		composioActions: [],
		createdAt: null,
		description: null,
		engine: null,
		id: "notes-agent",
		identityMode: "managed",
		identityProfileIds: [],
		inference: null,
		lifecycleStatus: "active",
		locked: false,
		memory: { read_levels: [], space_ids: [], write_enabled: writeEnabled },
		model: null,
		name: "Notes Agent",
		orchestrator: null,
		persona: null,
		safetyProfile: "autonomous",
		skills: [],
		systemPrompt: null,
		title: "",
		tools: [],
		updatedAt: null,
		version: "1.0.0",
	};
}

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

async function memoryFieldInJapanese(writeEnabled: boolean): Promise<string> {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<I18nProvider
					autoLocalizeDom={false}
					initialLocale="ja"
					initialPackId={null}
				>
					<AgentPassportPanel
						agent={detailedAgent(writeEnabled)}
						target={LOCAL_TARGET}
					/>
				</I18nProvider>
			</QueryClientProvider>
		);
	});
	await act(async () => {
		await Bun.sleep(50);
	});
	const terms = [...container.querySelectorAll("dt")];
	const memory = terms.find((term) => term.textContent === "Memory");
	return memory?.nextElementSibling?.textContent ?? "";
}

test("a writable agent's Memory field reads in Japanese", async () => {
	expect(await memoryFieldInJapanese(true)).toBe("読み取り/書き込み");
});

test("a read-only agent's Memory field reads in Japanese", async () => {
	expect(await memoryFieldInJapanese(false)).toBe("読み取り専用");
});
