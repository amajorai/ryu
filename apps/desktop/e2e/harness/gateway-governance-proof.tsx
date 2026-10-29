import { z } from "zod";
import { parseGatewayGovernanceSnapshot } from "../../src/lib/api/governance.ts";
import { parseGovernanceValues } from "../../src/lib/api/governance-wire-contracts.ts";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { EnvironmentsSection } from "../../src/components/gateway/EnvironmentsSection.tsx";
import { GitSettingsSection } from "../../src/components/gateway/GitSettingsSection.tsx";
import { HooksSection } from "../../src/components/gateway/HooksSection.tsx";
import { WorktreesSection } from "../../src/components/gateway/WorktreesSection.tsx";
import { ConnectedDevicesSection } from "../../src/components/settings/ConnectionsTab.tsx";
import { NodeSelector } from "../../src/components/shell/NodeSelector.tsx";
import { EntitlementProvider } from "../../src/contexts/entitlement-context.tsx";
import { SystemStatusProvider } from "../../src/contexts/SystemStatusContext.tsx";
import { TabsProvider } from "../../src/contexts/TabsContext.tsx";
import type {
	GatewayGovernanceSnapshot,
	GitGovernanceSettings,
	WorktreeGovernanceSettings,
} from "../../src/lib/api/governance.ts";
import type { HookInventory } from "../../src/lib/api/hooks.ts";
import { LOCAL_FALLBACK, useNodeStore } from "../../src/store/useNodeStore.ts";
import "../../src/index.css";

