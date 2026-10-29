// App-vs-plugin classification for the `ryu` CLI.
//
// Apps and plugins share ONE Core lifecycle API: `POST /api/plugins/:id/{install,
// enable,disable,uninstall}` is byte-identical for both, and `GET /api/plugins`
// and `GET /api/plugins/catalog` already return both. "app" vs "plugin" is a
// CATALOG CLASSIFICATION, not a second install path — so the only thing the CLI
// needs is a way to LABEL a row and FILTER a list, which is all this module does.
// Nothing here branches the lifecycle, and nothing should ever start to.
//
// The predicate is deliberately the same one three other places already run:
//   apps/core/src/server/mod.rs                                → `is_app` (the emitter)
//   packages/marketplace/src/catalog/apps-catalog-section.tsx  → `isCompanionApp`
//   apps/desktop/src/hooks/useStoreHome.ts                     → the `isApp` split
// An APP ships a Companion UI surface; everything else is a plugin. It is
// re-expressed here rather than imported because the shared helper lives in
// `@ryu/marketplace`, a React/tsx package the tui does not (and must not) depend
// on — a terminal binary that prints a table has no business pulling in a
// component tree, `@ryu/ui`, and react-dom to do it. Core's `is_app` is the
// upstream source of truth: if the derivation changes it changes there first and
// every mirror, this one included, follows.

import type { AppInfo, CatalogEntry } from "@ryuhq/core-client/plugins";
import { z } from "zod";
import { localize } from "./localizedText.ts";
import { UsageError } from "./types.ts";

/** What a registry item IS, for labelling/filtering only. */
export type AppKind = "app" | "plugin";

/** The `--kind` filter. `"all"` is the default: `ryu list` / `ryu catalog` have
 *  always printed apps AND plugins (one Core endpoint returns both), so anything
 *  narrower would silently drop rows from a script that predates this flag. */
export type KindFilter = AppKind | "all";

/** The runnable kind that makes a plugin an "app": a full-page Companion UI. */
const COMPANION_RUNNABLE_KIND = "companion";

/** The explicit discriminator Core stamps onto catalog entries (`"type": "app" |
 *  "plugin"`, see `is_app` in apps/core/src/server/mod.rs). core-client's
 *  `CatalogEntry` does not declare the field yet and the tui does not own that
 *  package, so it is read structurally off the pass-through wire object rather
 *  than by widening a type this unit cannot edit. Absent ⇒ an older wire, which
 *  is exactly the case the `kinds` fallback below exists for. */
const catalogClassificationSchema = z.object({
	type: z.enum(["app", "plugin"]).optional().catch(undefined),
});

/** Classify a catalog entry. Prefers Core's explicit `type`; falls back to the
 *  legacy "ships a Companion runnable" derivation for wires that predate it —
 *  identical to the desktop's `e.type ? e.type === "app" : e.kinds.includes(…)`. */
export function catalogEntryKind(entry: CatalogEntry): AppKind {
	const explicit = catalogClassificationSchema.parse(entry).type;
	if (explicit) {
		return explicit;
	}
	return entry.kinds.includes(COMPANION_RUNNABLE_KIND) ? "app" : "plugin";
}

/** Classify an INSTALLED item. `AppInfo` carries no `kinds`/`type` (it is the
 *  lifecycle view, not the catalog view), so this reads the manifest runnables it
 *  does carry — which is the very list Core derives both `kinds` and `type` from,
 *  so an installed row and its catalog row always agree. */
export function installedAppKind(app: AppInfo): AppKind {
	return app.runnables.some((r) => r.kind === COMPANION_RUNNABLE_KIND)
		? "app"
		: "plugin";
}

/** Resolve the `--kind` flag. Unset ⇒ `"all"` (see {@link KindFilter}); an
 *  unrecognized value is a usage error rather than a silent "all", so a typo like
 *  `--kind apps` fails loudly instead of appearing to work. */
export function parseKindFilter(raw: string | null): KindFilter {
	if (!raw) {
		return "all";
	}
	if (raw === "app" || raw === "plugin" || raw === "all") {
		return raw;
	}
	throw new UsageError(
		localize("Unknown --kind '{kind}'. Expected one of: app, plugin, all.", {
			kind: raw,
		})
	);
}

/** True when an item of `kind` survives `filter`. */
export function matchesKind(filter: KindFilter, kind: AppKind): boolean {
	return filter === "all" || filter === kind;
}
