import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSpacesContext } from "@/src/contexts/SpacesContext.tsx";
import {
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import { useRegisterDocLinks } from "@/src/hooks/useRegisterDocLinks.ts";
import type { SpaceDocumentContent } from "@/src/lib/api/spaces.ts";
import { getRealtimeJwt } from "@/src/lib/realtime/jwt.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";
import {
	ASSISTANT_CONTEXT_CAP,
	cursorColorFor,
	type SaveState,
} from "./SpaceDocEditorPage.model.ts";

interface SpaceDocEditorDocumentInput {
	documentId: string;
	spaceId: string;
}

/** Document loading, collaboration readiness, and assistant context for a Space page. */
export function useSpaceDocEditorDocument({
	documentId,
	spaceId,
}: SpaceDocEditorDocumentInput) {
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
	return {
		collabReady,
		collaborative,
		cursorUser,
		doc,
		getDocument,
		handleRemoteReset,
		handleSyncedChange,
		iconDialogOpen,
		jwt,
		loadFailed,
		markdownRef,
		nodeToken,
		nodeUrl,
		nodeUserJwt,
		openTab,
		reloadNonce,
		saveDocument,
		saveState,
		setDoc,
		setDocumentIcon,
		setIconDialogOpen,
		setReloadNonce,
		setSaveState,
		setTitle,
		tabId,
		timerRef,
		title,
		titleRef,
		updateTabTitle,
		updateTabsIconWhere,
	};
}
