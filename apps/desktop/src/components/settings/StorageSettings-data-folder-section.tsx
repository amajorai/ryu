import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { DataPathInfo } from "@/src/lib/api/data-path.ts";
import { humanBytes } from "./StorageSettings-model.ts";

export function DataFolderSection({
	busy,
	canUseNativeShell,
	doReset,
	info,
	loadFailed,
	refresh,
}: {
	busy: boolean;
	canUseNativeShell: boolean;
	doReset: () => Promise<void>;
	info: DataPathInfo | null;
	loadFailed: boolean;
	refresh: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<SettingsSection
			caption="Where Ryu stores everything on this device: chats, spaces, memory, models and downloaded engines. Relocate it to put large model files on another disk."
			title="Data folder"
		>
			{loadFailed ? (
				<SettingsCard className="flex items-center justify-between gap-3">
					<p className="text-muted-foreground text-sm">
						We couldn't load your data folder details. Please check your
						connection and try again.
					</p>
					<Button onClick={() => refresh()} size="sm" variant="outline">
						Retry
					</Button>
				</SettingsCard>
			) : (
				<SettingsGroup>
					<SettingsItem title="Current location">
						<p className="break-all pb-1 font-mono text-muted-foreground text-xs">
							{info?.current ?? "Loading…"}
						</p>
					</SettingsItem>
					<SettingsItem
						actions={
							<span className="text-muted-foreground text-sm">
								{info
									? tl("{used} used · {free} free on this drive", {
											used: humanBytes(info.size_bytes),
											free: humanBytes(info.free_space_bytes),
										})
									: "—"}
							</span>
						}
						title="Size"
					/>
					{canUseNativeShell && info?.is_custom ? (
						<SettingsItem
							actions={
								<Button
									disabled={busy}
									onClick={() => {
										doReset().catch(() => undefined);
									}}
									size="sm"
									variant="ghost"
								>
									Reset to default
								</Button>
							}
							title="Default location"
						>
							<p className="break-all pb-1 font-mono text-muted-foreground text-xs">
								{info.default}
							</p>
						</SettingsItem>
					) : null}
				</SettingsGroup>
			)}
		</SettingsSection>
	);
}
