// apps/desktop/src/components/layout/tab-rename.tsx
//
// Double-click inline rename for the tab strip's chips (horizontal TitleBar) and
// the vertical tab rows (sidebar Tabs section).
//
// Only tabs whose title is an entity the user can actually rename get the
// editor: a CHAT tab (`conversationId` set — the title is the conversation's,
// and the commit writes it through `renameConversation`, the same path the
// sidebar's inline rename uses) or a SPACE PAGE tab (a `/spaces/:id/{doc,db}/:id`
// or `/spaces/:id/app/:pluginId/:id` route — the title is the document's). A tab
// on a shell route (Settings, Library, the store) or a bare "/chat" with no
// thread yet has a route-derived title, so renaming it would be nonsense and the
// double-click does nothing.
//
// Persistence for a page tab is deliberately NOT duplicated here: the strip only
// rewrites `tab.title`; the open page editor (SpaceDocEditorPage /
// SpaceDatabaseEditorPage) converges its local title through `useTabTitleSync`
// and persists via its own debounced save path, so the server document and the
// strip can never disagree about the title (and no second write path exists).
// A chat tab is persisted here directly because the conversation API is the
// one-line existing seam.

import { cn } from "@ryu/ui/lib/utils.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { type Tab, useTabsContext } from "@/src/contexts/TabsContext.tsx";

/** A Space page's document address, derived from the tab's path. */
export interface SpaceDocumentRef {
	documentId: string;
	spaceId: string;
}

/**
 * The Space document a tab is showing, or `null` for any other tab.
 * `/spaces/:id/doc/:docId`, `/spaces/:id/db/:docId` and
 * `/spaces/:id/app/:pluginId/:docId` are all pages owned by a document; a row
 * detail (`/spaces/:id/db/:dbId/row/:rowId`) is a view inside a database, so
 * renaming it would rename the wrong thing and it is deliberately excluded.
 */
export function spaceDocumentRef(path: string): SpaceDocumentRef | null {
	const parts = path.split("?")[0].split("/").filter(Boolean);
	if (parts[0] !== "spaces") {
		return null;
	}
	const spaceId = parts[1];
	const kind = parts[2];
	// The app route's plugin id may itself contain slashes (`@ryu/canvas`), so its
	// document id is the LAST segment rather than a fixed index.
	const documentId =
		kind === "app"
			? parts.length >= 5
				? parts.at(-1)
				: undefined
			: kind === "doc" || kind === "db"
				? parts.length === 4
					? parts[3]
					: undefined
				: undefined;
	if (!(spaceId && documentId)) {
		return null;
	}
	return { documentId, spaceId };
}

/**
 * Whether double-clicking this tab should open the inline rename editor.
 * The two renamable families are the ones whose strip title is an entity name
 * the user owns — a conversation, or a Space page document. Everything else is
 * route-derived ("Settings", "Library", the store) and has nothing to rename.
 */
export function isRenamableTab(tab: Tab): boolean {
	return Boolean(tab.conversationId) || spaceDocumentRef(tab.path) !== null;
}

/**
 * Commit a strip rename: update the tab label immediately, and when the tab
 * shows a conversation, persist it through the same `renameConversation` seam
 * the sidebar's inline rename uses (optimistic local title + best-effort write,
 * which marks it user-chosen so auto-rename never overwrites it).
 *
 * A Space page tab is NOT handled here — its editor page persists through
 * `useTabTitleSync`, so this stays a two-line pure commit.
 */
export function commitTabRename(
	tab: Tab,
	title: string,
	updateTabTitle: (id: string, title: string) => void,
	renameConversation: (id: string, title: string) => void
): void {
	const next = title.trim();
	if (!next || next === tab.title) {
		return;
	}
	updateTabTitle(tab.id, next);
	if (tab.conversationId) {
		renameConversation(tab.conversationId, next);
	}
}

/**
 * Inline rename editor for a tab chip: a bare, ringed input replacing the label.
 * Commit on Enter/blur, cancel on Escape. Mouse/key events are stopped so the
 * surrounding chip's activate/middle-close/drag handlers don't fight the input.
 */
export function TabRenameInput({
	className,
	onCancel,
	onChange,
	onCommit,
	value,
}: {
	className?: string;
	onCancel: () => void;
	onChange: (value: string) => void;
	onCommit: () => void;
	value: string;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<input
			aria-label="Tab name"
			className={cn(
				"min-w-0 flex-1 rounded-sm bg-transparent font-medium outline-none ring-1 ring-primary/40 focus:ring-primary",
				className
			)}
			onBlur={onCommit}
			onChange={(e) => onChange(e.target.value)}
			onDoubleClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Enter") {
					onCommit();
				} else if (e.key === "Escape") {
					onCancel();
				}
			}}
			onMouseDown={(e) => e.stopPropagation()}
			ref={ref}
			value={value}
		/>
	);
}

/**
 * The double-click rename state machine for one tab chip/row, shared by the
 * horizontal strip and the vertical list so both surfaces behave identically.
 */
export function useTabRename(tab: Tab) {
	const { updateTabTitle } = useTabsContext();
	const { renameConversation } = useChatHistoryContext();
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState("");

	const canRename = isRenamableTab(tab);

	const startEditing = useCallback(() => {
		if (!canRename) {
			return;
		}
		setDraft(tab.title);
		setIsEditing(true);
	}, [canRename, tab.title]);

	const commitEditing = useCallback(() => {
		if (!isEditing) {
			return;
		}
		setIsEditing(false);
		commitTabRename(tab, draft, updateTabTitle, renameConversation);
	}, [draft, isEditing, renameConversation, tab, updateTabTitle]);

	const cancelEditing = useCallback(() => setIsEditing(false), []);

	return {
		cancelEditing,
		canRename,
		commitEditing,
		draft,
		isEditing,
		setDraft,
		startEditing,
	};
}

/**
 * Converge a page editor's local title when its TAB is renamed from the strip.
 *
 * The strip only rewrites `tab.title`; the open editor still holds the old
 * title, and without this the next debounced body save would write the OLD title
 * back to the server (and the in-page header would stay stale). This surfaces
 * the strip's change into the editor and persists it through the editor's own
 * save path, so one write path — the page's — owns the document title.
 *
 * `ready` gates the sync until the document is actually loaded: before that the
 * title ref is empty and a save would flush a blank body over the real content.
 */
export function useTabTitleSync({
	ready,
	scheduleSave,
	setTitle,
	tabId,
	titleRef,
}: {
	ready: boolean;
	scheduleSave: () => void;
	setTitle: (title: string) => void;
	tabId: string | undefined;
	titleRef: { current: string };
}) {
	const { tabs } = useTabsContext();
	const tabTitle = tabs.find((t) => t.id === tabId)?.title;
	useEffect(() => {
		if (!(ready && tabTitle) || tabTitle === titleRef.current) {
			return;
		}
		setTitle(tabTitle);
		titleRef.current = tabTitle;
		scheduleSave();
		// `titleRef` is a stable ref; `setTitle`/`scheduleSave` are stable setters
		// in the editor pages, so none of these re-arm the sync once it settles.
	}, [ready, setTitle, scheduleSave, tabTitle]);
}
