// Settings → Keyboard Shortcuts → Clips quick attach.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { ClipsQuickAttachDestination } from "@/src/lib/clips-quick-attach.ts";
import {
	openInputMonitoringSettings,
	requestInputMonitoringPermission,
} from "@/src/lib/os/permissions.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

interface ClipsQuickAttachStatus {
	destination: ClipsQuickAttachDestination;
	enabled: boolean;
	error: string | null;
	input_monitoring: boolean;
	listening: boolean;
	supported: boolean;
}

const CLIPS_DESTINATIONS = [
	{ label: "Automatic", value: "automatic" },
	{ label: "Current chat", value: "current_chat" },
	{ label: "New chat", value: "new_chat" },
] satisfies ReadonlyArray<{
	label: string;
	value: ClipsQuickAttachDestination;
}>;

function ClipsDestinationSelect({
	disabled,
	onValueChange,
	value,
}: {
	disabled?: boolean;
	onValueChange: (value: ClipsQuickAttachDestination) => void;
	value: ClipsQuickAttachDestination;
}) {
	return (
		<Select<ClipsQuickAttachDestination>
			disabled={disabled}
			items={CLIPS_DESTINATIONS}
			onValueChange={onValueChange}
			value={value}
		>
			<SelectTrigger aria-label="Clips destination" className="h-8 w-52">
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="end" className="min-w-80">
				<SelectItem textValue="Automatic" value="automatic">
					<span className="flex min-w-0 flex-col whitespace-normal leading-snug">
						<span>Automatic</span>
						<span className="font-normal text-muted-foreground text-xs">
							Use the selected chat when a chat tab is active. Otherwise start a
							new chat.
						</span>
					</span>
				</SelectItem>
				<SelectItem textValue="Current chat" value="current_chat">
					<span className="flex min-w-0 flex-col whitespace-normal leading-snug">
						<span>Current chat</span>
						<span className="font-normal text-muted-foreground text-xs">
							Always use the selected chat. If none is active, quick attach
							reports an error.
						</span>
					</span>
				</SelectItem>
				<SelectItem textValue="New chat" value="new_chat">
					<span className="flex min-w-0 flex-col whitespace-normal leading-snug">
						<span>New chat</span>
						<span className="font-normal text-muted-foreground text-xs">
							Always start a new chat.
						</span>
					</span>
				</SelectItem>
			</SelectContent>
		</Select>
	);
}

function isMacOS(): boolean {
	return "navigator" in globalThis && navigator.userAgent.includes("Mac");
}

export function ClipsQuickAttachSettings() {
	const tl = useLiteralMessages();
	const [status, setStatus] = useState<ClipsQuickAttachStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setStatus(
				await invoke<ClipsQuickAttachStatus>("clips_quick_attach_status")
			);
		} catch {
			setStatus(null);
		}
	}, []);

	useEffect(() => {
		void refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [refresh]);

	const toggle = async (enabled: boolean) => {
		setBusy(true);
		try {
			const updated = await invoke<ClipsQuickAttachStatus>(
				"clips_quick_attach_set_enabled",
				{ enabled }
			);
			setStatus(updated);
			if (enabled && !updated.listening) {
				toast.error({
					title: "Clips quick attach couldn't start",
					description:
						updated.error ?? "Grant Input Monitoring to Ryu, then try again.",
				});
			}
		} catch (error) {
			toast.error({
				title: "Clips quick attach couldn't start",
				description: error instanceof Error ? error.message : String(error),
			});
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	const changeDestination = async (
		destination: ClipsQuickAttachDestination
	) => {
		setBusy(true);
		try {
			setStatus(
				await invoke<ClipsQuickAttachStatus>(
					"clips_quick_attach_set_destination",
					{ destination }
				)
			);
		} catch (error) {
			toast.error({
				title: "Couldn't save Clips destination",
				description: error instanceof Error ? error.message : String(error),
			});
			await refresh();
		} finally {
			setBusy(false);
		}
	};

	if (!status) {
		return null;
	}

	if (!status.supported) {
		return (
			<SettingsSection
				caption="Clips quick attach is supported on macOS and Windows."
				title="Clips quick attach"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								aria-label="Attach recent activity to a chat"
								checked={false}
								disabled
							/>
						}
						title="Attach recent activity to a chat"
					/>
					<SettingsItem
						actions={
							<ClipsDestinationSelect
								disabled
								onValueChange={() => undefined}
								value={status.destination}
							/>
						}
						title="Clips destination"
					/>
				</SettingsGroup>
			</SettingsSection>
		);
	}

	const shortcut = isMacOS() ? "Command twice" : "Alt twice";
	return (
		<SettingsSection
			caption={tl(
				"Press {shortcut} to attach recent activity. Ryu never sends it automatically.",
				{ shortcut }
			)}
			title="Clips quick attach"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Attach recent activity to a chat"
							checked={status.enabled}
							disabled={busy}
							onCheckedChange={toggle}
						/>
					}
					description={tl(
						"{shortcut} captures the last three minutes as staged image attachments and a visible summary.",
						{ shortcut }
					)}
					title="Attach recent activity to a chat"
				/>
				<SettingsItem
					actions={
						<ClipsDestinationSelect
							disabled={busy}
							onValueChange={(destination) =>
								void changeDestination(destination)
							}
							value={status.destination}
						/>
					}
					title="Clips destination"
				/>

				{isMacOS() ? (
					<SettingsItem
						actions={
							status.input_monitoring ? (
								<span className="text-muted-foreground text-xs">Granted</span>
							) : (
								<Button
									onClick={async () => {
										await requestInputMonitoringPermission();
										await openInputMonitoringSettings();
										await refresh();
									}}
									size="sm"
									variant="ghost"
								>
									Grant
								</Button>
							)
						}
						description="Required on macOS so Ryu can recognize the double-Command gesture."
						title="Input Monitoring"
					/>
				) : null}

				{status.error ? (
					<SettingsItem
						description={status.error}
						title="Last Capture Failed"
					/>
				) : null}
			</SettingsGroup>
		</SettingsSection>
	);
}
