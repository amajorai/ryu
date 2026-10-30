import { MarketplaceWallpaperPickerDialog } from "@ryu/blocks/desktop/marketplace-wallpaper-picker.tsx";
import { AvatarUploadCropper, settingsApi } from "@ryu/settings";
import { getMarketplaceBackdrops } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/lib/auth-client.ts";
import type { PromptCacheConfirmation } from "@/src/components/chat/PromptCacheConfirmDialog.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	DEFAULT_USER_PERSONALIZATION,
	getPreference,
	setPreference,
	USER_PERSONALIZATION_PREF_KEY,
	type UserPersonalization,
} from "@/src/lib/api/preferences.ts";
import { usePluginBackgrounds } from "@/src/lib/plugin-backgrounds.ts";
import { personalizationCacheWarning } from "@/src/lib/user-personalization-prompt.ts";
import { AboutYouSection } from "./profile-tab/about-you-section.tsx";
import { ProfileBannerSection } from "./profile-tab/profile-banner-section.tsx";
import { useProfileBanner } from "./profile-tab/use-profile-banner.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export function ProfileTab() {
	const queryClient = useQueryClient();
	const { data: sessionData, refetch: refetchSession } = useSession();
	const user = sessionData?.user;

	const [name, setName] = useState(user?.name ?? "");
	const [isSavingName, setIsSavingName] = useState(false);
	const activeNode = useActiveNode();
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
	const {
		profileBanner,
		profileBannerError,
		profileBannerLoading,
		profileBannerPickerOpen,
		profileBannerSaving,
		profileBannerSyncPending,
		retryProfileBannerSync,
		saveProfileBanner,
		setProfileBannerPickerOpen,
	} = useProfileBanner(activeNode, user?.id ?? null, queryClient);
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
		<div>
			<SettingsSection title="Profile photo">
				<SettingsCard className="py-3">
					<AvatarUploadCropper
						className="items-start"
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
				<SettingsCard className="flex gap-2 py-3">
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
						size="default"
						variant="outline"
					>
						{isSavingName ? "Saving…" : "Save"}
					</Button>
				</SettingsCard>
			</SettingsSection>

			<ProfileBannerSection
				banner={profileBanner}
				error={profileBannerError}
				loading={profileBannerLoading}
				onChoose={() => setProfileBannerPickerOpen(true)}
				onRemove={() => void saveProfileBanner(null)}
				onRetrySync={() => void retryProfileBannerSync()}
				saving={profileBannerSaving}
				syncPending={profileBannerSyncPending}
			/>
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
				<SettingsCard className="py-3">
					<Label className="sr-only" htmlFor="email">
						Email
					</Label>
					<Input disabled id="email" tone="muted" value={user?.email ?? ""} />
				</SettingsCard>
			</SettingsSection>

			<AboutYouSection
				confirmation={personalizationConfirmation}
				loadFailed={personalizationLoadFailed}
				loading={loadingPersonalization}
				onChange={setPersonalization}
				onConfirmApply={() => {
					setPersonalizationConfirmation(null);
					void applyPersonalization(personalization);
				}}
				onConfirmCancel={() => setPersonalizationConfirmation(null)}
				onRetryLoad={() => void loadPersonalization()}
				onSave={savePersonalization}
				personalization={personalization}
				saving={savingPersonalization}
			/>
		</div>
	);
}
