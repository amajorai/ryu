// Fixture data and the fetch / Tauri / store doubles for
// app-sidebar-entity-rows-proof.tsx. Importing this module installs the doubles.
declare const window: Window;

import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
import type { Space, SpaceDocument } from "../../src/lib/api/spaces.ts";
import { projectIdForFolder } from "../../src/lib/workspace-projects.ts";
import { type Node, useNodeStore } from "../../src/store/useNodeStore.ts";
import type { WorkspaceProject } from "../../src/store/useWorkspaceStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import type { Conversation } from "../../types/chat.ts";

export const PROJECT_PATH = "/workspace/project-alpha";
export const SPACE_STORAGE_KEY = "proof:spaces";
export const SPACE_ICON_STORAGE_KEY = "proof:space-icons";
export const PROOF_NODE: Node = {
	name: "Proof cloud",
	token: "entity-row-proof-token",
	url: "https://proof-node.local",
};

const INITIAL_PROJECT: WorkspaceProject = {
	folders: [PROJECT_PATH],
	id: projectIdForFolder(PROJECT_PATH),
	name: "Alpha",
};

const DEFAULT_SPACES: Space[] = [
	{
		createdAt: 1_700_000_000_000,
		description: "Research source material",
		documentCount: 3,
		icon: null,
		id: "space-research",
		name: "Research notes",
		retrievalMode: "vector",
		system: false,
		updatedAt: 1_700_000_000_000,
		visibility: "private",
	},
	{
		createdAt: 1_700_000_000_000,
		description: "Shared team material",
		documentCount: 1,
		icon: null,
		id: "space-team",
		name: "Team notes",
		retrievalMode: "vector",
		system: false,
		updatedAt: 1_700_000_000_000,
		visibility: "org",
	},
	{
		createdAt: 1_700_000_000_000,
		description: null,
		documentCount: 0,
		icon: null,
		id: "space-locked",
		name: "Read-only notes",
		retrievalMode: "vector",
		system: false,
		updatedAt: 1_700_000_000_000,
		visibility: "private",
	},
	{
		createdAt: 1_700_000_000_000,
		description: null,
		documentCount: 0,
		icon: null,
		id: "space-system",
		name: "Uploads",
		retrievalMode: "vector",
		system: true,
		updatedAt: 1_700_000_000_000,
		visibility: "org",
	},
];

const spaceSchema = z.object({
	createdAt: z.number(),
	description: z.string().nullable(),
	documentCount: z.number(),
	icon: z.json().transform((value) => asGlyphValue(value) ?? null),
	id: z.string(),
	name: z.string(),
	retrievalMode: z.enum(["graph", "vector"]),
	system: z.boolean(),
	updatedAt: z.number(),
	visibility: z.enum(["private", "org", "team"]).optional(),
	teamId: z.string().nullable().optional(),
});
export function readSpaces(): Space[] {
	try {
		const raw = localStorage.getItem(SPACE_STORAGE_KEY);
		if (raw) {
			return z.array(spaceSchema).parse(JSON.parse(raw));
		}
	} catch {
		// Start from the deterministic fixture if storage is malformed.
	}
	return DEFAULT_SPACES;
}

export function proofConversation(id: string, title: string): Conversation {
	return {
		agentId: undefined,
		branch: undefined,
		createdAt: 1_700_000_000_000,
		folderPath: PROJECT_PATH,
		id,
		lastMessage: `Latest update for ${title}`,
		lastMessageAt: 1_700_000_000_000,
		lastMessageRole: "assistant",
		messageCount: 2,
		messages: [],
		runStatus: "idle",
		title,
		updatedAt: 1_700_000_000_000,
	};
}

function proofDocument(
	id: string,
	spaceId: string,
	title: string,
	kind: "page" | "database" | "file"
): SpaceDocument {
	return {
		byteSize: null,
		chunkCount: 1,
		createdAt: 1_700_000_000_000,
		icon: null,
		id,
		indexMessage: null,
		indexState: null,
		indexWarnings: [],
		kind: kind === "file" ? "page" : kind,
		mime: null,
		rawKind: kind,
		spaceId,
		title,
		updatedAt: 1_700_000_000_000,
	};
}

