import { z } from "zod";
import {
	type Account,
	accountMutationResponseSchema,
	accountsResponseSchema,
	type LoginStart,
	loginStartResponseSchema,
	sessionsResponseSchema,
} from "../core/account-response.ts";
import {
	type CoreAuthStatusWire as CoreAuthStatus,
	coreAuthStatusWireSchema,
} from "../core/auth-status-wire.ts";
import {
	nativeErrorMessage as errText,
	humanizeError,
} from "../core/native-errors.ts";
import {
	type SecuritySessionResponse as SessionWire,
	securityPasswordStatusResponseSchema,
	securitySessionResponseSchema,
} from "../overlays/settings/account-security-response-contracts.ts";
/* @jsxImportSource @opentui/react */
// Account tab - parity with apps/cli's SidebarTab::Account
// (apps/cli/src/{auth.rs,ui.rs::render_account_content,main.rs}).
//
// What apps/cli does, mirrored here (plus Notion-style multi-account switching):
//   - Accounts: a switcher card listing every signed-in account (monogram
//     "avatar" + name/email, a ✓ on the active one) backed by Core's local vault
//     (GET /api/auth/accounts). Tokens never leave the device.
//   - Logged in: also show the active account's Name, Email (verified/
//     unverified), Password (set / not set via <method>), 2FA, Plan, Sessions.
//   - Logged out: "Not logged in" + a sign-in hint.
//   - Login pending: "Waiting for browser authentication…" + the device code and
//     verification URL (shared by first sign-in AND add-account).
//   - Keys: ↑/↓ = select account, s/Enter = switch active
//     (POST /api/auth/accounts/switch), a = add account (device flow),
//     x = sign the selected account out (POST /api/auth/accounts/remove),
//     r = refresh, l = sign in (device flow), Shift+L = sign out active.
//
// Architecture note (reported as the integration gap): the rich profile fields
// live on the CONTROL-PLANE auth backend (RYU_AUTH_URL; see
// core/controlPlane.ts for the defaults), NOT on Ryu Core, and there is no core-client auth
// module. So this tab drives the device-login/logout/status through Core
// (/api/auth/login|status|logout via the core-client `request` primitive) and
// fetches the profile from the auth backend with a second ApiTarget
// { url: authBackendUrl, token } - exactly what apps/cli's auth.rs does. Core
// hydrates the persisted token into /api/auth/status on boot
// (apps/core/src/auth/mod.rs AuthState::new), so the bearer it returns matches
// the ~/.ryu/secrets/auth.json token apps/cli reads.

import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import {
	type AccountProbeResult,
	startAccountPolling,
} from "../core/account-polling.ts";
import { AUTH_BACKEND_URL, accountBackendTarget } from "../core/authBackend.ts";
import { useCore } from "../core/CoreContext.tsx";
import { refreshCliIdentityAfterAccountChange } from "../core/identity.ts";
// Best-effort open of the device-login URL; the panel always shows it too.
import { openBrowser } from "../core/openBrowser.ts";
import { AccountSecurity } from "../overlays/settings/account-security.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

// The control-plane (Better-Auth) backend that owns profile/billing/sessions.
// apps/cli reads this from RYU_AUTH_URL with the same default.
const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 300_000;

interface AuthInfo {
	authMethod: string;
	email: string;
	hasPassword: boolean;
	name: string;
	plan: string;
	sessionCount: number;
	token: string;
	twoFactor: boolean;
	verified: boolean;
}

interface LoginPrompt {
	url: string | null;
	userCode: string | null;
}

// One signed-in account in the local device vault Core maintains. Tokens NEVER
// cross the wire - Core returns only these safe fields (parity with the shared
// multi-account contract used by every bearer surface).

type Phase = "loading" | "ready";

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

