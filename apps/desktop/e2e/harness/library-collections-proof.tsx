import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { ContextType } from "react";
import { z } from "zod";
import { createTabsProofContext } from "./tabs-proof-context.ts";

declare const window: Window;

import { I18nProvider } from "@ryu/i18n/react";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createRoot } from "react-dom/client";
import { SkillDistributionProvider } from "../../src/components/skills/SkillDistributionProvider.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { ChatHistoryProvider } from "../../src/contexts/ChatHistoryContext.tsx";
import { SpacesProvider } from "../../src/contexts/SpacesContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import { queryClient } from "../../src/lib/query-client.ts";
import LibraryPage from "../../src/pages/LibraryPage.tsx";
import { useNodeStore } from "../../src/store/useNodeStore.ts";
import { type ProofJsonValue, parseProofJson } from "../fixture-json.ts";
import { EntitlementProvider } from "./app-sidebar-entitlement.mock.tsx";
import "../../src/index.css";

const CORE_STATE_KEY = "ryu:e2e:library-collections-core-state";
const CHAT_ID = "library-collections-chat";
const AGENT_ID = "library-collections-agent";
const TEAM_ID = "library-collections-team";

interface ConversationWire {
	agent_id: string | null;
	archived: boolean;
	branch: string | null;
	created_at: number;
	folder_path: string | null;
	id: string;
	message_count: number;
	pinned: boolean;
	run_status: string | null;
	title: string | null;
	updated_at: number;
	worktree_path: string | null;
}

interface TeamWire {
	coordination: string;
	created_at: number;
	description: string | null;
	id: string;
	lead_agent_id: string | null;
	members: string[];
	name: string;
	updated_at: number;
}

interface CoreState {
	conversations: ConversationWire[];
	teams: TeamWire[];
}

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

type TabOptions = NonNullable<
	Parameters<NonNullable<ContextType<typeof TabsContext>>["openTab"]>[1]
>;
interface OpenedTab {
	options: TabOptions;
	path: string;
}

interface LibraryCollectionsFixture {
	armFailure: (method: string, path: string, status?: number) => void;
	openedTabs: OpenedTab[];
	requests: CapturedRequest[];
	snapshot: () => { conversations: ConversationWire[]; teams: TeamWire[] };
}

declare global {
	interface Window {
		__libraryCollectionsFixture?: LibraryCollectionsFixture;
	}
}

const teamSchema = z.object({
	coordination: z.string(),
	created_at: z.number(),
	description: z.string().nullable(),
	id: z.string(),
	lead_agent_id: z.string().nullable(),
	members: z.array(z.string()),
	name: z.string(),
	updated_at: z.number(),
});
const conversationSchema = z.object({
	agent_id: z.string().nullable(),
	archived: z.boolean(),
	branch: z.string().nullable(),
	created_at: z.number(),
	folder_path: z.string().nullable(),
	id: z.string(),
	message_count: z.number(),
	pinned: z.boolean(),
	run_status: z.string().nullable(),
	title: z.string().nullable(),
	updated_at: z.number(),
	worktree_path: z.string().nullable(),
});
const coreStateSchema = z.object({
	conversations: z.array(conversationSchema),
	teams: z.array(teamSchema),
});
function seedState(): CoreState {
	const previous = localStorage.getItem(CORE_STATE_KEY);
	if (previous) {
		try {
			return coreStateSchema.parse(JSON.parse(previous));
		} catch {
			localStorage.removeItem(CORE_STATE_KEY);
		}
	}
	const now = Date.now();
	const state: CoreState = {
		conversations: [
			{
				agent_id: null,
				archived: false,
				branch: null,
				created_at: now - 30_000,
				folder_path: null,
				id: CHAT_ID,
				message_count: 2,
				pinned: false,
				run_status: null,
				title: "Regression chat from Library",
				updated_at: now - 10_000,
				worktree_path: null,
			},
		],
		teams: [
			{
				coordination: "broadcast",
				created_at: now - 60_000,
				description: "Reviews release changes",
				id: TEAM_ID,
				lead_agent_id: null,
				members: [AGENT_ID],
				name: "Release Review Group",
				updated_at: now - 15_000,
			},
		],
	};
	localStorage.setItem(CORE_STATE_KEY, JSON.stringify(state));
	return state;
}

function json<FixturePayload>(body: FixturePayload, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "Content-Type": "application/json" },
		status,
	});
}

