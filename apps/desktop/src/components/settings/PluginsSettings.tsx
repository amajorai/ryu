// apps/desktop/src/components/settings/PluginsSettings.tsx
//
// The App Settings "Plugins" section: every enabled plugin that declares
// configurable settings (`contributes.settings_tabs`), each rendered as its own
// section of editable fields. Mirrors the inline per-plugin settings on the Store
// card, but centralizes them in one place — the same way Gateway settings live
// under their own section. Plugins with no declared settings never appear here.

import { PackageIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginSettingsTabs } from "@/src/hooks/usePluginSettingsTabs.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { PluginSettingsFields } from "./PluginSettingsFields.tsx";
import { SettingsSection } from "./shared/settings-items.tsx";

export function PluginsSettings() {
	const target = toTarget(useActiveNode());
	const { byPlugin, loading, error, reload } = usePluginSettingsTabs();
	const { apps } = useApps();

	const nameFor = (pluginId: string): string =>
		apps.find((a) => a.id === pluginId)?.name ?? pluginId;

	if (loading) {
		return (
			<p className="text-muted-foreground text-sm">Loading plugin settings…</p>
		);
	}

	if (error) {
		return (
			<div className="space-y-3">
				<p className="text-muted-foreground text-sm">
					We couldn't load plugin settings. Check your connection and try again.
				</p>
				<Button onClick={reload} size="sm" variant="outline">
					Retry
				</Button>
			</div>
		);
	}

	if (byPlugin.size === 0) {
		return (
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={PackageIcon} />
					</EmptyMedia>
					<EmptyTitle>No plugin settings</EmptyTitle>
					<EmptyDescription>
						Enabled plugins that expose configurable settings show up here.
						Install and enable a plugin from the store to configure it.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="space-y-6">
			{[...byPlugin.entries()].map(([pluginId, tabs]) => (
				<SettingsSection key={pluginId} title={nameFor(pluginId)}>
					<PluginSettingsFields
						hideTabTitles={tabs.length === 1}
						tabs={tabs}
						target={target}
					/>
				</SettingsSection>
			))}
		</div>
	);
}
