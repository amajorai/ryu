/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { passwordValidationMessage } from "@ryuhq/protocol/password-policy";
import { useEffect, useRef, useState } from "react";
import { tf } from "../../i18n/translate.ts";
import {
	type SecurityEmailChangeResponse,
	type SecuritySessionResponse,
	securityBackupCodesResponseSchema,
	securityEmailChangeStatusResponseSchema,
	securityEnableTwoFactorResponseSchema,
	securityMessageSuccessResponseSchema,
	securityPasswordStatusResponseSchema,
	securitySessionResponseSchema,
	securitySetPasswordResponseSchema,
	securityStepUpChallengeResponseSchema,
	securityStepUpStatusResponseSchema,
	securityStepUpVerifyResponseSchema,
	securityVerifyTotpResponseSchema,
} from "./account-security-response-contracts.ts";
import {
	type Operation,
	SCOPE,
	type Stage,
	type UnloadedEmailChange,
	type UnloadedSecuritySession,
} from "./account-security-types.ts";
import { AccountSecurityView } from "./account-security-view.tsx";

export function AccountSecurity({
	active,
	authTarget,
	onEditingChange,
	onRefresh,
}: {
	active: boolean;
	authTarget: ApiTarget;
	onEditingChange: (editing: boolean) => void;
	onRefresh: () => void;
}) {
	const [stage, setStage] = useState<Stage>("idle");
	const [operation, setOperation] = useState<Operation>("password");
	const [session, setSession] = useState<
		SecuritySessionResponse | UnloadedSecuritySession
	>({});
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [value, setValue] = useState("");
	const [methods, setMethods] = useState<string[]>([]);
	const [methodIndex, setMethodIndex] = useState(0);
	const [uri, setUri] = useState("");
	const [codes, setCodes] = useState<string[]>([]);
	const [emailChange, setEmailChange] = useState<
		SecurityEmailChangeResponse | UnloadedEmailChange
	>({});
	const controllerRef = useRef<AbortController | null>(null);
	const switchStage = (next: Stage) => {
		setStage(next);
		onEditingChange(next !== "idle");
		setValue("");
	};
	const run = async (task: (signal: AbortSignal) => Promise<void>) => {
		if (busy) {
			return;
		}
		const controller = new AbortController();
		controllerRef.current?.abort();
		controllerRef.current = controller;
		setBusy(true);
		setMessage("");
		try {
			await task(controller.signal);
		} catch (error) {
			if (!controller.signal.aborted) {
				setMessage(
					tf("Could not complete action: {error}", {
						error: error instanceof Error ? error.message : String(error),
					})
				);
			}
		} finally {
			if (!controller.signal.aborted) {
				setBusy(false);
			}
		}
	};
	const read = async (signal: AbortSignal) => {
		const [next, change] = await Promise.all([
			request(
				authTarget,
				"/api/auth/get-session",
				{ signal },
				securitySessionResponseSchema
			),
			request(
				authTarget,
				"/api/user/email-change-status",
				{
					signal,
				},
				securityEmailChangeStatusResponseSchema
			),
		]);
		if (!signal.aborted) {
			setSession(next);
			setEmailChange(change);
		}
	};
	useEffect(() => {
		setBusy(false);
		setStage("idle");
		setValue("");
		setUri("");
		setCodes([]);
		onEditingChange(false);
		if (!active) {
			return;
		}
		const controller = new AbortController();
		controllerRef.current = controller;
		void read(controller.signal).catch((error) => {
			if (!controller.signal.aborted) {
				setMessage(
					tf("Could not load security: {error}", { error: String(error) })
				);
			}
		});
		return () => {
			controllerRef.current?.abort();
			onEditingChange(false);
		};
	}, [active, authTarget.url, authTarget.token]);
	const cancel = () => {
		if (busy) {
			return;
		}
		switchStage("idle");
		setUri("");
		setCodes([]);
		setMessage("");
	};
	const begin = (next: Operation) =>
		void run(async (signal) => {
			setOperation(next);
			if (next === "password" || next === "email") {
				const gate = await request(
					authTarget,
					`/api/step-up/status?scope=${SCOPE}`,
					{ signal },
					securityStepUpStatusResponseSchema
				);
				if (signal.aborted) {
					return;
				}
				if (!gate.satisfied) {
					if (
						gate.enrolmentRequired ||
						!Array.isArray(gate.methods) ||
						gate.methods.length === 0
					) {
						throw new Error(
							"Identity verification is unavailable for this account."
						);
					}
					const offered = gate.methods.filter((method) =>
						["password", "totp", "backup", "otp", "magic-link"].includes(method)
					);
					if (offered.length === 0) {
						throw new Error("No supported identity verification method.");
					}
					setMethods(offered);
					setMethodIndex(0);
					switchStage("factor");
					return;
				}
			}
			if (!signal.aborted) {
				switchStage("value");
			}
		});
	const submit = () =>
		void run(async (signal) => {
			if (stage === "factor") {
				const method = methods[methodIndex];
				let code = value;
				if (method === "magic-link" && value.includes("://")) {
					const link = new URL(value);
					code = link.searchParams.get("token") ?? "";
					if (link.searchParams.get("scope") !== SCOPE) {
						throw new Error(
							"Use the verification link for this account security request."
						);
					}
				}
				const result = await request(
					authTarget,
					"/api/step-up/verify",
					{ method: "POST", body: { scope: SCOPE, method, code }, signal },
					securityStepUpVerifyResponseSchema
				);
				if (result.verified !== true) {
					throw new Error("Identity verification was not confirmed.");
				}
				if (!signal.aborted) {
					switchStage("value");
				}
				return;
			}
			if (stage === "totp") {
				const result = await request(
					authTarget,
					"/api/auth/two-factor/verify-totp",
					{ method: "POST", body: { code: value }, signal },
					securityVerifyTotpResponseSchema
				);
				const next = await request(
					authTarget,
					"/api/auth/get-session",
					{ signal },
					securitySessionResponseSchema
				);
				if (next?.user?.twoFactorEnabled !== true) {
					throw new Error("Two-factor enablement was not confirmed.");
				}
				if (!signal.aborted) {
					setSession(next);
					setCodes(result.backupCodes ?? []);
					setUri("");
					switchStage("backup");
					setMessage(
						"Two-factor authentication enabled. Save these backup codes."
					);
					onRefresh();
				}
				return;
			}
			if (operation === "password") {
				// The rules sign-up and the set-password route hold a password to.
				const reason = passwordValidationMessage(value);
				if (reason) {
					throw new Error(`${reason}.`);
				}
				const result = await request(
					authTarget,
					"/api/user/set-password",
					{ method: "POST", body: { newPassword: value }, signal },
					securitySetPasswordResponseSchema
				);
				if (result.success !== true) {
					throw new Error("Password update was not confirmed.");
				}
				const status = await request(
					authTarget,
					"/api/user/password-status",
					{ signal },
					securityPasswordStatusResponseSchema
				);
				if (status.hasPassword !== true) {
					throw new Error("Password status did not confirm the update.");
				}
			} else if (operation === "email") {
				const newEmail = value.trim();
				if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
					throw new Error("Enter a valid email address.");
				}
				const result = await request(
					authTarget,
					"/api/user/initiate-email-change",
					{ method: "POST", body: { newEmail }, signal },
					securityMessageSuccessResponseSchema
				);
				if (result.success !== true) {
					throw new Error("Email change was not confirmed.");
				}
				const change = await request(
					authTarget,
					"/api/user/email-change-status",
					{ signal },
					securityEmailChangeStatusResponseSchema
				);
				if (!change.hasActive || change.emailChange?.newEmail !== newEmail) {
					throw new Error("Email request did not match readback.");
				}
				if (!signal.aborted) {
					setEmailChange(change);
				}
			} else if (operation === "enable") {
				const result = await request(
					authTarget,
					"/api/auth/two-factor/enable",
					{ method: "POST", body: { password: value }, signal },
					securityEnableTwoFactorResponseSchema
				);
				if (result.method !== "totp" || !result.totpURI) {
					throw new Error("Authenticator setup did not return a TOTP URI.");
				}
				if (!signal.aborted) {
					setUri(result.totpURI);
					switchStage("totp");
				}
				return;
			} else if (operation === "backup") {
				const result = await request(
					authTarget,
					"/api/auth/two-factor/generate-backup-codes",
					{ method: "POST", body: { password: value }, signal },
					securityBackupCodesResponseSchema
				);
				if (
					!Array.isArray(result.backupCodes) ||
					result.backupCodes.length === 0
				) {
					throw new Error("No backup codes returned.");
				}
				if (!signal.aborted) {
					setCodes(result.backupCodes);
					switchStage("backup");
				}
				return;
			} else {
				await request(
					authTarget,
					"/api/auth/two-factor/disable",
					{
						method: "POST",
						body: { password: value },
						signal,
					},
					appResponseValueSchema
				);
				const next = await request(
					authTarget,
					"/api/auth/get-session",
					{ signal },
					securitySessionResponseSchema
				);
				if (next?.user?.twoFactorEnabled !== false) {
					throw new Error("Two-factor disablement was not confirmed.");
				}
				if (!signal.aborted) {
					setSession(next);
				}
			}
			if (!signal.aborted) {
				switchStage("idle");
				setMessage(
					operation === "email"
						? "Email change requested. Confirm both email addresses to finish."
						: "Security update confirmed."
				);
				onRefresh();
			}
		});
	useKeyboard((key) => {
		if (!active || busy) {
			return;
		}
		if (stage !== "idle") {
			if (key.name === "tab") {
				cancel();
				return;
			}
			if (key.name === "return") {
				if (stage === "backup") {
					cancel();
					return;
				}
				submit();
				return;
			}
			if (stage === "backup") {
				return;
			}
			if (stage === "factor" && (key.name === "left" || key.name === "right")) {
				setMethodIndex(
					(index) =>
						(index + (key.name === "right" ? 1 : methods.length - 1)) %
						methods.length
				);
				setValue("");
				return;
			}
			if (
				stage === "factor" &&
				key.ctrl &&
				key.name === "s" &&
				["otp", "magic-link"].includes(methods[methodIndex] ?? "")
			) {
				void run(async (signal) => {
					const result = await request(
						authTarget,
						"/api/step-up/challenge",
						{
							method: "POST",
							body: { scope: SCOPE, method: methods[methodIndex] },
							signal,
						},
						securityStepUpChallengeResponseSchema
					);
					if (result.sent !== true) {
						throw new Error("Verification code was not sent.");
					}
					if (!signal.aborted) {
						setMessage(
							methods[methodIndex] === "magic-link"
								? "Verification link requested."
								: "Verification code requested."
						);
					}
				});
				return;
			}
			if (key.name === "backspace") {
				setValue((current) => current.slice(0, -1));
				return;
			}
			if (
				!(key.ctrl || key.meta) &&
				key.sequence &&
				!key.sequence.includes("\x1b")
			) {
				setValue((current) => (current + key.sequence).slice(0, 2048));
			}
			return;
		}
		if (key.name === "w") {
			begin("password");
		} else if (key.name === "u") {
			begin("email");
		} else if (key.name === "t") {
			begin(session?.user?.twoFactorEnabled ? "disable" : "enable");
		} else if (key.name === "b" && session?.user?.twoFactorEnabled) {
			begin("backup");
		} else if (
			key.name === "v" &&
			session?.user?.email &&
			!session?.user.emailVerified
		) {
			void run(async (signal) => {
				const result = await request(
					authTarget,
					"/api/user/resend-verification",
					{ method: "POST", body: { email: session?.user?.email }, signal },
					securityMessageSuccessResponseSchema
				);
				if (result.success !== true) {
					throw new Error("Verification request failed.");
				}
				if (!signal.aborted) {
					setMessage(
						"Verification email requested. Check your inbox, then refresh account status."
					);
				}
			});
		} else if (key.name === "c" && emailChange.hasActive) {
			void run(async (signal) => {
				const result = await request(
					authTarget,
					"/api/user/cancel-email-change",
					{ method: "POST", signal },
					securityMessageSuccessResponseSchema
				);
				if (result.success !== true) {
					throw new Error("Email cancellation was not confirmed.");
				}
				const change = await request(
					authTarget,
					"/api/user/email-change-status",
					{ signal },
					securityEmailChangeStatusResponseSchema
				);
				if (change.hasActive) {
					throw new Error("Email request remains active after cancellation.");
				}
				if (!signal.aborted) {
					setEmailChange(change);
					setMessage("Email change cancellation confirmed.");
				}
			});
		}
	});
	return (
		<AccountSecurityView
			busy={busy}
			codes={codes}
			emailChange={emailChange}
			message={message}
			methodIndex={methodIndex}
			methods={methods}
			operation={operation}
			session={session}
			stage={stage}
			uri={uri}
			value={value}
		/>
	);
}
