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
// live on the CONTROL-PLANE auth backend (RYU_AUTH_URL, default
// http://localhost:3000), NOT on Ryu Core, and there is no core-client auth
// module. So this tab drives the device-login/logout/status through Core
// (/api/auth/login|status|logout via the core-client `request` primitive) and
// fetches the profile from the auth backend with a second ApiTarget
// { url: authBackendUrl, token } - exactly what apps/cli's auth.rs does. Core
// hydrates the persisted token into /api/auth/status on boot
// (apps/core/src/auth/mod.rs AuthState::new), so the bearer it returns matches
// the ~/.ryu/auth.json token apps/cli reads.

import { useKeyboard } from "@opentui/react";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge.tsx";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

// The control-plane (Better-Auth) backend that owns profile/billing/sessions.
// apps/cli reads this from RYU_AUTH_URL with the same default.
const AUTH_BACKEND_URL =
	process.env.RYU_AUTH_URL?.trim() || "http://localhost:3000";
const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 300_000;

interface AuthInfo {
	authMethod: string;
	email: string;
	hasPassword: boolean;
	name: string;
	plan: string;
	sessionCount: number;
	twoFactor: boolean;
	verified: boolean;
}

interface CoreAuthStatus {
	authenticated?: boolean;
	pending?: boolean;
	token?: string | null;
	userCode?: string | null;
	verificationUri?: string | null;
}

interface LoginStart {
	error?: string;
	userCode?: string | null;
	verificationUri?: string | null;
	verificationUriComplete?: string | null;
}

interface SessionWire {
	user?: {
		email?: string | null;
		emailVerified?: boolean | null;
		name?: string | null;
		twoFactorEnabled?: boolean | null;
	} | null;
}

interface PasswordWire {
	authMethod?: string | null;
	hasPassword?: boolean | null;
}

interface SessionsWire {
	sessions?: unknown[];
}

interface LoginPrompt {
	url: string | null;
	userCode: string | null;
}

// One signed-in account in the local device vault Core maintains. Tokens NEVER
// cross the wire - Core returns only these safe fields (parity with the shared
// multi-account contract used by every bearer surface).
interface Account {
	active: boolean;
	email: string;
	image?: string | null;
	name?: string | null;
	userId: string;
}

interface AccountsWire {
	accounts?: Account[];
	activeUserId?: string | null;
}

