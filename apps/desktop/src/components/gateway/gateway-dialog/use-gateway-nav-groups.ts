import { Package01Icon, PlugSocketIcon } from "@hugeicons/core-free-icons";
import type { SettingsIconTile } from "@ryu/blocks/desktop/settings-nav.tsx";
import type { ComponentProps } from "react";
import { useMemo } from "react";
import type { buildEntityNavGroups } from "@/src/hooks/useScopedSettingsNav.ts";
import type { GatewaySection } from "@/src/store/useGatewayDialog.ts";
import { GATEWAY_NAV_GROUPS, sectionMatches } from "./gateway-nav.ts";
import { GATEWAY_SECTIONS } from "./gateway-sections.ts";

/**
 * The gateway dialog's sidebar groups: the static sections narrowed by the
 * search query, with the node-scoped app/plugin groups spliced in before the
 * "This device" group.
 */
export function useGatewayNavGroups(
	entityGroups: ReturnType<typeof buildEntityNavGroups>,
	search: string
) {
	return useMemo(() => {
		const query = search.trim();
		// Every section is in the nav by default; a search narrows it to the ones
		// whose label, hint or legacy keywords match what was typed.
		const visible = (value: GatewaySection) => {
			const meta = GATEWAY_SECTIONS.find((s) => s.value === value);
			if (!meta) {
				return false;
			}
			if (query) {
				return sectionMatches(meta, query);
			}
			return true;
		};
		const toGroup = (group: (typeof GATEWAY_NAV_GROUPS)[number]) => ({
			title: group.title,
			items: group.items.filter(visible).map((value) => {
				const meta = GATEWAY_SECTIONS.find((s) => s.value === value);
				return {
					value,
					label: meta?.label ?? value,
					// A plain muted glyph: a landmark, not information.
					icon: meta?.icon,
				};
			}),
		});
		const nodeIdx = GATEWAY_NAV_GROUPS.findIndex(
			(g) => g.title === "This device"
		);
		const before = GATEWAY_NAV_GROUPS.slice(0, nodeIdx).map(toGroup);
		const nodeAndAfter = GATEWAY_NAV_GROUPS.slice(nodeIdx).map(toGroup);
		// App/plugin tabs are matched on their own labels when searching.
		// They carry no icon of their own — a manifest declares a settings tab, not
		// a glyph — so both headers get one stand-in glyph each, which reads as
		// "contributed" rather than pretending to identify the app.
		const withEntityIcon = (group: (typeof entityGroups)[number]) => ({
			title: group.title,
			items: group.items
				.filter(
					(item) =>
						!query || item.label.toLowerCase().includes(query.toLowerCase())
				)
				.map(
					(item) =>
						({
							...item,
							icon: group.title === "Apps" ? Package01Icon : PlugSocketIcon,
						}) satisfies (typeof group.items)[number] &
							ComponentProps<typeof SettingsIconTile>
				),
		});
		const entities = entityGroups
			.map(withEntityIcon)
			.filter((group) => group.items.length > 0);
		return [...before, ...entities, ...nodeAndAfter].filter(
			(group) => group.items.length > 0
		);
	}, [entityGroups, search]);
}
