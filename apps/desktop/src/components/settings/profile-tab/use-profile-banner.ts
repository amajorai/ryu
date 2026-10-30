import type { RenderableBackdrop } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import {
	resolveMarketplaceWallpaperSelection,
	toMarketplaceWallpaperSelection,
} from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { toast } from "@ryu/ui/components/sileo.tsx";
import {
	type MarketplaceWallpaperSelection,
	parseMarketplaceWallpaperSelection,
} from "@ryuhq/protocol/marketplace-wallpaper";
import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { getActiveToken } from "@/lib/auth-client.ts";
import type { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { getPreference, setPreference } from "@/src/lib/api/preferences.ts";
import {
	type fetchProfileMe,
	fetchProfileMeWithToken,
	updateProfileBannerWallpaper,
} from "@/src/lib/api/profile.ts";
import { installWallpaper } from "@/src/lib/wallpaper-library.ts";
import {
	PROFILE_BANNER_WALLPAPER_PREF_KEY,
	parseStoredProfileBanner,
	sameProfileBanner,
} from "./profile-banner-pref.ts";

type ActiveNode = ReturnType<typeof useActiveNode>;

/**
 * The profile banner's node-preference state and its public-profile sync.
 * Every write is scoped to the account and node that started it.
 */
export function useProfileBanner(
	activeNode: ActiveNode,
	userId: string | null,
	queryClient: QueryClient
) {
	// A pending write belongs to the account and node that started it. The token
	// mirror is checked again after awaits, including switches before session rerender.
	const bannerScope = JSON.stringify([userId, toTarget(activeNode)]);
	const bannerScopeRef = useRef(bannerScope);
	bannerScopeRef.current = bannerScope;
	const bannerOperationRef = useRef(0);
	const profileBannerOwnerRef = useRef<{
		scope: string;
		token: string | null;
	} | null>(null);
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
	return {
		profileBanner,
		profileBannerError,
		profileBannerLoading,
		profileBannerPickerOpen,
		profileBannerSaving,
		profileBannerSyncPending,
		retryProfileBannerSync,
		saveProfileBanner,
		setProfileBannerPickerOpen,
	};
}
