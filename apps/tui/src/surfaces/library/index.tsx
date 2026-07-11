/* @jsxImportSource @opentui/react */
// Library surface (path /library) - the browsing surface, mirroring the desktop
// LibraryPage. The desktop version is a multi-collection browser; the terminal
// keeps it light by folding the legacy recipes tab (src/tabs/recipes.tsx) in as the
// single collection: ghost recipes from /api/recipes, with Enter to replay the
// selected recipe. It leans on the shared ListTab primitive for the full
// lazy-load / j-k / Enter / r lifecycle, passing `active={focused}` so a split only
// routes keys to the focused pane.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { runRecipe } from "@ryuhq/core-client/recipes";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { featureListLoader, type ListRow } from "../../core/featureList.ts";
import { ListTab } from "../../ui/ListTab.tsx";
import type { SurfaceModule, SurfaceProps } from "../../workspace/router.ts";
import { useWorkspace } from "../../workspace/WorkspaceContext.tsx";

const loadRecipes = featureListLoader({
	path: "/api/recipes",
	containerKeys: ["recipes", "data"],
	titleKeys: ["name", "id"],
	subtitleKeys: ["description", "task"],
	badgeKeys: ["steps"],
	idKeys: ["name", "id"],
});

const replayRecipe = async (
	row: ListRow,
	target: ApiTarget
): Promise<string> => {
	await runRecipe(target, row.id, {});
	return `replayed: ${row.id}`;
};

function LibrarySurface({ active, paneId }: SurfaceProps) {
	const theme = useTheme();
	const { focusedPaneId } = useWorkspace();
	const focused = active && focusedPaneId === paneId;

	return (
		<box flexDirection="column" flexGrow={1} paddingTop={1}>
			<box flexDirection="row" gap={2} paddingBottom={1} paddingLeft={1}>
				<text fg={theme.colors.foreground}>
					<b>Library</b>
				</text>
				<text fg={theme.colors.mutedForeground}>
					recipes · ↑↓ nav · Enter replay · r refresh
				</text>
			</box>
			<ListTab
				active={focused}
				emptyLabel="No recipes yet"
				load={loadRecipes}
				onActivate={replayRecipe}
			/>
		</box>
	);
}

/** The Library surface module (path /library). Registered by the Integrate step. */
export const librarySurface: SurfaceModule = {
	id: "library",
	title: "Library",
	match: (path) => path === "/library" || path.startsWith("/library/"),
	Component: LibrarySurface,
};
