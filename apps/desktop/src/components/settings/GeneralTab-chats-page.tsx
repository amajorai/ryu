import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { useAutoImportThreads } from "@/src/hooks/useAutoImportThreads.ts";
import { useAutoSetupImportSetting } from "@/src/hooks/useAutoSetupImportSetting.ts";
import { useComposerSelectionApplyMode } from "@/src/hooks/useComposerSelectionApplyMode.ts";
import {
	COMPOSER_SEND_SHORTCUT_OPTIONS,
	type ComposerSendShortcut,
	useComposerSendShortcut,
} from "@/src/hooks/useComposerSendShortcut.ts";
import {
	type QueueDrainMode,
	setQueueDrainMode,
	useQueueDrainMode,
} from "@/src/hooks/useQueueDrainMode.ts";
import { AvailabilitySettings } from "./AvailabilitySettings.tsx";
import {
	COMPOSER_SELECTION_APPLY_OPTIONS,
	QUEUE_DRAIN_OPTIONS,
} from "./GeneralTab-options.ts";
import { ResumeInterruptedChatsSetting } from "./ResumeInterruptedChatsSetting.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** General → Chats. */
export function GeneralTabChatsPage() {
	const queueDrainMode = useQueueDrainMode();
	const [composerSendShortcut, setComposerSendShortcut] =
		useComposerSendShortcut();
	const [composerSelectionApplyMode, setComposerSelectionApplyModeSetting] =
		useComposerSelectionApplyMode();
	const [autoImportThreads, setAutoImportThreads] = useAutoImportThreads();
	const [autoImportSetup, setAutoImportSetup] = useAutoSetupImportSetting();

	return (
		<>
			<AvailabilitySettings />
			<SettingsSection title="Chats">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={autoImportThreads}
								id="auto-import-threads-toggle"
								onCheckedChange={setAutoImportThreads}
							/>
						}
						description="Keep threads from Claude Code, Codex and other agents synced into Ryu."
						title="Auto-import agent threads"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={autoImportSetup}
								id="auto-import-setup-toggle"
								onCheckedChange={setAutoImportSetup}
							/>
						}
						description="Keep AGENTS.md and CLAUDE.md synced from your agent config folders."
						title="Auto-import agent setup"
					/>
					<ResumeInterruptedChatsSetting />
					<SettingsItem
						actions={
							<Select
								items={COMPOSER_SEND_SHORTCUT_OPTIONS}
								onValueChange={(value) => {
									if (
										value === "enter" ||
										value === "shift-enter" ||
										value === "command-enter"
									) {
										setComposerSendShortcut(value);
									}
								}}
								value={composerSendShortcut}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="composer-send-shortcut-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{COMPOSER_SEND_SHORTCUT_OPTIONS.map((option) => (
										<SelectItem
											key={option.value}
											value={option.value satisfies ComposerSendShortcut}
										>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Send shortcut"
					/>
					<SettingsItem
						actions={
							<Select<QueueDrainMode>
								items={QUEUE_DRAIN_OPTIONS}
								onValueChange={(v) => setQueueDrainMode(v)}
								value={queueDrainMode}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="queue-drain-mode-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{QUEUE_DRAIN_OPTIONS.map((opt) => (
										<SelectItem key={opt.value} value={opt.value}>
											{opt.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						description="How messages you send while an agent is replying are delivered."
						title="Queued messages send"
					/>
					<SettingsItem
						actions={
							<Select
								items={COMPOSER_SELECTION_APPLY_OPTIONS}
								onValueChange={(value) => {
									if (value === "next-turn" || value === "next-user-message") {
										setComposerSelectionApplyModeSetting(value);
									}
								}}
								value={composerSelectionApplyMode}
							>
								<SelectTrigger
									className="w-auto max-w-64 shrink-0"
									id="composer-selection-apply-mode-select"
									size="sm"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{COMPOSER_SELECTION_APPLY_OPTIONS.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						}
						title="Composer selection changes"
					/>
				</SettingsGroup>
			</SettingsSection>
		</>
	);
}
