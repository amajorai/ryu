import type { LibraryCardData } from "@ryu/blocks/desktop/library.tsx";
import type { LibraryViewMode } from "@ryu/blocks/desktop/view-toggle.tsx";
import { StatusBadge } from "@ryu/ui/components/status-badge.tsx";
import {
	LibraryItemMenuContent,
	useLibraryContributedRows,
} from "@/src/components/layout/library-entity-menu.tsx";
import {
	type LibraryItemType,
	type LibraryRef,
	refKey,
} from "@/src/lib/library.ts";
import type { LibraryItem } from "./library-sections.ts";

/** The per-card renderers every Library surface shares: the right-click menu and
 *  the shared card's data. */
export function useLibraryCardRenderers({
	beginRename,
	favorites,
	setDeleteError,
	setDeleting,
	toggleFavorite,
	view,
}: {
	beginRename: (item: LibraryItem) => void;
	favorites: LibraryRef[];
	/** Kept for callers; the type now reads from the card's leading icon. */
	mixedView?: boolean;
	setDeleteError: (error: string | null) => void;
	setDeleting: (item: LibraryItem | null) => void;
	toggleFavorite: (type: LibraryItemType, id: string) => void;
	view: LibraryViewMode;
}) {
	// One factory for every type's app-contributed rows. Called per card below;
	// the hook itself runs once, which is why `useLibraryContributedRows` returns
	// a function rather than the rows.
	const contributedRowsFor = useLibraryContributedRows();

	/** The right-click rows for one card — the same set on every surface the
	 *  Library renders (shared card, Spaces shelf, Agents badge wall). */
	const menuFor = (item: LibraryItem) => (
		<LibraryItemMenuContent
			contributedRows={contributedRowsFor(item.type, item.id)}
			item={{
				favorited: favorites.some(
					(f) => f.type === item.type && f.id === item.id
				),
				id: item.id,
				name: item.name,
				onOpen: item.open,
				onOpenInNewTab: item.openInNewTab,
				onRename: item.rename ? () => beginRename(item) : undefined,
				onRequestDelete: item.remove
					? () => {
							setDeleteError(null);
							setDeleting(item);
						}
					: undefined,
				onToggleFavorite: () => toggleFavorite(item.type, item.id),
				removeBlockedReason: item.removeBlockedReason,
				type: item.type,
			}}
		/>
	);

	// On the mixed tabs, prefix each card with its type so kinds are legible.
	const toCardData = (item: LibraryItem): LibraryCardData => {
		// Previews are grid-only (list rows stay compact). The workflow strip is
		// local data, so it renders wherever a workflow card appears. Spaces used to
		// mount a fetched markdown snippet here; the Spaces grid is a book shelf now
		// and never reaches this card, so nothing space-shaped is left to preview.
		const preview = view === "showcase" ? item.preview : undefined;
		return {
			key: refKey(item.type, item.id),
			icon: item.icon,
			name: item.name,
			subtitle: item.subtitle,
			// The leading icon already says what kind of item this is; a badge is
			// kept for exceptional states (Live, Disabled) only.
			badge: item.badge,
			statusIcon: item.status ? <StatusBadge kind={item.status} /> : undefined,
			favorited: favorites.some(
				(f) => f.type === item.type && f.id === item.id
			),
			preview,
		};
	};

	return { menuFor, toCardData };
}
