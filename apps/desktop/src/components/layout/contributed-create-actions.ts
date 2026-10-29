import { viewSourceRowSchema } from "@ryu/app-host/views";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
// apps/desktop/src/components/layout/contributed-create-actions.ts
//
// The app half of the sidebar "+" create menu. Built-in rows (New chat, New
// agent, …) are kernel-owned and stay compiled into CreateMenu; everything else
// arrives through this seam so an app can add "New meeting" / "New space"
// without a line of shell code.
//
// There are TWO seams, because they answer different questions:
//
//   1. `contributes.create_actions` — the general one. A standalone "New X" row:
//      open a route, or invoke a granted capability. Use this for an app whose
//      create is a destination (Workflows: "New workflow" → `/workflows/new`).
//
//   2. `contributes.sidebar_sections[].spec.create` — the section-scoped one, the
//      same declaration `DynamicSidebarSection` renders as that section's own "+"
//      button. POST, then open the created row through the section's `itemTarget`.
//      An app that owns a sidebar section gets its menu row from this for free.
//
// Seam 1 exists because seam 2 could not serve an app that contributes no sidebar
// section — which is why "New workflow" and "Build with AI" were hardcoded into
// CreateMenu, and therefore stayed in the menu with Workflows uninstalled and
// navigated to an error page. Both seams are served by `usePluginContributions`,
// which only ever returns ENABLED plugins, so a row now appears and disappears
// with its app.
//
// The runner below is deliberately a separate copy of AppSidebar's, not a shared
// helper: the section's own button re-fetches its list afterwards (it owns that
// list), whereas a menu row is fire-and-open. Folding the two together would
// mean a helper that has to ask which caller it is serving.

import {
	DECLARATIVE_HTTP_GRANT,
	isCoreApiPath,
	renderContributionActionHttp,
	renderTemplate,
} from "@ryu/app-host/views";
import { useCallback, useMemo, useState } from "react";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { apiUrl, requestHeaders, toTarget } from "@/src/lib/api/client.ts";
import {
	type PluginCreateAction,
	type PluginSidebarSection,
	pluginHostInvoke,
} from "@/src/lib/api/plugins.ts";

/** One row of the create menu. Label only — the menu renders no icons and no
 *  descriptions, so a contribution's `create.icon` is read but never drawn. */
export interface CreateMenuAction {
	id: string;
	label: string;
	onSelect: () => void;
}

/**
 * Every enabled app's contributed "New X" action, ready to concatenate after the
 * built-ins. Ordered by the contribution's `order` hint, then by title, so the
 * menu doesn't reshuffle when Core happens to return the sections differently.
 */
export function useContributedCreateActions(): CreateMenuAction[] {
	const { create_actions, sidebar_sections } = usePluginContributions();
	const node = useActiveNode();
	const { openTab } = useTabsContext();
	const [pendingSection, setPendingSection] = useState<string | null>(null);

	// Seam 1: a standalone create row. `target` navigates; `capability` dispatches
	// through the owning plugin's granted host seam, the same way a contributed
	// context-menu row does. Core rejects a manifest declaring neither, so the
	// no-op branch here is defence against an older/newer Core, not a real state.
	const runStandalone = useCallback(
		(action: PluginCreateAction) => {
			if (action.target) {
				openTab(action.target, { title: action.title ?? action.label });
				return;
			}
			if (action.capability) {
				void pluginHostInvoke(
					toTarget(node),
					action.plugin,
					action.capability,
					action.args ?? {}
				);
			}
		},
		[node, openTab]
	);

	const run = useCallback(
		async (section: PluginSidebarSection) => {
			const create = pluginSidebarSpec(section)?.create;
			const sectionKey = `${section.plugin}:${section.id}`;
			if (pendingSection === sectionKey) {
				return;
			}
			const http = create && "http" in create ? create.http : undefined;
			if (create && "target" in create && isNativeText(create.target)) {
				openTab(create.target, {
					title: create.label ?? `New ${section.title}`,
				});
				return;
			}
			// Same guard the section list applies before it fetches: a contributed
			// path that is not a Core `/api/` route never reaches the authenticated
			// node seam.
			if (
				!(
					create &&
					http &&
					(section.approved_grants ?? []).includes(DECLARATIVE_HTTP_GRANT) &&
					isCoreApiPath(http.path)
				)
			) {
				return;
			}
			setPendingSection(sectionKey);
			try {
				const target = toTarget(node);
				const rendered = renderContributionActionHttp(section, http, {});
				const resp = await fetch(apiUrl(target, rendered.path), {
					method: rendered.method,
					headers: await requestHeaders(target),
					body:
						rendered.body === undefined
							? undefined
							: JSON.stringify(rendered.body),
				});
				if (!resp.ok) {
					return;
				}
				const created = viewSourceRowSchema.parse(await resp.json());
				const itemTarget = pluginSidebarSpec(section)?.itemTarget;
				// `targetFrom` names the response key holding the new row's id; without
				// it (or without an `itemTarget`) the app only wanted the row created,
				// and the owning section picks it up on its next fetch.
				if (
					itemTarget &&
					create.targetFrom &&
					created[create.targetFrom] !== undefined
				) {
					openTab(
						renderTemplate(itemTarget, { item: created }, { uriEncode: true }),
						{ title: String(created.title ?? created.name ?? "Untitled") }
					);
				}
			} catch {
				// Best-effort, exactly as the section's own create button: a failed
				// create must not take the sidebar down with it.
			} finally {
				setPendingSection((current) =>
					current === sectionKey ? null : current
				);
			}
		},
		[node, openTab, pendingSection]
	);

	// Standalone rows first, then the section-scoped ones. Both families sort by
	// their own `order`, and the two lists are concatenated rather than merged and
	// re-sorted: an app's dedicated create row is the more direct declaration of
	// intent, and interleaving it with another app's section create by numeric
	// order would make the menu's shape depend on two apps' unrelated hints.
	const standaloneRows = useMemo(
		() =>
			[...create_actions]
				.sort(
					(a, b) =>
						(a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label)
				)
				.map((action) => ({
					id: `contrib:${action.plugin}:${action.id}`,
					label: action.label,
					onSelect: () => runStandalone(action),
				})),
		[create_actions, runStandalone]
	);

	const sectionRows = useMemo(() => {
		const seen = new Set<string>();
		return sidebar_sections
			.filter((section) => {
				const create = pluginSidebarSpec(section)?.create;
				if (!create) {
					return false;
				}
				if ("target" in create && isNativeText(create.target)) {
					return true;
				}
				const http = "http" in create ? create.http : undefined;
				if (
					!(
						http &&
						(section.approved_grants ?? []).includes(DECLARATIVE_HTTP_GRANT) &&
						isCoreApiPath(http.path)
					)
				) {
					return false;
				}
				// A plugin may contribute several sections; key on plugin + section id
				// so two of them can't collapse into one row (or double-add).
				const key = `${section.plugin}:${section.id}`;
				if (seen.has(key)) {
					return false;
				}
				seen.add(key);
				return true;
			})
			.sort(
				(a, b) =>
					(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
			)
			.map((section) => ({
				id: `contrib:${section.plugin}:${section.id}`,
				label:
					pluginSidebarSpec(section)?.create?.label ?? `New ${section.title}`,
				onSelect: () => {
					void run(section);
				},
			}));
	}, [sidebar_sections, run]);

	return useMemo(
		() => [...standaloneRows, ...sectionRows],
		[standaloneRows, sectionRows]
	);
}
