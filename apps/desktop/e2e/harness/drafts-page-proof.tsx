import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import type { useTabsContext } from "../../src/contexts/TabsContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import DraftsPage from "../../src/pages/DraftsPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import { EntitlementProvider } from "./app-sidebar-entitlement.mock.tsx";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

import type {
	DraftsSettings,
	DraftTrigger,
	DraftWire,
} from "../../src/lib/api/drafts.ts";

const STATE_KEY = "ryu:e2e:drafts-page-core-state";
const AGENT_ID = "drafts-proof-agent";
const DRAFT_ID = "drafts-proof-armed";

// Admit all four native DraftsSettings fields before publishing fixture state.
// This validates settings writes; other draft and persisted-storage inputs remain raw.
const draftsSettingsWriteSchema = z.looseObject({
	auto_queue_enabled: z.boolean(),
	autosave_enabled: z.boolean(),
	autosave_min_chars: z.number(),
	max_concurrent: z.number(),
});

const TriggerSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("manual") }),
	z.object({ kind: z.literal("all_done") }),
	z.object({ kind: z.literal("concurrency"), below: z.number() }),
	z.object({
		kind: z.literal("usage_reset"),
		agent_id: z.string(),
		below_percent: z.number(),
	}),
	z.object({ kind: z.literal("at"), epoch_ms: z.number() }),
]) satisfies z.ZodType<DraftTrigger>;
const DraftInputSchema = z.object({
	text: z.string().optional(),
	id: z.string().optional(),
	trigger: TriggerSchema.optional(),
	source: z.enum(["composer-autosave", "auto-queue", "manual"]).optional(),
	conversation_id: z.string().optional(),
	agent_id: z.string().optional(),
	model: z.string().optional(),
	folder_path: z.string().optional(),
});

interface DraftState {
	drafts: DraftWire[];
	sent: DraftWire[];
	settings: DraftsSettings;
}

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface DraftsPageProof {
	armFailure: (method: string, path: string, status?: number) => void;
	openedTabs: Array<{
		options: Parameters<ReturnType<typeof useTabsContext>["openTab"]>[1];
		path: string;
	}>;
	requests: CapturedRequest[];
	snapshot: () => DraftState;
}

declare global {
	interface Window {
		__draftsPageProof?: DraftsPageProof;
	}
}

function preview(text: string): string {
	const firstLine =
		text
			.split(/\r?\n/u)
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	return (
		[...firstLine].slice(0, 80).join("") +
		([...firstLine].length > 80 ? "…" : "")
	);
}

function waitingFor(trigger: DraftTrigger): string {
	switch (trigger.kind) {
		case "manual":
			return "";
		case "all_done":
			return "Waiting for agents to start, then finish";
		case "concurrency":
			return trigger.below === 1
				? "Waiting for nothing to be running"
				: `Waiting for fewer than ${trigger.below} runs`;
		case "usage_reset":
			return `Waiting for ${trigger.agent_id} to drop under ${trigger.below_percent}% used`;
		case "at":
			return "Sending at a set time";
	}
}

function rowFromInput(
	input: z.infer<typeof DraftInputSchema>,
	existing?: DraftWire
): DraftWire {
	const text = isNativeText(input.text) ? input.text : "";
	const id = isNativeText(input.id) ? input.id : "drafts-proof-created";
	const trigger: DraftTrigger = input.trigger ?? { kind: "manual" };
	const source =
		input.source === "composer-autosave" || input.source === "auto-queue"
			? input.source
			: "manual";
	const state = trigger.kind === "manual" ? "draft" : "armed";
	const optionalField = (
		key: "conversation_id" | "agent_id" | "model" | "folder_path"
	): string | undefined => input[key];
	const now = Date.now();
	return {
		id,
		text,
		preview: preview(text),
		source,
		state,
		state_label: state === "armed" ? "Queued" : "Draft",
		trigger,
		waiting_for: waitingFor(trigger),
		conversation_id: optionalField("conversation_id"),
		agent_id: optionalField("agent_id"),
		model: optionalField("model"),
		folder_path: optionalField("folder_path"),
		created_at: existing?.created_at ?? now,
		updated_at: now,
	};
}

