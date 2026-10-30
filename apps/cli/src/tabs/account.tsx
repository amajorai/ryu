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
import { request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { startAccountPolling } from "../core/account-polling.ts";
import {
	type Account,
	accountMutationResponseSchema,
	type LoginStart,
	loginStartResponseSchema,
} from "../core/account-response.ts";
import { AUTH_BACKEND_URL, accountBackendTarget } from "../core/authBackend.ts";
import { useCore } from "../core/CoreContext.tsx";
import { refreshCliIdentityAfterAccountChange } from "../core/identity.ts";
import {
	nativeErrorMessage as errText,
	humanizeError,
} from "../core/native-errors.ts";
// Best-effort open of the device-login URL; the panel always shows it too.
import { openBrowser } from "../core/openBrowser.ts";
import { tf } from "../i18n/translate.ts";
import { AccountSecurity } from "../overlays/settings/account-security.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import {
	type AuthInfo,
	describeFlowFailure,
	fetchAccounts,
	fetchAuth,
	type LoginPrompt,
	pollOnce,
} from "./account-data.ts";
import { AccountBody } from "./account-views.tsx";
import type { TabProps } from "./types.ts";

export { pollOnce } from "./account-data.ts";

// The control-plane (Better-Auth) backend that owns profile/billing/sessions.
// apps/cli reads this from RYU_AUTH_URL with the same default.
const POLL_INTERVAL_MS = 1500;
const LOGIN_TIMEOUT_MS = 300_000;

type Phase = "loading" | "ready";

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
				notify(tf("Sign-in failed: {0}", { 0: errText(err) }), "error");
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
				notify(tf("Sign-in failed: {error}", { error: start.error }), "error");
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
				notify(tf("Sign-out failed: {0}", { 0: errText(err) }), "error");
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
						notify(tf("Switch failed: {error}", { error: res.error }), "error");
					}
					return;
				}
			} catch (err) {
				if (mountedRef.current) {
					notify(tf("Switch failed: {0}", { 0: errText(err) }), "error");
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
						notify(
							tf("Sign-out failed: {error}", { error: res.error }),
							"error"
						);
					}
					return;
				}
			} catch (err) {
				if (mountedRef.current) {
					notify(tf("Sign-out failed: {0}", { 0: errText(err) }), "error");
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
