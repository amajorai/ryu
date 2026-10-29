// Channel-bot management as a standalone tab page (ported out of the Gateway
// settings dialog). Configs live in the control-plane server (lib/api/channels.ts
// → :3000) and are account-global — not scoped to the active Core node. A bot
// routes to a single agent OR a team. Secrets are write-only: existing tokens
// are never shown; leaving a credential field blank on edit keeps the stored
// value.

import {
	type ChannelConfigView,
	type ChannelSavePayload,
	ChannelsView,
	type ChannelType,
	defaultReactionLearningSettings,
} from "@ryu/blocks/desktop/channels.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { DestructiveConfirmDialog } from "@/src/components/ui/DestructiveConfirmDialog.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import { useCanManagePermission } from "@/src/hooks/useGatewayConfigurable.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import {
	type ChannelConfig,
	type ChannelInput,
	channelPlatformOptionsSchema,
} from "@/src/lib/api/channels.ts";

function toView(
	c: ChannelConfig,
	overrides: Pick<ChannelConfigView, "bindingWarning"> = {}
): ChannelConfigView {
	return {
		id: c.id,
		name: c.name,
		channelType: c.channelType,
		credentialSource: c.credentialSource,
		enabled: c.enabled,
		agentId: c.agentId,
		teamId: c.teamId,
		groupReplyMode: c.groupReplyMode ?? "mentions",
		model: c.model,
		managedBotId: c.managedBotId,
		managedBotUsername: c.managedBotUsername,
		managedProvisioningState: c.managedProvisioningState,
		systemPrompt: c.systemPrompt,
		provisionedServerId: c.provisionedServerId,
		platformOptions: c.platformOptions ?? {},
		secrets: c.secrets ?? {},
		// Behaviour settings round-trip unmasked (they are configuration, not
		// credentials). Each falls back to the server's own default so a bot saved
		// before the field existed still opens with a coherent form.
		dmPolicy: c.dmPolicy ?? "pairing",
		groupPolicy: c.groupPolicy ?? "allowlist",
		dmAllowlist: c.dmAllowlist ?? [],
		groupAllowlist: c.groupAllowlist ?? [],
		groupUserAllowlist: c.groupUserAllowlist ?? [],
		lifecycleReactions: c.lifecycleReactions ?? true,
		proactiveOpening: c.proactiveOpening ?? false,
		proactiveTarget: c.proactiveTarget ?? null,
		typingIndicator: c.typingIndicator ?? true,
		publishCommands: c.publishCommands ?? true,
		richText: c.richText ?? true,
		streaming: c.streaming ?? false,
		voiceReply: c.voiceReply ?? "never",
		threadReplies: c.threadReplies ?? false,
		sendReadReceipts: c.sendReadReceipts ?? true,
		profileName: c.profileName ?? null,
		profileShortBio: c.profileShortBio ?? null,
		profileDescription: c.profileDescription ?? null,
		reactionLearning: c.reactionLearning ?? defaultReactionLearningSettings(),
		...overrides,
	};
}

/**
 * The behaviour settings the form edits, lifted off the save payload.
 *
 * Listed explicitly rather than spread wholesale: the payload also carries
 * `secrets`, which the update path deliberately omits when nothing changed, so a
 * blanket spread would put an empty secrets map back on the wire and look like
 * an intentional clear.
 */
function behaviorFields(payload: ChannelSavePayload) {
	return {
		dmPolicy: payload.dmPolicy,
		groupPolicy: payload.groupPolicy,
		dmAllowlist: payload.dmAllowlist,
		groupAllowlist: payload.groupAllowlist,
		groupUserAllowlist: payload.groupUserAllowlist,
		reactionLearning: payload.reactionLearning,
		lifecycleReactions: payload.lifecycleReactions,
		proactiveOpening: payload.proactiveOpening,
		proactiveTarget: payload.proactiveTarget,
		typingIndicator: payload.typingIndicator,
		publishCommands: payload.publishCommands,
		richText: payload.richText,
		streaming: payload.streaming,
		voiceReply: payload.voiceReply,
		threadReplies: payload.threadReplies,
		sendReadReceipts: payload.sendReadReceipts,
		profileName: payload.profileName,
		profileShortBio: payload.profileShortBio,
		profileDescription: payload.profileDescription,
	};
}

