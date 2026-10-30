import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type FileTreePrefs,
	fileTreePrefsToOptions,
	setFileTreePrefs,
} from "@/src/hooks/useFileTreePrefs.ts";
import {
	TREE_DARK_THEMES,
	TREE_LIGHT_THEMES,
} from "@/src/lib/pierre-themes.ts";
import {
	FILE_TREE_DENSITY_OPTIONS,
	FILE_TREE_EXPANSION_OPTIONS,
	FILE_TREE_ICON_OPTIONS,
	FILE_TREE_SEARCH_MODE_OPTIONS,
	FileTreePreview,
} from "./appearance-options.tsx";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function AppearanceFilesPage({ state }: { state: AppearanceTabState }) {
	const { fileTreePrefs, treePreviewStyle, treePreviewClasses } = state;
	return (
		<SettingsSection caption="How the workspace Files tab renders your project.">
			<SettingsCard className="mb-2 overflow-hidden rounded-xl border border-border">
				<div className="border-border border-b px-3 py-1.5 text-muted-foreground text-xs">
					Live preview
				</div>
				<div className="h-52 overflow-hidden text-xs">
					{/* Keyed on the constructor-time options only — theme rides in as
						    host CSS variables and must not force a remount. */}
					<FileTreePreview
						className={treePreviewClasses}
						key={JSON.stringify(fileTreePrefsToOptions(fileTreePrefs))}
						prefs={fileTreePrefs}
						style={treePreviewStyle}
					/>
				</div>
			</SettingsCard>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Select<FileTreePrefs["density"]>
							items={FILE_TREE_DENSITY_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setFileTreePrefs({
									density: v,
								});
							}}
							value={fileTreePrefs.density}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FILE_TREE_DENSITY_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Density"
				/>
				<SettingsItem
					actions={
						<Select
							items={TREE_LIGHT_THEMES}
							onValueChange={(v) => {
								if (v != null) {
									setFileTreePrefs({ lightTheme: v });
								}
							}}
							value={fileTreePrefs.lightTheme}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TREE_LIGHT_THEMES.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Match app theme keeps the tree on the app's own colors."
					settingsId="appearance.file-tree.light-theme"
					title="Light theme"
				/>
				<SettingsItem
					actions={
						<Select
							items={TREE_DARK_THEMES}
							onValueChange={(v) => {
								if (v != null) {
									setFileTreePrefs({ darkTheme: v });
								}
							}}
							value={fileTreePrefs.darkTheme}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{TREE_DARK_THEMES.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					settingsId="appearance.file-tree.dark-theme"
					title="Dark theme"
				/>
				<SettingsItem
					actions={
						<Select<FileTreePrefs["iconSet"]>
							items={FILE_TREE_ICON_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setFileTreePrefs({
									iconSet: v,
								});
							}}
							value={fileTreePrefs.iconSet}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FILE_TREE_ICON_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Icons"
				/>
				<SettingsItem
					actions={
						<Select<FileTreePrefs["searchMode"]>
							items={FILE_TREE_SEARCH_MODE_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setFileTreePrefs({
									searchMode: v,
								});
							}}
							value={fileTreePrefs.searchMode}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FILE_TREE_SEARCH_MODE_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Search mode"
				/>
				<SettingsItem
					actions={
						<Select<FileTreePrefs["initialExpansion"]>
							items={FILE_TREE_EXPANSION_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setFileTreePrefs({
									initialExpansion: v,
								});
							}}
							value={fileTreePrefs.initialExpansion}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FILE_TREE_EXPANSION_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Initial state"
				/>
			</SettingsGroup>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={fileTreePrefs.coloredIcons}
							id="file-tree-colored-icons-toggle"
							onCheckedChange={(v) => setFileTreePrefs({ coloredIcons: v })}
						/>
					}
					title="Colored icons"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={fileTreePrefs.stickyFolders}
							id="file-tree-sticky-folders-toggle"
							onCheckedChange={(v) => setFileTreePrefs({ stickyFolders: v })}
						/>
					}
					title="Sticky folders"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={fileTreePrefs.showSearch}
							id="file-tree-show-search-toggle"
							onCheckedChange={(v) => setFileTreePrefs({ showSearch: v })}
						/>
					}
					title="Search box"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={fileTreePrefs.flattenEmptyDirectories}
							id="file-tree-flatten-toggle"
							onCheckedChange={(v) =>
								setFileTreePrefs({ flattenEmptyDirectories: v })
							}
						/>
					}
					description="Show a chain of single-child folders as one row, like src/main/java."
					title="Flatten empty directories"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={fileTreePrefs.dragAndDrop}
							id="file-tree-dnd-toggle"
							onCheckedChange={(v) => setFileTreePrefs({ dragAndDrop: v })}
						/>
					}
					title="Drag and drop"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={fileTreePrefs.renaming}
							id="file-tree-renaming-toggle"
							onCheckedChange={(v) => setFileTreePrefs({ renaming: v })}
						/>
					}
					description="Rename with F2 or a double-click."
					title="Inline rename"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
