import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
// packages/marketplace/src/catalog/chrome/store-list-header.tsx
//
// Formerly apps/desktop/src/components/store/StoreListHeader.tsx (since removed). Fixed chrome
// at the top of the store's left list column: pill section tabs plus an optional
// search field. Unlike the desktop original it reads the chrome context via the
// NON-throwing accessor, so when no provider is mounted (web) it simply renders
// the search field without the section-tab row. Desktop mounts the provider, so
// its tabs render exactly as before.

import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Icon } from "@ryu/ui/components/icon.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Tabs, TabsList, TabsTrigger } from "@ryu/ui/components/tabs.tsx";
import { Fragment } from "react";
import { useStoreChromeOptional } from "./store-chrome.tsx";

export default function StoreListHeader({
	search,
}: {
	search?: {
		value: string;
		onChange: (value: string) => void;
		placeholder?: string;
	};
}) {
	const chrome = useStoreChromeOptional();

	return (
		<div className="flex shrink-0 flex-col gap-2.5 border-border border-b p-3">
			{chrome ? (
				<Tabs onValueChange={chrome.onSelect} value={chrome.active}>
					<TabsList layout="catalog-sections" variant="pills">
						{chrome.sections.map((section, index) => {
							const prev = index > 0 ? chrome.sections[index - 1] : undefined;
							const showDivider = Boolean(
								prev?.group && prev.group !== section.group
							);
							return (
								<Fragment key={section.value}>
									{showDivider ? (
										<span
											aria-hidden
											className="mx-0.5 h-5 w-px shrink-0 self-center bg-border/60"
										/>
									) : null}
									<TabsTrigger
										density="catalog"
										title={section.label}
										value={section.value}
									>
										{isNativeText(section.icon) ? (
											<Icon
												className="size-3.5"
												icon={section.icon}
												size={14}
											/>
										) : (
											<HugeiconsIcon className="size-3.5" icon={section.icon} />
										)}
										<span className="truncate" title={section.label}>
											{section.label}
										</span>
									</TabsTrigger>
								</Fragment>
							);
						})}
					</TabsList>
				</Tabs>
			) : null}
			{search ? (
				<div className="relative">
					<HugeiconsIcon
						className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						icon={Search01Icon}
					/>
					<Input
						aria-label={search.placeholder ?? "Search"}
						leadingAdornment="compact"
						onChange={(e) => search.onChange(e.target.value)}
						placeholder={search.placeholder ?? "Search…"}
						size="settings-search"
						value={search.value}
					/>
				</div>
			) : null}
		</div>
	);
}
