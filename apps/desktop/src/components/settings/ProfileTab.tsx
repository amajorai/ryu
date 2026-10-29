import { MarketplaceWallpaperPickerDialog } from "@ryu/blocks/desktop/marketplace-wallpaper-picker.tsx";
import { AvatarUploadCropper, settingsApi } from "@ryu/settings";
import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import {
	getMarketplaceBackdrops,
	type RenderableBackdrop,
	resolveMarketplaceWallpaperSelection,
	toMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import {
	type MarketplaceWallpaperSelection,
	parseMarketplaceWallpaperSelection,
} from "@ryuhq/protocol/marketplace-wallpaper";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getActiveToken, useSession } from "@/lib/auth-client.ts";
import {
	type PromptCacheConfirmation,
	PromptCacheConfirmDialog,
} from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_USER_PERSONALIZATION,
	getPreference,
	setPreference,
	USER_PERSONALIZATION_PREF_KEY,
	type UserPersonalization,
} from "@/src/lib/api/preferences.ts";
import {
	type fetchProfileMe,
	fetchProfileMeWithToken,
	updateProfileBannerWallpaper,
} from "@/src/lib/api/profile.ts";
import { usePluginBackgrounds } from "@/src/lib/plugin-backgrounds.ts";
import { personalizationCacheWarning } from "@/src/lib/user-personalization-prompt.ts";
import { installWallpaper } from "@/src/lib/wallpaper-library.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const PROFILE_BANNER_WALLPAPER_PREF_KEY = "ryu.profile-banner-wallpaper.v1";

function parseStoredProfileBanner(
	value: string
): MarketplaceWallpaperSelection | null | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed === null ? null : parseMarketplaceWallpaperSelection(parsed);
	} catch {
		return undefined;
	}
}