// Mirror apps/cli main.rs::format_plan: collapse the subscription payload into a
// short human label.
function formatPlan(sub: SubscriptionStatus): string {
	const lifetime = sub.lifetime;
	if (lifetime) {
		const lt = lifetime;
		if (lt.expired === true) {
			return "Lifetime (updates expired)";
		}
		const until = lt.updatesExpiresAt?.split("T")[0] ?? "—";
		return `Lifetime (updates until ${until})`;
	}

	const subscription = sub.subscription;
	if (subscription) {
		const s = subscription;
		const status = s.status;
		const interval = s.interval;
		if (status === "trialing") {
			return `Trial (${interval}ly after trial)`;
		}
		let label = interval;
		if (interval === "month") {
			label = "monthly";
		} else if (interval === "year") {
			label = "annual";
		}
		return `Pro (${label})`;
	}

	return "Free";
}

type LoadResult =
	| { kind: "coreDown"; message: string }
	| { kind: "loggedIn"; info: AuthInfo }
	| { kind: "loggedOut" };

// One device-status probe of the flow `/api/auth/login` started under
// `userCode`. Core stays `authenticated` with the previous account when an "add
// account" flow is denied or expires, so success is read from the outcome Core
// records for THIS code (`lastFlow`), never from `authenticated` alone.
export async function pollOnce(
	target: ApiTarget,
	userCode: string | null,
	signal?: AbortSignal
): Promise<AccountProbeResult> {
	const status = await request(
		target,
		"/api/auth/status",
		{
			signal,
		},
		coreAuthStatusWireSchema
	);
	const flow = status.lastFlow;
	if (userCode !== null && flow?.userCode === userCode) {
		return flow.result === "succeeded"
			? true
			: { failed: flow.error ?? "failed" };
	}
	if (status.pending) {
		return false;
	}
	if (userCode === null || flow === undefined) {
		// A Core that predates `lastFlow` (or a flow without a code) only
		// publishes the settled state.
		return Boolean(status.authenticated && status.token);
	}
	// Core is no longer waiting and recorded no outcome for this code: the flow
	// was cancelled (sign-out) or replaced by another one.
	return { failed: "cancelled" };
}

// Human copy for a device flow that ended without signing in.
function describeFlowFailure(reason: string): string {
	if (reason === "access_denied") {
		return "Sign-in was denied";
	}
	if (reason === "device_code_expired" || reason === "timeout") {
		return "Sign-in code expired";
	}
	if (reason === "cancelled") {
		return "Sign-in was cancelled";
	}
	return `Sign-in failed: ${reason}`;
}

