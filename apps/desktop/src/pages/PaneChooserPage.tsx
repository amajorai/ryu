// What an EMPTY pane shows. Applying a layout preset tiles the panes first and
// asks what goes in them second, so each unfilled pane opens this page: a
// picker that replaces itself with whatever the user chooses.
//
// A pane IS a tab in this app — there is no vacancy leaf in the split tree, and
// a split with fewer than two live members is dissolved on every mutation. So
// "empty pane" is a real tab on a real route, which also means this page has to
// read sensibly on its own: session restore can revive it outside any split,
// and it still works there (it just fills its own tab).

import {
	Calendar04Icon,
	Chat01Icon,
	DashboardSquare01Icon,
	InboxIcon,
	LibraryIcon,
	PackageIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { PageHeader } from "@ryu/ui/components/page-header.tsx";
import {
	findSplit,
	useCurrentTabId,
	useTabSelector,
} from "@/src/contexts/TabsContext.tsx";
import { DASHBOARD_DEFAULT_PATH } from "@/src/lib/dashboards/app.ts";
import { PANE_CHOOSER_PATH } from "@/src/lib/splitPresets.ts";

interface PaneRoute {
	icon: IconSvgElement;
	label: string;
	path: string;
}

// The same surfaces the launchpad offers, minus anything that only makes sense
// full-window. Deliberately a short list: this is a pane, not a home page.
const PANE_ROUTES: PaneRoute[] = [
	{ path: "/chat", label: "New chat", icon: Chat01Icon },
	{ path: DASHBOARD_DEFAULT_PATH, label: "Home", icon: DashboardSquare01Icon },
	{ path: "/library", label: "Library", icon: LibraryIcon },
	{ path: "/inbox", label: "Inbox", icon: InboxIcon },
	{ path: "/calendar", label: "Calendar", icon: Calendar04Icon },
	{ path: "/store", label: "Customize", icon: PackageIcon },
];

export function PaneChooserPage() {
	const tabId = useCurrentTabId();
	const tabs = useTabSelector((state) => state.tabs);
	const splits = useTabSelector((state) => state.splits);
	const setTabRoute = useTabSelector((state) => state.setTabRoute);
	const replacePaneTab = useTabSelector((state) => state.replacePaneTab);
	const split = findSplit(tabs, splits, tabId);
	// Movable tabs: anything that isn't this pane, isn't pinned, and isn't
	// another empty pane of this same split (moving one hole into another is a
	// no-op the user would have to undo).
	const movable = tabs.filter(
		(t) =>
			t.id !== tabId &&
			!t.pinned &&
			!(t.path === PANE_CHOOSER_PATH && t.splitId === split?.id)
	);

	if (!tabId) {
		return null;
	}

	return (
		<div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 pt-6 pb-12">
				<PageHeader
					size="app"
					title={split ? "Fill this pane" : "Choose a page"}
				/>

				<section className="flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Open a page</h2>
					<div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
						{PANE_ROUTES.map((route) => (
							<button
								className="group flex h-10 items-center gap-2 rounded-lg px-3 text-left transition-colors duration-150 hover:bg-muted hover:duration-0"
								key={route.path}
								onClick={() => setTabRoute(tabId, route.path)}
								type="button"
							>
								<HugeiconsIcon
									className="shrink-0 text-muted-foreground group-hover:text-foreground"
									icon={route.icon}
									size={16}
								/>
								<span
									className="truncate font-medium text-sm"
									title={route.label}
								>
									{route.label}
								</span>
							</button>
						))}
					</div>
				</section>

				{split && movable.length > 0 && (
					<section className="flex flex-col gap-3">
						<h2 className="font-semibold text-sm">Move an open tab here</h2>
						<div className="flex flex-col gap-1">
							{movable.map((tab) => (
								<button
									className="flex h-10 items-center gap-3 rounded-lg px-3 text-left transition-colors duration-150 hover:bg-muted hover:duration-0"
									key={tab.id}
									onClick={() => replacePaneTab(tabId, tab.id)}
									type="button"
								>
									<span
										className="min-w-0 flex-1 truncate text-sm"
										title={tab.title}
									>
										{tab.title}
									</span>
									<span
										className="shrink-0 truncate font-mono text-muted-foreground text-xs"
										title={tab.path}
									>
										{tab.path}
									</span>
								</button>
							))}
						</div>
					</section>
				)}
			</div>
		</div>
	);
}
