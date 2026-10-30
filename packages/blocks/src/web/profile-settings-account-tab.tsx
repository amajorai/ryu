"use client";

import { Button } from "@ryu/ui/components/button";
import type { ReactNode } from "react";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "../desktop/settings-items.tsx";
import { RowHint } from "./profile-settings-row-hint.tsx";

export interface AccountTabPanelProps {
	authMethod: string | null;
	changeEmailSlot?: ReactNode;
	changePasswordSlot?: ReactNode;
	email: string;
	emailChangeStatusSlot?: ReactNode;
	isPasswordStatusLoading: boolean;
	mergeAccountsSlot?: ReactNode;
	mergeStatusSlot?: ReactNode;
	onDeleteAccount?: () => void;
	passkeysSlot?: ReactNode;
	twoFactorEnabled: boolean;
	twoFactorSlot?: ReactNode;
}

function passwordButtonLabel(
	isPasswordStatusLoading: boolean,
	authMethod: string | null
): string {
	if (isPasswordStatusLoading) {
		return "Loading…";
	}
	return authMethod === "password" ? "Change password" : "Set password";
}

export function AccountTabPanel({
	authMethod,
	changeEmailSlot,
	changePasswordSlot,
	email,
	emailChangeStatusSlot,
	isPasswordStatusLoading,
	mergeAccountsSlot,
	mergeStatusSlot,
	onDeleteAccount,
	passkeysSlot,
	twoFactorEnabled,
	twoFactorSlot,
}: AccountTabPanelProps) {
	return (
		<>
			<SettingsSection title="Email">
				<SettingsGroup>
					<SettingsItem
						actions={
							changeEmailSlot ?? (
								<Button size="sm" variant="outline">
									Change email
								</Button>
							)
						}
						title="Email address"
					>
						<RowHint className="truncate">{email}</RowHint>
					</SettingsItem>
				</SettingsGroup>
				{emailChangeStatusSlot}
			</SettingsSection>

			<SettingsSection title="Sign-in">
				<SettingsGroup>
					<SettingsItem
						actions={
							changePasswordSlot ?? (
								<Button
									disabled={isPasswordStatusLoading}
									size="sm"
									variant="outline"
								>
									{passwordButtonLabel(isPasswordStatusLoading, authMethod)}
								</Button>
							)
						}
						title="Password"
					>
						<RowHint>
							{authMethod === "password"
								? "Update your account password"
								: "Set a password to enable password-based login"}
						</RowHint>
					</SettingsItem>
					{passkeysSlot ? (
						<SettingsItem actions={passkeysSlot} title="Passkeys">
							<RowHint>
								Sign in with your device or a security key instead of a
								password.
							</RowHint>
						</SettingsItem>
					) : null}
					<SettingsItem
						actions={
							twoFactorSlot ?? (
								<Button size="sm" variant="outline">
									{twoFactorEnabled ? "Manage 2FA" : "Enable 2FA"}
								</Button>
							)
						}
						title="Two-factor authentication"
					>
						<RowHint>
							{twoFactorEnabled
								? "Two-factor authentication is enabled"
								: "Add an extra layer of security to your account"}
						</RowHint>
					</SettingsItem>
				</SettingsGroup>
			</SettingsSection>

			{mergeAccountsSlot ? (
				<SettingsSection>
					<SettingsGroup>
						<SettingsItem
							actions={mergeAccountsSlot}
							description="Signed up twice? Fold the other account's workspaces, credit and history into this one. Both inboxes have to confirm, and it can't be undone."
							title="Merge another account"
						/>
					</SettingsGroup>
					{mergeStatusSlot}
				</SettingsSection>
			) : null}

			{onDeleteAccount ? (
				<SettingsSection>
					<SettingsGroup>
						<SettingsItem
							actions={
								<Button
									onClick={onDeleteAccount}
									size="sm"
									variant="destructive"
								>
									Delete account
								</Button>
							}
							description="Permanently delete your account and all data"
							title={
								<span className="text-status-destructive">Delete account</span>
							}
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}
		</>
	);
}
