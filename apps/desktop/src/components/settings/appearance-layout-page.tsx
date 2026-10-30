import { useLiteralMessages } from "@ryu/i18n/react";
import { FluidSlider } from "@ryu/ui/components/motion/range-slider-fluid.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	CODE_FONTS,
	DEFAULT_CARD_SPACING,
	DEFAULT_SPACING,
	HEADING_FONTS,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	SCALE_MAX,
	SCALE_MIN,
	UI_FONTS,
} from "@/src/hooks/useThemePreset.ts";
import appearanceStyles from "./appearance.module.css";
import { SeasonalEffectsSettings } from "./appearance-seasonal-effects.tsx";
import type { AppearancePaintStyle } from "./appearance-tab-model.ts";
import type { AppearanceTabState } from "./appearance-tab-state.ts";
import { BackgroundCustomizationSettings } from "./BackgroundCustomizationSettings.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";
import { TimezoneSetting } from "./TimezoneSetting.tsx";
import { WallpaperSetting } from "./WallpaperSetting.tsx";

export function AppearanceLayoutPage({ state }: { state: AppearanceTabState }) {
	const tl = useLiteralMessages();
	const {
		uiFont,
		headingFont,
		codeFont,
		contrastValue,
		radiusValue,
		spacingValue,
		scaleValue,
		cardSpacingValue,
		chatWidthValue,
		sidebarWidthValue,
		handleUiFont,
		handleHeadingFont,
		handleCodeFont,
		handleContrast,
		handleRadius,
		handleSpacing,
		handleScale,
		handleCardSpacing,
		handleChatWidth,
		handleSidebarWidth,
	} = state;
	return (
		<>
			<SettingsSection title="Layout & sizing">
				<SettingsCard className="space-y-3">
					<div className="space-y-1.5">
						<FluidSlider
							label="Muted contrast"
							max={100}
							min={0}
							onValueChange={handleContrast}
							step={1}
							value={contrastValue}
						/>
						<p className="text-muted-foreground text-xs">
							Center (50) is the preset default. Lower darkens muted surfaces,
							higher brightens them.
						</p>
					</div>

					<FluidSlider
						format={(v) => `${v.toFixed(3)}rem`}
						label="Roundness"
						max={1.5}
						min={0}
						onValueChange={handleRadius}
						step={0.025}
						value={radiusValue}
					/>

					<div className="space-y-1.5">
						<FluidSlider
							format={(v) => `${(v * 100).toFixed(0)}%`}
							label="Scale (UI zoom)"
							max={SCALE_MAX}
							min={SCALE_MIN}
							onValueChange={handleScale}
							step={0.05}
							value={scaleValue}
						/>
						<p className="text-muted-foreground text-xs">
							Scales the whole interface like a browser zoom: text, spacing, and
							everything else. 100% is the default.
						</p>
					</div>

					<div className="space-y-1.5">
						<FluidSlider
							format={(v) => `${v.toFixed(3)}rem`}
							label="Zoom (spacing)"
							max={0.36}
							min={0.16}
							onValueChange={handleSpacing}
							step={0.005}
							value={spacingValue}
						/>
						<p className="text-muted-foreground text-xs">
							{tl(
								"Scales the base spacing unit all UI padding, gaps, and sizes derive from. {defaultSpacing}rem is the default; lower compacts the interface, higher zooms it in.",
								{ defaultSpacing: String(DEFAULT_SPACING) }
							)}
						</p>
					</div>

					<div className="space-y-1.5">
						<FluidSlider
							format={(v) => `${v.toFixed(2)}rem`}
							label="Card padding"
							max={1.6}
							min={0.48}
							onValueChange={handleCardSpacing}
							step={0.02}
							value={cardSpacingValue}
						/>
						<p className="text-muted-foreground text-xs">
							{tl(
								"Inner padding of cards (header, content, footer). {defaultCardSpacing} is the default; lower tightens cards, higher loosens them.",
								{ defaultCardSpacing: `${DEFAULT_CARD_SPACING}rem` }
							)}
						</p>
					</div>

					<FluidSlider
						format={(v) => `${v}px`}
						label="Chat width"
						max={960}
						min={480}
						onValueChange={handleChatWidth}
						step={10}
						value={chatWidthValue}
					/>

					<FluidSlider
						format={(v) => `${v}px`}
						label="Sidebar width"
						max={MAX_SIDEBAR_WIDTH}
						min={MIN_SIDEBAR_WIDTH}
						onValueChange={handleSidebarWidth}
						step={4}
						value={sidebarWidthValue}
					/>
				</SettingsCard>
			</SettingsSection>

			<BackgroundCustomizationSettings />

			<SettingsSection
				caption="Fonts for the interface and for code."
				title="Typography"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Select
								items={UI_FONTS}
								onValueChange={handleUiFont}
								value={uiFont}
							>
								<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{UI_FONTS.map((f) => {
										const fontStyle: AppearancePaintStyle = {
											"--appearance-font": f.value,
										};
										return (
											<SelectItem key={f.label} value={f.value}>
												<span
													className={appearanceStyles.fontSample}
													style={fontStyle}
												>
													{f.label}
												</span>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						}
						title="UI font"
					/>
					<SettingsItem
						actions={
							<Select
								items={HEADING_FONTS}
								onValueChange={handleHeadingFont}
								value={headingFont}
							>
								<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{HEADING_FONTS.map((f) => {
										const fontStyle: AppearancePaintStyle = {
											"--appearance-font": f.value,
										};
										return (
											<SelectItem key={f.label} value={f.value}>
												<span
													className={appearanceStyles.fontSample}
													style={fontStyle}
												>
													{f.label}
												</span>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						}
						title="Heading font"
					/>
					<SettingsItem
						actions={
							<Select
								items={CODE_FONTS}
								onValueChange={handleCodeFont}
								value={codeFont}
							>
								<SelectTrigger className="w-auto max-w-64 shrink-0" size="sm">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{CODE_FONTS.map((f) => {
										const fontStyle: AppearancePaintStyle = {
											"--appearance-font": f.value,
										};
										return (
											<SelectItem key={f.label} value={f.value}>
												<span
													className={appearanceStyles.fontSample}
													style={fontStyle}
												>
													{f.label}
												</span>
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						}
						title="Code font"
					/>
				</SettingsGroup>
			</SettingsSection>

			<TimezoneSetting />

			<WallpaperSetting />
		</>
	);
}

export function AppearanceMotionPage({ state }: { state: AppearanceTabState }) {
	const {
		animationsEnabled,
		setAnimationsEnabled,
		streamAnimation,
		setStreamAnimation,
	} = state;
	return (
		<>
			<SettingsSection title="Motion">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Switch
								checked={animationsEnabled}
								id="animations-enabled-toggle"
								onCheckedChange={setAnimationsEnabled}
							/>
						}
						description="Your system reduce-motion setting always wins."
						title="Enable animations"
					/>
					<SettingsItem
						actions={
							<Switch
								checked={streamAnimation}
								disabled={!animationsEnabled}
								id="stream-animation-toggle"
								onCheckedChange={setStreamAnimation}
							/>
						}
						description="Fade replies in word by word. Needs animations on."
						title="Animate streaming chat text"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SeasonalEffectsSettings />
		</>
	);
}