export const DOCUMENTS = {
	"space-research": [
		proofDocument("doc-brief", "space-research", "Launch brief", "page"),
		proofDocument("db-decisions", "space-research", "Decision log", "database"),
		proofDocument("file-source", "space-research", "Reference PDF", "file"),
	],
	"space-team": [
		proofDocument("doc-team", "space-team", "Team roadmap", "page"),
	],
};

const CONTRIBUTIONS = {
	context_menu_items: [
		{
			anchor: "space",
			args: { source: "sidebar" },
			capability: "space.review",
			id: "review-space",
			label: "Review this space",
			order: 5,
			plugin: "@ryu/spaces",
		},
	],
};

const originalFetch = globalThis.fetch.bind(globalThis);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = input instanceof Request ? input.url : String(input);
	let parsed: URL;
	try {
		parsed = new URL(url, window.location.href);
	} catch {
		return originalFetch(input, init);
	}
	const json = <FixturePayload>(value: FixturePayload, status = 200) =>
		Promise.resolve(
			new Response(JSON.stringify(value), {
				headers: { "content-type": "application/json" },
				status,
			})
		);
	if (parsed.hostname === "api.iconify.design") {
		if (parsed.pathname.endsWith("/search")) {
			return json({ icons: ["lucide:folder"] });
		}
		if (parsed.pathname.endsWith("/collection")) {
			return json({ uncategorized: ["folder"] });
		}
		return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', {
			headers: { "content-type": "image/svg+xml" },
			status: 200,
		});
	}
	if (parsed.pathname === "/api/plugins/contributions") {
		return json(CONTRIBUTIONS);
	}
	if (
		parsed.pathname.startsWith("/api/plugins/") &&
		parsed.pathname.endsWith("/host")
	) {
		const plugin = decodeURIComponent(
			parsed.pathname.match(/\/api\/plugins\/([^/]+)\/host$/)?.[1] ?? ""
		);
		const body = isNativeText(init?.body) ? JSON.parse(init.body) : {};
		document.documentElement.dataset.spaceHostInvocation = JSON.stringify({
			args: body.args,
			method: body.method,
			plugin,
		});
		return json({ result: "review dispatched" });
	}
	if (parsed.pathname === "/api/org-project-mappings") {
		return json({ mappings: [] });
	}
	if (parsed.pathname.startsWith("/api/")) {
		return json({});
	}
	return originalFetch(input, init);
};

// SAFETY: This is the sole authored fixture kernel mutation view. Its complete
// two-member value is derived from the actual object below, not a promise of the
// installed Tauri runtime or a caller-selected command result. All other native
// window slots retain their original ambient SDK ownership.
const tauriWindow = window as Omit<
	typeof globalThis.window,
	"__TAURI_INTERNALS__"
> & {
	__TAURI_INTERNALS__?: typeof entityTauriBridge;
};
let nativeCall = 0;
const entityTauriBridge = {
	transformCallback: () => {
		nativeCall += 1;
		return nativeCall;
	},
	invoke: async (
		command: Parameters<typeof import("@tauri-apps/api/core").invoke>[0],
		args?: Parameters<typeof import("@tauri-apps/api/core").invoke>[1]
	) => {
		const calls = JSON.parse(
			localStorage.getItem("proof:native-calls") ?? "[]"
		);
		const next = [...calls, { args, command }];
		localStorage.setItem("proof:native-calls", JSON.stringify(next));
		document.documentElement.dataset.nativeCalls = JSON.stringify(next);
		if (command === "read_project_file") {
			return "# Alpha project instructions";
		}
		if (command === "write_project_file") {
			if (localStorage.getItem("proof:fail-project-write-once") === "true") {
				localStorage.removeItem("proof:fail-project-write-once");
				throw new Error("fixture project file write failed");
			}
			return undefined;
		}
		return undefined;
	},
};
tauriWindow.__TAURI_INTERNALS__ = entityTauriBridge;

const currentWorkspaceProjects = useWorkspaceStore.getState().projects;
if (
	!currentWorkspaceProjects.some((project) =>
		project.folders.includes(PROJECT_PATH)
	)
) {
	useWorkspaceStore.setState({
		projects: [...currentWorkspaceProjects, INITIAL_PROJECT],
	});
}
useNodeStore.setState({
	activeNodeOnline: true,
	cloudNodes: [],
	defaultNode: PROOF_NODE.name,
	localNodes: [PROOF_NODE],
	nodes: [PROOF_NODE],
});
