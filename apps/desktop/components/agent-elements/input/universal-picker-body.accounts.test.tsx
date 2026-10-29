import { afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { UniversalPickerData } from "@/components/agent-elements/input/universal-picker-body.tsx";
import type { AgentSummary } from "@/src/lib/api/agents.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { ProviderCommandDialog } = await import(
	"@/components/agent-elements/input/provider-command-dialog.tsx"
);
const { UniversalPickerBody } = await import(
	"@/components/agent-elements/input/universal-picker-body.tsx"
);

const NOOP = () => undefined;
const agent: AgentSummary = {
	avatarGlyph: null,
	avatarUrl: null,
	builtIn: true,
	createdAt: null,
	description: null,
	engine: "kiro",
	id: "acp:kiro",
	installed: true,
	installHint: null,
	latestVersion: null,
	lifecycleStatus: "active",
	locked: false,
	model: null,
	name: "Proof Agent",
	recommended: false,
	safetyProfile: "standard",
	systemPrompt: null,
	title: "",
	transport: "acp",
	version: null,
	versionStatus: null,
} as unknown as AgentSummary;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
const accountReads: string[] = [];
const originalFetch = globalThis.fetch;

beforeEach(() => {
	accountReads.length = 0;
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			if (path.endsWith("/accounts")) {
				accountReads.push(path);
				return Response.json({
					accounts: [
						{
							accountId: "work",
							active: true,
							kind: "native_cli",
							label: "Proof Work Account",
						},
						{
							accountId: "home",
							active: false,
							kind: "native_cli",
							label: "Proof Home Account",
						},
					],
				});
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
		{ preconnect: originalFetch.preconnect }
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	client.clear();
	globalThis.fetch = originalFetch;
});

function data(): UniversalPickerData {
	return {
		activeAgentId: agent.id,
		activeExtraSections: [],
		activeModelSection: {
			key: "model",
			ariaLabel: "Select model",
			label: "Model",
			value: "model-a",
			items: [{ id: "model-a", name: "Proof Model A" }],
			onChange: NOOP,
		},
		agents: [agent],
		availableExternal: [],
		customAgents: [],
		hideAuto: true,
		installedExternal: [agent],
		installPendingId: null,
		providers: [],
		ryuActive: false,
		ryuAgent: null,
		teams: [],
		thinkingLevels: [],
		onConfigureCredentials: NOOP,
		onInstallExternal: NOOP,
		onRemoveAgentAccount: NOOP,
		onRemoveProviderAccount: NOOP,
		onSelectAgent: NOOP,
		onSelectProviderModel: NOOP,
		onSelectProviderThinking: NOOP,
		onSwitchAgentAccount: NOOP,
		onSwitchProviderAccount: NOOP,
		onUpgrade: NOOP,
		onUseProvider: NOOP,
	};
}

async function settle() {
	await act(async () => {
		await Bun.sleep(30);
	});
}

test("the active external agent's submenu lists its accounts beside its live sections", async () => {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ProviderCommandDialog
					renderBody={(close) => (
						<UniversalPickerBody close={close} data={data()} mode="agents" />
					)}
					trigger={<button type="button">Choose agent</button>}
				/>
			</QueryClientProvider>
		)
	);
	const trigger = [...document.querySelectorAll("button")].find(
		(node) => node.textContent?.trim() === "Choose agent"
	);
	await act(async () => trigger?.click());
	const row = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((node) => node.textContent?.includes("Proof Agent"));
	if (!row) {
		throw new Error(`Missing agent row; rendered ${document.body.textContent}`);
	}
	await act(async () => row.click());
	await settle();
	expect(accountReads).toEqual(["/api/agents/acp%3Akiro/accounts"]);
	expect(document.body.textContent).toContain("Proof Model A");
	expect(document.body.textContent).toContain("Proof Home Account");
});
