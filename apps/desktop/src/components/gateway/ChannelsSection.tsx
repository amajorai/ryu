// apps/desktop/src/components/gateway/ChannelsSection.tsx
//
// Channel-bot management, hosted inside the Gateway settings dialog. Channels
// are a gateway concern (the gateway runs the platform listeners), so this lives
// under Gateway → Channels rather than as a standalone page.
//
// It is a thin container: it loads channel configs, agents, and teams via hooks
// and renders the presentational `ChannelsView` from `@ryu/blocks/desktop/channels`
// (shared with the storyboard). Configs live in the control-plane server
// (lib/api/channels.ts → :3000) and are account-global — unlike the rest of the
// gateway dialog, they are not scoped to the active Core node. A bot routes to a
// single agent OR a team (whose lead agent orchestrates the members). Secrets are
// write-only: existing tokens are never shown; leaving a credential field blank on
// edit keeps the stored value.

import {
	type ChannelConfigView,
	type ChannelSavePayload,
	ChannelsView,
} from "@ryu/blocks/desktop/channels";
import { useState } from "react";
import { SettingsSection } from "@/src/components/settings/shared/settings-items.tsx";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useChannels } from "@/src/hooks/useChannels.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useTeams } from "@/src/hooks/useTeams.ts";
import type { ChannelConfig } from "@/src/lib/api/channels.ts";

function toView(c: ChannelConfig): ChannelConfigView {
	return {
		id: c.id,
		name: c.name,
		channelType: c.channelType,
		enabled: c.enabled,
		agentId: c.agentId,
		teamId: c.teamId,
		groupReplyMode: c.groupReplyMode ?? "mentions",
		model: c.model,
		systemPrompt: c.systemPrompt,
		secrets: c.secrets ?? {},
	};
}

export function ChannelsSection() {
	const { channels, loading, error, authed, create, update, remove } =
		useChannels();
	const { agents } = useAgents();
	const { teams } = useTeams();
	// Adapter types contributed by enabled plugins — surfaced as disabled options
	// in the create picker (functional channels await the plugin runtime).
	const { channels: pluginChannels } = usePluginContributions();

	const [saving, setSaving] = useState(false);

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
					model: payload.model,
					systemPrompt: payload.systemPrompt,
					enabled: payload.enabled,
				});
			} else if (ctx.id) {
				await update(ctx.id, {
					name: payload.name,
					...(hasSecrets ? { secrets: payload.secrets } : {}),
					agentId: payload.agentId,
					teamId: payload.teamId,
					groupReplyMode: payload.groupReplyMode,
					model: payload.model,
					systemPrompt: payload.systemPrompt,
					enabled: payload.enabled,
				});
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

	const handleDelete = async (id: string) => {
		const channel = channels.find((c) => c.id === id);
		if (!window.confirm(`Delete the "${channel?.name ?? id}" bot?`)) {
			return;
		}
		try {
			await remove(id);
		} catch {
			// Surfaced via the list error state on next refresh.
		}
	};

	// Render through the shared SettingsSection so this reads as a native gateway
	// dialog section (header + caption + the iOS-grouped `bg-muted/40` surface),
	// not a one-off bordered card. The shared ChannelsView is a full-height
	// master-detail layout and the dialog content pane is scroll-bounded, so the
	// surface gets a definite height for its internal list/form scroll regions to
	// resolve against.
	return (
		<SettingsSection caption="Channel bots run on the gateway and are account-global — not scoped to the active node. A bot routes to a single agent or a team.">
			<div className="h-[60vh] min-h-[420px] overflow-hidden rounded-[10px] bg-muted/40">
				<ChannelsView
					agents={agents.map((a) => ({ id: a.id, name: a.name }))}
					authed={authed}
					channels={channels.map(toView)}
					error={error}
					loading={loading}
					onDelete={handleDelete}
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
		</SettingsSection>
	);
}
