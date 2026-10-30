import { Tick01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { MODES } from "./appearance-tab-model.ts";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import { ThemePanel } from "./appearance-theme-panel.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export function AppearanceThemeIntro({ state }: { state: AppearanceTabState }) {
	const {
		theme,
		setTheme,
		lightPresetId,
		darkPresetId,
		lightTokens,
		darkTokens,
		lightBaseTokens,
		darkBaseTokens,
		lightDirty,
		darkDirty,
		lightGroups,
		darkGroups,
		lightSaveDialog,
		setLightSaveDialog,
		darkSaveDialog,
		setDarkSaveDialog,
		lightSaveName,
		setLightSaveName,
		darkSaveName,
		setDarkSaveName,
		pendingCustomPresetIds,
		handleLightPreset,
		handleDarkPreset,
		handleLightTokenChange,
		handleDarkTokenChange,
		handleLightSaveConfirm,
		handleDarkSaveConfirm,
		handleLightDelete,
		handleDarkDelete,
		handleLightDiscard,
		handleDarkDiscard,
	} = state;
	return (
		<div>
			<SettingsSection title="Theme">
				<SettingsCard className="flex gap-4">
					{MODES.map(({ value, label, image }) => (
						<label
							className="flex cursor-pointer flex-col items-center gap-2"
							key={value}
						>
							<input
								checked={theme === value}
								className="sr-only"
								name="theme"
								onChange={() => setTheme(value)}
								type="radio"
								value={value}
							/>
							{/* dynamic remote logo URL */}
							<img
								alt={label}
								className={cn(
									"rounded-lg border border-border transition-shadow duration-150",
									theme === value &&
										"ring-2 ring-ring ring-offset-2 ring-offset-background"
								)}
								height={70}
								src={image}
								width={88}
							/>
							<span className="flex items-center gap-1 font-medium text-xs">
								{theme === value ? (
									<HugeiconsIcon className="size-3.5" icon={Tick01Icon} />
								) : (
									<span className="size-3.5" />
								)}
								<span
									className={theme === value ? "" : "text-muted-foreground"}
								>
									{label}
								</span>
							</span>
						</label>
					))}
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Color theme">
				<SettingsCard className="grid grid-cols-2 gap-6">
					<ThemePanel
						baseTokens={lightBaseTokens}
						dirty={lightDirty}
						groups={lightGroups}
						label="Light"
						mode="light"
						onDeletePreset={handleLightDelete}
						onDiscardClick={handleLightDiscard}
						onSaveCancel={() => {
							pendingCustomPresetIds.current.light = null;
							setLightSaveDialog(false);
						}}
						onSaveClick={() => setLightSaveDialog(true)}
						onSaveConfirm={handleLightSaveConfirm}
						onSaveNameChange={setLightSaveName}
						onSelectPreset={handleLightPreset}
						onTokenChange={handleLightTokenChange}
						saveDialogOpen={lightSaveDialog}
						saveName={lightSaveName}
						selectedId={lightPresetId}
						tokens={lightTokens}
					/>
					<ThemePanel
						baseTokens={darkBaseTokens}
						dirty={darkDirty}
						groups={darkGroups}
						label="Dark"
						mode="dark"
						onDeletePreset={handleDarkDelete}
						onDiscardClick={handleDarkDiscard}
						onSaveCancel={() => {
							pendingCustomPresetIds.current.dark = null;
							setDarkSaveDialog(false);
						}}
						onSaveClick={() => setDarkSaveDialog(true)}
						onSaveConfirm={handleDarkSaveConfirm}
						onSaveNameChange={setDarkSaveName}
						onSelectPreset={handleDarkPreset}
						onTokenChange={handleDarkTokenChange}
						saveDialogOpen={darkSaveDialog}
						saveName={darkSaveName}
						selectedId={darkPresetId}
						tokens={darkTokens}
					/>
				</SettingsCard>
			</SettingsSection>
		</div>
	);
}
