import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import type { RenderableBackdrop } from "@ryu/ui/components/backdrop/marketplace-backdrops.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import { SettingsCard, SettingsSection } from "../shared/settings-items.tsx";

export interface ProfileBannerSectionProps {
	banner: RenderableBackdrop | null;
	error: string | null;
	loading: boolean;
	onChoose: () => void;
	onRemove: () => void;
	onRetrySync: () => void;
	saving: boolean;
	syncPending: boolean;
}

/** The profile banner preview and its choose / remove / retry-sync actions. */
export function ProfileBannerSection({
	banner,
	error,
	loading,
	onChoose,
	onRemove,
	onRetrySync,
	saving,
	syncPending,
}: ProfileBannerSectionProps) {
	return (
		<SettingsSection
			caption="Saved on this node and its devices. Visitors see a synced public copy."
			title="Profile banner"
		>
			<SettingsCard className="flex flex-col gap-3 py-3">
				<div
					className={`relative isolate overflow-hidden rounded-xl bg-muted ${banner ? "h-36 sm:h-44" : "h-20"}`}
					data-testid="profile-banner-preview"
				>
					{banner ? (
						<Backdrop
							className="absolute inset-0"
							definition={banner}
							live={false}
							params={banner.initialParams}
						/>
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<span className="mr-auto min-w-0 truncate text-muted-foreground text-sm">
						{banner?.label ??
							(loading ? "Loading banner…" : "No banner selected")}
					</span>
					<Button
						disabled={loading || saving}
						onClick={onChoose}
						size="sm"
						variant="outline"
					>
						Choose Marketplace wallpaper
					</Button>
					{banner ? (
						<Button
							disabled={saving}
							loading={saving}
							onClick={onRemove}
							size="sm"
							variant="ghost-muted"
						>
							Remove banner
						</Button>
					) : null}
					{syncPending ? (
						<Button
							disabled={saving}
							loading={saving}
							onClick={onRetrySync}
							size="sm"
							variant="outline"
						>
							Retry public profile sync
						</Button>
					) : null}
				</div>
				{error ? (
					<p className="text-detail text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
			</SettingsCard>
		</SettingsSection>
	);
}
