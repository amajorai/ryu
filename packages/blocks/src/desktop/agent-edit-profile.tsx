"use client";

import { LockedIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties, ReactNode } from "react";
import {
	AgentBannerDialog,
	type AgentBannerPreferenceStore,
	AgentBannerWash,
	AgentProfileBannerFade,
	resolveAgentBanner,
	useAgentBannerPrefs,
} from "./agent-banner-dialog.tsx";
import styles from "./agent-edit.module.css";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./settings-items.tsx";

const PROFILE_DITHER_SETTINGS = {
	color: "#B497CF",
	edgeFade: 0.5,
	enableRipples: true,
	patternDensity: 1,
	patternScale: 2,
	pixelSize: 3,
	rippleIntensityScale: 1,
	rippleSpeed: 0.3,
	rippleThickness: 0.1,
	speed: 0.5,
	transparent: true,
	variant: "square",
} as const;

function squarePixelTileDataUri(): string {
	const spacing =
		PROFILE_DITHER_SETTINGS.pixelSize *
		PROFILE_DITHER_SETTINGS.patternScale *
		PROFILE_DITHER_SETTINGS.patternDensity;
	const dot = PROFILE_DITHER_SETTINGS.pixelSize;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${spacing}" height="${spacing}" viewBox="0 0 ${spacing} ${spacing}"><rect width="${dot}" height="${dot}" fill="${PROFILE_DITHER_SETTINGS.color}"/></svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

interface ProfileDitherStyle extends CSSProperties {
	"--agent-profile-dither-fade"?: string;
	"--agent-profile-dither-image"?: string;
	"--agent-profile-dither-size"?: string;
}
function DitherLayer({ className }: { className?: string }) {
	const spacing =
		PROFILE_DITHER_SETTINGS.pixelSize *
		PROFILE_DITHER_SETTINGS.patternScale *
		PROFILE_DITHER_SETTINGS.patternDensity;
	return (
		<div
			aria-hidden
			className={cn(
				"pointer-events-none absolute inset-0",
				styles.dither,
				className
			)}
			style={
				{
					"--agent-profile-dither-image": squarePixelTileDataUri(),
					"--agent-profile-dither-size": `${spacing}px ${spacing}px`,
					"--agent-profile-dither-fade": `${Math.round((1 - PROFILE_DITHER_SETTINGS.edgeFade) * 100)}%`,
				} satisfies ProfileDitherStyle as ProfileDitherStyle
			}
		/>
	);
}

/** The editor's identity row: picture, name, one-line description, and the save
 *  actions. Deliberately small — the profile card (banner, badge, lanyard) is a
 *  cosmetic extra and lives under Advanced, not above every setting. */
export function ProfileHeader({
	agentIcon,
	builtIn,
	description,
	healthBadge,
	isLocked,
	isNew,
	modelLabel,
	name,
	onCreateAndChat,
	onDescriptionChange,
	onNameChange,
	onSave,
	saveDisabled,
	saving,
}: {
	agentIcon?: ReactNode;
	builtIn: boolean;
	description?: string;
	healthBadge?: ReactNode;
	isLocked: boolean;
	isNew: boolean;
	modelLabel: string;
	name: string;
	onCreateAndChat?: () => void;
	onDescriptionChange?: (v: string) => void;
	onNameChange?: (v: string) => void;
	onSave?: () => void;
	saveDisabled?: boolean;
	saving?: boolean;
}) {
	return (
		<section aria-label="Agent profile" className="flex items-start gap-4">
			<div className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border bg-card">
				{agentIcon ?? <RyuLogo size="28px" tone="foreground" />}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Label className="sr-only" htmlFor="agent-name">
					Name
				</Label>
				<Input
					disabled={isLocked}
					id="agent-name"
					onChange={(e) => onNameChange?.(e.target.value)}
					placeholder="Name your agent"
					value={name}
					variant="agent-profile-name"
				/>
				<Label className="sr-only" htmlFor="agent-description">
					Description
				</Label>
				<Input
					disabled={isLocked}
					id="agent-description"
					onChange={(e) => onDescriptionChange?.(e.target.value)}
					placeholder="What is it for? e.g. Drafts replies to support email"
					value={description ?? ""}
					variant="agent-profile-description"
				/>
				<div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<span className="truncate">{modelLabel || "No model selected"}</span>
					{builtIn ? <Badge variant="outline">Core</Badge> : null}
					{healthBadge}
					{isLocked ? (
						<Badge variant="secondary">
							<HugeiconsIcon className="size-3" icon={LockedIcon} />
							Locked
						</Badge>
					) : null}
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<Button
					disabled={saveDisabled}
					onClick={onCreateAndChat}
					size="sm"
					variant="ghost"
				>
					{isNew ? "Create & chat" : "Chat"}
				</Button>
				<Button
					disabled={saveDisabled}
					loading={saving}
					onClick={onSave}
					size="sm"
				>
					{isNew ? "Create agent" : "Save"}
				</Button>
			</div>
		</section>
	);
}

/** Cosmetic profile extras: the banner (with its customise dialog), the
 *  lanyard badge, the short badge text, and the persona display name. Advanced
 *  only — none of it changes what the agent does. */
export function ProfileCardSection({
	agentTitle,
	badge,
	bannerAgentId,
	bannerPreferenceStore,
	isLocked,
	marketplaceWallpapers = [],
	name,
	onAgentTitleChange,
	onInstallWallpaper,
	onPersonaDisplayNameChange,
	personaDisplayName,
}: {
	agentTitle: string;
	badge?: ReactNode;
	bannerAgentId?: string;
	bannerPreferenceStore?: AgentBannerPreferenceStore;
	isLocked: boolean;
	marketplaceWallpapers?: readonly RenderableBackdrop[];
	name: string;
	onAgentTitleChange?: (v: string) => void;
	onInstallWallpaper?: (
		wallpaper: RenderableBackdrop
	) => boolean | Promise<boolean>;
	onPersonaDisplayNameChange?: (v: string) => void;
	personaDisplayName: string;
}) {
	// Prefs live in their own module with the dialog that edits them, so this
	// section only has to know how to PAINT one.
	const {
		error: bannerStorageError,
		loading: bannerLoading,
		prefs,
		reset,
		update,
	} = useAgentBannerPrefs(bannerAgentId ?? name, bannerPreferenceStore, name);
	const bannerIdentity = bannerAgentId ?? name;
	const banner = resolveAgentBanner(bannerIdentity, prefs);
	const marketplaceWallpaper = resolveMarketplaceWallpaperSelection(
		prefs.wallpaper
	);

	return (
		<SettingsSection
			caption="How this agent looks on its profile and badge. Nothing here changes what it does."
			title="Profile card"
		>
			<div
				className={cn(
					"relative min-h-36 overflow-hidden rounded-lg",
					styles.banner
				)}
			>
				{marketplaceWallpaper ? (
					<Backdrop
						className="absolute inset-0"
						definition={marketplaceWallpaper}
						live={false}
						params={marketplaceWallpaper.initialParams}
					/>
				) : (
					<AgentBannerWash banner={banner} />
				)}
				{isLocked ? null : (
					<div className="absolute top-3 left-3 z-10">
						<AgentBannerDialog
							agent={bannerIdentity}
							loading={bannerLoading}
							marketplaceWallpapers={marketplaceWallpapers}
							onInstallWallpaper={onInstallWallpaper}
							onReset={reset}
							onUpdate={update}
							prefs={prefs}
							storageError={bannerStorageError}
						/>
					</div>
				)}
				<AgentProfileBannerFade />
				{badge ? (
					<div className="absolute top-3 right-3 bottom-3 hidden w-32 sm:block">
						<div className="relative h-full overflow-hidden rounded-lg border border-white/25 bg-background/12 shadow-2xl backdrop-blur">
							<DitherLayer className="opacity-45" />
							<div className="absolute inset-0">{badge}</div>
						</div>
					</div>
				) : null}
			</div>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Input
							className="w-56"
							disabled={isLocked}
							id="agent-title"
							maxLength={48}
							onChange={(e) => onAgentTitleChange?.(e.target.value)}
							placeholder="e.g. CTO"
							size="agent-row"
							value={agentTitle}
						/>
					}
					description="Shown beside the name."
					title="Badge"
				/>
				<SettingsItem
					actions={
						<Input
							className="w-56"
							disabled={isLocked}
							id="persona-display-name"
							onChange={(e) => onPersonaDisplayNameChange?.(e.target.value)}
							placeholder="e.g. Aria"
							size="agent-row"
							value={personaDisplayName}
						/>
					}
					description="The name it introduces itself with, if different."
					title="Display name"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}
