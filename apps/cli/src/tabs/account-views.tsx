/* @jsxImportSource @opentui/react */
// Presentational cards for the Account tab (switcher, profile, device-login
// prompt, logged-out hint).

import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import type { Account } from "../core/account-response.ts";
import { tf } from "../i18n/translate.ts";
import type { AuthInfo, LoginPrompt } from "./account-data.ts";

const WHITESPACE_RE = /\s+/;

// Two-letter monogram for the terminal "avatar" (no images in a TUI): first
// letters of the first two name words, else the first two chars of name/email.
function initials(account: Account): string {
	const source = account.name?.trim() || account.email?.trim() || "?";
	const parts = source.split(WHITESPACE_RE).filter(Boolean);
	if (parts.length >= 2) {
		const first = parts[0]?.charAt(0) ?? "";
		const second = parts[1]?.charAt(0) ?? "";
		return `${first}${second}`.toUpperCase();
	}
	return source.slice(0, 2).toUpperCase();
}

function InfoRow({
	label,
	value,
	valueColor,
	suffix,
	suffixColor,
}: {
	label: string;
	suffix?: string;
	suffixColor?: string;
	value: string;
	valueColor: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="row" gap={1}>
			<text fg={theme.colors.mutedForeground}>{label.padEnd(10, " ")}</text>
			<text fg={valueColor}>{value}</text>
			{suffix ? (
				<text fg={suffixColor ?? theme.colors.mutedForeground}>{suffix}</text>
			) : null}
		</box>
	);
}

export function AccountBody({
	accounts,
	info,
	loginPending,
	loginPrompt,
	selectedIdx,
}: {
	accounts: Account[];
	info: AuthInfo | null;
	loginPending: boolean;
	loginPrompt: LoginPrompt | null;
	selectedIdx: number;
}) {
	// A device flow in flight (first sign-in OR add-account) owns the view so the
	// user_code / verification_uri is always visible.
	if (loginPending) {
		return <SigningInCard loginPrompt={loginPrompt} />;
	}

	if (accounts.length === 0 && !info) {
		return <NotSignedInCard />;
	}

	return (
		<box flexDirection="column" gap={1}>
			{accounts.length > 0 ? (
				<AccountsList accounts={accounts} selectedIdx={selectedIdx} />
			) : null}
			{info ? <ProfileCard info={info} /> : null}
		</box>
	);
}

// Notion-style account switcher: one row per signed-in account with a monogram
// "avatar", name/email, the active marker, and a cursor on the highlighted row.
function AccountsList({
	accounts,
	selectedIdx,
}: {
	accounts: Account[];
	selectedIdx: number;
}) {
	const theme = useTheme();
	return (
		<Card
			subtitle="↑↓ select · s switch · a add account · x sign out · r refresh"
			title="Accounts"
		>
			{accounts.map((account, idx) => {
				const isSelected = idx === selectedIdx;
				const displayName = account.name?.trim() || account.email;
				const showEmail =
					Boolean(account.name?.trim()) && account.email !== displayName;
				return (
					<box flexDirection="row" gap={1} key={account.userId}>
						<text
							fg={
								isSelected ? theme.colors.primary : theme.colors.mutedForeground
							}
						>
							{isSelected ? "›" : " "}
						</text>
						<text fg={theme.colors.accent}>{`[${initials(account)}]`}</text>
						{isSelected ? (
							<text fg={theme.colors.primary}>
								<b>{displayName}</b>
							</text>
						) : (
							<text fg={theme.colors.foreground}>{displayName}</text>
						)}
						{showEmail ? (
							<text fg={theme.colors.mutedForeground}>{account.email}</text>
						) : null}
						{account.active ? (
							<text fg={theme.colors.success}>✓ active</text>
						) : null}
					</box>
				);
			})}
		</Card>
	);
}

function ProfileCard({ info }: { info: AuthInfo }) {
	const theme = useTheme();
	return (
		<Card title="Active account">
			<InfoRow
				label="Name"
				value={info.name}
				valueColor={theme.colors.foreground}
			/>
			<InfoRow
				label="Email"
				suffix={info.verified ? "(verified)" : "(unverified)"}
				suffixColor={
					info.verified ? theme.colors.success : theme.colors.warning
				}
				value={info.email}
				valueColor={theme.colors.foreground}
			/>
			<box height={1} />
			<InfoRow
				label="Password"
				value={info.hasPassword ? "Set" : `Not set (via ${info.authMethod})`}
				valueColor={
					info.hasPassword ? theme.colors.success : theme.colors.mutedForeground
				}
			/>
			<InfoRow
				label="2FA"
				value={info.twoFactor ? "Enabled" : "Disabled"}
				valueColor={
					info.twoFactor ? theme.colors.success : theme.colors.mutedForeground
				}
			/>
			<box height={1} />
			<InfoRow
				label="Plan"
				value={info.plan}
				valueColor={theme.colors.accent}
			/>
			<box flexDirection="row" gap={1}>
				<text fg={theme.colors.mutedForeground}>
					{"Sessions".padEnd(10, " ")}
				</text>
				<Badge bordered={false} variant="secondary">
					{tf("{sessionCount} active", {
						sessionCount: String(info.sessionCount),
					})}
				</Badge>
			</box>
		</Card>
	);
}

function SigningInCard({ loginPrompt }: { loginPrompt: LoginPrompt | null }) {
	const theme = useTheme();
	return (
		<Card borderColor={theme.colors.warning} title="Signing in">
			<text fg={theme.colors.warning}>Waiting for browser authentication…</text>
			<box height={1} />
			{loginPrompt?.url ? (
				<box flexDirection="column" gap={0}>
					<text fg={theme.colors.mutedForeground}>
						Open this URL to continue:
					</text>
					<text fg={theme.colors.info}>{loginPrompt.url}</text>
				</box>
			) : (
				<text fg={theme.colors.mutedForeground}>
					Complete sign-in in the browser window that just opened.
				</text>
			)}
			{loginPrompt?.userCode ? (
				<box flexDirection="row" gap={1} marginTop={1}>
					<text fg={theme.colors.mutedForeground}>Device code:</text>
					<text fg={theme.colors.foreground}>
						<b>{loginPrompt.userCode}</b>
					</text>
				</box>
			) : null}
		</Card>
	);
}

function NotSignedInCard() {
	const theme = useTheme();
	return (
		<Card title="Not signed in">
			<text fg={theme.colors.warning}>Not logged in</text>
			<box height={1} />
			<box flexDirection="row" gap={1}>
				<Badge variant="default">Sign in</Badge>
				<text fg={theme.colors.mutedForeground}>press l or a</text>
			</box>
		</Card>
	);
}