function installFixture(): LibraryCollectionsFixture {
	const state = seedState();
	const failures = new Map<string, number>();
	const fixture: LibraryCollectionsFixture = {
		armFailure(method, path, status = 503) {
			failures.set(`${method.toUpperCase()} ${path}`, status);
		},
		openedTabs: [],
		requests: [],
		snapshot: () => ({
			conversations: state.conversations.map((conversation) => ({
				...conversation,
			})),
			teams: state.teams.map((team) => ({
				...team,
				members: [...team.members],
			})),
		}),
	};
	window.__libraryCollectionsFixture = fixture;

	window.fetch = async (input, init) => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		const url = new URL(requestUrl, window.location.href);
		const method = (
			init?.method ?? (input instanceof Request ? input.method : "GET")
		).toUpperCase();
		let body: ProofJsonValue = null;
		if (isNativeText(init?.body)) {
			body = parseProofJson(init.body);
		}
		const failureKey = `${method} ${url.pathname}`;
		const forcedStatus = failures.get(failureKey);
		if (forcedStatus !== undefined) {
			failures.delete(failureKey);
			fixture.requests.push({
				body,
				method,
				path: url.pathname,
				status: forcedStatus,
			});
			return json(
				{ error: "The local Core fixture rejected this write." },
				forcedStatus
			);
		}
		let response: Response;
		if (url.pathname === "/api/conversations" && method === "GET") {
			response = json({ conversations: state.conversations });
		} else if (
			url.pathname === `/api/conversations/${CHAT_ID}/title` &&
			method === "POST"
		) {
			const { title } = z.object({ title: z.string() }).parse(body);
			state.conversations = state.conversations.map((conversation) =>
				conversation.id === CHAT_ID
					? { ...conversation, title, updated_at: Date.now() }
					: conversation
			);
			localStorage.setItem(CORE_STATE_KEY, JSON.stringify(state));
			response = json({ ok: true });
		} else if (url.pathname === "/api/teams" && method === "GET") {
			response = json({ teams: state.teams });
		} else if (url.pathname === "/api/teams" && method === "POST") {
			const input = teamSchema.partial().nullable().parse(body);
			const team: TeamWire = {
				coordination: input?.coordination ?? "broadcast",
				created_at: Date.now(),
				description: input?.description ?? null,
				id: "library-collections-created-team",
				lead_agent_id: input?.lead_agent_id ?? null,
				members: input?.members ?? [],
				name: input?.name ?? "",
				updated_at: Date.now(),
			};
			state.teams = [...state.teams, team];
			localStorage.setItem(CORE_STATE_KEY, JSON.stringify(state));
			response = json({ team }, 201);
		} else if (url.pathname === `/api/teams/${TEAM_ID}` && method === "PATCH") {
			const input = teamSchema.partial().nullable().parse(body);
			state.teams = state.teams.map((team) =>
				team.id === TEAM_ID
					? {
							...team,
							...(input?.name === undefined ? undefined : { name: input.name }),
							...(input?.description === undefined
								? undefined
								: { description: input.description }),
							...(input?.members === undefined
								? undefined
								: { members: input.members }),
							...(input?.coordination === undefined
								? undefined
								: { coordination: input.coordination }),
							...(input?.lead_agent_id === undefined
								? undefined
								: { lead_agent_id: input.lead_agent_id }),
							updated_at: Date.now(),
						}
					: team
			);
			localStorage.setItem(CORE_STATE_KEY, JSON.stringify(state));
			const team = state.teams.find((candidate) => candidate.id === TEAM_ID);
			response = team
				? json({ team })
				: json({ error: "Group not found." }, 404);
		} else if (
			url.pathname === `/api/teams/${TEAM_ID}` &&
			method === "DELETE"
		) {
			state.teams = state.teams.filter((team) => team.id !== TEAM_ID);
			localStorage.setItem(CORE_STATE_KEY, JSON.stringify(state));
			response = json({ ok: true });
		} else if (url.pathname === "/api/agents" && method === "GET") {
			response = json({
				agents: [
					{
						created_at: new Date(Date.now() - 120_000).toISOString(),
						description: "Checks release notes and test plans.",
						engine: null,
						id: AGENT_ID,
						name: "Atlas Research Agent",
						title: "Research",
						transport: null,
					},
				],
			});
		} else if (url.pathname === "/api/plugins" && method === "GET") {
			response = json({
				apps: [
					{
						approved_grants: ["app:http", "ui:declarative-http"],
						built_in: false,
						enabled: true,
						id: "@ryu/teams",
						installed: true,
						installed_version: "0.1.0",
						local_only: true,
						name: "Groups",
						permission_grants: ["app:http", "ui:declarative-http"],
						runnables: [
							{
								config: { label: "Groups" },
								id: "teams-companion",
								kind: "companion",
								name: "Groups",
							},
						],
						sidecar_name: "ryu-teams",
						version: "0.1.0",
						windows_first: false,
					},
				],
			});
		} else if (
			url.pathname === "/api/plugins/contributions" &&
			method === "GET"
		) {
			response = json({
				sidebar_sections: [
					{
						approved_grants: ["ui:declarative-http"],
						icon: "user-multiple-02",
						id: "teams",
						plugin: "@ryu/teams",
						spec: {
							emptyState: {
								description:
									"Create a group to address a group of agents as one.",
								title: "No groups yet",
							},
							itemTarget: "/plugin/app__teams-companion",
							source: {
								http: { method: "GET", path: "/api/ext/@ryu/teams/" },
								items: "teams",
								limit: 50,
								map: {
									id: "id",
									subtitle: "description",
									title: "name",
								},
							},
						},
						title: "Groups",
					},
				],
			});
		} else if (url.pathname === "/api/ext/@ryu/teams/" && method === "GET") {
			response = json({ teams: state.teams });
		} else if (url.pathname === "/api/engines" && method === "GET") {
			response = json({ engines: [] });
		} else if (url.pathname === "/api/engine/active" && method === "GET") {
			response = json({ active: null, available: [], running: false });
		} else if (url.pathname === "/workflows" && method === "GET") {
			response = json({ workflows: [] });
		} else if (url.pathname === "/api/spaces" && method === "GET") {
			response = json({ spaces: [] });
		} else if (url.pathname.startsWith("/api/meetings")) {
			response = json({ meetings: [] });
		} else if (url.pathname.startsWith("/api/channels")) {
			response = json({ channels: [] });
		} else if (url.pathname.startsWith("/api/identities")) {
			response = json({ profiles: [] });
		} else if (url.pathname.startsWith("/api/mcp")) {
			response = json({ servers: [], tools: [] });
		} else if (url.pathname.startsWith("/api/skills")) {
			response = json({ skills: [] });
		} else if (url.pathname.startsWith("/api/sandbox")) {
			response = json({ backends: [] });
		} else {
			response = json({});
		}
		fixture.requests.push({
			body,
			method,
			path: url.pathname,
			status: response.status,
		});
		return response;
	};
	return fixture;
}

