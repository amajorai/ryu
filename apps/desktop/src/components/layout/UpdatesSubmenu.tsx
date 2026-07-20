import {
	ArrowUpRight01Icon,
	NewReleasesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Spinner } from "@ryu/ui/components/spinner";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useRecentUpdates } from "@/src/hooks/useRecentUpdates.ts";
import type { RecentUpdateItem } from "@/src/lib/api/updates.ts";

const TRAILING_SLASH_RE = /\/$/;

function formatItemDate(date: string): string {
	const parsed = new Date(date);
	if (Number.isNaN(parsed.getTime())) {
		return "";
	}
	return parsed.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function itemMeta(item: RecentUpdateItem): string {
	const date = formatItemDate(item.date);
	if (item.kind === "blog") {
		return [item.tag ?? "Blog", date].filter(Boolean).join(" · ");
	}
	const parts = ["Changelog"];
	if (item.version) {
		parts.push(`v${item.version}`);
	}
	if (date) {
		parts.push(date);
	}
	return parts.join(" · ");
}

function itemUrl(item: RecentUpdateItem, frontendBase: string): string {
	if (item.kind === "blog") {
		return `${frontendBase}/blog/${item.slug}`;
	}
	return `${frontendBase}/changelog/${item.slug}`;
}

function openUpdate(item: RecentUpdateItem, frontendBase: string) {
	openExternal(itemUrl(item, frontendBase)).catch(() => undefined);
}

/** Account-menu submenu listing recent blog posts and changelog entries. */
export function UpdatesSubmenu() {
	const { items, loading } = useRecentUpdates(8);
	const frontendBase = FRONTEND_URL.replace(TRAILING_SLASH_RE, "");

	const openBlogIndex = () => {
		openExternal(`${frontendBase}/blog`).catch(() => undefined);
	};

	const openChangelogIndex = () => {
		openExternal(`${frontendBase}/changelog`).catch(() => undefined);
	};

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="mr-2 size-4" icon={NewReleasesIcon} />
				Updates
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-80 min-w-72 overflow-y-auto">
				{loading ? (
					<div className="flex items-center justify-center px-3 py-6">
						<Spinner className="size-4" />
					</div>
				) : items.length === 0 ? (
					<div className="px-3 py-4 text-muted-foreground text-sm">
						No updates yet
					</div>
				) : (
					items.map((item) => (
						<DropdownMenuItem
							key={`${item.kind}-${item.id}`}
							onClick={() => openUpdate(item, frontendBase)}
						>
							<span className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate font-medium text-sm">
									{item.title}
								</span>
								<span className="truncate text-[11px] text-muted-foreground">
									{itemMeta(item)}
								</span>
							</span>
							<HugeiconsIcon
								className="ml-2 size-3.5 shrink-0 text-muted-foreground"
								icon={ArrowUpRight01Icon}
							/>
						</DropdownMenuItem>
					))
				)}
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={openBlogIndex}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					View all blog posts
				</DropdownMenuItem>
				<DropdownMenuItem onClick={openChangelogIndex}>
					<HugeiconsIcon className="mr-2 size-4" icon={ArrowUpRight01Icon} />
					View full changelog
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