interface MutationWire {
	error?: string;
	success?: boolean;
}

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
function formatPlan(sub: Record<string, unknown>): string {
	const lifetime = sub.lifetime;
	if (lifetime && typeof lifetime === "object") {
		const lt = lifetime as Record<string, unknown>;
		if (lt.expired === true) {
			return "Lifetime (updates expired)";
		}
		const until =
			typeof lt.updatesExpiresAt === "string"
				? (lt.updatesExpiresAt.split("T")[0] ?? "—")
				: "—";
		return `Lifetime (updates until ${until})`;
	}

	const subscription = sub.subscription;
	if (subscription && typeof subscription === "object") {
		const s = subscription as Record<string, unknown>;
		const status = typeof s.status === "string" ? s.status : "unknown";
		const interval = typeof s.interval === "string" ? s.interval : "";
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

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

type LoadResult =
	| { kind: "coreDown"; message: string }
	| { kind: "loggedIn"; info: AuthInfo }
	| { kind: "loggedOut" };

// One device-status probe: true once Core reports authenticated with a token.
async function pollOnce(target: ApiTarget): Promise<boolean> {
	const status = await request<CoreAuthStatus>(target, "/api/auth/status");
	return Boolean(status.authenticated && status.token);
}

// Resolve the full account state in one pass (no setState - the caller applies it
// once, guarded by mountedRef). get-session gates logged-in (parity with
// auth.rs::fetch_auth_info); password/billing/sessions degrade independently.
async function fetchAuth(target: ApiTarget): Promise<LoadResult> {
	let status: CoreAuthStatus;
	try {
		status = await request<CoreAuthStatus>(target, "/api/auth/status");
	} catch (err) {
		return { kind: "coreDown", message: errText(err) };
	}
	const token = status.token ?? null;
	if (!token) {
		return { kind: "loggedOut" };
	}

	const authTarget: ApiTarget = { url: AUTH_BACKEND_URL, token };
	let session: SessionWire;
	try {
		session = await request<SessionWire>(authTarget, "/api/auth/get-session");
	} catch {
		return { kind: "loggedOut" };
	}
	const user = session.user;
	if (!user) {
		return { kind: "loggedOut" };
	}

	const [pw, sub, sessions] = await Promise.all([
		request<PasswordWire>(authTarget, "/api/user/password-status").catch(
			() => null
		),
		request<Record<string, unknown>>(
			authTarget,
			"/api/billing/subscription-status"
		).catch(() => null),
		request<SessionsWire>(authTarget, "/api/sessions").catch(() => null),
	]);

	return {
		kind: "loggedIn",
		info: {
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
async function fetchAccounts(target: ApiTarget): Promise<Account[]> {
	try {
		const wire = await request<AccountsWire>(target, "/api/auth/accounts");
		return Array.isArray(wire.accounts) ? wire.accounts : [];
	} catch {
		return [];
	}
}

// Best-effort browser open for the device-login URL. The URL is always shown in
// the panel too (apps/cli prints it as a fallback), so failures are ignored.
function openBrowser(url: string | null): void {
	if (!url) {
		return;
	}
	try {
		const bun = (globalThis as { Bun?: { spawn: (cmd: string[]) => unknown } })
			.Bun;
		if (!bun) {
			return;
		}
		const platform = process.platform;
		let cmd: string[];
		if (platform === "win32") {
			cmd = ["cmd", "/c", "start", "", url];
		} else if (platform === "darwin") {
			cmd = ["open", url];
		} else {
			cmd = ["xdg-open", url];
		}
		bun.spawn(cmd);
	} catch {
		// Best-effort only - the panel shows the URL.
	}
}

export function AccountTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();

	const [phase, setPhase] = useState<Phase>("loading");
	const [info, setInfo] = useState<AuthInfo | null>(null);
	const [accounts, setAccounts] = useState<Account[]>([]);
	const [selectedIdx, setSelectedIdx] = useState(0);
	const [coreError, setCoreError] = useState<string | null>(null);
	const [loginPending, setLoginPending] = useState(false);
	const [loginPrompt, setLoginPrompt] = useState<LoginPrompt | null>(null);

	const mountedRef = useRef(true);
	// Active poll context; `stop` flips true on unmount/logout/success/timeout so a
	// queued tick is a no-op (the shell unmounts inactive tabs, so a tab switch
	// mid-login cancels the poll - acceptable, the code/URL live on this tab).
	const pollRef = useRef<{ deadline: number; stop: boolean } | null>(null);

	const loadAuth = useCallback(async () => {
		const [result, accts] = await Promise.all([
			fetchAuth(target),
			fetchAccounts(target),
		]);
		if (!mountedRef.current) {
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
		if (pollRef.current) {
			pollRef.current.stop = true;
		}
		pollRef.current = null;
	}, []);

	const startPolling = useCallback(() => {
		stopPolling();
		const ctx = { stop: false, deadline: Date.now() + LOGIN_TIMEOUT_MS };
		pollRef.current = ctx;

		const finish = (signedIn: boolean) => {
			ctx.stop = true;
			if (!mountedRef.current) {
				return;
			}
			setLoginPending(false);
			setLoginPrompt(null);
			if (signedIn) {
				notify("Signed in", "success");
				loadAuth();
			} else {
				notify("Sign-in timed out", "error");
			}
		};

		const tick = async () => {
			if (ctx.stop) {
				return;
			}
			if (Date.now() > ctx.deadline) {
				finish(false);
				return;
			}
			// Swallow transient probe errors - keep polling until the deadline.
			const done = await pollOnce(target).catch(() => false);
			if (ctx.stop) {
				return;
			}
			if (done) {
				finish(true);
				return;
			}
			setTimeout(tick, POLL_INTERVAL_MS);
		};
		setTimeout(tick, POLL_INTERVAL_MS);
	}, [target, notify, loadAuth, stopPolling]);

	// Device flow, shared by first sign-in AND "add account". Unlike the old
	// single-account tab it does NOT bail when already signed in: adding a second
	// account while signed into a first is the whole point of multi-account. Core
	// upserts the returned token+profile into the vault (keeping the others), so
	// after success loadAuth reloads the accounts list. Only guarded so a second
	// login can't start while one is already in flight.
	const startLogin = useCallback(async () => {
		if (loginPending) {
			return;
		}
		setLoginPending(true);
		setLoginPrompt(null);
		notify("Starting sign-in…", "loading");
		let start: LoginStart;
		try {
			start = await request<LoginStart>(target, "/api/auth/login", {
				method: "POST",
				body: { backendUrl: AUTH_BACKEND_URL },
			});
		} catch (err) {
			if (mountedRef.current) {
				setLoginPending(false);
				notify(`Sign-in failed: ${errText(err)}`, "error");
			}
			return;
		}
		if (start.error) {
			if (mountedRef.current) {
				setLoginPending(false);
				notify(`Sign-in failed: ${start.error}`, "error");
			}
			return;
		}
		const url = start.verificationUriComplete ?? start.verificationUri ?? null;
		if (mountedRef.current) {
			setLoginPrompt({ userCode: start.userCode ?? null, url });
		}
		openBrowser(url);
		startPolling();
	}, [loginPending, target, notify, startPolling]);

	// Mirror do_logout: only acts when signed in.
	const logout = useCallback(async () => {
		if (!info) {
			return;
		}
		stopPolling();
		setLoginPending(false);
		setLoginPrompt(null);
		try {
			await request<unknown>(target, "/api/auth/logout", { method: "POST" });
		} catch (err) {
			if (mountedRef.current) {
				notify(`Sign-out failed: ${errText(err)}`, "error");
			}
			return;
		}
		if (mountedRef.current) {
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
				const res = await request<MutationWire>(
					target,
					"/api/auth/accounts/switch",
					{ method: "POST", body: { userId } }
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
			if (mountedRef.current) {
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
				const res = await request<MutationWire>(
					target,
					"/api/auth/accounts/remove",
					{ method: "POST", body: { userId } }
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
			if (mountedRef.current) {
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
			if (pollRef.current) {
				pollRef.current.stop = true;
			}
			pollRef.current = null;
		};
	}, []);

	useEffect(() => {
		if (!active) {
			return;
		}
		setPhase("loading");
		loadAuth();
	}, [active, loadAuth]);

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
		if (!active) {
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
				message={coreError}
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
			<box marginTop={1}>{body}</box>
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