function Harness() {
	const initialSection =
		new URLSearchParams(window.location.search).get("section") ?? "recents";
	const tabsValue = createTabsProofContext({
		activateTab: () => undefined,
		openTab: (path: string, options: TabOptions = {}) => {
			window.__libraryCollectionsFixture?.openedTabs.push({ options, path });
			return "library-proof-tab";
		},
		tabs: [],
	});
	return (
		<TabsContext.Provider value={tabsValue}>
			<LibraryPage initialSection={initialSection} />
		</TabsContext.Provider>
	);
}

useNodeStore.setState({
	autoSelect: false,
	defaultNode: "Library collections fixture node",
	nodes: [
		{
			name: "Library collections fixture node",
			url: window.location.origin,
			token: "library-collections-fixture-token",
			userJwt: null,
		},
	],
});
localStorage.setItem(
	"ryu:library-recents",
	JSON.stringify([
		{ id: CHAT_ID, ts: Date.now(), type: "chat" },
		{ id: AGENT_ID, ts: Date.now() - 1, type: "agent" },
	])
);
queryClient.clear();
installFixture();

const root = document.getElementById("root");
if (!root) {
	throw new Error("Library collections fixture root is missing.");
}
createRoot(root).render(
	<I18nProvider>
		<ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
			<AppSurfaceProvider surface="desktop">
				<QueryClientProvider client={queryClient}>
					<TooltipProvider delay={0}>
						<EntitlementProvider>
							<ChatHistoryProvider>
								<SpacesProvider>
									<SkillDistributionProvider>
										<Harness />
										<Toaster position="bottom-right" theme="dark" />
									</SkillDistributionProvider>
								</SpacesProvider>
							</ChatHistoryProvider>
						</EntitlementProvider>
					</TooltipProvider>
				</QueryClientProvider>
			</AppSurfaceProvider>
		</ThemeProvider>
	</I18nProvider>
);
