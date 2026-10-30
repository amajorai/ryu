import { PatchDiff } from "@pierre/diffs/react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type DiffViewPrefs,
	diffViewPrefsToOptions,
	setDiffViewPrefs,
} from "@/src/hooks/useDiffViewPrefs.ts";
import {
	PIERRE_DARK_THEMES,
	PIERRE_LIGHT_THEMES,
} from "@/src/lib/pierre-themes.ts";
import {
	DIFF_HUNK_SEPARATOR_OPTIONS,
	DIFF_INDICATOR_OPTIONS,
	DIFF_LINE_DIFF_OPTIONS,
	DIFF_PREVIEW_PATCH,
	DIFF_STYLE_OPTIONS,
	DIFF_THEME_OPTIONS,
} from "./appearance-options.tsx";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function AppearanceDiffPage({ state }: { state: AppearanceTabState }) {
	const { diffPrefs } = state;
	return (
		<SettingsSection caption="How diffs render in the workspace Changes tab.">
			<SettingsCard className="mb-2 overflow-hidden rounded-xl border border-border">
				<div className="border-border border-b px-3 py-1.5 text-muted-foreground text-xs">
					Live preview
				</div>
				<div className="max-h-64 overflow-auto text-xs">
					<PatchDiff
						disableWorkerPool
						options={diffViewPrefsToOptions(diffPrefs)}
						patch={DIFF_PREVIEW_PATCH}
					/>
				</div>
			</SettingsCard>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Select<DiffViewPrefs["diffStyle"]>
							items={DIFF_STYLE_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setDiffViewPrefs({
									diffStyle: v,
								});
							}}
							value={diffPrefs.diffStyle}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DIFF_STYLE_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Layout"
				/>
				<SettingsItem
					actions={
						<Select<DiffViewPrefs["themeMode"]>
							items={DIFF_THEME_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setDiffViewPrefs({
									themeMode: v,
								});
							}}
							value={diffPrefs.themeMode}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DIFF_THEME_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					description="Auto follows the app's light or dark mode."
					title="Theme mode"
				/>
				<SettingsItem
					actions={
						<Select
							items={PIERRE_LIGHT_THEMES}
							onValueChange={(v) => {
								if (v != null) {
									setDiffViewPrefs({ lightTheme: v });
								}
							}}
							value={diffPrefs.lightTheme}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PIERRE_LIGHT_THEMES.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					settingsId="appearance.diff-viewer.light-theme"
					title="Light theme"
				/>
				<SettingsItem
					actions={
						<Select
							items={PIERRE_DARK_THEMES}
							onValueChange={(v) => {
								if (v != null) {
									setDiffViewPrefs({ darkTheme: v });
								}
							}}
							value={diffPrefs.darkTheme}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{PIERRE_DARK_THEMES.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					settingsId="appearance.diff-viewer.dark-theme"
					title="Dark theme"
				/>
				<SettingsItem
					actions={
						<Select<DiffViewPrefs["diffIndicators"]>
							items={DIFF_INDICATOR_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setDiffViewPrefs({
									diffIndicators: v,
								});
							}}
							value={diffPrefs.diffIndicators}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DIFF_INDICATOR_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Change markers"
				/>
				<SettingsItem
					actions={
						<Select<DiffViewPrefs["lineDiffType"]>
							items={DIFF_LINE_DIFF_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setDiffViewPrefs({
									lineDiffType: v,
								});
							}}
							value={diffPrefs.lineDiffType}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DIFF_LINE_DIFF_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Inline highlighting"
				/>
				<SettingsItem
					actions={
						<Select<DiffViewPrefs["hunkSeparators"]>
							items={DIFF_HUNK_SEPARATOR_OPTIONS}
							onValueChange={(v) => {
								if (v === null) {
									return;
								}
								setDiffViewPrefs({
									hunkSeparators: v,
								});
							}}
							value={diffPrefs.hunkSeparators}
						>
							<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{DIFF_HUNK_SEPARATOR_OPTIONS.map((o) => (
									<SelectItem key={o.value} value={o.value}>
										{o.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					}
					title="Hunk separators"
				/>
			</SettingsGroup>

			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							checked={diffPrefs.showBackground}
							id="diff-show-background-toggle"
							onCheckedChange={(v) => setDiffViewPrefs({ showBackground: v })}
						/>
					}
					title="Line backgrounds"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={diffPrefs.showLineNumbers}
							id="diff-show-line-numbers-toggle"
							onCheckedChange={(v) => setDiffViewPrefs({ showLineNumbers: v })}
						/>
					}
					title="Line numbers"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={diffPrefs.wrapLines}
							id="diff-wrap-lines-toggle"
							onCheckedChange={(v) => setDiffViewPrefs({ wrapLines: v })}
						/>
					}
					title="Wrap long lines"
				/>
				<SettingsItem
					actions={
						<Switch
							checked={diffPrefs.expandUnchanged}
							id="diff-expand-unchanged-toggle"
							onCheckedChange={(v) => setDiffViewPrefs({ expandUnchanged: v })}
						/>
					}
					title="Expand unchanged context"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