function seedState(seed: string): DraftState {
	const stored = localStorage.getItem(STATE_KEY);
	if (stored) {
		try {
			// SAFETY: This controlled key stores the authored seed plus real mounted save/arm/disarm/delete actions and validated settings writes; these states contain native finite timestamps and JSON fields. Foreign storage edits are outside this proof.
			return JSON.parse(stored) as DraftState;
		} catch {
			localStorage.removeItem(STATE_KEY);
		}
	}
	const now = Date.now();
	const empty: DraftState = {
		drafts: [],
		sent: [
			{
				id: "drafts-proof-sent",
				text: "A message that was already sent",
				preview: "A message that was already sent",
				source: "manual",
				state: "sent",
				state_label: "Sent",
				trigger: { kind: "manual" },
				waiting_for: "",
				created_at: now - 60_000,
				updated_at: now - 30_000,
				sent_at: now - 30_000,
			},
		],
		settings: {
			autosave_enabled: true,
			autosave_min_chars: 4,
			auto_queue_enabled: false,
			max_concurrent: 3,
		},
	};
	if (seed === "armed") {
		const text = "Review the release notes after the Atlas run";
		const trigger: DraftTrigger = {
			kind: "usage_reset",
			agent_id: AGENT_ID,
			below_percent: 90,
		};
		empty.drafts.push({
			id: DRAFT_ID,
			text,
			preview: preview(text),
			source: "composer-autosave",
			state: "armed",
			state_label: "Queued",
			trigger,
			waiting_for: waitingFor(trigger),
			conversation_id: "conversation-atlas",
			agent_id: AGENT_ID,
			model: "gpt-4.1",
			folder_path: "/work/atlas",
			created_at: now - 20_000,
			updated_at: now - 10_000,
		});
	}
	if (seed === "hand") {
		const hand = [
			"Ship the changelog once the Atlas run is green",
			"Ask the reviewer to re-run the flaky upload suite",
			"Draft the migration note for the settings rename",
			"Summarise yesterday's incident for the team thread",
			"Remind me to rotate the staging deploy key",
		];
		hand.forEach((text, index) => {
			empty.drafts.push({
				id: `drafts-proof-hand-${index + 1}`,
				text,
				preview: preview(text),
				source: "manual",
				state: "draft",
				state_label: "Draft",
				trigger: { kind: "manual" },
				waiting_for: "",
				created_at: now - (index + 1) * 60_000,
				updated_at: now - (index + 1) * 60_000,
			});
		});
	}
	localStorage.setItem(STATE_KEY, JSON.stringify(empty));
	return empty;
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installFixture(): DraftsPageProof {
	const seed =
		new URLSearchParams(window.location.search).get("seed") ?? "empty";
	const state = seedState(seed);
	const failures = new Map<string, number>();
	const fixture: DraftsPageProof = {
		armFailure(method, path, status = 503) {
			failures.set(`${method.toUpperCase()} ${path}`, status);
		},
		openedTabs: [],
		requests: [],
		// SAFETY: The controlled authored seed and mounted mutations above/below preserve DraftState JSON fields; this snapshot only serializes and decodes that private state, dropping optional undefined fields.
		snapshot: () => JSON.parse(JSON.stringify(state)) as DraftState,
	};
	window.__draftsPageProof = fixture;

	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		const path = url.pathname + url.search;
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			body = parseProofJson(init.body);
		}
		const failureKey = `${method} ${url.pathname}`;
		const forcedStatus = failures.get(failureKey);
		if (forcedStatus !== undefined) {
			failures.delete(failureKey);
			fixture.requests.push({ body, method, path, status: forcedStatus });
			return json(
				{ error: "The local Drafts fixture rejected this write." },
				forcedStatus
			);
		}

		let response: Response;
		if (url.pathname === "/api/agents" && method === "GET") {
			response = json({
				agents: [
					{
						created_at: new Date(nowMs() - 120_000).toISOString(),
						description: "Checks release notes and test plans.",
						engine: "openai",
						id: AGENT_ID,
						model: "gpt-4.1",
						name: "Atlas Research Agent",
						title: "Research",
						transport: null,
					},
				],
			});
		} else if (url.pathname === "/api/engines" && method === "GET") {
			response = json({ engines: [] });
		} else if (url.pathname === "/api/engine/active" && method === "GET") {
			response = json({ active: null, available: [], running: false });
		} else if (url.pathname === "/api/drafts/list" && method === "GET") {
			response = json({ drafts: state.drafts });
		} else if (url.pathname === "/api/drafts/drafts" && method === "GET") {
			response = json({ drafts: state.sent.slice(0, 25) });
		} else if (url.pathname === "/api/drafts/settings" && method === "GET") {
			response = json({ settings: state.settings });
		} else if (url.pathname === "/api/drafts/settings" && method === "PUT") {
			state.settings = draftsSettingsWriteSchema.parse(body);
			localStorage.setItem(STATE_KEY, JSON.stringify(state));
			response = json({ settings: state.settings });
		} else if (url.pathname === "/api/drafts/drafts" && method === "POST") {
			const input = DraftInputSchema.parse(body);
			const existing = isNativeText(input.id)
				? state.drafts.find((draft) => draft.id === input.id)
				: undefined;
			const draft = rowFromInput(input, existing);
			state.drafts = existing
				? state.drafts.map((item) => (item.id === draft.id ? draft : item))
				: [draft, ...state.drafts];
			localStorage.setItem(STATE_KEY, JSON.stringify(state));
			response = json({ draft });
		} else if (
			url.pathname.startsWith("/api/drafts/drafts/") &&
			method === "POST"
		) {
			const pathParts = url.pathname.split("/");
			const id = decodeURIComponent(pathParts[4] ?? "");
			const action = pathParts[5];
			const existing = state.drafts.find((draft) => draft.id === id);
			if (!existing) {
				response = json({ error: "Draft not found." }, 404);
			} else if (action === "arm") {
				// SAFETY: The mounted TriggerEditor builds the real triggerFor variants from finite validated settings and fixture string agent IDs; armDraft JSON-serializes that authored { trigger } object into this controlled action.
				const input = body as { trigger?: DraftTrigger } | null;
				const trigger = input?.trigger ?? { kind: "manual" as const };
				const draft = {
					...existing,
					state:
						trigger.kind === "manual" ? ("draft" as const) : ("armed" as const),
					state_label: trigger.kind === "manual" ? "Draft" : "Queued",
					trigger,
					waiting_for: waitingFor(trigger),
					updated_at: Date.now(),
				};
				state.drafts = state.drafts.map((item) =>
					item.id === id ? draft : item
				);
				localStorage.setItem(STATE_KEY, JSON.stringify(state));
				response = json({ draft });
			} else if (action === "disarm") {
				const trigger: DraftTrigger = { kind: "manual" };
				const draft = {
					...existing,
					state: "draft" as const,
					state_label: "Draft",
					trigger,
					waiting_for: "",
					updated_at: Date.now(),
				};
				state.drafts = state.drafts.map((item) =>
					item.id === id ? draft : item
				);
				localStorage.setItem(STATE_KEY, JSON.stringify(state));
				response = json({ draft });
			} else {
				response = json({ error: "Unsupported draft action." }, 404);
			}
		} else if (
			url.pathname.startsWith("/api/drafts/drafts/") &&
			method === "DELETE"
		) {
			const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
			const found = state.drafts.some((draft) => draft.id === id);
			state.drafts = state.drafts.filter((draft) => draft.id !== id);
			localStorage.setItem(STATE_KEY, JSON.stringify(state));
			response = found
				? json({ deleted: true })
				: json({ error: "Draft not found." }, 404);
		} else {
			response = json({});
		}
		fixture.requests.push({ body, method, path, status: response.status });
		return response;
	};
	return fixture;
}

function nowMs(): number {
	return Date.now();
}

function Harness() {
	const tabsValue = createTabsProofContext({
		activateTab: () => undefined,
		openTab: (path, options) => {
			window.__draftsPageProof?.openedTabs.push({ options, path });
			return "drafts-page-proof-tab";
		},
		tabs: [],
	});
	return (
		<TabsContext.Provider value={tabsValue}>
			<main
				aria-label="Drafts route"
				className="h-full bg-background text-foreground"
			>
				<DraftsPage />
			</main>
		</TabsContext.Provider>
	);
}

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Drafts fixture node",
	nodes: [
		{
			name: "Drafts fixture node",
			url: window.location.origin,
			token: "drafts-fixture-token",
			userJwt: null,
		},
	],
});
queryClient.clear();
installFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Drafts fixture root is missing.");
}
createRoot(root).render(
	<I18nProvider>
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<AppSurfaceProvider surface="desktop">
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delay={0}>
						<EntitlementProvider>
							<Harness />
							<Toaster position="bottom-right" theme="dark" />
						</EntitlementProvider>
					</TooltipProvider>
				</QueryClientProvider>
			</AppSurfaceProvider>
		</ThemeProvider>
	</I18nProvider>
);
