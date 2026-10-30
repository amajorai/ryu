import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import {
	TERMINAL_PANEL_LOCATION_VALUES,
	useTerminalPanelLocation,
} from "@/src/hooks/useTerminalPanelLocation.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import {
	DEFAULT_FILE_OPENER_OPTIONS,
	FILE_MANAGER_NAME,
	TERMINAL_LOCATION_LABELS,
	TERMINAL_SHELL_OPTIONS,
} from "./GeneralTab-options.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

/** General → Terminal. */
export function GeneralTabTerminalPage() {
	const terminalShell = useWorkspaceStore((s) => s.terminalShell);
	const setTerminalShell = useWorkspaceStore((s) => s.setTerminalShell);
	const [terminalPanelLocation, setTerminalPanelLocationPreference] =
		useTerminalPanelLocation();

	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<ToggleGroup
							appearance="segmented"
							aria-label="Default terminal location"
							onValueChange={(values: string[]) => {
								const value = values[0];
								if (value === "bottom" || value === "right") {
									setTerminalPanelLocationPreference(value);
								}
							}}
							spacing={0}
							value={[terminalPanelLocation]}
							variant="default"
						>
							{TERMINAL_PANEL_LOCATION_VALUES.map((value) => (
								<ToggleGroupItem density="segmented" key={value} value={value}>
									{TERMINAL_LOCATION_LABELS[value]}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					}
					description="Where the terminal shortcut opens new terminal tabs."
					settingsId="general.terminal.panel-location"
					title="Default terminal location"
				/>
				<SettingsItem
					actions={
						<Select
							items={TERMINAL_SHELL_OPTIONS}
							onValueChange={(value) => {
								if (value) {
									setTerminalShell(value);
								}
							}}
							value={terminalShell}
						>
							<SelectTrigger
								className="w-auto max-w-64 shrink-0"
								id="terminal-shell-select"
								size="sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TERMINAL_SHELL_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Used by the terminal and git actions. OS default follows the platform."
					title="Default shell"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

/** General → Files. */
export function GeneralTabFilesPage() {
	const tl = useLiteralMessages();
	const defaultFileOpener = useWorkspaceStore((s) => s.defaultFileOpener);
	const setDefaultFileOpener = useWorkspaceStore((s) => s.setDefaultFileOpener);

	return (
		<SettingsSection>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Select
							items={DEFAULT_FILE_OPENER_OPTIONS}
							onValueChange={(value) => {
								if (
									value === "system" ||
									value === "vscode" ||
									value === "cursor" ||
									value === "zed"
								) {
									setDefaultFileOpener(value);
								}
							}}
							value={defaultFileOpener}
						>
							<SelectTrigger
								className="w-auto max-w-64 shrink-0"
								id="default-file-opener-select"
								size="sm"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DEFAULT_FILE_OPENER_OPTIONS.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description={tl(
						"What the file tree's Open action uses. OS default is {fileManager}.",
						{ fileManager: FILE_MANAGER_NAME }
					)}
					settingsId="general.files.default-file-open-destination"
					title="Default file open destination"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
