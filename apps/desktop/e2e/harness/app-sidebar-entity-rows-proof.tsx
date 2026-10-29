declare const window: Window;

import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import {
	type ContextType,
	Fragment,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { SpaceSidebarRow } from "../../src/components/layout/AppSidebar.tsx";
import { ResourceVisibilityConfirmationDialog } from "../../src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { ProjectRow } from "../../src/components/layout/sidebar-project-row.tsx";
import { DestructiveConfirmDialog } from "../../src/components/ui/DestructiveConfirmDialog.tsx";
import { AppSurfaceProvider } from "../../src/contexts/app-surface-context.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import type { Space, SpaceDocument } from "../../src/lib/api/spaces.ts";
import type { VisibilityChangeRequest } from "../../src/lib/resource-visibility.ts";
import { projectIdForFolder } from "../../src/lib/workspace-projects.ts";
import { type Node, useNodeStore } from "../../src/store/useNodeStore.ts";
import type { WorkspaceProject } from "../../src/store/useWorkspaceStore.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import type { Conversation } from "../../types/chat.ts";
import "../../src/index.css";

type ProjectBucket = Parameters<typeof ProjectRow>[0]["bucket"];
type ProjectDnd = Parameters<typeof ProjectRow>[0]["dnd"];

interface ProofEvent {
	kind: string;
	payload: object;
}

const PROJECT_PATH = "/workspace/project-alpha";
const SPACE_STORAGE_KEY = "proof:spaces";
const SPACE_ICON_STORAGE_KEY = "proof:space-icons";
const PROOF_NODE: Node = {
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
function readSpaces(): Space[] {
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

function proofConversation(id: string, title: string): Conversation {
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

const DOCUMENTS = {
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
	const json = <FixturePayload,>(value: FixturePayload, status = 200) =>
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

function Story() {
	const [queryClient] = useState(
		() =>
			new QueryClient({
				defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
			})
	);
	const [events, setEvents] = useState<ProofEvent[]>([]);
	const [spaces, setSpaces] = useState(readSpaces);
	const [documentReads, setDocumentReads] = useState<Record<string, number>>(
		{}
	);
	const readsRef = useRef<Record<string, number>>({});
	const [spaceDeleteStatus, setSpaceDeleteStatus] = useState(
		"No space deletion requested"
	);
	const [spaceIconStatus, setSpaceIconStatus] = useState(
		"No space icon change"
	);
	const [pendingDelete, setPendingDelete] = useState<Space | null>(null);
	const [deletingSpace, setDeletingSpace] = useState(false);
	const [pendingVisibility, setPendingVisibility] =
		useState<VisibilityChangeRequest | null>(null);
	const [changingVisibility, setChangingVisibility] = useState(false);
	const [projectCollapsed, setProjectCollapsed] = useState(true);
	const [projectConversations, setProjectConversations] = useState(() => {
		const deleted = new Set(
			JSON.parse(localStorage.getItem("proof:deleted-project-chats") ?? "[]")
		);
		return [
			proofConversation("project-chat-1", "Ship release notes"),
			proofConversation("project-chat-2", "Review onboarding flow"),
		].filter((conversation) => !deleted.has(conversation.id));
	});
	const [deletedConversations, setDeletedConversations] = useState<string[]>(
		() =>
			z
				.array(z.string())
				.parse(
					JSON.parse(
						localStorage.getItem("proof:deleted-project-chats") ?? "[]"
					)
				)
	);
	const deletedConversationIds = useRef(new Set(deletedConversations));
	const [projectRemoved, setProjectRemoved] = useState(() =>
		useWorkspaceStore.getState().removedProjects.includes(PROJECT_PATH)
	);
	const activeFolder = useWorkspaceStore((state) => state.folder);
	const projectLabel = useWorkspaceStore(
		(state) => state.projectNames[PROJECT_PATH]
	);
	const projectIcon = useWorkspaceStore(
		(state) => state.projectIcons[PROJECT_PATH]
	);
	const record = useCallback(
		<Payload extends object>(kind: string, payload: Payload) => {
			setEvents((current) => [...current, { kind, payload }]);
		},
		[]
	);
	const openTab = useCallback<
		NonNullable<ContextType<typeof TabsContext>>["openTab"]
	>(
		(path, options) => {
			record("tab", {
				path,
				title: options?.title,
				forceNew: options?.forceNew ?? false,
			});
			return "entity-row-proof-tab";
		},
		[record]
	);
	const updateTabsIconWhere = useCallback<
		NonNullable<ContextType<typeof TabsContext>>["updateTabsIconWhere"]
	>(
		(predicate, icon) => {
			record("tab-icon-update", {
				icon,
				matches: predicate({
					id: "entity-row-proof-tab",
					path: "/spaces/space-research",
					title: "Research notes",
				}),
			});
		},
		[record]
	);
	const tabsContext = useMemo<NonNullable<ContextType<typeof TabsContext>>>(
		() => ({
			activateTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: activateTab");
			},
			activeTabId: "entity-row-proof-tab",
			addTabToGroup: () => {
				throw new Error("Unexpected entity-row Tabs operation: addTabToGroup");
			},
			addTabToSplit: () => {
				throw new Error("Unexpected entity-row Tabs operation: addTabToSplit");
			},
			applySplitPreset: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: applySplitPreset"
				);
			},
			applySplitPresetToNewTabs: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: applySplitPresetToNewTabs"
				);
			},
			bindTabConversation: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: bindTabConversation"
				);
			},
			canGoBack: false,
			canGoForward: false,
			clearScrollToMessage: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: clearScrollToMessage"
				);
			},
			closeGroup: () => {
				throw new Error("Unexpected entity-row Tabs operation: closeGroup");
			},
			closeTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: closeTab");
			},
			createGroup: () => {
				throw new Error("Unexpected entity-row Tabs operation: createGroup");
			},
			equalizeSplit: () => {
				throw new Error("Unexpected entity-row Tabs operation: equalizeSplit");
			},
			focusTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: focusTab");
			},
			goBack: () => {
				throw new Error("Unexpected entity-row Tabs operation: goBack");
			},
			goForward: () => {
				throw new Error("Unexpected entity-row Tabs operation: goForward");
			},
			groups: [],
			hasClosedTabs: false,
			moveTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: moveTab");
			},
			openTab,
			prepareTabForWorkbenchSplit: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: prepareTabForWorkbenchSplit"
				);
			},
			removeFromSplit: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: removeFromSplit"
				);
			},
			removeTabFromGroup: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: removeTabFromGroup"
				);
			},
			renameGroup: () => {
				throw new Error("Unexpected entity-row Tabs operation: renameGroup");
			},
			renameSplit: () => {
				throw new Error("Unexpected entity-row Tabs operation: renameSplit");
			},
			replacePaneTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: replacePaneTab");
			},
			requestScrollToMessage: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: requestScrollToMessage"
				);
			},
			restoreTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: restoreTab");
			},
			setGroupColor: () => {
				throw new Error("Unexpected entity-row Tabs operation: setGroupColor");
			},
			setSplitColor: () => {
				throw new Error("Unexpected entity-row Tabs operation: setSplitColor");
			},
			setSplitOrientation: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: setSplitOrientation"
				);
			},
			setSplitSizes: () => {
				throw new Error("Unexpected entity-row Tabs operation: setSplitSizes");
			},
			setTabRoute: () => {
				throw new Error("Unexpected entity-row Tabs operation: setTabRoute");
			},
			splitPane: () => {
				throw new Error("Unexpected entity-row Tabs operation: splitPane");
			},
			splits: [],
			splitTabs: () => {
				throw new Error("Unexpected entity-row Tabs operation: splitTabs");
			},
			swapSplitPanes: () => {
				throw new Error("Unexpected entity-row Tabs operation: swapSplitPanes");
			},
			tabs: [
				{
					id: "entity-row-proof-tab",
					path: "/spaces/space-research",
					title: "Research notes",
				},
			],
			toggleGroupCollapsed: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: toggleGroupCollapsed"
				);
			},
			togglePin: () => {
				throw new Error("Unexpected entity-row Tabs operation: togglePin");
			},
			toggleSplitCollapsed: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: toggleSplitCollapsed"
				);
			},
			ungroup: () => {
				throw new Error("Unexpected entity-row Tabs operation: ungroup");
			},
			unloadTab: () => {
				throw new Error("Unexpected entity-row Tabs operation: unloadTab");
			},
			unsplit: () => {
				throw new Error("Unexpected entity-row Tabs operation: unsplit");
			},
			updateTabBusy: () => {
				throw new Error("Unexpected entity-row Tabs operation: updateTabBusy");
			},
			updateTabIcon: () => {
				throw new Error("Unexpected entity-row Tabs operation: updateTabIcon");
			},
			updateTabsIconWhere,
			updateTabTitle: () => {
				throw new Error("Unexpected entity-row Tabs operation: updateTabTitle");
			},
			updateTabWorkspaceSession: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: updateTabWorkspaceSession"
				);
			},
			updateTabWorktreeMode: () => {
				throw new Error(
					"Unexpected entity-row Tabs operation: updateTabWorktreeMode"
				);
			},
		}),
		[openTab, updateTabsIconWhere]
	);
	const documentList = useCallback(async (spaceId: string) => {
		const attempt = (readsRef.current[spaceId] ?? 0) + 1;
		readsRef.current = { ...readsRef.current, [spaceId]: attempt };
		setDocumentReads({ ...readsRef.current });
		if (
			spaceId === "space-research" &&
			attempt === 1 &&
			localStorage.getItem("proof:fail-document-read-once") === "true"
		) {
			localStorage.removeItem("proof:fail-document-read-once");
			throw new Error("fixture document read failed");
		}
		return Object.entries(DOCUMENTS).find(([id]) => id === spaceId)?.[1] ?? [];
	}, []);
	const renameSpace = useCallback(
		async (spaceId: string, name: string) => {
			if (localStorage.getItem("proof:fail-space-rename-once") === "true") {
				localStorage.removeItem("proof:fail-space-rename-once");
				throw new Error("Space name conflict");
			}
			const next = spaces.map((space) =>
				space.id === spaceId ? { ...space, name } : space
			);
			setSpaces(next);
			localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(next));
			record("space-rename", { id: spaceId, name });
		},
		[record, spaces]
	);
	const setSpaceIcon = useCallback(
		async (spaceId: string, icon: GlyphValue) => {
			if (localStorage.getItem("proof:fail-space-icon-once") === "true") {
				localStorage.removeItem("proof:fail-space-icon-once");
				setSpaceIconStatus("icon save failed");
				throw new Error("fixture space icon write failed");
			}
			const current = z
				.record(
					z.string(),
					z.json().transform((value) => asGlyphValue(value) ?? null)
				)
				.parse(
					JSON.parse(localStorage.getItem(SPACE_ICON_STORAGE_KEY) ?? "{}")
				);
			const next = { ...current, [spaceId]: icon };
			localStorage.setItem(SPACE_ICON_STORAGE_KEY, JSON.stringify(next));
			setSpaceIconStatus(
				`icon saved: ${icon?.kind === "icon" ? icon.id : "custom"}`
			);
			setSpaces((previous) => {
				const updated = previous.map((space) =>
					space.id === spaceId ? { ...space, icon } : space
				);
				localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(updated));
				return updated;
			});
			record("space-icon", { icon, spaceId });
		},
		[record]
	);
	const setDocumentIcon = useCallback(
		async (spaceId: string, documentId: string, icon: GlyphValue) => {
			record("document-icon", { documentId, icon, spaceId });
		},
		[record]
	);
	const requestSpaceDelete = useCallback(
		(space: Space) => {
			setPendingDelete(space);
			setSpaceDeleteStatus(`Delete requested for ${space.id}`);
			record("space-delete-request", { id: space.id, name: space.name });
		},
		[record]
	);
	const confirmSpaceDelete = useCallback(async () => {
		if (!pendingDelete) {
			return false;
		}
		setDeletingSpace(true);
		if (localStorage.getItem("proof:fail-space-delete-once") === "true") {
			localStorage.removeItem("proof:fail-space-delete-once");
			setSpaceDeleteStatus("Delete failed; space retained");
			setDeletingSpace(false);
			return false;
		}
		const next = spaces.filter((space) => space.id !== pendingDelete.id);
		setSpaces(next);
		localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(next));
		setSpaceDeleteStatus(`Deleted ${pendingDelete.id}`);
		record("space-delete", { id: pendingDelete.id });
		setPendingDelete(null);
		setDeletingSpace(false);
		return true;
	}, [pendingDelete, record, spaces]);
	const confirmVisibility = useCallback(async () => {
		if (!pendingVisibility) {
			return;
		}
		setChangingVisibility(true);
		const next = spaces.map<Space>((space) =>
			space.id === pendingVisibility.id
				? {
						...space,
						visibility: pendingVisibility.to === "team" ? "org" : "private",
					}
				: space
		);
		setSpaces(next);
		localStorage.setItem(SPACE_STORAGE_KEY, JSON.stringify(next));
		record("space-visibility", pendingVisibility);
		setChangingVisibility(false);
		setPendingVisibility(null);
	}, [pendingVisibility, record, spaces]);
	const projectDnd = useMemo<ProjectDnd>(
		() => ({
			draggingKey: null,
			dragOverKey: null,
			onDragEnd: () => undefined,
			onDragOver: () => undefined,
			onDragStart: () => undefined,
			onDrop: () => undefined,
			order: [PROJECT_PATH, "/workspace/empty-project"],
		}),
		[]
	);
	const projectHandlers = useMemo<ChatRowHandlers>(
		() => ({
			activeConversationId: null,
			agents: [],
			archivedIds: new Set<string>(),
			canMakePrivate: true,
			loadMessages: async () => [],
			onAddScheduledTask: () => undefined,
			onDeleteConversation: (id) => {
				const nextIds = new Set(deletedConversationIds.current);
				nextIds.add(id);
				deletedConversationIds.current = nextIds;
				const next = [...nextIds];
				setDeletedConversations(next);
				setProjectConversations((current) =>
					current.filter((item) => item.id !== id)
				);
				localStorage.setItem(
					"proof:deleted-project-chats",
					JSON.stringify(next)
				);
				record("delete-conversation", { id });
			},
			onForkConversation: () => undefined,
			onJumpToMessage: () => undefined,
			onMarkRead: () => undefined,
			onMarkUnread: () => undefined,
			onOpenInNewTab: () => undefined,
			onOpenInNewWindow: () => undefined,
			onOpenNewSideChat: () => undefined,
			onOpenQuickReply: () => undefined,
			onOpenSideChat: () => undefined,
			onMoveToProject: () => undefined,
			onRemoveFromProject: () => undefined,
			onRenameConversation: () => undefined,
			onRequestConversationVisibility: () => undefined,
			onSelectConversation: () => undefined,
			onSetConversationIcon: () => undefined,
			onToggleArchive: () => undefined,
			onTogglePin: () => undefined,
			pinnedIds: new Set<string>(),
			projectTargets: [],
			projectNameForFolder: (folderPath) =>
				folderPath.split("/").at(-1) ?? folderPath,
			target: { token: PROOF_NODE.token, url: PROOF_NODE.url },
			unreadIds: new Set<string>(),
		}),
		[deletedConversations, record]
	);
	const workspace = useWorkspaceStore.getState();
	const projectBucket: ProjectBucket = {
		conversations: projectConversations,
		name: "Alpha",
		path: PROJECT_PATH,
		sourceFolders: [PROJECT_PATH],
	};
	const removedProject =
		projectRemoved || workspace.removedProjects.includes(PROJECT_PATH);
	const recordNewChat = useCallback(
		(path: string) => {
			record("new-chat", { path });
			void useWorkspaceStore
				.getState()
				.setFolder(path)
				.then(() => {
					record("new-chat-folder-activated", { path });
				});
		},
		[record]
	);
	const setActiveProject = useCallback(
		(path: string) => {
			void useWorkspaceStore
				.getState()
				.setFolder(path)
				.then(() => {
					record("set-active-project", { path });
				});
		},
		[record]
	);
	const removeProject = useCallback(
		(path: string) => {
			useWorkspaceStore.getState().removeProject(path);
			setProjectRemoved(true);
			record("remove-project", { path });
		},
		[record]
	);
	const projectDndState = useMemo(
		() => ({
			collapsed: projectCollapsed,
			toggle: () => setProjectCollapsed((value) => !value),
		}),
		[projectCollapsed]
	);
	const projectRow = removedProject ? (
		<p className="rounded-lg border border-border/60 p-3 text-muted-foreground text-sm">
			Project removed from app
		</p>
	) : (
		<div
			className="rounded-lg border border-border/60 bg-background p-2"
			data-testid="project-row-alpha"
		>
			<ProjectRow
				bucket={projectBucket}
				collapsed={projectCollapsed}
				dnd={projectDnd}
				handlers={projectHandlers}
				onNewChat={recordNewChat}
				onRemove={removeProject}
				onSetActive={setActiveProject}
				onToggleCollapsed={(key) => {
					record("project-collapse", { key });
					projectDndState.toggle();
				}}
			/>
		</div>
	);
	const emptyProjectBucket: ProjectBucket = {
		conversations: [],
		name: "Empty project",
		path: "/workspace/empty-project",
		sourceFolders: ["/workspace/empty-project"],
	};
	const emptyProjectRow = (
		<div
			className="rounded-lg border border-border/60 bg-background p-2"
			data-testid="project-row-empty"
		>
			<ProjectRow
				bucket={emptyProjectBucket}
				collapsed
				dnd={{ ...projectDnd, order: ["/workspace/empty-project"] }}
				handlers={projectHandlers}
				onNewChat={recordNewChat}
				onRemove={removeProject}
				onSetActive={setActiveProject}
				onToggleCollapsed={() => undefined}
			/>
		</div>
	);
	const tabsProvider = (
		<TabsContext.Provider value={tabsContext}>
			<main className="min-h-screen bg-background p-6 text-foreground">
				<div className="mx-auto grid max-w-[1040px] gap-4 lg:grid-cols-2">
					<section
						className="space-y-3 rounded-xl border border-border/60 bg-sidebar p-4"
						data-testid="project-surface"
					>
						<header>
							<h1 className="font-semibold text-sm">Projects</h1>
							<p className="text-muted-foreground text-xs">
								Folder actions and conversations
							</p>
						</header>
						{projectRow}
						{emptyProjectRow}
						<div className="rounded-lg border border-border/40 p-2 text-muted-foreground text-xs">
							Active folder: {activeFolder ?? "none"}
							<br />
							Project label: {projectLabel ?? "Alpha"}
							<br />
							Project icon:{" "}
							{projectIcon?.kind === "icon" ? projectIcon.id : "default"}
						</div>
					</section>
					<section
						className="space-y-3 rounded-xl border border-border/60 bg-sidebar p-4"
						data-testid="space-surface"
					>
						<header>
							<h2 className="font-semibold text-sm">Spaces</h2>
							<p className="text-muted-foreground text-xs">
								Page collections and share scope
							</p>
						</header>
						{spaces.map((space) => {
							const suffix = space.id.replace(/^space-/, "");
							return (
								<div
									className="rounded-lg border border-border/50 bg-background p-2"
									data-testid={`space-row-${suffix}`}
									key={space.id}
								>
									<SpaceSidebarRow
										canDelete={space.id !== "space-locked"}
										canMakePrivate={space.id !== "space-team"}
										listDocuments={documentList}
										onAdd={() => record("space-add", { spaceId: space.id })}
										onOpen={() =>
											record("space-page", {
												forceNew: false,
												path: `/spaces/${space.id}`,
											})
										}
										onOpenDoc={(doc, forceNew = false) =>
											record("space-document", {
												forceNew,
												path: `/spaces/${doc.spaceId}/${doc.rawKind === "file" ? "file" : doc.kind === "database" ? "db" : "doc"}/${doc.id}`,
											})
										}
										onOpenDocInNewWindow={(doc) =>
											record("space-document-window", {
												path: `/spaces/${doc.spaceId}/${doc.rawKind === "file" ? "file" : doc.kind === "database" ? "db" : "doc"}/${doc.id}`,
											})
										}
										onOpenInNewTab={() =>
											record("space-page", {
												forceNew: true,
												path: `/spaces/${space.id}`,
											})
										}
										onOpenInNewWindow={() =>
											record("space-window", {
												path: `/spaces/${space.id}`,
												title: space.name,
											})
										}
										onRename={(name) => renameSpace(space.id, name)}
										onRequestDelete={() => requestSpaceDelete(space)}
										onRequestVisibilityChange={setPendingVisibility}
										setDocumentIcon={setDocumentIcon}
										setSpaceIcon={setSpaceIcon}
										space={space}
									/>
								</div>
							);
						})}
						<div className="rounded-lg border border-border/40 p-2 text-muted-foreground text-xs">
							Document reads: {JSON.stringify(documentReads)}
							<br />
							Add target:{" "}
							{events.filter((event) => event.kind === "space-add").at(-1)
								?.payload &&
								JSON.stringify(
									events.filter((event) => event.kind === "space-add").at(-1)
										?.payload
								)}
							<br />
							Delete: {spaceDeleteStatus}
							<br />
							Icon: {spaceIconStatus}
						</div>
					</section>
				</div>
				<div
					className="mx-auto mt-4 max-w-[1040px] rounded-lg border border-border/60 border-dashed px-4 py-3 text-muted-foreground text-xs"
					data-testid="visibility-drop-target"
					onDragOver={(event) => event.preventDefault()}
					onDrop={(event) => {
						event.preventDefault();
						const transfer = event.dataTransfer;
						document.documentElement.dataset.spaceVisibilityDrag =
							JSON.stringify({
								effectAllowed: transfer.effectAllowed,
								marker: transfer.getData(
									"application/x-ryu-resource-visibility-space"
								),
								payload: transfer.getData(
									"application/x-ryu-resource-visibility"
								),
								text: transfer.getData("text/plain"),
							});
					}}
				>
					Drop zone for checking the space visibility payload
				</div>
				<output className="sr-only" data-testid="navigation-events">
					{JSON.stringify(events)}
				</output>
				<output className="sr-only" data-testid="document-reads">
					{JSON.stringify(documentReads)}
				</output>
				<output className="sr-only" data-testid="space-delete-status">
					{spaceDeleteStatus}
				</output>
				<output className="sr-only" data-testid="space-icon-status">
					{spaceIconStatus}
				</output>
				<output className="sr-only" data-testid="active-folder">
					{activeFolder ?? "none"}
				</output>
				<output className="sr-only" data-testid="project-label">
					{projectLabel ?? "Alpha"}
				</output>
				<output className="sr-only" data-testid="project-removed">
					{String(removedProject)}
				</output>
				<output className="sr-only" data-testid="project-expanded">
					{String(!projectCollapsed)}
				</output>
				<output className="sr-only" data-testid="deleted-conversations">
					{JSON.stringify(deletedConversations)}
				</output>
				{spaces.map((space) => (
					<Fragment key={space.id}>
						<output className="sr-only" data-testid={`space-name-${space.id}`}>
							{space.name}
						</output>
						<output
							className="sr-only"
							data-testid={`space-visibility-${space.id}`}
						>
							{space.visibility ?? "private"}
						</output>
					</Fragment>
				))}
				{pendingDelete ? (
					<DestructiveConfirmDialog
						busy={deletingSpace}
						description={`"${pendingDelete.name}" and all its documents will be permanently deleted. This can't be undone.`}
						label={`Delete ${pendingDelete.name}`}
						onConfirm={confirmSpaceDelete}
						onOpenChange={(open) => {
							if (!(open || deletingSpace)) {
								setPendingDelete(null);
							}
						}}
						open
						title="Delete this Space?"
					/>
				) : null}
				<ResourceVisibilityConfirmationDialog
					canMakePrivate
					changing={changingVisibility}
					onConfirm={() => {
						void confirmVisibility();
					}}
					onOpenChange={(open) => {
						if (!(open || changingVisibility)) {
							setPendingVisibility(null);
						}
					}}
					request={pendingVisibility}
				/>
			</main>
		</TabsContext.Provider>
	);

	return (
		<QueryClientProvider client={queryClient}>
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				enableSystem={false}
				forcedTheme="dark"
			>
				<AppSurfaceProvider surface="desktop">
					{tabsProvider}
				</AppSurfaceProvider>
			</ThemeProvider>
		</QueryClientProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
