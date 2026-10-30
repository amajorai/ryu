import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SvglIcon } from "@ryu/blocks/web/svgl-icon.tsx";
import { AgentTitleBadge } from "@ryu/ui/components/agent-title-badge.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import {
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import type { GlyphValue } from "@ryu/ui/components/glyph.ts";
import type { ReactNode } from "react";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import {
	ProviderUsageBadge,
	UsageBar,
} from "@/components/agent-elements/input/usage-bar.tsx";
import { useSubscriptions } from "@/src/hooks/useSubscriptions.ts";
import { AgentAvatar, AgentLogo } from "@/src/lib/agent-logos.tsx";
import { supportsSubscriptionProviderUsage } from "@/src/lib/api/usage.ts";
import { svglForProvider } from "@/src/lib/provider-brand.tsx";
import type { ProviderEntry } from "./universal-picker-types.ts";

/**
 * A configured subscription provider row's usage: the same bar an ACP agent
 * row shows for one saved login, or the active login's number with every login
 * in the tooltip when there are several. Which providers can report
 * per-account usage comes from Core's subscriptions listing (no usage read, one
 * shared request for every row); until it loads, the row stays quiet rather
 * than guessing.
 */
export function SubscriptionProviderUsage({
	provider,
}: {
	provider: ProviderEntry;
}) {
	const listing = useSubscriptions({ usage: "none" });
	const listed = listing.data?.providers.find(
		(entry) => entry.providerId === provider.id
	);
	if (
		!supportsSubscriptionProviderUsage({
			...provider,
			accountUsage: listed?.capabilities.accountUsage,
		})
	) {
		return null;
	}
	return (listed?.accounts.length ?? 0) > 1 ? (
		<ProviderUsageBadge className="shrink-0" providerId={provider.id} />
	) : (
		<UsageBar agentId={provider.id} className="shrink-0" />
	);
}

/** A top-level target row that opens a submenu (its settings body). */
export function TargetSub({
	label,
	engineKey,
	providerId,
	avatarUrl,
	glyph,
	isActive,
	title,
	trailing,
	children,
}: {
	avatarUrl?: string | null;
	children: ReactNode;
	engineKey: string | null;
	glyph?: GlyphValue;
	/** Pi provider id — routes the row through the svgl brand mark when set. */
	providerId?: string;
	isActive: boolean;
	label: string;
	title?: string;
	/**
	 * A small right-aligned status for this row, before the active checkmark: an
	 * agent's subscription usage, or a Ryu pool's remaining granted credit. This is
	 * the one seam both live on, because provider rows and agent rows are the same
	 * component — anything that renders per-target belongs here rather than in two
	 * near-identical copies.
	 */
	trailing?: ReactNode;
}) {
	const commandNavigation = useProviderCommandNavigation();
	// Provider rows carry a Pi id (groq, cerebras, nvidia, …) whose bundled brand
	// mark lives in `/logos/`. Agents (no providerId) keep the engine logo.
	const providerSpec = providerId ? svglForProvider(providerId) : null;
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={isActive}
				onSelect={() =>
					commandNavigation.push({ body: children, title: label })
				}
			>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					<span className="truncate">{label}</span>
					<AgentTitleBadge title={title ?? ""} />
				</span>
				{trailing}
			</CommandItem>
		);
	}

	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger active={isActive}>
				<span className="flex min-w-0 flex-1 items-center gap-2">
					{glyph ? (
						<AgentAvatar
							className="size-4 shrink-0 object-contain"
							engine={engineKey}
							glyph={glyph}
							size="16px"
						/>
					) : avatarUrl ? (
						// Tauri/Vite, data URL avatar
						// sized via class
						<img
							alt=""
							className="size-4 shrink-0 rounded-full object-cover"
							src={avatarUrl}
						/>
					) : providerSpec ? (
						<SvglIcon
							className="size-4 shrink-0"
							size={16}
							spec={providerSpec}
						/>
					) : (
						<AgentLogo
							className="size-4 shrink-0"
							engine={engineKey}
							size="16px"
						/>
					)}
					<span className="truncate">{label}</span>
					<AgentTitleBadge title={title ?? ""} />
				</span>
				{trailing}
				{isActive && (
					<HugeiconsIcon
						className="mr-1 shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={15}
						strokeWidth={2}
					/>
				)}
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent
				className="max-h-96 min-w-[220px] max-w-[320px] overflow-y-auto"
				data-desktop-picker-inset="true"
			>
				{children}
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
