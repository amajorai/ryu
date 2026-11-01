// Local Core fixture routes (auth, conversations, plugins, agents, catalog)
// for the AppSidebar interactions proof.
import type { Request, Route } from "@playwright/test";
import {
	EMPTY_CONTRIBUTIONS,
	jsonResponse,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

type RouteResponse = Parameters<Route["fulfill"]>[0];

/** Answers one local Core `/api/*` request, or returns null when this
 *  module does not own the path. */
export function sidebarCoreApiResponse(
	fixture: ApiFixture,
	request: Request,
	url: URL,
	body: SidebarProofJson
): RouteResponse | null {
	// Better Auth's signed-out response is null, never an empty session object.
	if (url.pathname === "/api/auth/get-session" && request.method() === "GET") {
		if (
			request.headers().authorization !== "Bearer local-app-sidebar-proof-token"
		) {
			return jsonResponse(null);
		}
		return jsonResponse({
			session: {
				id: "sidebar-proof-session",
				token: "local-app-sidebar-proof-token",
				userId: "sidebar-proof-user",
				expiresAt: "2050-01-01T00:00:00.000Z",
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
			user: {
				id: "sidebar-proof-user",
				email: "sidebar-proof@example.test",
				name: "Sidebar proof",
				image: null,
				emailVerified: true,
				isAnonymous: false,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		});
	}

	if (url.pathname === "/api/control-plane/orgs") {
		return jsonResponse({ organizations: [] });
	}

	if (url.pathname === "/api/conversations" && request.method() === "GET") {
		return jsonResponse({
			conversations: [
				{
					agent_id: null,
					branch: null,
					created_at: 1_700_000_000_000,
					folder_path: null,
					id: "chat-loose",
					last_message: "Latest proof update",
					last_message_at: 1_700_000_000_100,
					last_message_role: "assistant",
					message_count: 2,
					participants: [],
					run_status: "idle",
					title: "Proof chat",
					updated_at: 1_700_000_000_100,
					worktree_path: null,
				},
				{
					agent_id: "agent-alpha",
					branch: null,
					created_at: 1_700_000_000_000,
					folder_path: null,
					id: "chat-agent-alpha",
					last_message: "Agent thread preview",
					last_message_at: 1_700_000_000_200,
					last_message_role: "assistant",
					message_count: 1,
					participants: [],
					run_status: "idle",
					title: "Agent chat",
					updated_at: 1_700_000_000_200,
					worktree_path: null,
				},
				{
					agent_id: null,
					branch: null,
					created_at: 1_700_000_000_000,
					folder_path: null,
					id: "chat-group-alpha",
					last_message: "Group conversation update",
					last_message_at: 1_700_000_000_300,
					last_message_role: "assistant",
					message_count: 1,
					participants: ["agent-alpha", "agent-beta"],
					run_status: "idle",
					title: "Group proof chat",
					updated_at: 1_700_000_000_300,
					worktree_path: null,
				},
			],
		});
	}
	if (url.pathname === "/api/plugins/contributions") {
		return jsonResponse(EMPTY_CONTRIBUTIONS);
	}
	if (url.pathname === "/api/plugins") {
		const apps = [
			{
				accentColor: null,
				approved_grants: [],
				built_in: true,
				category: null,
				channel: "stable",
				companion: null,
				description: "Spaces sidebar proof capability",
				enabled: true,
				external: false,
				icon: "lucide:library",
				iconBackground: null,
				iconDither: null,
				iconPadding: null,
				iconUrl: null,
				id: "@ryu/spaces",
				installed: true,
				installed_version: "1.0.0",
				layers: [],
				local_only: true,
				mandatory: true,
				mcp_oauth_servers: [],
				name: "Spaces",
				permission_grants: [],
				requires: null,
				runnables: [],
				sidecar_name: null,
				stability: "stable",
				suppressed_by_safe_mode: false,
				surface_support: [],
				tagline: "Spaces local fixture",
				targets: [],
				tier: "core",
				version: "1.0.0",
				windows_first: false,
			},
			{
				accentColor: null,
				approved_grants: [],
				built_in: false,
				category: "Proof",
				channel: "stable",
				companion: null,
				description: "Local proof plugin",
				enabled: true,
				external: false,
				icon: "lucide:plug",
				iconBackground: null,
				iconDither: null,
				iconPadding: null,
				iconUrl: null,
				id: "proof-plugin",
				installed: true,
				installed_version: "1.0.0",
				layers: [],
				local_only: true,
				mandatory: false,
				mcp_oauth_servers: [],
				name: "Proof Plugin",
				permission_grants: [],
				requires: null,
				runnables: [],
				sidecar_name: null,
				stability: "stable",
				suppressed_by_safe_mode: false,
				surface_support: [],
				tagline: "Plugin route fixture",
				targets: [],
				tier: "third_party",
				version: "1.0.0",
				windows_first: false,
			},
		];
		if (fixture.calendarEnabled) {
			apps.push({
				accentColor: null,
				approved_grants: [],
				built_in: true,
				category: null,
				channel: "stable",
				companion: null,
				description: "Local scheduling proof capability",
				enabled: true,
				external: false,
				icon: "lucide:calendar",
				iconBackground: null,
				iconDither: null,
				iconPadding: null,
				iconUrl: null,
				id: "@ryu/calendar",
				installed: true,
				installed_version: "1.0.0",
				layers: [],
				local_only: true,
				mandatory: true,
				mcp_oauth_servers: [],
				name: "Calendar",
				permission_grants: [],
				requires: null,
				runnables: [],
				sidecar_name: null,
				stability: "stable",
				suppressed_by_safe_mode: false,
				surface_support: [],
				tagline: "Scheduling fixture",
				targets: [],
				tier: "core",
				version: "1.0.0",
				windows_first: false,
			});
		}
		return jsonResponse({ apps });
	}
	if (url.pathname === "/api/agents") {
		return jsonResponse({
			agents: [
				{ id: "agent-alpha", name: "Agent Alpha", title: "Researcher" },
				{ id: "agent-beta", name: "Agent Beta", title: "Writer" },
			],
		});
	}
	if (
		url.pathname === "/api/agents/agent-alpha/threads" &&
		request.method() === "GET"
	) {
		return jsonResponse({
			engine: "claude-code",
			supported: true,
			threads: [
				{
					cwd: "/Users/proof/Project Alpha",
					engine: "claude-code",
					git_branch: "proof/import-thread",
					id: "native-thread-proof",
					message_count: 3,
					title: "Imported proof thread",
					updated_at: 1_700_000_000_500,
				},
			],
		});
	}
	if (
		url.pathname === "/api/agents/agent-alpha/threads/import" &&
		request.method() === "POST"
	) {
		return jsonResponse(
			{
				already_imported: false,
				conversation_id: "conversation-imported-proof",
				cwd: "/Users/proof/Project Alpha",
				dry_run: false,
				message_count: 3,
				messages_added: 3,
				title: "Imported proof thread",
				truncated: false,
				would_create: true,
			},
			201
		);
	}
	if (url.pathname === "/api/catalog") {
		// Complete `nativeCatalogResponseSchema` rows (description, deprecated
		// and recommended are required), or the Engines section reads nothing.
		return jsonResponse({
			sidecars: [
				{
					deprecated: false,
					description: "Local catalog fixture",
					recommended: false,
					category: "provider",
					display_name: "Proof Engine",
					install_state: "installed",
					name: "proof-engine",
					platforms: [],
					supported: true,
					installed_version: "1.0.0",
					latest_version: "1.0.0",
				},
				{
					deprecated: false,
					description: "Local catalog fixture",
					recommended: false,
					category: "voice",
					display_name: "Proof Voice",
					install_state: "installed",
					name: "proof-voice",
					platforms: [],
					supported: true,
					installed_version: "1.0.0",
					latest_version: "1.0.0",
				},
			],
		});
	}
	if (url.pathname === "/api/engine/active") {
		return jsonResponse({
			active: "proof-engine",
			available: ["proof-engine"],
			running: true,
		});
	}
	if (url.pathname === "/api/sidecar/status") {
		return jsonResponse({ sidecars: [{ name: "proof-voice", running: true }] });
	}
	return null;
}
