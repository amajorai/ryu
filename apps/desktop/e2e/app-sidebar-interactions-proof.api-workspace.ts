// Local Core fixture routes (MCP, identities, channels, spaces, workspace,
// import, composio, skills, proof records) for the AppSidebar interactions proof.
import type { Request, Route } from "@playwright/test";
import {
	sidebarChannelRequestSchema,
	sidebarCloneFolderSchema,
	sidebarCreateSpaceSchema,
	sidebarIconRequestSchema,
	sidebarIdentityRequestSchema,
	sidebarImportRunSchema,
	sidebarImportScanSchema,
	sidebarNewFolderSchema,
	sidebarSpaceVisibilitySchema,
} from "./app-sidebar-interactions-proof.contracts.ts";
import {
	channelConfig,
	jsonResponse,
} from "./app-sidebar-interactions-proof.fixture-data.ts";

type RouteResponse = Parameters<Route["fulfill"]>[0];

/** Answers one local Core `/api/*` request, or returns null when this
 *  module does not own the path. */
export function sidebarWorkspaceApiResponse(
	fixture: ApiFixture,
	request: Request,
	url: URL,
	body: SidebarProofJson
): RouteResponse | null {
	if (url.pathname === "/api/mcp/servers") {
		// `command` is required by the MCP server response contract.
		return jsonResponse({
			servers: [{ command: "proof-mcp", enabled: true, name: "Proof MCP" }],
		});
	}
	if (url.pathname === "/api/mcp/tools") {
		return jsonResponse({
			tools: [
				{
					description: "Search fixture documents",
					id: "proof-search",
					input_schema: { type: "object" },
					name: "proof_search",
					server: "Proof MCP",
				},
			],
		});
	}
	if (url.pathname === "/api/identities" && request.method() === "GET") {
		return jsonResponse({ profiles: fixture.identities });
	}
	if (
		url.pathname === "/api/identities/connections" &&
		request.method() === "POST"
	) {
		const value = sidebarIdentityRequestSchema.parse(body ?? {});
		const connection = {
			created_at: 1_700_000_000_000,
			domain: value.domain ?? "",
			flow_status: "IDLE",
			id: "connection-proof-created",
			last_checked: 1_700_000_000_000,
			profile_id: value.profile_id ?? "",
			source: "manual",
			status: "NEEDS_AUTH",
			updated_at: 1_700_000_000_000,
		} satisfies Connection;
		fixture.identities = [
			...fixture.identities.filter(
				(profile) => profile.profile_id !== connection.profile_id
			),
			{ connections: [connection], profile_id: connection.profile_id },
		];
		return jsonResponse({ connection });
	}
	if (url.pathname === "/api/channels" && request.method() === "GET") {
		return jsonResponse({ channels: fixture.channels });
	}
	if (url.pathname === "/api/channels" && request.method() === "POST") {
		if (fixture.failChannelCreateOnce) {
			fixture.failChannelCreateOnce = false;
			return jsonResponse({ message: "Fixture channel create failed" }, 503);
		}
		const value = sidebarChannelRequestSchema.parse(body ?? {});
		const created = channelConfig(
			"channel-proof-created",
			value.name ?? "Created channel",
			sidebarChannelRequestSchema.parse(body)
		);
		created.secrets = { bot_token: "***" };
		fixture.channels = [...fixture.channels, created];
		return jsonResponse(created, 201);
	}
	if (url.pathname === "/api/spaces" && request.method() === "GET") {
		return jsonResponse({ spaces: fixture.spaces });
	}
	if (url.pathname === "/api/spaces" && request.method() === "POST") {
		if (fixture.failSpaceCreateOnce) {
			fixture.failSpaceCreateOnce = false;
			return jsonResponse({ error: "Fixture space create failed" }, 503);
		}
		const created = {
			created_at: 1_700_000_000_400,
			description: sidebarCreateSpaceSchema.parse(body)?.description ?? null,
			document_count: 0,
			icon: null,
			id: "space-proof-created",
			name: sidebarCreateSpaceSchema.parse(body)?.name ?? "Created proof space",
			retrieval_mode:
				sidebarCreateSpaceSchema.parse(body)?.retrieval_mode ?? "vector",
			system: false,
			updated_at: 1_700_000_000_400,
			visibility: sidebarCreateSpaceSchema.parse(body)?.visibility ?? "private",
		};
		fixture.spaces = [...fixture.spaces, created];
		return jsonResponse(
			{ id: created.id, retrieval_mode: created.retrieval_mode },
			201
		);
	}
	if (
		url.pathname === "/api/spaces/space-proof/visibility" &&
		request.method() === "POST"
	) {
		const visibility =
			sidebarSpaceVisibilitySchema.parse(body)?.visibility ?? "private";
		fixture.spaces = fixture.spaces.map((space) =>
			space.id === "space-proof" ? { ...space, visibility } : space
		);
		return { body: "", status: 204 };
	}
	if (url.pathname === "/api/spaces/space-proof/documents") {
		return jsonResponse({
			documents: [
				{
					chunk_count: 2,
					created_at: 1_700_000_000_100,
					id: "doc-proof-page",
					kind: "page",
					space_id: "space-proof",
					title: "Proof page",
					updated_at: 1_700_000_000_200,
				},
			],
		});
	}
	if (
		url.pathname === "/api/spaces/space-proof/documents/doc-proof-page/icon"
	) {
		return jsonResponse({ icon: sidebarIconRequestSchema.parse(body)?.icon });
	}
	if (url.pathname === "/api/workspace/list") {
		const requested = url.searchParams.get("path");
		if (requested === "::this-pc") {
			return jsonResponse({ error: "This node is not Windows" }, 404);
		}
		const path = requested ?? "/Users/proof";
		return jsonResponse({
			entries:
				path === "/Users/proof"
					? [{ name: "Documents", path: "/Users/proof/Documents" }]
					: path === "/Users/proof/Documents"
						? [{ name: "Ryu", path: "/Users/proof/Documents/Ryu" }]
						: [],
			home: "/Users/proof",
			parent: path === "/Users/proof" ? null : "/Users/proof",
			path,
		});
	}
	if (
		url.pathname === "/api/workspace/new-folder" &&
		request.method() === "POST"
	) {
		if (fixture.failFolderCreateOnce) {
			fixture.failFolderCreateOnce = false;
			return jsonResponse({ error: "Fixture project folder collision" }, 409);
		}
		const name = sidebarNewFolderSchema.parse(body)?.name ?? "Proof project";
		return jsonResponse({ path: `/Users/proof/Documents/Ryu/${name}` }, 201);
	}
	if (url.pathname === "/api/workspace/clone" && request.method() === "POST") {
		if (fixture.failFolderCloneOnce) {
			fixture.failFolderCloneOnce = false;
			return jsonResponse({ error: "Fixture clone failed" }, 503);
		}
		const value = sidebarCloneFolderSchema.parse(body ?? {});
		const name = value.name || "proof-repo";
		return jsonResponse(
			{ name, path: `/Users/proof/Documents/Ryu/${name}` },
			201
		);
	}
	if (url.pathname === "/api/import/scan" && request.method() === "POST") {
		return jsonResponse({
			items: [
				{
					already_exists: false,
					detail: "CLAUDE.md",
					id: "proof-instructions",
					kind: "instructions",
					title: "Proof instructions",
				},
				{
					already_exists: false,
					id: "proof-skill-import",
					kind: "skill",
					title: "Proof imported skill",
				},
			],
			root: sidebarImportScanSchema.parse(body)?.path ?? "/Users/proof/.claude",
			warnings: [],
		});
	}
	if (url.pathname === "/api/import/run" && request.method() === "POST") {
		return jsonResponse({
			results: [
				{
					already_exists: false,
					folder_path: "/Users/proof/Imported instructions",
					id: "proof-instructions",
					kind: "instructions",
					status: "imported",
					title: "Proof instructions",
				},
			],
			root: sidebarImportRunSchema.parse(body)?.path ?? "/Users/proof/.claude",
		});
	}
	if (url.pathname === "/api/composio/status") {
		return jsonResponse({ configured: true });
	}
	if (url.pathname === "/api/composio/connections") {
		return jsonResponse({
			data: [
				{
					active: true,
					id: "integration-proof",
					status: "ACTIVE",
					toolkit: "proof-mail",
				},
			],
		});
	}
	if (url.pathname === "/api/composio/toolkits") {
		return jsonResponse({
			data: [{ logo: null, name: "Proof Mail", slug: "proof-mail" }],
		});
	}
	if (url.pathname === "/api/skills") {
		if (fixture.failSkillReadCount > 0) {
			fixture.failSkillReadCount -= 1;
			return jsonResponse({ message: "Fixture skill read failed" }, 503);
		}
		return jsonResponse({
			skills: [{ enabled: true, id: "proof-skill", name: "Proof skill" }],
		});
	}
	if (url.pathname === "/api/proof/records" && request.method() === "GET") {
		return jsonResponse({
			records: [
				{
					id: "proof-record-a",
					name: "Proof record A",
					summary: "First fixture record",
				},
				{
					id: "proof-record-b",
					name: "Proof record B",
					summary: "Second fixture record",
				},
			],
		});
	}
	if (url.pathname === "/api/proof/records" && request.method() === "POST") {
		return jsonResponse(
			{ id: "proof-record-created", name: "Created proof record" },
			201
		);
	}
	if (url.pathname === "/api/proof/records/proof-record-a/archive") {
		return jsonResponse({ archived: true });
	}
	return null;
}