// Resolve the full account state in one pass (no setState - the caller applies it
// once, guarded by mountedRef). get-session gates logged-in (parity with
// auth.rs::fetch_auth_info); password/billing/sessions degrade independently.
async function fetchAuth(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<LoadResult> {
	let status: CoreAuthStatus;
	try {
		status = await request(
			target,
			"/api/auth/status",
			{
				signal,
			},
			coreAuthStatusWireSchema
		);
	} catch (err) {
		return { kind: "coreDown", message: errText(err) };
	}
	const token = status.token ?? null;
	if (!token) {
		return { kind: "loggedOut" };
	}

	const authTarget = accountBackendTarget(token);
	let session: SessionWire;
	try {
		session = await request(
			authTarget,
			"/api/auth/get-session",
			{
				signal,
			},
			securitySessionResponseSchema
		);
	} catch {
		return { kind: "loggedOut" };
	}
	const user = session?.user;
	if (!user) {
		return { kind: "loggedOut" };
	}

	const [pw, sub, sessions] = await Promise.all([
		request(
			authTarget,
			"/api/user/password-status",
			{
				signal,
			},
			securityPasswordStatusResponseSchema
		).catch(() => null),
		request(
			authTarget,
			"/api/billing/subscription-status",
			{ signal },
			appResponseValueSchema
		)
			.then((value) => subscriptionStatusSchema.parse(value))
			.catch(() => null),
		request(
			authTarget,
			"/api/sessions",
			{ signal },
			sessionsResponseSchema
		).catch(() => null),
	]);

	return {
		kind: "loggedIn",
		info: {
			token,
			name: user.name ?? "Unknown",
			email: user.email ?? "—",
			verified: user.emailVerified ?? false,
			twoFactor: user.twoFactorEnabled ?? false,
			hasPassword: pw?.hasPassword ?? false,
			authMethod: pw?.authMethod ?? "unknown",
			plan: sub ? formatPlan(sub) : "—",
			sessionCount: sessions?.sessions?.length ?? 0,
		},
	};
}

// List the signed-in accounts from Core's local vault. Degrades to an empty
// list so a vault/read failure never blocks the profile view.
async function fetchAccounts(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<Account[]> {
	try {
		const wire = await request(
			target,
			"/api/auth/accounts",
			{
				signal,
			},
			accountsResponseSchema
		);
		return Array.isArray(wire.accounts) ? wire.accounts : [];
	} catch {
		return [];
	}
}

export function AccountTab({
	active,
	onEditingChange,
}: TabProps & { onEditingChange?: (editing: boolean) => void }) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();

	const securityEditing = useRef(false);
	const setSecurityEditing = useCallback(
		(editing: boolean) => {
			securityEditing.current = editing;
			onEditingChange?.(editing);
		},
		[onEditingChange]
	);
	const [phase, setPhase] = useState<Phase>("loading");
	const [info, setInfo] = useState<AuthInfo | null>(null);
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [coreError, setCoreError] = useState<string | null>(null);
	const [loginPending, setLoginPending] = useState(false);
	const [loginPrompt, setLoginPrompt] = useState<LoginPrompt | null>(null);

	const mountedRef = useRef(true);
	const scopeRef = useRef({ target, active });
	scopeRef.current = { target, active };
	const pollRef = useRef<(() => void) | null>(null);
	const loginRequestRef = useRef<AbortController | null>(null);
	const profileRequestRef = useRef<AbortController | null>(null);

	const loadAuth = useCallback(async () => {
		if (
			!(mountedRef.current && scopeRef.current.active) ||
			scopeRef.current.target !== target
		) {
			return;
		}
		profileRequestRef.current?.abort();
		const controller = new AbortController();
		profileRequestRef.current = controller;
		const [result, accts] = await Promise.all([
			fetchAuth(target, controller.signal),
			fetchAccounts(target, controller.signal),
		]);
		if (profileRequestRef.current === controller) {
			profileRequestRef.current = null;
		}
		if (
			!mountedRef.current ||
			controller.signal.aborted ||
			scopeRef.current.target !== target
		) {
			return;
		}
		setAccounts(accts);
		if (result.kind === "coreDown") {
			setCoreError(result.message);
			setInfo(null);
		} else if (result.kind === "loggedIn") {
			setCoreError(null);
			setInfo(result.info);
		} else {
			setCoreError(null);
			setInfo(null);
		}
		setPhase("ready");
	}, [target]);

	const refresh = useCallback(() => {
		setPhase("loading");
		loadAuth();
	}, [loadAuth]);

	const stopPolling = useCallback(() => {
		pollRef.current?.();
		pollRef.current = null;
		loginRequestRef.current?.abort();
		loginRequestRef.current = null;
	}, []);

	const startPolling = useCallback(
		(userCode: string | null) => {
			stopPolling();
			if (
				!(mountedRef.current && scopeRef.current.active) ||
				scopeRef.current.target !== target
			) {
				return;
			}
			pollRef.current = startAccountPolling(
				(signal) => pollOnce(target, userCode, signal),
				async (signedIn, failure) => {
					pollRef.current = null;
					if (!mountedRef.current || scopeRef.current.target !== target) {
						return;
					}
					setLoginPending(false);
					setLoginPrompt(null);
					if (signedIn) {
						await refreshCliIdentityAfterAccountChange();
						if (!mountedRef.current || scopeRef.current.target !== target) {
							return;
						}
						notify("Signed in", "success");
						loadAuth();
					} else if (failure === undefined) {
						notify("Sign-in timed out", "error");
					} else {
						notify(describeFlowFailure(failure), "error");
					}
				},
				{ intervalMs: POLL_INTERVAL_MS, timeoutMs: LOGIN_TIMEOUT_MS }
			);
		},
		[target, notify, loadAuth, stopPolling]
	);

	// Device flow, shared by first sign-in AND "add account". Unlike the old
	// single-account tab it does NOT bail when already signed in: adding a second
	// account while signed into a first is the whole point of multi-account. Core
	// upserts the returned token+profile into the vault (keeping the others), so
	// after success loadAuth reloads the accounts list. Only guarded so a second
	// login can't start while one is already in flight.
	const startLogin = useCallback(async () => {
		if (
			loginPending ||
			!mountedRef.current ||
			!scopeRef.current.active ||
			scopeRef.current.target !== target
		) {
			return;
		}
		stopPolling();
		const controller = new AbortController();
		loginRequestRef.current = controller;
		setLoginPending(true);
		setLoginPrompt(null);
		notify("Starting sign-in…", "loading");
		let start: LoginStart;
		try {
			start = await request(
				target,
				"/api/auth/login",
				{
					method: "POST",
					body: { backendUrl: AUTH_BACKEND_URL },
					signal: controller.signal,
				},
				loginStartResponseSchema
			);
		} catch (err) {
			if (
				mountedRef.current &&
				!controller.signal.aborted &&
				scopeRef.current.target === target
			) {
				setLoginPending(false);
				notify(`Sign-in failed: ${errText(err)}`, "error");
			}
			return;
		}
		if (
			!mountedRef.current ||
			controller.signal.aborted ||
			scopeRef.current.target !== target
		) {
			return;
		}
		if (start.error) {
			if (
				mountedRef.current &&
				!controller.signal.aborted &&
				scopeRef.current.target === target
			) {
				setLoginPending(false);
				notify(`Sign-in failed: ${start.error}`, "error");
			}
			return;
		}
		const url = start.verificationUriComplete ?? start.verificationUri ?? null;
		if (
			mountedRef.current &&
			!controller.signal.aborted &&
			scopeRef.current.target === target
		) {
			setLoginPrompt({ userCode: start.userCode ?? null, url });
		}
		openBrowser(url);
		startPolling(start.userCode ?? null);
	}, [loginPending, target, notify, startPolling, stopPolling]);

	// Mirror do_logout: only acts when signed in.
	const logout = useCallback(async () => {
		if (!info) {
			return;
		}
		stopPolling();
		setLoginPending(false);
		setLoginPrompt(null);
		try {
			await request(
				target,
				"/api/auth/logout",
				{ method: "POST" },
				appResponseValueSchema
			);
		} catch (err) {
			if (mountedRef.current) {
				notify(`Sign-out failed: ${errText(err)}`, "error");
			}
			return;
		}
		await refreshCliIdentityAfterAccountChange();
		if (mountedRef.current && scopeRef.current.target === target) {
			notify("Signed out", "info");
			loadAuth();
		}
	}, [info, target, notify, stopPolling, loadAuth]);

	// Switch the active account. Core swaps the active token in its vault; loadAuth
	// then re-fetches the profile with the new bearer.
	const switchAccount = useCallback(
		async (userId: string) => {
			notify("Switching account…", "loading");
			try {
				const res = await request(
					target,
					"/api/auth/accounts/switch",
					{ method: "POST", body: { userId } },
					accountMutationResponseSchema
				);
				if (res.error) {
					if (mountedRef.current) {
						notify(`Switch failed: ${res.error}`, "error");
					}
					return;
				}
			} catch (err) {
				if (mountedRef.current) {
					notify(`Switch failed: ${errText(err)}`, "error");
				}
				return;
			}
			await refreshCliIdentityAfterAccountChange();
			if (mountedRef.current && scopeRef.current.target === target) {
				notify("Switched account", "success");
				loadAuth();
			}
		},
		[target, notify, loadAuth]
	);

	// Sign one account out of the vault. Core falls back to another account if one
	// remains, else the logged-out state; loadAuth reflects whichever it is.
	const removeAccount = useCallback(
		async (userId: string) => {
			stopPolling();
			setLoginPending(false);
			setLoginPrompt(null);
			try {
				const res = await request(
					target,
					"/api/auth/accounts/remove",
					{ method: "POST", body: { userId } },
					accountMutationResponseSchema
				);
				if (res.error) {
					if (mountedRef.current) {
						notify(`Sign-out failed: ${res.error}`, "error");
					}
					return;
				}
			} catch (err) {
				if (mountedRef.current) {
					notify(`Sign-out failed: ${errText(err)}`, "error");
				}
				return;
			}
			await refreshCliIdentityAfterAccountChange();
			if (mountedRef.current && scopeRef.current.target === target) {
				notify("Signed out of account", "info");
				loadAuth();
			}
		},
		[target, notify, loadAuth, stopPolling]
	);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			stopPolling();
			profileRequestRef.current?.abort();
		};
	}, [stopPolling]);

	useEffect(() => {
		if (!active) {
			return;
		}
		setPhase("loading");
		loadAuth();
		return () => {
			stopPolling();
			profileRequestRef.current?.abort();
			setLoginPending(false);
			setLoginPrompt(null);
		};
	}, [active, loadAuth, stopPolling]);

	// Keep the highlighted row in range as the account list grows/shrinks.
	useEffect(() => {
		setSelectedIdx((i) => {
			if (accounts.length === 0) {
				return 0;
			}
			return Math.min(i, accounts.length - 1);
		});
	}, [accounts.length]);

	useKeyboard((key) => {
		if (!active || securityEditing.current) {
			return;
		}
		const name = key.name?.toLowerCase();
		const selected = accounts[selectedIdx];
		if (name === "up") {
			setSelectedIdx((i) => Math.max(0, i - 1));
		} else if (name === "down") {
			setSelectedIdx((i) => Math.min(Math.max(0, accounts.length - 1), i + 1));
		} else if (name === "r") {
			refresh();
		} else if (name === "a") {
			// Add another account via the same device flow.
			startLogin();
		} else if (name === "s" || name === "return") {
			// Switch to the highlighted account (no-op if it is already active).
			if (selected && !selected.active) {
				switchAccount(selected.userId);
			}
		} else if (name === "x") {
			// Sign the highlighted account out of the vault.
			if (selected) {
				removeAccount(selected.userId);
			}
		} else if (name === "l") {
			// apps/cli: l = sign in, Shift+L = sign out. OpenTUI keeps name lowercase
			// and sets key.shift for the shifted letter.
			if (key.shift || key.name === "L") {
				logout();
			} else {
				startLogin();
			}
		}
	});

	let body: ReturnType<typeof AccountBody>;
	if (phase === "loading") {
		body = <Loading label="Loading account…" />;
	} else if (coreError) {
		body = (
			<ErrorView
				hint="Press r to retry · Core may be unreachable"
				message={humanizeError(coreError, { url: target.url })}
				onRetry
			/>
		);
	} else {
		body = (
			<AccountBody
				accounts={accounts}
				info={info}
				loginPending={loginPending}
				loginPrompt={loginPrompt}
				selectedIdx={selectedIdx}
			/>
		);
	}

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<text fg={theme.colors.foreground}>
				<b>Account</b>
			</text>
			<scrollbox flexGrow={1} marginTop={1}>
				{body}
				{info && !loginPending && phase === "ready" ? (
					<AccountSecurity
						active={active}
						authTarget={accountBackendTarget(info.token)}
						onEditingChange={setSecurityEditing}
						onRefresh={loadAuth}
					/>
				) : null}
			</scrollbox>
		</box>
	);
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

function AccountBody({
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
					{`${info.sessionCount} active`}
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

const subscriptionStatusSchema = z.object({
	lifetime: z
		.object({
			expired: z.boolean().catch(false),
			updatesExpiresAt: z.string().nullable().catch(null),
		})
		.nullable()
		.catch(null),
	subscription: z
		.object({
			status: z.string().catch("unknown"),
			interval: z.string().catch(""),
		})
		.nullable()
		.catch(null),
});
type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