interface GovernanceProofCall {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface GovernanceProofWindow extends Window {
	__GATEWAY_GOVERNANCE_PROOF__: {
		armFailure: (kind: "git" | "worktrees") => void;
		calls: () => GovernanceProofCall[];
		releaseHeldRead: () => void;
		snapshot: () => GatewayGovernanceSnapshot;
	};
}

declare global {
	interface Window {
		__GATEWAY_GOVERNANCE_PROOF__?: GovernanceProofWindow["__GATEWAY_GOVERNANCE_PROOF__"];
	}
}

const TARGET = {
	token: null,
	url: "http://127.0.0.1:7980",
};

const governance: GatewayGovernanceSnapshot = {
	layers: [
		{
			revision: 4,
			scope: "node",
			values: {
				git: {
					branchPrefix: "codex/",
					createDraftPullRequests: true,
					mergeMethod: "merge",
					reviewDelivery: "inline",
				},
				worktrees: {
					autoDelete: true,
					autoDeleteLimit: 15,
					fetchUpstream: false,
					root: "/proof/managed-worktrees",
				},
			},
			writable: true,
		},
		{
			revision: 8,
			scope: "organization",
			values: {
				git: { createDraftPullRequests: false },
			},
			writable: false,
		},
		{
			revision: 8,
			scope: "team",
			values: {},
			writable: false,
		},
		{
			revision: 4,
			scope: "user",
			values: {},
			writable: true,
		},
	],
	schemaVersion: 1,
};
const GOVERNANCE_STORAGE_KEY = "proof:gateway-governance";
const storedGovernance = localStorage.getItem(GOVERNANCE_STORAGE_KEY);
let governanceState: GatewayGovernanceSnapshot = storedGovernance
	? parseGatewayGovernanceSnapshot(JSON.parse(storedGovernance))
	: structuredClone(governance);
const governanceCalls: GovernanceProofCall[] = [];
const failedWrites = new Set<"git" | "worktrees">();
const searchParams = new URLSearchParams(window.location.search);
const failGovernanceReadOnce = searchParams.has("failGovernanceReadOnce");
const holdGovernanceRead = searchParams.has("holdGovernanceRead");
let readFailurePending = failGovernanceReadOnce;
let heldReadPending = holdGovernanceRead;
let releaseHeldRead: Parameters<
	ConstructorParameters<typeof Promise<void>>[0]
>[0] = () => undefined;
const heldRead = new Promise<void>((resolve) => {
	releaseHeldRead = resolve;
});

const cloneSnapshot = (snapshot: GatewayGovernanceSnapshot) =>
	structuredClone(snapshot);

const persistGovernance = () => {
	localStorage.setItem(GOVERNANCE_STORAGE_KEY, JSON.stringify(governanceState));
};

const updateGovernanceLayer = (
	scope: "node" | "user",
	kind: "git" | "worktrees",
	values: GitGovernanceSettings | WorktreeGovernanceSettings
) => {
	governanceState = {
		...governanceState,
		layers: governanceState.layers.map((layer) => {
			if (layer.scope !== scope) {
				return layer;
			}
			return {
				...layer,
				revision: layer.revision + 1,
				values: { ...layer.values, [kind]: values },
			};
		}),
	};
	persistGovernance();
};

window.__GATEWAY_GOVERNANCE_PROOF__ = {
	armFailure: (kind) => failedWrites.add(kind),
	calls: () =>
		governanceCalls.map((call) => ({
			...call,
			body: call.body === null ? null : JSON.parse(JSON.stringify(call.body)),
		})),
	releaseHeldRead: () => releaseHeldRead(),
	snapshot: () => cloneSnapshot(governanceState),
};

const hooks: HookInventory = {
	hooks: [
		{
			effectiveEnabled: false,
			enabled: true,
			handler: {
				display: "Sandboxed JavaScript",
				kind: "sandbox_js",
				path: "hooks/review.js",
			},
			hookKey: "com.example.security::review",
			id: "review",
			localOverrides: {},
			matcher: { flag: "io.example.review" },
			ownerId: "com.example.security",
			ownerName: "Security Guidance",
			phase: "post_assistant_turn",
			pluginEnabled: true,
			priority: 4,
			reviewRequired: true,
			source: "plugin",
			trusted: false,
		},
		{
			effectiveEnabled: true,
			enabled: true,
			handler: {
				display: "Sandboxed JavaScript",
				kind: "sandbox_js",
				path: "hooks/session-start.js",
			},
			hookKey: "com.example.security::session-start",
			id: "session-start",
			localOverrides: {},
			ownerId: "com.example.security",
			ownerName: "Security Guidance",
			phase: "session_start",
			pluginEnabled: true,
			priority: 2,
			reviewRequired: false,
			source: "plugin",
			trusted: true,
		},
		{
			effectiveEnabled: true,
			enabled: true,
			handler: {
				display: "Command",
				kind: "command",
				path: "~/.ryu/hooks/lint.sh",
			},
			hookKey: "user-config::lint",
			id: "lint",
			localOverrides: { user: { enabled: true, trusted: true } },
			matcher: { commands: ["/review"] },
			ownerId: "user-config",
			ownerName: "User config",
			phase: "user_prompt_submit",
			pluginEnabled: true,
			priority: 1,
			reviewRequired: false,
			source: "config",
			trusted: true,
		},
	],
};

const connections = {
	client_count: 4,
	data: [
		{
			client_id: "desktop-proof",
			client_label: "Proof desktop",
			first_seen: 1000,
			last_seen: Math.floor(Date.now() / 1000),
			surface: "desktop",
			user_id: "jiawei@example.com",
			user_name: "Jiawei",
		},
		{
			client_id: "cli-proof",
			client_label: "release shell",
			first_seen: 1000,
			last_seen: Math.floor(Date.now() / 1000) - 12,
			surface: "cli",
			user_id: null,
			user_name: null,
		},
		{
			client_id: "phone-proof",
			client_label: "iPhone",
			first_seen: 1000,
			last_seen: Math.floor(Date.now() / 1000) - 40,
			surface: "mobile",
			user_id: "jiawei@example.com",
			user_name: "Jiawei",
		},
		{
			client_id: "extension-proof",
			client_label: "Chrome",
			first_seen: 1000,
			last_seen: Math.floor(Date.now() / 1000) - 65,
			surface: "extension",
			user_id: null,
			user_name: null,
		},
	],
	ttl_secs: 90,
	user_count: 2,
};

function jsonResponse<FixturePayload>(
	body: FixturePayload,
	status = 200
): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

const connectionsMode = new URLSearchParams(window.location.search).get(
	"connections"
);

window.fetch = async (input, init) => {
	const url = isNativeText(input)
		? input
		: input instanceof Request
			? input.url
			: input.toString();
	const parsedUrl = new URL(url, window.location.href);
	const method =
		init?.method ?? (input instanceof Request ? input.method : "GET");
	const recordGovernanceCall = <Body,>(body: Body, status: number) => {
		governanceCalls.push({
			body: body === undefined ? null : JSON.parse(JSON.stringify(body)),
			method,
			path: parsedUrl.pathname,
			status,
		});
	};
	if (url.endsWith("/api/hooks/management")) {
		return jsonResponse(hooks);
	}
	if (
		url.endsWith("/api/hooks/overrides") &&
		init?.method === "PUT" &&
		isNativeText(init.body)
	) {
		const update = z
			.object({
				hookKey: z.string(),
				scope: z.enum(["node", "user"]),
				policy: z.object({
					enabled: z.boolean().optional(),
					trusted: z.boolean().optional(),
				}),
			})
			.parse(JSON.parse(init.body));
		const hook = hooks.hooks.find((entry) => entry.hookKey === update.hookKey);
		if (hook) {
			const current = hook.localOverrides[update.scope] ?? {};
			hook.localOverrides = {
				...hook.localOverrides,
				[update.scope]: { ...current, ...update.policy },
			};
		}
		return jsonResponse(hooks);
	}
	if (
		parsedUrl.pathname.endsWith("/api/gateway/governance/git") &&
		method === "PUT"
	) {
		const input = z
			.object({ scope: z.enum(["node", "user"]), values: z.json() })
			.parse(JSON.parse(String(init?.body)));
		const values = parseGovernanceValues({ git: input.values }).git;
		if (!values) {
			throw new Error("Missing git settings fixture contract");
		}
		const update = { scope: input.scope, values };
		if (failedWrites.delete("git")) {
			recordGovernanceCall(update, 503);
			return jsonResponse(
				{ message: "Git settings are temporarily unavailable" },
				503
			);
		}
		updateGovernanceLayer(update.scope, "git", update.values);
		recordGovernanceCall(update, 200);
		return jsonResponse(cloneSnapshot(governanceState));
	}
	if (
		parsedUrl.pathname.endsWith("/api/gateway/governance/worktrees") &&
		method === "PUT"
	) {
		const input = z
			.object({ scope: z.enum(["node", "user"]), values: z.json() })
			.parse(JSON.parse(String(init?.body)));
		const values = parseGovernanceValues({ worktrees: input.values }).worktrees;
		if (!values) {
			throw new Error("Missing worktrees settings fixture contract");
		}
		const update = { scope: input.scope, values };
		if (failedWrites.delete("worktrees")) {
			recordGovernanceCall(update, 503);
			return jsonResponse(
				{ message: "Worktree settings are temporarily unavailable" },
				503
			);
		}
		updateGovernanceLayer(update.scope, "worktrees", update.values);
		recordGovernanceCall(update, 200);
		return jsonResponse(cloneSnapshot(governanceState));
	}
	if (parsedUrl.pathname.endsWith("/api/gateway/governance")) {
		if (heldReadPending) {
			heldReadPending = false;
			await heldRead;
		}
		if (readFailurePending) {
			readFailurePending = false;
			recordGovernanceCall(null, 503);
			return jsonResponse(
				{ message: "Governance settings are temporarily unavailable" },
				503
			);
		}
		recordGovernanceCall(null, 200);
		return jsonResponse(cloneSnapshot(governanceState));
	}
	if (url.endsWith("/api/connections")) {
		if (connectionsMode === "error") {
			return jsonResponse({ message: "presence unavailable" }, 503);
		}
		if (connectionsMode === "empty") {
			return jsonResponse({
				client_count: 0,
				data: [],
				ttl_secs: 90,
				user_count: 0,
			});
		}
		return jsonResponse(connections);
	}
	if (url.endsWith("/api/system/status")) {
		return jsonResponse({
			engine: { active: "llamacpp", running: true },
			gateway: { reachable: true },
			mesh: null,
			sidecars: [
				{ name: "core", running: true },
				{ name: "gateway", running: true },
			],
		});
	}
	if (url.endsWith("/api/system/info")) {
		return jsonResponse({
			cpu_cores: 10,
			cpu_name: "Proof machine",
			disk_human: "512 GB",
			hostname: "proof-machine",
			ram_human: "32 GB",
			used_disk_human: "120 GB",
			used_ram_human: "8 GB",
		});
	}
	return jsonResponse({});
};

useNodeStore.setState({
	defaultNode: LOCAL_FALLBACK.name,
	localNodes: [LOCAL_FALLBACK],
	nodes: [LOCAL_FALLBACK],
});

const queryClient = new QueryClient({
	defaultOptions: { queries: { retry: false } },
});

function Proof() {
	const canConfigure = searchParams.get("canConfigure") !== "false";
	return (
		<ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
			<I18nProvider>
				<QueryClientProvider client={queryClient}>
					<EntitlementProvider>
						<TabsProvider>
							<SystemStatusProvider>
								<main className="min-h-screen bg-background px-8 py-10 text-foreground">
									<div className="mx-auto max-w-6xl space-y-8">
										<header>
											<p className="font-medium text-muted-foreground text-xs uppercase tracking-(--tracking-section)">
												Ryu · Gateway governance
											</p>
											<h1 className="mt-2 font-heading text-3xl tracking-tight">
												Hooks, developer defaults, and connected clients
											</h1>
											<p className="mt-2 max-w-3xl text-muted-foreground text-sm">
												Effective controls follow the same user → team →
												organization → node hierarchy used by managed MCP and
												skills.
											</p>
										</header>
										<div className="rounded-2xl border border-border/70 bg-sidebar px-4 py-3">
											<p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
												Node selector
											</p>
											<NodeSelector mode="compact-dropdown" />
										</div>
										<div className="grid gap-6 lg:grid-cols-2">
											<div className="lg:col-span-2">
												<HooksSection canConfigure target={TARGET} />
											</div>
											<div data-testid="proof-git">
												<GitSettingsSection
													canConfigure={canConfigure}
													target={TARGET}
												/>
											</div>
											<div data-testid="proof-worktrees">
												<WorktreesSection
													canConfigure={canConfigure}
													target={TARGET}
												/>
											</div>
											<EnvironmentsSection />
											<ConnectedDevicesSection />
										</div>
									</div>
								</main>
							</SystemStatusProvider>
						</TabsProvider>
					</EntitlementProvider>
				</QueryClientProvider>
			</I18nProvider>
		</ThemeProvider>
	);
}

createRoot(document.getElementById("root")!).render(<Proof />);
