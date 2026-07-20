import { LibraryIcon, WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type MarkdownCollab,
	MarkdownEditor,
} from "@/src/components/editor/MarkdownEditor.tsx";
import { BacklinksPanel } from "@/src/components/spaces/BacklinksPanel.tsx";
import {
	VersionHistory,
	type VersionSource,
} from "@/src/components/versioning/VersionHistory.tsx";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabsContext,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import { useRegisterDocLinks } from "@/src/hooks/useRegisterDocLinks.ts";
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

const SAVE_LABEL: Record<SaveState, string> = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Saved on this device",
};

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
	const { getDocument, saveDocument } = useSpacesContext();
	const { updateTabTitle, openTab } = useTabsContext();
	const tabId = useCurrentTabId();
	const node = useActiveNode();
	const nodeUrl = node.url;
	const nodeToken = node.token ?? null;
	const oidcUser = useAppStore((s) => s.oidcUser);

	// Wire `[[wikilinks]]` / `@mentions` in this Space's editor to real documents.
	useRegisterDocLinks(spaceId);

	const [doc, setDoc] = useState<SpaceDocumentContent | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
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
			})
			.catch(() => {
				if (!cancelled) {
					setLoadFailed(true);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [getDocument, spaceId, documentId]);

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
		return { color: cursorColorFor(seed), name };
	}, [oidcUser]);

	// Flip the persistence model when the room becomes (or stops being) live.
	const handleSyncedChange = useCallback((synced: boolean) => {
		collaborativeRef.current = synced;
		setCollaborative(synced);
	}, []);

	const collab = useMemo<MarkdownCollab | undefined>(() => {
		if (!(collabReady && doc)) {
			return;
		}
		return {
			documentId,
			jwt,
			onSyncedChange: handleSyncedChange,
			target: { token: nodeToken, url: nodeUrl },
			user: cursorUser,
		};
	}, [
		collabReady,
		doc,
		documentId,
		jwt,
		nodeToken,
		nodeUrl,
		cursorUser,
		handleSyncedChange,
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
			// fallback) writes a CRDT-consistent snapshot. Once collaborative, the
			// CRDT persists the body in Core, so the markdown PUT is skipped.
			markdownRef.current = markdown;
			if (!collaborativeRef.current) {
				scheduleSave();
			}
		},
		[scheduleSave]
	);

	// Server-backed page version history (snapshot / diff / restore).
	const versionSource = useMemo<VersionSource>(() => {
		const target = { token: nodeToken, url: nodeUrl };
		return {
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
				await createDocumentVersion(target, spaceId, documentId, label);
			},
			restore: (versionId) =>
				restoreDocumentVersion(target, spaceId, documentId, versionId),
		};
	}, [nodeToken, nodeUrl, spaceId, documentId, flush]);

	// After a restore, re-fetch the document and re-mount the editor so the
	// restored content is shown (the flush timer is cleared to avoid clobbering it
	// with a stale in-flight draft).
	const handleRestored = useCallback(async () => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		try {
			const restored = await getDocument(spaceId, documentId);
			setDoc(restored);
			setTitle(restored.title);
			titleRef.current = restored.title;
			markdownRef.current = restored.source;
			setReloadNonce((n) => n + 1);
			setSaveState("saved");
			toast.success("Version restored");
		} catch {
			toast.error("Restored on the server, but couldn't reload the page");
		}
	}, [getDocument, spaceId, documentId]);

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
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<Input
					aria-label="Page title"
					className="h-8 border-none bg-transparent px-0 font-medium text-base shadow-none focus-visible:ring-0"
					onChange={(e) => handleTitleChange(e.target.value)}
					placeholder="Untitled"
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
					<HugeiconsIcon className="size-4" icon={WorkflowSquare01Icon} />
					Graph
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<MarkdownEditor
					collab={collab}
					initialMarkdown={doc.source}
					key={`${documentId}:${reloadNonce}`}
					onChangeMarkdown={handleMarkdownChange}
				/>
			</div>
			<BacklinksPanel documentId={documentId} spaceId={spaceId} />
		</div>
	);
}
