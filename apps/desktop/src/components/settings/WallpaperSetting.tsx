// apps/desktop/src/components/settings/WallpaperSetting.tsx
//
// Appearance → "Wallpaper": the device-level backdrop shared by OS and the
// startup account/node chooser. The picker and store live in
// components/wallpaper and lib/wallpaper.ts so every surface edits one value.

import {
	WallpaperPicker,
	WallpaperPreview,
} from "../wallpaper/WallpaperPicker.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export function WallpaperSetting() {
	return (
		<SettingsSection
			caption="Shown on OS and the account chooser. Saved on this device."
			title="Wallpaper"
		>
			<SettingsCard className="space-y-4">
				<WallpaperPreview />
				<WallpaperPicker />
			</SettingsCard>
		</SettingsSection>
	);
}
