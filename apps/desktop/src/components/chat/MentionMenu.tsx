import {
	ComposerMenu,
	type ComposerMenuGroup,
} from "@ryu/blocks/desktop/agent-elements/input/composer-menu.tsx";
import { createElement, useMemo } from "react";
import type { MentionGroup, MentionItem } from "@/src/lib/mentions/types.ts";

interface MentionMenuProps {
	anchorRef: React.RefObject<HTMLElement | null>;
	groups: MentionGroup[];
	onDismiss: () => void;
	onSelect: (item: MentionItem) => void;
}

function mentionBadge(kind: MentionItem["kind"]): string | undefined {
	switch (kind) {
		case "app":
			return "App";
		case "app-item":
			return "App item";
		case "integration":
			return "Integration";
		case "output-style":
			return "Profile";
		case "page":
			return "Page";
		case "plugin":
			return "Plugin";
		case "user":
			return "User";
		default:
			return undefined;
	}
}

/** The @ trigger expressed through the same list surface as + and /. */
export function MentionMenu({
	groups,
	onSelect,
	onDismiss,
	anchorRef,
}: MentionMenuProps) {
	const byId = useMemo<Map<string, MentionItem>>(
		() =>
			new Map(
				groups.flatMap((group) =>
					group.items.map((item) => [`${item.kind}:${item.id}`, item] as const)
				)
			),
		[groups]
	);
	const menuGroups = useMemo<ComposerMenuGroup[]>(
		() =>
			groups.map((group) => ({
				id: group.kind,
				label: group.label,
				items: group.items.map((item) => ({
					id: `${item.kind}:${item.id}`,
					label: item.label,
					description: item.description,
					badge: mentionBadge(item.kind),
					icon:
						item.visualIcon ??
						(item.icon
							? createElement(item.icon, { className: "size-4" })
							: undefined),
				})),
			})),
		[groups]
	);

	return (
		<ComposerMenu
			anchorRef={anchorRef}
			className="absolute start-0 bottom-full z-50 mb-2"
			groups={menuGroups}
			onDismiss={onDismiss}
			onSelect={(item) => {
				const mention = byId.get(item.id);
				if (mention) {
					onSelect(mention);
				}
			}}
		/>
	);
}
