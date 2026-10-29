import { LibraryIcon, WorkflowCircle06Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import { GlyphDisplay } from "@ryu/ui/components/glyph-display.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type MarkdownCollab,
	MarkdownEditor,
} from "@/src/components/editor/MarkdownEditor.tsx";
import { EntityIconDialog } from "@/src/components/layout/EntityIconDialog.tsx";
import { useTabTitleSync } from "@/src/components/layout/tab-rename.tsx";
import { BacklinksPanel } from "@/src/components/spaces/BacklinksPanel.tsx";
import {
	VersionHistory,
	type VersionSource,
} from "@/src/components/versioning/VersionHistory.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import { useRegisterDocLinks } from "@/src/hooks/useRegisterDocLinks.ts";
import {
	managedDelegationFor,
	mayAttachAccountJwt,
} from "@/src/lib/api/client.ts";
import {
	createDocumentVersion,
	getDocumentVersion,
	listDocumentVersions,
	restoreDocumentVersion,
	type SpaceDocumentContent,
} from "@/src/lib/api/spaces.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";

const SAVE_DEBOUNCE_MS = 800;

/** Cap on page-context text shipped to the assistant's first message. */
const ASSISTANT_CONTEXT_CAP = 4000;

/** Distinct, readable caret colors assigned to collaborators by a stable hash of
 * their identity, so the same person keeps the same color across sessions. */
const CURSOR_COLORS = [
	"#ef4444",
	"#f59e0b",
	"#10b981",
	"#3b82f6",
	"#8b5cf6",
	"#ec4899",
	"#14b8a6",
	"#f97316",
] as const;

/** Pick a deterministic caret color for an identity seed (email / name). */
const HASH_MODULUS = 2_147_483_647;
function cursorColorFor(seed: string): string {
	let hash = 0;
	for (let i = 0; i < seed.length; i += 1) {
		hash = (hash * 31 + seed.charCodeAt(i)) % HASH_MODULUS;
	}
	return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_LABEL = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Saved on this device",
} satisfies Record<SaveState, string>;

/**
 * A Notion-style page editor: loads a Space document's Markdown, edits it in the
 * full Plate editor, and autosaves (debounced) back to Core, which re-chunks and
 * re-embeds on every save. One tab per document.
 */
