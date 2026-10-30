// Account-menu Help submenu: docs + support on top, a "What's new?" timeline of
// recent posts/releases (public feed, same source as the marketing site), then
// the running build's version and when it shipped.

import {
	ArrowUpRight01Icon,
	BookOpen01Icon,
	BrowserIcon,
	HelpCircleIcon,
	Mail01Icon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useRecentUpdates } from "@/src/hooks/useRecentUpdates.ts";
import type { RecentUpdateItem } from "@/src/lib/api/updates.ts";
import { getAppVersion } from "@/src/lib/app-version.ts";
import { compactAge } from "@/src/lib/time.ts";
import { formatDate } from "@/src/lib/timezone.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";

const TRAILING_SLASH_RE = /\/$/;

// The timeline preview — three headlines, matching the menu's mock.
const WHATS_NEW_LIMIT = 3;

// Shared with useAvailableUpdates so opening this menu never refetches the app
// version; the bundle's version cannot change while the app runs.
const APP_VERSION_KEY = ["app", "version"] as const;

const SUPPORT_EMAIL = "support@ryuhq.com";

// The feed's `date` is the site's calendar day (`2026-10-01`) or, rarely, a
// timestamp. Hand `formatDate` the original string, not a parsed `Date`: it
// prints a bare day as written and keeps an instant in the display zone, but a
// `Date` of UTC midnight shows the previous day west of UTC.
function formatItemDate(date: string): string {
	if (Number.isNaN(new Date(date).getTime())) {
		return "";
	}
	return formatDate(date, {
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

/** Account-menu submenu: help & support, then the "What's new?" feed. */
export function HelpSubmenu() {
	const tl = useLiteralMessages();
	const { items, loading } = useRecentUpdates(8);
	const { data: appVersion } = useQuery({
		queryKey: APP_VERSION_KEY,
		queryFn: () => getAppVersion(),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const frontendBase = FRONTEND_URL.replace(TRAILING_SLASH_RE, "");

	const openDocs = () => {
		openExternal(`${frontendBase}/docs`).catch(() => undefined);
	};

	const openSupport = () => {
		openExternal(`mailto:${SUPPORT_EMAIL}`).catch(() => undefined);
	};

	const openAllReleases = () => {
		openExternal(`${frontendBase}/changelog`).catch(() => undefined);
	};

	const whatsNew = items.slice(0, WHATS_NEW_LIMIT);

	// "Updated x ago" names the running BUILD, so it looks up the changelog entry
	// whose version matches the installed one — the age is when that release
	// shipped, not when the latest one did. No match (old build, nightly, or a
	// feed window that doesn't cover it) means no line at all.
	const releasedAt = appVersion
		? items.find(
				(item) => item.kind === "changelog" && item.version === appVersion
			)?.date
		: undefined;
	const releasedAtMs = releasedAt ? Date.parse(releasedAt) : Number.NaN;
	const updatedLabel = Number.isNaN(releasedAtMs)
		? null
		: tl("Updated {age} ago", { age: compactAge(releasedAtMs) });

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={HelpCircleIcon} />
				Help
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="max-h-80 min-w-72 max-w-80 overflow-y-auto">
				<DropdownMenuItem onClick={openDocs}>
					<HugeiconsIcon className="size-4" icon={BookOpen01Icon} />
					Documentation
				</DropdownMenuItem>
				<DropdownMenuItem onClick={openSupport}>
					<HugeiconsIcon className="size-4" icon={Mail01Icon} />
					<span className="flex min-w-0 flex-1 flex-col">
						<span>Get support</span>
						<span className="font-normal text-muted-foreground text-xs">
							{SUPPORT_EMAIL}
						</span>
					</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuLabel layout="icon">
						<HugeiconsIcon className="size-3.5" icon={SparklesIcon} />
						What&rsquo;s new?
					</DropdownMenuLabel>
					{loading ? (
						<SkeletonRows inset="panel-horizontal" spacing="generous" />
					) : whatsNew.length === 0 ? (
						<div className="px-3 py-4 text-muted-foreground text-sm">
							No recent updates
						</div>
					) : (
						<DropdownMenuGroup className="relative">
							{/* The timeline rail. Runs behind the dots and stops a beat
						    above/below the first and last so the endpoints read as
						    start/stop rather than a clipped line. */}
							<span
								aria-hidden
								className="absolute top-4 bottom-4 left-[11px] w-px bg-border"
							/>
							{whatsNew.map((item) => (
								<DropdownMenuItem
									key={`${item.kind}-${item.id}`}
									onClick={() => openUpdate(item, frontendBase)}
								>
									<span className="mr-3 size-1.5 shrink-0 rounded-full bg-foreground/70" />
									<span className="flex min-w-0 flex-1 flex-col gap-0.5">
										<OverflowTooltip
											className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium text-sm"
											fade
											text={item.title}
										/>
										<OverflowTooltip
											className="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground text-xs"
											fade
											text={itemMeta(item)}
										/>
									</span>
									<HugeiconsIcon
										className="ml-2 size-3.5 shrink-0 text-muted-foreground"
										icon={ArrowUpRight01Icon}
									/>
								</DropdownMenuItem>
							))}
						</DropdownMenuGroup>
					)}
				</DropdownMenuGroup>
				<DropdownMenuItem onClick={openAllReleases}>
					<HugeiconsIcon className="size-4" icon={ArrowUpRight01Icon} />
					View all releases
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem disabled purpose="app-version">
					<HugeiconsIcon className="size-4" icon={BrowserIcon} />
					<span className="flex min-w-0 flex-1 flex-col gap-0.5">
						<span className="text-sm">App Version</span>
						{updatedLabel ? (
							<span className="text-muted-foreground text-xs">
								{updatedLabel}
							</span>
						) : null}
					</span>
					<span className="ml-2 text-muted-foreground text-xs tabular-nums">
						{appVersion ? `v${appVersion}` : "—"}
					</span>
				</DropdownMenuItem>
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
