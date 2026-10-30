/* @jsxImportSource @opentui/react */
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { tf } from "../../i18n/translate.ts";
import type {
	SecurityEmailChangeResponse,
	SecuritySessionResponse,
} from "./account-security-response-contracts.ts";
import type {
	Operation,
	Stage,
	UnloadedEmailChange,
	UnloadedSecuritySession,
} from "./account-security-types.ts";

export function AccountSecurityView({
	busy,
	codes,
	emailChange,
	message,
	methodIndex,
	methods,
	operation,
	session,
	stage,
	uri,
	value,
}: {
	busy: boolean;
	codes: string[];
	emailChange: SecurityEmailChangeResponse | UnloadedEmailChange;
	message: string;
	methodIndex: number;
	methods: string[];
	operation: Operation;
	session: SecuritySessionResponse | UnloadedSecuritySession;
	stage: Stage;
	uri: string;
	value: string;
}) {
	const theme = useTheme();
	return (
		<Card title="Account security">
			{stage === "idle" ? (
				<>
					<text>
						{tf(
							"w set/change password · u change email · t {enabled, select, true {disable} other {enable}} two-factor",
							{ enabled: session?.user?.twoFactorEnabled ? "true" : "false" }
						)}
					</text>
					<text>
						{session?.user?.twoFactorEnabled
							? "b regenerate backup codes · "
							: ""}
						{session?.user?.emailVerified
							? "Email verified"
							: "v request verification email"}
					</text>
					{emailChange.hasActive ? (
						<text>
							{tf("Changing to {newEmail} · c cancel request", {
								newEmail: emailChange.emailChange?.newEmail ?? "",
							})}
						</text>
					) : null}
				</>
			) : null}
			{stage === "factor" ? (
				<text>
					{tf(
						"Verify identity: {method} · ←/→ method{request, select, true { · Ctrl+s request verification} other {}}",
						{
							method: methods[methodIndex] ?? "",
							request: ["otp", "magic-link"].includes(
								methods[methodIndex] ?? ""
							)
								? "true"
								: "false",
						}
					)}
				</text>
			) : null}
			{stage === "factor" && methods[methodIndex] === "magic-link" ? (
				<text>
					Request a link, then paste its token or complete verification URL from
					your inbox.
				</text>
			) : null}
			{stage === "value" ? (
				<text>
					{operation === "password"
						? "New password (other sessions will be revoked)"
						: operation === "email"
							? "New email address (requires confirmation from both addresses)"
							: "Current password"}
				</text>
			) : null}
			{stage === "totp" ? (
				<>
					<text>
						{tf("Add this URI to your authenticator: {uri}", { uri })}
					</text>
					<text>Enter the authenticator code to finish setup.</text>
				</>
			) : null}
			{stage !== "idle" && stage !== "backup" ? (
				<text fg={theme.colors.foreground}>
					{operation === "email" && stage === "value"
						? value
						: "•".repeat(value.length)}
					▏
				</text>
			) : null}
			{stage === "backup" ? (
				<>
					<text>Store these codes privately before continuing.</text>
					{codes.map((code) => (
						<text key={code}>{code}</text>
					))}
					<text>Enter acknowledge and clear</text>
				</>
			) : null}
			{message ? (
				<text
					fg={
						message.startsWith("Could not")
							? theme.colors.error
							: theme.colors.success
					}
				>
					{message}
				</text>
			) : null}
			{busy ? (
				<text>Working…</text>
			) : stage === "idle" ? null : (
				<text>Type · Enter submit · Tab cancel</text>
			)}
		</Card>
	);
}
