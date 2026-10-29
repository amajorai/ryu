import {
	AGENT_AVAILABILITY_OPTIONS,
	AgentAvailabilityDot,
	agentAvailabilityLabel,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { Check, Settings } from "lucide-react";
import { useUserAvailability } from "@/src/hooks/useUserAvailability.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";

type AvailabilityView = ReturnType<typeof useUserAvailability>;

export function AvailabilityOptions({
	availability,
}: {
	availability: AvailabilityView;
}) {
	const openSettings = useSettingsDialog((state) => state.openSettings);

	return (
		<>
			<DropdownMenuGroup>
				{AGENT_AVAILABILITY_OPTIONS.map((option) => (
					<DropdownMenuItem
						key={option.value}
						onClick={() => availability.setStatus(option.value)}
					>
						<AgentAvailabilityDot className="mr-2" status={option.value} />
						<span className="flex-1">{option.label}</span>
						{availability.status === option.value ? (
							<Check className="size-4 text-muted-foreground" />
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuGroup>
			<DropdownMenuSeparator />
			<DropdownMenuItem onClick={() => openSettings("general")}>
				<Settings className="mr-2 size-4" />
				Availability settings
			</DropdownMenuItem>
		</>
	);
}

function availabilityMenuCaption(
	availability: AvailabilityView,
	tl: LiteralMessage
): string {
	if (availability.source === "stream" && availability.detectedStreamingApp) {
		return tl("Streaming: {appName} is running", {
			appName: availability.detectedStreamingApp,
		});
	}
	if (availability.source === "game" && availability.detectedGame) {
		return tl("Gaming: {gameName} is running", {
			gameName: availability.detectedGame,
		});
	}
	if (availability.status === "streaming") {
		return "Connected-app suggestions are hidden while you stream";
	}
	if (availability.status === "away" && availability.source === "afk") {
		return "Away from AFK detection";
	}
	return "Choose when Ryu may ask for a decision";
}

/** Direct user-nav control for the status that governs human-input prompts. */
export function AvailabilityStatusButton({
	compact = false,
}: {
	compact?: boolean;
}) {
	const tl = useLiteralMessages();
	const availability = useUserAvailability();

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						aria-label={tl("Availability: {status}", {
							status: agentAvailabilityLabel(availability.status),
						})}
						className={
							compact
								? "flex size-[24px] items-center justify-center rounded-lg border border-transparent text-white/75 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
								: "flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						}
						type="button"
					/>
				}
			>
				<AgentAvailabilityDot
					className={compact ? "size-2" : undefined}
					status={availability.status}
				/>
				{compact ? null : (
					<span>{agentAvailabilityLabel(availability.status)}</span>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align={compact ? "end" : "start"}
				className="min-w-60"
				side={compact ? "bottom" : "top"}
			>
				<div className="px-3 py-2">
					<p className="font-medium text-sm">Prompt interruptions</p>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{availabilityMenuCaption(availability, tl)}
					</p>
				</div>
				<DropdownMenuSeparator />
				<AvailabilityOptions availability={availability} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** Retain the accessible account submenu alongside the direct availability control. */
export function AvailabilitySubmenu() {
	const tl = useLiteralMessages();
	const availability = useUserAvailability();
	const statusLabel = agentAvailabilityLabel(availability.status);
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger
				aria-label={tl("Online status: {statusLabel}", { statusLabel })}
			>
				<AgentAvailabilityDot status={availability.status} />
				<span className="flex-1">Online status</span>
				<span className="text-muted-foreground text-xs">{statusLabel}</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="min-w-60">
				<AvailabilityOptions availability={availability} />
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
