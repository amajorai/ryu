import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import type { LibrarySection } from "./library-sections.ts";
import type { LibraryTabsValue } from "./library-tabs.ts";

/** The active tab's primary action (New chat, New agent, …) and the empty
 *  state's action, which becomes "Clear search" while a query is typed. */
export function useLibraryCta({
	openCreateAgent,
	openTab,
	openTeam,
	query,
	section,
	setQuery,
	setSpaceDialogOpen,
}: {
	openCreateAgent: () => void;
	openTab: LibraryTabsValue["openTab"];
	openTeam: (id: string | null) => void;
	query: string;
	section: LibrarySection;
	setQuery: (query: string) => void;
	setSpaceDialogOpen: (open: boolean) => void;
}) {
	const handleNewChat = () => openTab("/chat", { forceNew: true });

	// Which enabled app answers to `/meetings` right now (null → none). Read here
	// because `ctaForSection` is a plain function, not a component.
	const meetingsCompanion = useCompanionAlias("/meetings");

	const ctaForSection = (): {
		label: string;
		onCta: () => void;
	} | null => {
		switch (section) {
			case "recents":
			case "chat":
				return { label: "New chat", onCta: handleNewChat };
			case "agent":
				return {
					label: "New agent",
					onCta: () => openCreateAgent(),
				};
			case "workflow":
				return {
					label: "New workflow",
					onCta: () => openTab("/workflows/new", { title: "New workflow" }),
				};
			case "space":
				return { label: "New space", onCta: () => setSpaceDialogOpen(true) };
			case "team":
				return { label: "New group", onCta: () => openTeam(null) };
			case "meeting":
				// `/meetings` is owned by the not-pre-installed `@ryu/meetings` app and
				// resolves through the companion-alias catch-all, so with no enabled
				// app claiming it this button's only outcome was an "App not enabled"
				// tab. No CTA at all is the honest answer — same AFFORDANCE gate the
				// `nav.timeline` hotkey uses in `Layout.tsx`.
				return meetingsCompanion
					? {
							label: "Record a meeting",
							onCta: () => openTab("/meetings", { title: "Meetings" }),
						}
					: null;
			case "channel":
				return {
					label: "New channel",
					onCta: () => openTab("/channels/new", { title: "New channel" }),
				};
			case "identity":
				return {
					label: "New identity",
					onCta: () => openTab("/identities/new", { title: "New identity" }),
				};
			case "favorites":
				return {
					label: "Browse agents",
					onCta: () => openTab("/library/agent", { title: "Agents" }),
				};
			default:
				return null;
		}
	};
	const cta = ctaForSection();
	// The toolbar already carries the create action, so the empty state offers
	// only the one thing the toolbar cannot: clearing a search that found nothing.
	const emptyAction = query.trim()
		? { label: "Clear search", onCta: () => setQuery("") }
		: null;

	return { cta, emptyAction };
}