export default function SpaceDocEditorPage({
	spaceId,
	documentId,
}: {
	spaceId: string;
	documentId: string;
}) {
	const { getDocument, saveDocument, setDocumentIcon } = useSpacesContext();
	const updateTabTitle = useTabSelector((state) => state.updateTabTitle);
	const updateTabsIconWhere = useTabSelector(
		(state) => state.updateTabsIconWhere
	);
	const openTab = useTabSelector((state) => state.openTab);
	const tabId = useCurrentTabId();
	const node = useActiveNode();
	const nodeUrl = node.url;
	const nodeToken = node.token ?? null;
	const nodeUserJwt = node.userJwt ?? null;
	const oidcUser = useAppStore((s) => s.oidcUser);

	// Wire `[[wikilinks]]` / `@mentions` in this Space's editor to real documents.
	useRegisterDocLinks(spaceId);

	const [doc, setDoc] = useState<SpaceDocumentContent | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [iconDialogOpen, setIconDialogOpen] = useState(false);
	// Bumped by the Retry button and by a version restore to force the editor to
	// re-mount with fresh content (Plate deserializes `initialMarkdown` once).
	const [reloadNonce, setReloadNonce] = useState(0);
	const [title, setTitle] = useState("");
	const [saveState, setSaveState] = useState<SaveState>("idle");
	// `collaborative` flips true once the CRDT room finishes its first sync; from
	// then on the CRDT owns the body and the markdown PUT is a no-op fallback.
	const [collaborative, setCollaborative] = useState(false);
	// The realtime JWT must be resolved before the editor mounts, because the Yjs
	// provider is constructed synchronously with the editor (it cannot be swapped
	// in later). `null` is a valid value (anonymous, read-only join).
	const [jwt, setJwt] = useState<string | null>(null);
	const [collabReady, setCollabReady] = useState(false);

	// Latest unsaved values, read inside the debounced flush without re-arming it.
	const titleRef = useRef("");
	const markdownRef = useRef("");
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const collaborativeRef = useRef(false);

	useEffect(() => {
		let cancelled = false;
		setLoadFailed(false);
		getDocument(spaceId, documentId)
			.then((d) => {
				if (cancelled) {
					return;
				}
				setDoc(d);
				setTitle(d.title);
				titleRef.current = d.title;
				markdownRef.current = d.source;
				if (d.icon !== undefined) {
					updateTabsIconWhere(
						(t) =>
							t.path === `/spaces/${spaceId}/doc/${documentId}` ||
							t.path === `/spaces/${spaceId}/db/${documentId}`,
						d.icon ?? null
					);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setLoadFailed(true);
				}
			});
		return () => {
			cancelled = true;
		};
		// `reloadNonce` is load-bearing: the "Try again" button on the load-failed
		// screen only bumps it. Without it here the effect never re-runs, so
		// `loadFailed` stays true and the retry can never clear the error screen.
		// Mirror of the same restore in SpaceDatabaseEditorPage — the two must
		// move together.
	}, [getDocument, spaceId, documentId, updateTabsIconWhere, reloadNonce]);

	// Offer this page as context to the global "Ask Ryu" assistant.
	useAssistantPageContext(
		useMemo(
			() => ({
				id: `doc:${documentId}`,
				title: title || "Untitled page",
				text: (doc?.source ?? "").slice(0, ASSISTANT_CONTEXT_CAP),
			}),
			[documentId, title, doc?.source]
		)
	);

	// Resolve the realtime JWT once so the collaborative editor can mount with a
	// stable provider. A failure still readies the editor (anonymous join).
	useEffect(() => {
		let cancelled = false;
		getRealtimeJwt()
			.then((token) => {
				if (!cancelled) {
					setJwt(token);
					setCollabReady(true);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setCollabReady(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// The local user's caret label + a stable color derived from their identity.
	const cursorUser = useMemo(() => {
		const name = oidcUser?.name || oidcUser?.email || "Anonymous";
		const seed = oidcUser?.email || oidcUser?.name || "anonymous";
		return {
			avatarUrl: oidcUser?.picture,
			color: cursorColorFor(seed),
			id: seed,
			name,
		};
	}, [oidcUser]);

	// Flip the persistence model when the room becomes (or stops being) live.
	const handleSyncedChange = useCallback((synced: boolean) => {
		collaborativeRef.current = synced;
		setCollaborative(synced);
	}, []);
	const handleRemoteReset = useCallback(async () => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		const restored = await getDocument(spaceId, documentId);
		setDoc(restored);
		setTitle(restored.title);
		titleRef.current = restored.title;
		markdownRef.current = restored.source;
		setReloadNonce((value) => value + 1);
		setSaveState("saved");
	}, [documentId, getDocument, spaceId]);

	const collab = useMemo<MarkdownCollab | undefined>(() => {
		if (!(collabReady && doc)) {
			return;
		}
		const target = { token: nodeToken, url: nodeUrl, userJwt: nodeUserJwt };
		return {
			documentId,
			// The account JWT only goes to a node with a token or managed
			// delegation, reached over HTTPS or on this machine. Otherwise keep
			// the node's own managed delegation rather than stripping it.
			jwt: mayAttachAccountJwt(target) ? jwt : managedDelegationFor(target),
			onReset: () => {
				void handleRemoteReset();
			},
			onSyncedChange: handleSyncedChange,
			target,
			user: cursorUser,
		};
	}, [
		collabReady,
		doc,
		documentId,
		jwt,
		nodeToken,
		nodeUrl,
		nodeUserJwt,
		cursorUser,
		handleSyncedChange,
		handleRemoteReset,
	]);

	const flush = useCallback(async () => {
		setSaveState("saving");
		try {
			await saveDocument(
				spaceId,
				documentId,
				titleRef.current,
				markdownRef.current
			);
			setSaveState("saved");
		} catch {
			// The text is saved on this device, but the server-side update failed —
			// surface it softly so edits aren't perceived as lost.
			setSaveState("error");
			toast.error("Saved on this device, but couldn't sync your changes", {
				description: "We'll keep trying as you edit. Your text is safe.",
			});
		}
	}, [saveDocument, spaceId, documentId]);

	const scheduleSave = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		setSaveState("saving");
		timerRef.current = setTimeout(() => {
			flush().catch(() => undefined);
		}, SAVE_DEBOUNCE_MS);
	}, [flush]);

	// Flush a pending save when the tab unmounts (closed / unloaded / switched away
	// long enough to be reaped) so in-flight edits are never dropped.
	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				flush().catch(() => undefined);
			}
		},
		[flush]
	);

	const handleTitleChange = useCallback(
		(next: string) => {
			setTitle(next);
			titleRef.current = next;
			if (tabId) {
				updateTabTitle(tabId, next || "Untitled");
			}
			scheduleSave();
		},
		[scheduleSave, tabId, updateTabTitle]
	);

	const handleMarkdownChange = useCallback(
		(markdown: string) => {
			// Always track the latest body so the title save (and the offline
			// fallback) writes a CRDT-consistent projection for search, backlinks, and
			// version history. Yjs remains the merge authority; this is its readable
			// materialization.
			markdownRef.current = markdown;
			scheduleSave();
		},
		[scheduleSave]
	);

	// A strip double-click rename only rewrites `tab.title`; converge this
	// editor's own title (and persist it through the normal save path) so the
	// page header and the server document follow the strip.
	useTabTitleSync({
		ready: doc !== null,
		scheduleSave,
		setTitle,
		tabId,
		titleRef,
	});

	const documentVersionScope = useMemo(
		() => ({}),
		[nodeToken, nodeUrl, nodeUserJwt, spaceId, documentId]
	);
	const activeDocumentVersionScope = useRef(documentVersionScope);
	activeDocumentVersionScope.current = documentVersionScope;
	const documentVersionMounted = useRef(true);
	useEffect(() => {
		documentVersionMounted.current = true;
		return () => {
			documentVersionMounted.current = false;
		};
	}, []);

	// Server-backed page version history (snapshot / diff / restore).
	const versionSource = useMemo<
		VersionSource<Awaited<ReturnType<typeof restoreDocumentVersion>>, void>
	>(() => {
		const target = {
			token: nodeToken,
			url: nodeUrl,
			userJwt: nodeUserJwt,
		};
		return {
			scope: documentVersionScope,
			list: () =>
				listDocumentVersions(target, spaceId, documentId).then((vs) =>
					vs.map((v) => ({
						createdAt: v.createdAt,
						id: v.id,
						label: v.label,
						title: v.title,
					}))
				),
			getValue: (versionId) =>
				getDocumentVersion(target, spaceId, documentId, versionId),
			snapshot: async (label) => {
				// Persist any pending debounced edit first so the snapshot captures the
				// latest content rather than the last auto-saved state.
				if (timerRef.current) {
					clearTimeout(timerRef.current);
					timerRef.current = null;
				}
				await flush();
				if (
					!documentVersionMounted.current ||
					activeDocumentVersionScope.current !== documentVersionScope
				) {
					return;
				}
				await createDocumentVersion(target, spaceId, documentId, label);
			},
			restore: (versionId) =>
				restoreDocumentVersion(target, spaceId, documentId, versionId),
		};
	}, [
		nodeToken,
		nodeUrl,
		nodeUserJwt,
		spaceId,
		documentId,
		flush,
		documentVersionScope,
	]);

	// After a restore, re-fetch the document and re-mount the editor so the
	// restored content is shown (the flush timer is cleared to avoid clobbering it
	// with a stale in-flight draft).
	const handleRestored = useCallback(async () => {
		if (
			!documentVersionMounted.current ||
			activeDocumentVersionScope.current !== documentVersionScope
		) {
			return;
		}
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		try {
			const restored = await getDocument(spaceId, documentId);
			if (
				!documentVersionMounted.current ||
				activeDocumentVersionScope.current !== documentVersionScope
			) {
				return;
			}
			setDoc(restored);
			setTitle(restored.title);
			titleRef.current = restored.title;
			markdownRef.current = restored.source;
			setReloadNonce((n) => n + 1);
			setSaveState("saved");
			toast.success("Version restored");
		} catch {
			if (
				!documentVersionMounted.current ||
				activeDocumentVersionScope.current !== documentVersionScope
			) {
				return;
			}
			toast.error("Restored on the server, but couldn't reload the page");
		}
	}, [getDocument, spaceId, documentId, documentVersionScope]);

	if (loadFailed) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LibraryIcon} />
					</EmptyMedia>
					<EmptyTitle>Couldn't open this page</EmptyTitle>
					<EmptyDescription>
						Something went wrong while loading it. Check your connection and try
						again.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={() => setReloadNonce((n) => n + 1)}>
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	// Wait for both the document body and the realtime JWT before mounting the
	// editor, so it can be created collaboratively in one shot (the Yjs provider
	// is fixed at editor-creation time and cannot be attached afterwards).
	if (!(doc && collabReady)) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<button
					aria-label="Change page icon"
					className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={() => setIconDialogOpen(true)}
					title="Change icon…"
					type="button"
				>
					<GlyphDisplay
						fallback={<HugeiconsIcon className="size-4" icon={LibraryIcon} />}
						size={20}
						value={doc.icon}
					/>
				</button>
				<Input
					aria-label="Page title"
					onChange={(e) => handleTitleChange(e.target.value)}
					placeholder="Untitled"
					purpose="space-title"
					value={title}
				/>
				<span className="shrink-0 text-muted-foreground text-xs">
					{collaborative ? "Live" : SAVE_LABEL[saveState]}
				</span>
				<div className="shrink-0">
					<VersionHistory
						currentValue={markdownRef.current}
						onRestored={handleRestored}
						source={versionSource}
					/>
				</div>
				<Button
					className="shrink-0"
					onClick={() => openTab(`/spaces/${spaceId}/graph`)}
					size="sm"
					title="Open the knowledge graph for this space"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={WorkflowCircle06Icon} />
					Graph
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<MarkdownEditor
					collab={collab}
					initialMarkdown={doc.source}
					key={`${documentId}:${reloadNonce}`}
					onChangeMarkdown={handleMarkdownChange}
					toolbar="two-row"
				/>
			</div>
			<BacklinksPanel documentId={documentId} spaceId={spaceId} />
			<EntityIconDialog
				description={title || "Untitled"}
				onChange={(next: GlyphValue) => {
					setDoc((prev) => (prev ? { ...prev, icon: next } : prev));
					updateTabsIconWhere(
						(t) =>
							t.path === `/spaces/${spaceId}/doc/${documentId}` ||
							t.path === `/spaces/${spaceId}/db/${documentId}`,
						next
					);
					void setDocumentIcon(spaceId, documentId, next).catch(() => {
						toast.error("Couldn't update page icon");
					});
				}}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Page icon"
				value={doc.icon}
			/>
		</div>
	);
}
