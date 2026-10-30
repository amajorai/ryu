import { Settings01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AGENT_AVAILABILITY_OPTIONS,
	AgentAvailabilityDot,
	agentAvailabilityLabel,
} from "@ryu/blocks/desktop/agent-availability.tsx";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
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
						<AgentAvailabilityDot
							className="mx-1 size-1.5"
							status={option.value}
						/>
						<span className="flex-1">{option.label}</span>
						{availability.status === option.value ? (
							<HugeiconsIcon
								className="size-4 text-muted-foreground"
								icon={Tick02Icon}
							/>
						) : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuGroup>
			<DropdownMenuSeparator />
			<DropdownMenuItem onClick={() => openSettings("general")}>
				<HugeiconsIcon className="size-4" icon={Settings01Icon} />
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

/**
 * The account menu's availability control. The footer shows the status only as
 * the dot on the avatar; choosing it happens here.
 */
export function AvailabilitySubmenu() {
	const tl = useLiteralMessages();
	const availability = useUserAvailability();
	const statusLabel = agentAvailabilityLabel(availability.status);
	return (
		<DropdownMenuSub>
			<DropdownMenuSubTrigger
				aria-label={tl("Online status: {statusLabel}", { statusLabel })}
			>
				<AgentAvailabilityDot
					className="mx-1 size-1.5"
					status={availability.status}
				/>
				<span className="flex-1">Online status</span>
				<span className="text-muted-foreground text-xs">{statusLabel}</span>
			</DropdownMenuSubTrigger>
			<DropdownMenuSubContent className="min-w-60">
				<p className="px-2 py-1 text-muted-foreground text-xs">
					{availabilityMenuCaption(availability, tl)}
				</p>
				<DropdownMenuSeparator />
				<AvailabilityOptions availability={availability} />
			</DropdownMenuSubContent>
		</DropdownMenuSub>
	);
}