export default function ChannelsPage({
	initialNew = false,
	initialSelectedId = null,
	initialChannelType,
}: {
	initialNew?: boolean;
	initialSelectedId?: string | null;
	initialChannelType?: ChannelType;
}) {
	const tl = useLiteralMessages();
	const { channels, loading, error, authed, create, update, remove } =
		useChannels();
	const { agents } = useAgents();
	const activeAgents = agents.filter(
		(agent) => agent.lifecycleStatus === "active"
	);
	const { teams } = useTeams();
	const canDelete = useCanManagePermission("channel.delete");
	// Adapter types contributed by enabled plugins — surfaced as disabled options
	// in the create picker (functional channels await the plugin runtime).
	const { channels: pluginChannels } = usePluginContributions();

	const [saving, setSaving] = useState(false);
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);

	const handleSave = async (
		payload: ChannelSavePayload,
		ctx: { isNew: boolean; id: string | null }
	): Promise<boolean> => {
		setSaving(true);
		try {
			const hasSecrets = Object.keys(payload.secrets).length > 0;
			if (ctx.isNew) {
				await create({
					channelType: payload.channelType,
					name: payload.name,
					secrets: payload.secrets,
					agentId: payload.agentId,
					teamId: payload.teamId,
					groupReplyMode: payload.groupReplyMode,
					platformOptions: channelPlatformOptionsSchema.parse(
						payload.platformOptions
					),
					model: payload.model,
					systemPrompt: payload.systemPrompt,
					enabled: payload.enabled,
					...behaviorFields(payload),
				});
			} else if (ctx.id) {
				const input: Partial<ChannelInput> = { name: payload.name };
				if (hasSecrets) {
					input.secrets = payload.secrets;
				}
				Object.assign(input, {
					agentId: payload.agentId,
					teamId: payload.teamId,
					groupReplyMode: payload.groupReplyMode,
					platformOptions: channelPlatformOptionsSchema.parse(
						payload.platformOptions
					),
					model: payload.model,
					systemPrompt: payload.systemPrompt,
					enabled: payload.enabled,
					...behaviorFields(payload),
				});
				await update(ctx.id, input);
			}
			return true;
		} catch {
			// The view surfaces validation errors; backend errors fall back to the
			// list error state on next refresh.
			return false;
		} finally {
			setSaving(false);
		}
	};

	const requestDelete = (id: string) => {
		if (!canDelete) {
			return false;
		}
		setPendingDeleteId(id);
		return false;
	};

	const confirmDelete = async () => {
		if (!pendingDeleteId) {
			return false;
		}
		setDeleting(true);
		try {
			await remove(pendingDeleteId);
			setPendingDeleteId(null);
			return true;
		} catch {
			toast.error("Couldn't delete this channel", {
				description: "The bot configuration was kept. Please try again.",
			});
			return false;
		} finally {
			setDeleting(false);
		}
	};
	const pendingDelete = channels.find(
		(channel) => channel.id === pendingDeleteId
	);

	// Sidebar is the channel picker; this page is create/edit only (no in-page
	// list). Bots are account-global on the gateway — not scoped to the active node.
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="min-h-0 flex-1 overflow-hidden">
				<ChannelsView
					agents={activeAgents.map((a) => ({ id: a.id, name: a.name }))}
					authed={authed}
					canDelete={canDelete}
					channels={channels.map((channel) =>
						toView(channel, {
							bindingWarning:
								channel.agentId &&
								!agents.some((agent) => agent.id === channel.agentId)
									? "This channel was reverted to the default agent because its original agent was deleted. Rebind it to another agent to clear this warning."
									: null,
						})
					)}
					error={error}
					initialChannelType={initialChannelType}
					initialNew={initialNew}
					initialSelectedId={initialSelectedId}
					loading={loading}
					onDelete={requestDelete}
					onSave={handleSave}
					pluginPlatforms={pluginChannels.map((c) => ({
						id: c.id,
						name: c.name,
						platform: c.platform,
					}))}
					saving={saving}
					teams={teams.map((t) => ({ id: t.id, name: t.name }))}
				/>
			</div>
			<DestructiveConfirmDialog
				busy={deleting}
				description="The bot credentials and channel configuration will be deleted. Its shared Core session history will stay available to desktop and other channel participants."
				impact={
					<p className="text-muted-foreground">
						Deleting this channel does not delete the agent or the conversation
						history.
					</p>
				}
				label={
					pendingDelete
						? tl("Delete {channelName}", { channelName: pendingDelete.name })
						: tl("Delete this channel")
				}
				onConfirm={confirmDelete}
				onOpenChange={(open) => {
					if (!(open || deleting)) {
						setPendingDeleteId(null);
					}
				}}
				open={pendingDeleteId !== null}
				title={
					pendingDelete
						? tl("Delete {channelName}?", { channelName: pendingDelete.name })
						: tl("Delete this channel?")
				}
			/>
		</div>
	);
}
