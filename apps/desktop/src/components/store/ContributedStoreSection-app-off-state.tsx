import { Download01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InstallProgressButton } from "@ryu/blocks/desktop/install-button.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useState } from "react";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import type { PluginStoreTab } from "@/src/lib/api/plugins.ts";
import { TabIcon } from "./ContributedStoreSection-tab-icon.tsx";

/**
 * The prompt shown when a contributed tab's owning app is not installed, or is
 * installed but disabled. The tab itself is always listed (that is the point — this
 * is where the app gets installed from), but its catalog lives behind the app's own
 * route gate, so there is nothing to fetch until the app is on.
 */
export function AppOffState({
	tab,
	onEnabled,
}: {
	onEnabled: () => void;
	tab: PluginStoreTab;
}) {
	const tl = useLiteralMessages();
	const { install, toggle } = useApps();
	const [busy, setBusy] = useState(false);
	// An installed-but-disabled app can be configured before it is turned on — that
	// is often the point (paste the key, then enable). Absent for an app that isn't
	// installed yet: there is nothing on this node to configure.
	const openSettings = usePluginSettingsOpener()(tab.plugin);

	const handleEnable = async () => {
		setBusy(true);
		try {
			if (!tab.app_installed) {
				await install(tab.plugin);
			}
			const outcome = await toggle(tab.plugin, true);
			if (!outcome.success) {
				throw new Error(outcome.error);
			}
			toast.success(tl("{title} is ready", { title: tab.title }));
			onEnabled();
		} catch (e) {
			toast.error("Couldn't enable the app", {
				description: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<Empty className="h-full" inset="dense">
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<TabIcon icon={tab.icon} />
				</EmptyMedia>
				<EmptyTitle>{tl("Turn on {title}", { title: tab.title })}</EmptyTitle>
				<EmptyDescription>
					{tab.subtitle ??
						"This catalog is provided by an app that isn't running yet."}
				</EmptyDescription>
			</EmptyHeader>
			<div className="flex items-center gap-2">
				<InstallProgressButton installing={busy} onClick={handleEnable}>
					<HugeiconsIcon className="size-4" icon={Download01Icon} />
					{tab.app_installed ? "Enable" : "Add"}
				</InstallProgressButton>
				{openSettings ? (
					<Button onClick={openSettings} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Settings01Icon} />
						Settings
					</Button>
				) : null}
			</div>
		</Empty>
	);
}
