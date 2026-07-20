// Channels sub-section of the agent-edit Connections group. Channel bots
// (Telegram/Slack/WhatsApp/Discord) are control-plane (`:3000`) configs that
// each carry a `agentId`; this lists the ones bound to THIS agent and links to
// the Channels page to connect more. Channels are not part of the Core agent
// record, so the builder chat can't create them — this is a manual/linked panel.

import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useMemo } from "react";
import {
	SettingsCard,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import { useChannels } from "@/src/hooks/useChannels.ts";
import { CHANNEL_LABELS } from "@/src/lib/api/channels.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";

export function AgentChannelsSection({ agentId }: { agentId: string | null }) {
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const { channels, loading, authed } = useChannels();

	const bound = useMemo(
		() => (agentId ? channels.filter((c) => c.agentId === agentId) : []),
		[channels, agentId]
	);

	return (
		<SettingsSection
			headerAction={
				<div className="flex items-center gap-2">
					{bound.length > 0 ? (
						<Badge variant="secondary">{bound.length}</Badge>
					) : null}
					<Button
						onClick={() => openGateway("channels")}
						size="sm"
						variant="ghost"
					>
						<HugeiconsIcon className="size-4" icon={Add01Icon} />
						Connect
					</Button>
				</div>
			}
			title="Channels"
		>
			<SettingsCard className="flex flex-col gap-2">
				{authed ? null : (
					<p className="text-muted-foreground text-sm">
						Sign in to connect Telegram or Discord bots to this agent.
					</p>
				)}

				{authed && loading ? (
					<div className="flex items-center gap-2 text-muted-foreground text-xs">
						<Spinner className="size-3" />
						Loading channels…
					</div>
				) : null}

				{authed && !loading && bound.length === 0 ? (
					<p className="text-muted-foreground text-sm">
						No channels connected. Use Connect to route a bot's messages to this
						agent.
					</p>
				) : null}

				{bound.length > 0 ? (
					<div className="flex flex-wrap gap-1.5">
						{bound.map((channel) => (
							<Badge className="gap-1.5" key={channel.id} variant="outline">
								<span className="size-1.5 rounded-full bg-success" />
								{channel.name}
								<span className="text-muted-foreground">
									· {CHANNEL_LABELS[channel.channelType]}
								</span>
							</Badge>
						))}
					</div>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
