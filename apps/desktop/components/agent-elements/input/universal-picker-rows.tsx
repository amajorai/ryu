import {
	CheckmarkCircle02Icon,
	Download04Icon,
	GitBranchIcon,
	HelpCircleIcon,
	Loading03Icon,
	type PlugSocketIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { CommandItem } from "@ryu/ui/components/command.tsx";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ComposerSettingItem } from "@/components/agent-elements/input/composer-settings-menu.tsx";
import { useProviderCommandNavigation } from "@/components/agent-elements/input/provider-command-dialog.tsx";
import { AgentCatalogLogo } from "@/src/lib/agent-catalog-logo.tsx";
import type { AgentCatalogEntry } from "@/src/lib/api/agents.ts";
import { formatMicroUsd } from "@/src/lib/api/credits.ts";
import {
	expiryClass,
	formatCountdown,
	formatExpiryDate,
} from "@/src/lib/expiry.ts";
import pickerStyles from "./universal-picker-body.module.css";
import type { ProviderEntry } from "./universal-picker-types.ts";

/** Section header, with an optional hover-explained "?" tooltip. */
export function SectionHeader({
	label,
	tooltip,
}: {
	label: string;
	tooltip?: string;
}) {
	return (
		<div className="sticky top-0 z-10 flex items-center gap-1 border-border border-b bg-popover/95 px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide backdrop-blur supports-backdrop-filter:bg-popover/80">
			<span>{label}</span>
			{tooltip && (
				<Tooltip>
					<TooltipTrigger
						render={
							<span
								aria-label={tooltip}
								className="flex size-4 items-center justify-center rounded-full text-muted-foreground/70 hover:text-foreground"
								role="img"
							/>
						}
					>
						<HugeiconsIcon icon={HelpCircleIcon} size={13} />
					</TooltipTrigger>
					<TooltipContent className="max-w-56">{tooltip}</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}

export function LoadingRow({ text = "Detecting…" }: { text?: string }) {
	return (
		<div className="text-(length:--text-detail) flex items-center gap-2 px-2.5 py-2 text-muted-foreground">
			<HugeiconsIcon
				className="shrink-0 animate-spin"
				icon={Loading03Icon}
				size={14}
				strokeWidth={2}
			/>
			<span>{text}</span>
		</div>
	);
}

/** One picker row inside a setting submenu (model / thinking / approval value). */
export function SettingItemRow({
	item,
	isActive,
	decoClassName,
	onSelect,
}: {
	decoClassName?: string;
	isActive: boolean;
	item: ComposerSettingItem;
	onSelect: (id: string) => void;
}) {
	return (
		<DropdownMenuItem
			active={isActive}
			className="flex-col items-start"
			closeOnClick={false}
			key={item.id}
			onClick={() => onSelect(item.id)}
			spacing="tight"
		>
			<span className="flex w-full items-center gap-2.5">
				<span className={cn("flex-1 truncate", decoClassName)}>
					{item.name}
				</span>
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
}

/** A brand logo + name row header inside a target's submenu. */
export function UseTargetItem({
	label,
	isActive,
	onSelect,
}: {
	isActive: boolean;
	label: string;
	onSelect: () => void;
}) {
	const commandNavigation = useProviderCommandNavigation();
	if (commandNavigation) {
		return (
			<CommandItem
				data-checked={isActive}
				onSelect={() => {
					onSelect();
					commandNavigation.close();
				}}
			>
				<span className="flex-1 truncate">{label}</span>
			</CommandItem>
		);
	}
	return (
		<DropdownMenuItem
			closeOnClick={false}
			onClick={onSelect}
			spacing="comfortable"
		>
			<HugeiconsIcon
				className={cn(
					"shrink-0",
					isActive ? "text-foreground" : "text-muted-foreground"
				)}
				icon={CheckmarkCircle02Icon}
				size={16}
				strokeWidth={2}
			/>
			<span className="flex-1 truncate">{label}</span>
			{isActive && (
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={Tick02Icon}
					size={16}
					strokeWidth={2}
				/>
			)}
		</DropdownMenuItem>
	);
}

export function NOOP() {
	// Non-ACP engine-model changes don't apply to external agents.
}

/** A single icon + label action row inside a provider submenu. */
export function ActionRow({
	icon,
	label,
	description,
	onClick,
}: {
	description?: string;
	icon: typeof PlugSocketIcon;
	label: string;
	onClick: () => void;
}) {
	return (
		<DropdownMenuItem
			className="flex-col items-start"
			onClick={onClick}
			spacing="tight"
		>
			<span className="flex w-full items-center gap-2">
				<HugeiconsIcon
					className="shrink-0 text-muted-foreground"
					icon={icon}
					size={16}
					strokeWidth={2}
				/>
				<span className="flex-1 truncate">{label}</span>
			</span>
			{description && (
				<span className="w-full truncate pl-6 text-left font-normal text-muted-foreground text-xs">
					{description}
				</span>
			)}
		</DropdownMenuItem>
	);
}

/**
 * The user's free credit, in dollars, on the Ryu Router row.
 *
 * The number is granted money and nothing else (see `ProviderEntry.poolGrant`).
 * Campaign grants lapse, so when this money has a
 * date the badge wears the shared expiry urgency hue and the tooltip says when —
 * the same convention the composer's banked-reset timeline uses, from the same
 * helpers, so two "expires in" readings on one screen can't disagree.
 */
export function PoolGrantBadge({
	grant,
	label,
}: {
	grant: NonNullable<ProviderEntry["poolGrant"]>;
	label: string;
}) {
	const tl = useLiteralMessages();
	const amount = formatMicroUsd(grant.remainingMicroUsd);
	const expiry = grant.expiresAt;
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span
						aria-label={tl("{label}: {amount} of free credit left", {
							amount,
							label,
						})}
						className="flex shrink-0 items-center gap-1 font-mono text-muted-foreground/70 text-xs tabular-nums"
					/>
				}
			>
				{expiry ? (
					<span
						aria-hidden="true"
						className={cn("size-1.5 rounded-full", expiryClass(expiry))}
					/>
				) : null}
				{amount}
			</TooltipTrigger>
			<TooltipContent>
				<div className="flex flex-col gap-0.5 text-xs">
					<span className="font-medium">
						{tl("{amount} of free credit left", { amount })}
					</span>
					{expiry ? (
						<span className="text-muted-foreground">
							{tl("Expires {date} · {countdown}", {
								countdown: formatCountdown(expiry),
								date: formatExpiryDate(expiry),
							})}
						</span>
					) : null}
					<span className="text-muted-foreground">
						Used automatically on models marked Free.
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

/** A greyed, not-installed external agent row with a right-aligned Install button. */
export function AvailableAgentRow({
	entry,
	installing,
	onInstall,
}: {
	entry: AgentCatalogEntry;
	installing: boolean;
	onInstall: () => void;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 rounded-md px-2 py-1.5",
				pickerStyles.availableAgent
			)}
		>
			<AgentCatalogLogo className="size-4 shrink-0" entry={entry} size="16px" />
			<span className="text-(length:--text-detail) min-w-0 flex-1 truncate text-muted-foreground">
				{entry.name}
			</span>
			<Button
				className="shrink-0"
				disabled={!entry.available}
				loading={installing}
				onClick={(e) => {
					e.stopPropagation();
					onInstall();
				}}
				size="tiny"
				type="button"
				variant="ghost"
			>
				<HugeiconsIcon icon={Download04Icon} size={12} strokeWidth={2} />
				{installing ? "Installing" : "Install"}
			</Button>
		</div>
	);
}

/**
 * The special "Auto" row (Plane B): selecting it points the composer at the
 * sentinel `auto` agent, so Core resolves the best agent per-turn by the user's
 * rules. It uses the same unadorned branch mark as the message action; the
 * configuration action lives in the picker footer beside model management.
 */
export function AutoTargetRow({
	isActive,
	onSelect,
}: {
	isActive: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem
			active={isActive}
			className="min-w-0"
			closeOnClick={false}
			onClick={onSelect}
			spacing="tight"
			// One line: what Auto does is a tooltip, not a second row of text.
			title="Routes each turn to the best agent by your rules."
		>
			<HugeiconsIcon
				className="size-4 shrink-0 text-muted-foreground"
				icon={GitBranchIcon}
			/>
			<span className="flex-1 truncate">Auto</span>
			{isActive && (
				<HugeiconsIcon
					className="size-4 shrink-0 text-muted-foreground"
					icon={Tick02Icon}
				/>
			)}
		</DropdownMenuItem>
	);
}
