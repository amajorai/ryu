import {
	AlertCircleIcon,
	CheckmarkBadge04Icon,
	CheckmarkCircle01Icon,
	CircleIcon,
	Clock01Icon,
	ShieldBanIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	settingsApi,
	useEmailChangeStatus,
	usePasswordStatus,
} from "@ryu/settings";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Spinner } from "@ryu/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import { useSession } from "@/lib/auth-client.ts";
import { EmailChangeDialog } from "./dialogs/EmailChangeDialog.tsx";
import { PasswordChangeDialog } from "./dialogs/PasswordChangeDialog.tsx";
import { TwoFactorDialog } from "./dialogs/TwoFactorDialog.tsx";
import { ResendVerificationButton } from "./ResendVerificationButton.tsx";
import { CopyableId } from "./shared/CopyableId.tsx";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const AUTH_METHOD_LABELS: Record<string, string> = {
	"magic-link": "You sign in with a magic link",
	google: "You sign in with Google",
	github: "You sign in with GitHub",
	apple: "You sign in with Apple",
	discord: "You sign in with Discord",
};

function describeAuthMethod(method: string): string {
	return AUTH_METHOD_LABELS[method] ?? "You sign in with a connected account";
}

export function AccountTab() {
	const queryClient = useQueryClient();
	const { data: sessionData, isPending: sessionLoading } = useSession();
	const user = sessionData?.user;

	const { hasPassword, authMethod, isLoading: pwLoading } = usePasswordStatus();
	const {
		hasActiveEmailChange,
		emailChange,
		isLoading: emailChangeLoading,
		refetch: refetchEmailChange,
	} = useEmailChangeStatus();

	const twoFactorEnabled = !!(
		sessionData?.user as { twoFactorEnabled?: boolean } | undefined
	)?.twoFactorEnabled;

	const handleCancelEmailChange = async () => {
		try {
			await settingsApi.user.cancelEmailChange();
			sileo.success({ title: "Email change cancelled" });
			refetchEmailChange();
		} catch {
			sileo.error({ title: "Failed to cancel email change" });
		}
	};

	return (
		<div className="space-y-6">
			{/* Email verification banner */}
			{user && !user.emailVerified && (
				<div className="flex items-start justify-between gap-3 rounded-lg border border-warning bg-warning p-3 dark:border-warning dark:bg-warning/20">
					<div className="flex items-center gap-2">
						<HugeiconsIcon
							className="size-4 shrink-0 text-warning dark:text-warning"
							icon={AlertCircleIcon}
						/>
						<p className="text-sm text-warning dark:text-warning">
							Please verify your email address to unlock all features.
						</p>
					</div>
					<ResendVerificationButton email={user.email ?? ""} />
				</div>
			)}

			<SettingsSection title="Sign-in & security">
				<SettingsGroup>
					<SettingsItem
						actions={
							user?.email &&
							!hasActiveEmailChange && (
								<EmailChangeDialog currentEmail={user.email} />
							)
						}
						description={sessionLoading ? "Loading…" : user?.email}
						title="Email address"
					>
						{emailChangeLoading ? (
							<Spinner className="size-4" />
						) : hasActiveEmailChange && emailChange ? (
							<div className="w-full space-y-2 rounded-lg border border-warning bg-warning p-3 dark:border-warning dark:bg-warning/20">
								<div className="flex items-center gap-2">
									<HugeiconsIcon
										className="size-4 shrink-0 text-warning dark:text-warning"
										icon={Clock01Icon}
									/>
									<p className="font-medium text-sm text-warning dark:text-warning">
										Email change pending
									</p>
								</div>
								<p className="text-warning text-xs dark:text-warning">
									{emailChange.statusMessage ??
										`Changing to ${emailChange.newEmail}`}
								</p>
								<div className="flex items-center gap-3 text-xs">
									<span className="flex items-center gap-1">
										{emailChange.oldEmailConfirmedAt ? (
											<HugeiconsIcon
												className="size-3 text-success"
												icon={CheckmarkCircle01Icon}
											/>
										) : (
											<HugeiconsIcon
												className="size-3 text-muted-foreground"
												icon={CircleIcon}
											/>
										)}
										Old email confirmed
									</span>
									<span className="flex items-center gap-1">
										{emailChange.newEmailConfirmedAt ? (
											<HugeiconsIcon
												className="size-3 text-success"
												icon={CheckmarkCircle01Icon}
											/>
										) : (
											<HugeiconsIcon
												className="size-3 text-muted-foreground"
												icon={CircleIcon}
											/>
										)}
										New email confirmed
									</span>
								</div>
								<Button
									className="h-7 px-2 text-muted-foreground text-xs"
									onClick={handleCancelEmailChange}
									size="sm"
									variant="ghost"
								>
									Cancel change
								</Button>
							</div>
						) : null}
					</SettingsItem>

					<SettingsItem
						actions={
							!pwLoading && <PasswordChangeDialog hasPassword={hasPassword} />
						}
						description={
							pwLoading
								? "…"
								: hasPassword
									? "Password is set"
									: describeAuthMethod(authMethod)
						}
						title="Password"
					/>

					<SettingsItem
						actions={
							<TwoFactorDialog
								isEnabled={twoFactorEnabled}
								onStatusChange={() => {
									queryClient.invalidateQueries({ queryKey: ["session"] });
								}}
							/>
						}
						description={
							twoFactorEnabled
								? "Your account is protected with 2FA."
								: "Add an extra layer of security to your account."
						}
						title={
							<span className="flex items-center gap-2">
								{twoFactorEnabled ? (
									<HugeiconsIcon
										className="size-4 shrink-0 text-success"
										icon={CheckmarkBadge04Icon}
									/>
								) : (
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={ShieldBanIcon}
									/>
								)}
								Two-Factor Authentication
								<Badge
									className="text-xs"
									variant={twoFactorEnabled ? "default" : "secondary"}
								>
									{twoFactorEnabled ? "Enabled" : "Disabled"}
								</Badge>
							</span>
						}
					/>

					{user?.id ? (
						<SettingsItem
							actions={<CopyableId label="user ID" value={user.id} />}
							description="Your account's stable identifier."
							title="User ID"
						/>
					) : null}
				</SettingsGroup>
			</SettingsSection>
		</div>
	);
}
