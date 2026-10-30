import { useMemo } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import {
	usePluginContributions,
	usePluginContributionsQuery,
} from "@/src/hooks/usePluginContributions.ts";
import { useSidebarSectionSources } from "@/src/hooks/useSidebarSectionSource.ts";
import { pluginSidebarSpec } from "@/src/lib/api/plugin-contribution-specs.ts";
import {
	contributedSectionValue,
	SECTION_PLUGIN,
	SECTIONS,
} from "./library-sections.ts";

/** The Library tabs to show: the built-in collections whose owning app is enabled,
 *  minus any an app replaces with its own source-backed section, plus every
 *  app-registered collection. */
export function useLibraryVisibleSections() {
	// Only show a collection tab when its owning app is enabled — an uninstalled
	// Workflows/Teams/Meetings app should leave no empty tab. Host surfaces
	// (recents/favorites/chat/channel/identity) have no owner and always show.
	const { apps, loading: appsLoading } = useApps();
	const enabledPlugins = useMemo(
		() => new Set(apps.filter((a) => a.enabled).map((a) => a.id)),
		[apps]
	);
	// While the app list is still loading, show every tab — gating on an empty set
	// would flash the pre-installed collections (Agents/Spaces/Teams) off then on.
	const appVisibleSections = useMemo(
		() =>
			appsLoading
				? SECTIONS
				: SECTIONS.filter((s) => {
						const plugin = SECTION_PLUGIN.get(s.value);
						return !plugin || enabledPlugins.has(plugin);
					}),
		[enabledPlugins, appsLoading]
	);

	// App-registered collections, from the same `sidebar_sections` declaration the
	// sidebar renders. Core serves these only for ENABLED apps, so no gate is
	// needed here. A section owned by an app that also owns a built-in tab is
	// skipped: @ryu/meetings ships both, and two tabs called "Meetings" listing the
	// same rows is worse than either alone.
	const { isLoading: contributionsLoading } = usePluginContributionsQuery();
	const { companions, sidebar_sections } = usePluginContributions();
	const contributedSections = useMemo(
		() =>
			[...sidebar_sections].sort(
				(a, b) =>
					(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
			),
		[sidebar_sections]
	);
	const contributedSourceData = useSidebarSectionSources(contributedSections);
	const contributedSourceByValue = useMemo(
		() =>
			new Map(
				contributedSourceData.map((data) => [
					contributedSectionValue(data.contribution),
					data,
				])
			),
		[contributedSourceData]
	);

	// If an app owns one of the compiled-in surfaces and also contributes its
	// sidebar section, the source-backed app section is the Library tab. This
	// keeps Meetings/Workflows/etc. from appearing twice while still allowing any
	// other app-registered section to arrive automatically.
	const visibleSections = useMemo(
		() =>
			appVisibleSections.filter((section) => {
				const owner = SECTION_PLUGIN.get(section.value);
				return !(
					owner &&
					contributedSections.some(
						(c) => c.plugin === owner && Boolean(pluginSidebarSpec(c)?.source)
					)
				);
			}),
		[appVisibleSections, contributedSections]
	);

	return {
		apps,
		appsLoading,
		companions,
		contributedSections,
		contributedSourceByValue,
		contributionsLoading,
		visibleSections,
	};
}
