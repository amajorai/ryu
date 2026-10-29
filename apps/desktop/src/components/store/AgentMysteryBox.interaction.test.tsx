// The Mystery Box dialog with WebGL unavailable (happy-dom): the flat fallback
// still opens, reveals a pull, and Add / Skip drive the same flow the 3D box does.

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// Stand in for the lazy three.js scene the way a machine without WebGL fails it.
mock.module("@ryu/ui/components/mystery-box/mystery-box-scene.tsx", () => ({
	default: () => {
		throw new Error("WebGL unavailable");
	},
}));

const { AgentMysteryBox } = await import(
	"@/src/components/store/AgentMysteryBox.tsx"
);

function entry(over: Partial<AgentCatalogEntry>): AgentCatalogEntry {
	return {
		added: false,
		available: true,
		bridgeVersionStatus: null,
		description: "Writes code",
		detected: null,
		engine: null,
		gatewayBypass: false,
		iconUrl: null,
		id: "acp:example",
		installedBridgeVersion: null,
		installedVersion: null,
		installHint: null,
		latestBridgeVersion: null,
		latestVersion: null,
		name: "Example",
		recommended: false,
		registryId: null,
		transport: "acp",
		versionStatus: null,
		...over,
	};
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
});

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll("button")].find(
		(el) => el.textContent?.trim() === label
	);
	if (!match) {
		throw new Error(`no "${label}" button`);
	}
	return match;
}

async function waitFor(check: () => boolean, timeoutMs = 3000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("timed out");
		}
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
	}
}

function mount(
	runtimes: AgentCatalogEntry[],
	onAddRuntime: (id: string) => Promise<void> = async () => undefined
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => {
		root?.render(
			<AgentMysteryBox
				onAddRuntime={onAddRuntime}
				onAddTemplate={async () => undefined}
				onBuyTemplate={() => undefined}
				onOpenChange={() => undefined}
				onViewDetails={() => undefined}
				open
				runtimes={runtimes}
				templates={[]}
			/>
		);
	});
}

test("an empty pool says so and cannot be opened", () => {
	mount([entry({ added: true, id: "taken" })]);
	expect(document.body.textContent).toContain("You've collected every agent");
	expect(button("Open box").disabled).toBe(true);
});

test("opening reveals a pull that can be added, then another box opens", async () => {
	const added: string[] = [];
	mount(
		[entry({ id: "acp:codex", name: "Codex", recommended: true })],
		async (id) => {
			added.push(id);
		}
	);
	await act(async () => {
		button("Open box").click();
	});
	await waitFor(
		() => document.body.textContent?.includes("Legendary") ?? false
	);
	expect(document.body.textContent).toContain("Recommended by Ryu");

	await act(async () => {
		button("Add to my agents").click();
	});
	expect(added).toEqual(["acp:codex"]);
	await act(async () => {
		button("Open another").click();
	});
	expect(button("Open box").disabled).toBe(false);
});

test("a template pull discloses its Identity and the account-access notice before Add", async () => {
	const card = {
		author: "Publisher",
		communityStats: { downloads: 0, instances: 0, runs: 0 },
		description: "Researches things",
		firstParty: false,
		iconUrl: null,
		id: "researcher",
		kind: "agent",
		name: "Researcher",
		pricing: null,
		ratingAverage: 0,
		ratingCount: 0,
		verification: "verified",
		version: "1.0.0",
	} as unknown as MarketplaceCard;
	// Primed below; never stale, so nothing refetches over the network.
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
	client.setQueryData(["marketplace", "detail", "agent", card.id], {
		capabilities: [],
		description: null,
		examplePrompts: [],
		identityMode: "managed",
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => {
		root?.render(
			<QueryClientProvider client={client}>
				<AgentMysteryBox
					onAddRuntime={async () => undefined}
					onAddTemplate={async () => undefined}
					onBuyTemplate={() => undefined}
					onOpenChange={() => undefined}
					onViewDetails={() => undefined}
					open
					runtimes={[]}
					templates={[card]}
				/>
			</QueryClientProvider>
		);
	});
	await act(async () => {
		button("Open box").click();
	});
	await waitFor(
		() =>
			document.querySelector('[data-testid="mystery-template-disclosure"]') !==
			null
	);
	const disclosure = document.querySelector(
		'[data-testid="mystery-template-disclosure"]'
	)?.textContent;
	expect(disclosure).toContain("Identity:");
	expect(disclosure).toContain("can use your connected accounts");
	expect(disclosure).toContain("Account access");
});