function sameProfileBanner(
	left: MarketplaceWallpaperSelection | null,
	right: MarketplaceWallpaperSelection | null
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function ProfileTab() {
	const queryClient = useQueryClient();
	const { data: sessionData, refetch: refetchSession } = useSession();
	const user = sessionData?.user;

	const [name, setName] = useState(user?.name ?? "");
	const [isSavingName, setIsSavingName] = useState(false);
	const activeNode = useActiveNode();
	// A pending write belongs to the account and node that started it. The token
	// mirror is checked again after awaits, including switches before session rerender.
	const bannerScope = JSON.stringify([user?.id ?? null, toTarget(activeNode)]);
	const bannerScopeRef = useRef(bannerScope);
	bannerScopeRef.current = bannerScope;
	const bannerOperationRef = useRef(0);
	const profileBannerOwnerRef = useRef<{
		scope: string;
		token: string | null;
	} | null>(null);
	const [personalization, setPersonalization] = useState<UserPersonalization>(
		DEFAULT_USER_PERSONALIZATION
	);
	const [loadingPersonalization, setLoadingPersonalization] = useState(true);
	const [personalizationLoadFailed, setPersonalizationLoadFailed] =
		useState(false);
	const [savingPersonalization, setSavingPersonalization] = useState(false);
	// What the node holds now: the baseline a save is compared against, so only
	// a change that reaches every thread's system prompt asks first.
	const [savedPersonalization, setSavedPersonalization] =
		useState<UserPersonalization>(DEFAULT_USER_PERSONALIZATION);
	const [personalizationConfirmation, setPersonalizationConfirmation] =
		useState<PromptCacheConfirmation | null>(null);
	const pluginBackgrounds = usePluginBackgrounds();
	const marketplaceWallpapers = useMemo(
		() => getMarketplaceBackdrops(pluginBackgrounds),
		[pluginBackgrounds]
	);
	const [profileBanner, setProfileBanner] = useState<RenderableBackdrop | null>(
		null
	);
	const [profileBannerLoading, setProfileBannerLoading] = useState(true);
	const [profileBannerSaving, setProfileBannerSaving] = useState(false);
	const [profileBannerSyncPending, setProfileBannerSyncPending] =
		useState(false);
	const [profileBannerPickerOpen, setProfileBannerPickerOpen] = useState(false);
	const [profileBannerError, setProfileBannerError] = useState<string | null>(
		null
	);
	// Only the newest read may fill the form: after a node switch, a slower
	// read from the previous node must not replace this node's details, or a
	// save would copy them onto this node.
	const personalizationLoadRef = useRef(0);
	const loadPersonalization = useCallback(async () => {
		const load = ++personalizationLoadRef.current;
		const isCurrent = () => personalizationLoadRef.current === load;
		setLoadingPersonalization(true);
		setPersonalizationLoadFailed(false);
		// A confirm still open is about the previous node's details; applying it
		// mid-switch would write that draft onto the newly selected node.
		setPersonalizationConfirmation(null);
		try {
			const raw = await getPreference(
				toTarget(activeNode),
				USER_PERSONALIZATION_PREF_KEY
			);
			if (!isCurrent()) {
				return;
			}
			if (!raw) {
				setPersonalization(DEFAULT_USER_PERSONALIZATION);
				setSavedPersonalization(DEFAULT_USER_PERSONALIZATION);
				return;
			}
			try {
				const loaded = {
					...DEFAULT_USER_PERSONALIZATION,
					...JSON.parse(raw),
				};
				setPersonalization(loaded);
				setSavedPersonalization(loaded);
			} catch {
				// A corrupt preference reads as the empty defaults, never as the
				// details still on screen from another node.
				setPersonalization(DEFAULT_USER_PERSONALIZATION);
				setSavedPersonalization(DEFAULT_USER_PERSONALIZATION);
			}
		} catch {
			if (isCurrent()) {
				setPersonalizationLoadFailed(true);
			}
		} finally {
			if (isCurrent()) {
				setLoadingPersonalization(false);
			}
		}
	}, [activeNode]);
	useEffect(() => {
		void loadPersonalization();
	}, [loadPersonalization]);
	useEffect(() => {
		let current = true;
		const target = toTarget(activeNode);
		const capturedScope = bannerScope;
		const capturedToken = getActiveToken();
		const isCurrent = () =>
			current &&
			bannerScopeRef.current === capturedScope &&
			getActiveToken() === capturedToken;
		setProfileBannerSaving(false);
		setProfileBannerLoading(true);
		setProfileBanner(null);
		profileBannerOwnerRef.current = null;
		setProfileBannerError(null);
		setProfileBannerSyncPending(false);
		const loadAndSyncBanner = async () => {
			let selection: MarketplaceWallpaperSelection | null;
			let profile: Awaited<ReturnType<typeof fetchProfileMe>> | undefined;
			const stored = await getPreference(
				target,
				PROFILE_BANNER_WALLPAPER_PREF_KEY
			);
			if (stored === null) {
				// Migrate existing account banners once; all later edits use the node
				// preference as the source of truth.
				profile = await fetchProfileMeWithToken(capturedToken);
				selection =
					parseMarketplaceWallpaperSelection(profile.bannerWallpaper) ?? null;
				if (!isCurrent()) {
					return;
				}
				await setPreference(
					target,
					PROFILE_BANNER_WALLPAPER_PREF_KEY,
					JSON.stringify(selection)
				);
			} else {
				const parsed = parseStoredProfileBanner(stored);
				if (parsed === undefined) {
					throw new Error("The saved node banner is invalid.");
				}
				selection = parsed;
			}
			if (!isCurrent()) {
				return;
			}
			profileBannerOwnerRef.current = {
				scope: capturedScope,
				token: capturedToken,
			};
			setProfileBanner(resolveMarketplaceWallpaperSelection(selection) ?? null);
			if (selection && !installWallpaper(selection.id)) {
				setProfileBannerError(
					"The banner is active, but it could not be added to this device's Wallpaper Library."
				);
			}

			try {
				profile ??= await fetchProfileMeWithToken(capturedToken);
				if (!isCurrent()) {
					return;
				}
				const publicSelection =
					parseMarketplaceWallpaperSelection(profile.bannerWallpaper) ?? null;
				if (!sameProfileBanner(selection, publicSelection)) {
					await updateProfileBannerWallpaper(selection, capturedToken);
					if (!isCurrent()) {
						return;
					}
					await queryClient.invalidateQueries({ queryKey: ["profile"] });
				}
			} catch {
				if (isCurrent()) {
					setProfileBannerSyncPending(true);
					setProfileBannerError(
						"Your banner is saved on this node, but its public profile copy could not be updated."
					);
				}
			}
		};
		void loadAndSyncBanner()
			.catch(() => {
				if (isCurrent()) {
					setProfileBannerError(
						"Your profile banner could not be loaded from this node."
					);
				}
			})
			.finally(() => {
				if (isCurrent()) {
					setProfileBannerLoading(false);
				}
			});
		return () => {
			current = false;
		};
	}, [activeNode, bannerScope, queryClient]);
	const saveProfileBanner = async (
		wallpaper: RenderableBackdrop | null
	): Promise<boolean> => {
		const capturedScope = bannerScopeRef.current;
		const capturedToken = getActiveToken();
		const operation = ++bannerOperationRef.current;
		const isCurrent = () =>
			bannerScopeRef.current === capturedScope &&
			getActiveToken() === capturedToken &&
			bannerOperationRef.current === operation;
		setProfileBannerSaving(true);
		setProfileBannerError(null);
		try {
			if (wallpaper && !installWallpaper(wallpaper.id)) {
				setProfileBannerError(
					"This wallpaper could not be added to your Library."
				);
				return false;
			}
			const bannerWallpaper = wallpaper
				? toMarketplaceWallpaperSelection(wallpaper)
				: null;
			await setPreference(
				toTarget(activeNode),
				PROFILE_BANNER_WALLPAPER_PREF_KEY,
				JSON.stringify(bannerWallpaper)
			);
			if (!isCurrent()) {
				return false;
			}
			profileBannerOwnerRef.current = {
				scope: capturedScope,
				token: capturedToken,
			};
			setProfileBanner(wallpaper);
			try {
				await updateProfileBannerWallpaper(bannerWallpaper, capturedToken);
				if (!isCurrent()) {
					return false;
				}
				await queryClient.invalidateQueries({ queryKey: ["profile"] });
				if (!isCurrent()) {
					return false;
				}
				setProfileBannerSyncPending(false);
			} catch {
				if (!isCurrent()) {
					return false;
				}
				setProfileBannerSyncPending(true);
				setProfileBannerError(
					"Saved on this node, but the public profile copy could not be updated. Retry the sync below."
				);
				return false;
			}
			toast.success(
				wallpaper ? "Profile banner updated" : "Profile banner removed"
			);
			return true;
		} catch {
			if (!isCurrent()) {
				return false;
			}
			setProfileBannerError(
				"Your profile banner could not be saved on this node."
			);
			return false;
		} finally {
			if (bannerOperationRef.current === operation) {
				setProfileBannerSaving(false);
			}
		}
	};
	const retryProfileBannerSync = async () => {
		const capturedScope = bannerScopeRef.current;
		const capturedToken = getActiveToken();
		const owner = profileBannerOwnerRef.current;
		if (
			!owner ||
			owner.scope !== capturedScope ||
			owner.token !== capturedToken
		) {
			setProfileBannerSyncPending(false);
			setProfileBannerError(
				"Your account or node changed. Reload your profile before syncing its banner."
			);
			return;
		}
		const operation = ++bannerOperationRef.current;
		const isCurrent = () =>
			bannerScopeRef.current === capturedScope &&
			getActiveToken() === capturedToken &&
			bannerOperationRef.current === operation;
		setProfileBannerSaving(true);
		setProfileBannerError(null);
		try {
			const bannerWallpaper = profileBanner
				? toMarketplaceWallpaperSelection(profileBanner)
				: null;
			await updateProfileBannerWallpaper(bannerWallpaper, capturedToken);
			if (!isCurrent()) {
				return;
			}
			await queryClient.invalidateQueries({ queryKey: ["profile"] });
			if (!isCurrent()) {
				return;
			}
			setProfileBannerSyncPending(false);
			toast.success("Public profile banner synced");
		} catch {
			if (!isCurrent()) {
				return;
			}
			setProfileBannerError(
				"The public profile copy could not be updated. Try again."
			);
		} finally {
			if (bannerOperationRef.current === operation) {
				setProfileBannerSaving(false);
			}
		}
	};
	const applyPersonalization = async (next: UserPersonalization) => {
		const load = personalizationLoadRef.current;
		setSavingPersonalization(true);
		try {
			await setPreference(
				toTarget(activeNode),
				USER_PERSONALIZATION_PREF_KEY,
				JSON.stringify(next)
			);
			// A node switch during the write has loaded that node's own baseline.
			if (personalizationLoadRef.current === load) {
				setSavedPersonalization(next);
			}
			toast.success("Personalization saved");
		} catch {
			toast.error("Couldn't save personalization", {
				description: "Check your connection and try again.",
			});
		} finally {
			setSavingPersonalization(false);
		}
	};
	// Core folds these details into every owner thread's system prompt, so a
	// change is a one-time prompt-cache miss per thread: confirm it first.
	const savePersonalization = () => {
		const warning = personalizationCacheWarning(
			savedPersonalization,
			personalization
		);
		if (warning) {
			setPersonalizationConfirmation(warning);
			return;
		}
		void applyPersonalization(personalization);
	};

	// Session data loads asynchronously, so backfill the field once the name
	// arrives. Keyed on user?.name so it won't clobber in-progress edits.
	useEffect(() => {
		if (user?.name) {
			setName(user.name);
		}
	}, [user?.name]);

	const handleNameSave = async () => {
		if (!name.trim() || name === user?.name) {
			return;
		}
		setIsSavingName(true);
		try {
			await settingsApi.profile.updateName(name.trim());
			await refetchSession();
			toast.success("Name updated");
		} catch {
			toast.error("Couldn't update your name", {
				description: "Check your connection and try again.",
			});
		} finally {
			setIsSavingName(false);
		}
	};

	const avatarUrl = user?.image ?? null;

	return (
		<div className="space-y-6">
			<SettingsSection title="Profile photo">
				<SettingsCard>
					<AvatarUploadCropper
						currentAvatarUrl={avatarUrl}
						onUploadComplete={() => {
							refetchSession();
							queryClient.invalidateQueries({ queryKey: ["session"] });
						}}
						userName={user?.name}
					/>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection title="Display name">
				<SettingsCard className="flex gap-2">
					<Label className="sr-only" htmlFor="display-name">
						Display Name
					</Label>
					<Input
						id="display-name"
						maxLength={50}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								handleNameSave();
							}
						}}
						placeholder="Your name"
						value={name}
					/>
					<Button
						disabled={isSavingName || !name.trim() || name === user?.name}
						onClick={handleNameSave}
						size="sm"
					>
						{isSavingName ? "Saving…" : "Save"}
					</Button>
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="Saved on the active node and shared with its connected devices. A public profile copy is kept in sync for visitors."
				title="Profile banner"
			>
				<SettingsCard className="space-y-3">
					<div
						className="relative isolate h-36 overflow-hidden rounded-xl border bg-muted sm:h-44"
						data-testid="profile-banner-preview"
					>
						{profileBanner ? (
							<Backdrop
								className="absolute inset-0"
								definition={profileBanner}
								live={false}
								params={profileBanner.initialParams}
							/>
						) : (
							<div className="absolute inset-0 bg-gradient-to-br from-primary/20 via-muted to-background" />
						)}
						<div className="absolute inset-0 bg-gradient-to-t from-background/75 via-background/10 to-transparent" />
						<div className="absolute inset-x-4 bottom-3 font-medium text-foreground text-sm drop-shadow-sm">
							{profileBanner?.label ??
								(profileBannerLoading
									? "Loading banner…"
									: "No banner selected")}
						</div>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={profileBannerLoading || profileBannerSaving}
							onClick={() => setProfileBannerPickerOpen(true)}
							size="sm"
						>
							Choose Marketplace wallpaper
						</Button>
						{profileBanner ? (
							<Button
								disabled={profileBannerSaving}
								loading={profileBannerSaving}
								onClick={() => void saveProfileBanner(null)}
								size="sm"
								variant="outline"
							>
								Remove banner
							</Button>
						) : null}
						{profileBannerSyncPending ? (
							<Button
								disabled={profileBannerSaving}
								loading={profileBannerSaving}
								onClick={() => void retryProfileBannerSync()}
								size="sm"
								variant="outline"
							>
								Retry public profile sync
							</Button>
						) : null}
					</div>
					{profileBannerError ? (
						<p className="text-sm text-status-destructive" role="alert">
							{profileBannerError}
						</p>
					) : null}
				</SettingsCard>
			</SettingsSection>
			<MarketplaceWallpaperPickerDialog
				onOpenChange={setProfileBannerPickerOpen}
				onSelect={saveProfileBanner}
				open={profileBannerPickerOpen}
				selectedId={profileBanner?.id}
				title="Choose a public profile banner"
				wallpapers={marketplaceWallpapers}
			/>

			<SettingsSection
				caption="To change your email, go to the Account tab."
				title="Email"
			>
				<SettingsCard>
					<Label className="sr-only" htmlFor="email">
						Email
					</Label>
					<Input disabled id="email" tone="muted" value={user?.email ?? ""} />
				</SettingsCard>
			</SettingsSection>

			<SettingsSection
				caption="These details are added to the agent context on this node. They are not shared with your organization."
				title="About you"
			>
				<SettingsCard className="space-y-3">
					{personalizationLoadFailed ? (
						<div className="space-y-2" role="alert">
							<p className="text-muted-foreground text-sm">
								Couldn’t load your saved profile details. Retry before editing
								so you don’t overwrite them.
							</p>
							<Button
								disabled={loadingPersonalization}
								onClick={() => void loadPersonalization()}
								size="sm"
							>
								{loadingPersonalization ? "Loading…" : "Retry"}
							</Button>
						</div>
					) : (
						<>
							<Input
								aria-label="Nickname"
								disabled={loadingPersonalization}
								onChange={(e) =>
									setPersonalization({
										...personalization,
										nickname: e.target.value,
									})
								}
								placeholder="Nickname"
								value={personalization.nickname}
							/>
							<Input
								aria-label="Occupation"
								disabled={loadingPersonalization}
								onChange={(e) =>
									setPersonalization({
										...personalization,
										occupation: e.target.value,
									})
								}
								placeholder="Occupation"
								value={personalization.occupation}
							/>
							<Textarea
								aria-label="More about you"
								disabled={loadingPersonalization}
								onChange={(e) =>
									setPersonalization({
										...personalization,
										aboutYou: e.target.value,
									})
								}
								placeholder="More about you"
								value={personalization.aboutYou}
							/>
							<Textarea
								aria-label="About your organization"
								disabled={loadingPersonalization}
								onChange={(e) =>
									setPersonalization({
										...personalization,
										aboutOrganization: e.target.value,
									})
								}
								placeholder="About your organization"
								value={personalization.aboutOrganization}
							/>
							<Button
								disabled={loadingPersonalization || savingPersonalization}
								onClick={savePersonalization}
								size="sm"
							>
								{savingPersonalization ? "Saving…" : "Save personalization"}
							</Button>
						</>
					)}
				</SettingsCard>
				<PromptCacheConfirmDialog
					confirmation={personalizationConfirmation}
					onApply={() => {
						setPersonalizationConfirmation(null);
						void applyPersonalization(personalization);
					}}
					onCancel={() => setPersonalizationConfirmation(null)}
				/>
			</SettingsSection>
		</div>
	);
}
