"use client";
// The "More" overflow of the Store section strip. The strip shows a handful of
// primary sections; the rest of the open-ended list (every app may register one)
// lives in this menu, so the row stays one calm line instead of a scrolling band.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useOptionalI18n } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import type { ReactNode } from "react";

export interface StoreSectionMoreItem {
	count?: number;
	icon: IconSvgElement | string;
	iconNode?: ReactNode;
	label: string;
	value: string;
}

function MoreItemIcon({ item }: { item: StoreSectionMoreItem }) {
	if (item.iconNode) {
		return (
			<span className="flex size-4 shrink-0 items-center">{item.iconNode}</span>
		);
	}
	if (isNativeText(item.icon)) {
		return <Icon className="shrink-0" icon={item.icon} size={16} />;
	}
	if (!Array.isArray(item.icon)) {
		return null;
	}
	return <HugeiconsIcon className="size-4 shrink-0" icon={item.icon} />;
}

/** Split a section list into the visible strip and the "More" overflow. The
 *  active section is always visible: when it lives in the overflow it is
 *  promoted to the end of the strip, so the selected tab never hides in a menu. */
export function splitStoreSections<T extends { value: string }>(
	sections: readonly T[],
	active: string,
	primaryValues: readonly string[] | undefined
): { overflow: T[]; visible: T[] } {
	if (!primaryValues) {
		return { overflow: [], visible: [...sections] };
	}
	const primary = new Set(primaryValues);
	const visible = sections.filter((s) => primary.has(s.value));
	const overflow = sections.filter((s) => !primary.has(s.value));
	const promoted = overflow.find((s) => s.value === active);
	if (!promoted) {
		return { overflow, visible };
	}
	return {
		overflow: overflow.filter((s) => s !== promoted),
		visible: [...visible, promoted],
	};
}

export function StoreSectionMore({
	items,
	onSelect,
}: {
	items: StoreSectionMoreItem[];
	onSelect: (value: string) => void;
}) {
	const i18n = useOptionalI18n();
	const moreLabel = useLocalizedString("More");
	const moreSectionsLabel = useLocalizedString("More sections");
	if (items.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={moreSectionsLabel}
						className="shrink-0 text-muted-foreground"
						data-slot="store-section-more"
						size="sm"
						variant="ghost"
					>
						{moreLabel}
						<HugeiconsIcon className="size-3.5" icon={ArrowDown01Icon} />
					</Button>
				}
			/>
			<DropdownMenuContent align="start" className="min-w-52">
				{items.map((item) => (
					<DropdownMenuItem
						key={item.value}
						onClick={() => onSelect(item.value)}
					>
						<MoreItemIcon item={item} />
						<span className="min-w-0 flex-1 truncate">
							{i18n?.t(`marketplace.section.${item.value}`, {}, item.label) ??
								item.label}
						</span>
						{item.count !== undefined && item.count > 0 ? (
							<span className="text-muted-foreground/70 text-xs tabular-nums">
								{formatCount(item.count)}
							</span>
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
