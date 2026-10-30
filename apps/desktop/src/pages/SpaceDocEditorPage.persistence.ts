import { toast } from "@ryu/ui/components/sileo.tsx";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { MarkdownCollab } from "@/src/components/editor/MarkdownEditor.tsx";
import { useTabTitleSync } from "@/src/components/layout/tab-rename.tsx";
import type { VersionSource } from "@/src/components/versioning/VersionHistory.tsx";
import {
	managedDelegationFor,
	mayAttachAccountJwt,
} from "@/src/lib/api/client.ts";
import {
	createDocumentVersion,
	getDocumentVersion,
	listDocumentVersions,
	restoreDocumentVersion,
} from "@/src/lib/api/spaces.ts";
import type { useSpaceDocEditorDocument } from "./SpaceDocEditorPage.document.ts";
import { SAVE_DEBOUNCE_MS } from "./SpaceDocEditorPage.model.ts";

type SpaceDocEditorPersistenceInput = Pick<
	ReturnType<typeof useSpaceDocEditorDocument>,
	| "collabReady"
	| "cursorUser"
	| "doc"
	| "getDocument"
	| "handleRemoteReset"
	| "handleSyncedChange"
	| "jwt"
	| "markdownRef"
	| "nodeToken"
	| "nodeUrl"
	| "nodeUserJwt"
	| "saveDocument"
	| "setDoc"
	| "setReloadNonce"
	| "setSaveState"
	| "setTitle"
	| "tabId"
	| "timerRef"
	| "titleRef"
	| "updateTabTitle"
> & { documentId: string; spaceId: string };

/** Collaboration wiring, debounced autosave, tab title sync, and version restore. */
export function useSpaceDocEditorPersistence({
	collabReady,
	cursorUser,
	doc,
	documentId,
	getDocument,
	handleRemoteReset,
	handleSyncedChange,
	jwt,
	markdownRef,
	nodeToken,
	nodeUrl,
	nodeUserJwt,
	saveDocument,
	setDoc,
	setReloadNonce,
	setSaveState,
	setTitle,
	spaceId,
	tabId,
	timerRef,
	titleRef,
	updateTabTitle,
}: SpaceDocEditorPersistenceInput) {
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
	return {
		collab,
		handleMarkdownChange,
		handleRestored,
		handleTitleChange,
		versionSource,
	};
}
