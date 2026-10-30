import { Button } from "@ryu/ui/components/button.tsx";
import { FRONTEND_URL } from "@/lib/auth-client.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

/** Where a solo user goes to create or pick an organization. */
const ORGANIZATIONS_URL = `${FRONTEND_URL.replace(/\/$/, "")}/organizations`;

/** Shown when the desktop has no signed-in account to bill. */
export function TeamsBillingSignedOut() {
	return (
		<SettingsSection title="Teams">
			<SettingsCard>
				<p className="text-center text-muted-foreground text-sm">
					Sign in to manage your organization&apos;s Teams seats.
				</p>
			</SettingsCard>
		</SettingsSection>
	);
}

/** Shown when the account has no active organization to bill. */
export function TeamsBillingNoOrganization() {
	return (
		<SettingsSection title="Teams">
			<SettingsCard>
				<div className="flex flex-col items-start gap-3">
					<p className="text-muted-foreground text-sm">
						Teams is an organization plan. Create or join an organization to set
						up shared credits and member seats.
					</p>
					<Button
						onClick={() => {
							openExternal(ORGANIZATIONS_URL).catch(() => undefined);
						}}
						size="sm"
					>
						Create or select an organization
					</Button>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

/** Shown when the billing reads fail; `onRetry` refetches each of them. */
export function TeamsBillingLoadFailed({ onRetry }: { onRetry: () => void }) {
	return (
		<SettingsSection title="Teams">
			<SettingsCard>
				<div className="flex flex-col items-start gap-3">
					<p className="text-muted-foreground text-sm">
						We couldn&apos;t load your organization billing details. Check your
						connection and try again.
					</p>
					<Button onClick={onRetry} size="sm" variant="ghost">
						Try again
					</Button>
				</div>
			</SettingsCard>
		</SettingsSection>
	);
}

/** Shown when the billing-permission read fails, so controls stay hidden. */
export function TeamsBillingAccessUnavailable({
	isFetching,
	onRetry,
}: {
	isFetching: boolean;
	onRetry: () => void;
}) {
	return (
		<SettingsCard>
			<div className="flex flex-col items-start gap-3">
				<p
					className="text-sm text-status-destructive"
					data-testid="teams-billing-access-unavailable"
					role="alert"
				>
					We couldn&apos;t check your billing permissions, so seat and billing
					controls are hidden. Check your connection and try again.
				</p>
				<Button
					disabled={isFetching}
					onClick={onRetry}
					size="sm"
					variant="ghost"
				>
					{isFetching ? "Retrying…" : "Try again"}
				</Button>
			</div>
		</SettingsCard>
	);
}
