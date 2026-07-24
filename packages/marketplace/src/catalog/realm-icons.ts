// packages/marketplace/src/catalog/realm-icons.ts
//
// The single source of truth for each catalog realm's glyph, so the bottom nav
// tab and the list cards can NEVER drift apart. Before this map they were
// hardcoded in two disconnected places (the SECTIONS array in StorePage and each
// section's StoreCatalogCard fallback), which is how skills cards ended up wearing
// the plugins puzzle and workflow cards used a different variant than their tab.
//
// Import this in BOTH surfaces: the tab nav for `icon`, and the card list for the
// `icon` fallback glyph (shown when an item has no logo of its own).

import {
	GridIcon,
	Mortarboard01Icon,
	Package01Icon,
	PuzzleIcon,
	ServerStack01Icon,
	Target01Icon,
	WorkflowCircle06Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

/** The catalog realms that render a browsable card list. */
export type CatalogRealm =
	| "apps"
	| "plugins"
	| "models"
	| "skills"
	| "mcp"
	| "agents"
	| "workflows";

/** Realm → glyph. The tab nav and the card fallback both read from here. */
export const REALM_ICONS: Record<CatalogRealm, IconSvgElement> = {
	apps: GridIcon,
	plugins: PuzzleIcon,
	models: Package01Icon,
	skills: Mortarboard01Icon,
	mcp: ServerStack01Icon,
	agents: Target01Icon,
	workflows: WorkflowCircle06Icon,
};
