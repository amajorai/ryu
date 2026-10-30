import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ItemTag } from "@/components/agent-elements/input/item-tag.tsx";
import type {
	ComposerSettingItem,
	ComposerSettingsSection,
} from "./composer-settings-menu-types.ts";

/** One dropdown row of a settings section; picking it applies the setting without closing. */
export const renderComposerSettingsRow =
	(selectItem: (section: ComposerSettingsSection) => (id: string) => void) =>
	(section: ComposerSettingsSection) =>
	(item: ComposerSettingItem) => {
		const isActive = item.id === (section.value ?? section.items[0]?.id);
		const deco = section.decorate?.(item);
		return (
			<DropdownMenuItem
				active={isActive}
				className="flex-col items-start"
				closeOnClick={false}
				key={item.id}
				onClick={() => selectItem(section)(item.id)}
				spacing="tight"
			>
				<span className="flex w-full items-center gap-2.5">
					{deco && (
						<HugeiconsIcon
							className={cn("shrink-0", deco.className)}
							icon={deco.icon}
							size={16}
							strokeWidth={2}
						/>
					)}
					<span className={cn("flex-1 truncate", deco?.className)}>
						{item.name}
					</span>
					{item.tag ? <ItemTag tag={item.tag} /> : null}
					{isActive && (
						<HugeiconsIcon
							className="shrink-0 text-muted-foreground"
							icon={Tick02Icon}
							size={16}
							strokeWidth={2}
						/>
					)}
				</span>
				{item.description && (
					<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
						{item.description}
					</span>
				)}
			</DropdownMenuItem>
		);
	};
