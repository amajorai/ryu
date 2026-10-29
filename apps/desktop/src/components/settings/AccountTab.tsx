import {
	AlertCircleIcon,
	CheckmarkBadge04Icon,
	CheckmarkCircle01Icon,
	CircleIcon,
	Clock01Icon,
	ShieldBanIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	settingsApi,
	useEmailChangeStatus,
	usePasswordStatus,
} from "@ryu/settings";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { sileo } from "sileo";
import { z } from "zod";
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

const AUTH_METHOD_LABELS = new Map<string, string>([
	["magic-link", "You sign in with a magic link"],
	["google", "You sign in with Google"],
	["github", "You sign in with GitHub"],
	["apple", "You sign in with Apple"],
	["discord", "You sign in with Discord"],
]);

function describeAuthMethod(method: string): string {
	return (
		AUTH_METHOD_LABELS.get(method) ?? "You sign in with a connected account"
	);
}

export function AccountTab() {
	const tl = useLiteralMessages();
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

	const twoFactorStatus = z
		.object({ twoFactorEnabled: z.boolean().optional() })
		.safeParse(user);
	const twoFactorEnabled =
		twoFactorStatus.success && twoFactorStatus.data.twoFactorEnabled === true;

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
							className="size-4 shrink-0 text-status-warning dark:text-status-warning"
							icon={AlertCircleIcon}
						/>
						<p className="text-sm text-status-warning dark:text-status-warning">
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
										className="size-4 shrink-0 text-status-warning dark:text-status-warning"
										icon={Clock01Icon}
									/>
									<p className="font-medium text-sm text-status-warning dark:text-status-warning">
										Email change pending
									</p>
								</div>
								<p className="text-status-warning text-xs dark:text-status-warning">
									{emailChange.statusMessage ??
										tl("Changing to {newEmail}", {
											newEmail: emailChange.newEmail,
										})}
								</p>
								<div className="flex items-center gap-3 text-xs">
									<span className="flex items-center gap-1">
										{emailChange.oldEmailConfirmedAt ? (
											<HugeiconsIcon
												className="size-3 text-status-success"
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
												className="size-3 text-status-success"
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
									appearance="service-action"
									onClick={handleCancelEmailChange}
									size="sm"
									typography="compact"
									variant="ghost-muted"
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
										className="size-4 shrink-0 text-status-success"
										icon={CheckmarkBadge04Icon}
									/>
								) : (
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={ShieldBanIcon}
									/>
								)}
								Two-Factor Authentication
								<Badge variant={twoFactorEnabled ? "default" : "secondary"}>
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
