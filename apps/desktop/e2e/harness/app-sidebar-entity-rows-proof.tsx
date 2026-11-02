import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { asGlyphValue } from "@ryu/ui/components/glyph.ts";
import { IDLE_REORDER_SHIFT } from "@ryu/ui/hooks/use-reorder-shift.tsx";
import { QueryClient } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { SpaceSidebarRow } from "../../src/components/layout/AppSidebar.tsx";
import { ResourceVisibilityConfirmationDialog } from "../../src/components/layout/ResourceVisibilityConfirmationDialog.tsx";
import type { ChatRowHandlers } from "../../src/components/layout/sidebar-conversation-rows.tsx";
import { ProjectRow } from "../../src/components/layout/sidebar-project-row.tsx";
import { DestructiveConfirmDialog } from "../../src/components/ui/DestructiveConfirmDialog.tsx";
import type { Space } from "../../src/lib/api/spaces.ts";
import type { VisibilityChangeRequest } from "../../src/lib/resource-visibility.ts";
import { useWorkspaceStore } from "../../src/store/useWorkspaceStore.ts";
import {
	DOCUMENTS,
	PROJECT_PATH,
	PROOF_NODE,
	proofConversation,
	readSpaces,
	SPACE_ICON_STORAGE_KEY,
	SPACE_STORAGE_KEY,
} from "./app-sidebar-entity-rows-fixtures.ts";
import {
	ShellProofProviders,
	type ShellTabsValue,
} from "./shell-proof-providers.tsx";
import "../../src/index.css";

type ProjectBucket = Parameters<typeof ProjectRow>[0]["bucket"];
type ProjectDnd = Parameters<typeof ProjectRow>[0]["dnd"];

interface ProofEvent {
	kind: string;
	payload: object;
}

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
	// The real Tabs value with the two operations the rows call recorded, then
	// delegated, so the proof sees each target the row asked to open.
	const observeTabs = useCallback(
		(value: ShellTabsValue): ShellTabsValue => ({
			...value,
			openTab: (path, options) => {
				record("tab", {
					path,
					title: options?.title,
					forceNew: options?.forceNew ?? false,
				});
				return value.openTab(path, options);
			},
			updateTabsIconWhere: (predicate, icon) => {
				record("tab-icon-update", { icon });
				value.updateTabsIconWhere(predicate, icon);
			},
		}),
		[record]
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
			nestOverKey: null,
			onDragEnd: () => undefined,
			onDragOver: () => undefined,
			onDragStart: () => undefined,
			onDrop: () => undefined,
			order: [PROJECT_PATH, "/workspace/empty-project"],
			shift: IDLE_REORDER_SHIFT,
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
	const surface = (
		<>
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
		</>
	);

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<ShellProofProviders
				chatHistory
				observeTabs={observeTabs}
				queryClient={queryClient}
				tabs
			>
				{surface}
			</ShellProofProviders>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
