import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { coreAuthStatusWireSchema } from "../../core/auth-status-wire.ts";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import {
	type ApiTarget,
	type RequestOptions,
	request,
} from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { accountBackendTarget } from "../../core/authBackend.ts";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";

const SESSION_WINDOW = 8;

const sessionSchema = z.object({
	isCurrent: z.preprocess((value) => value === true, z.boolean()),
	id: z.string().min(1),
	createdAt: z.string().nullable().catch(null),
	ipAddress: z.string().nullable().catch(null),
	userAgent: z.string().nullable().catch(null),
});
type Session = z.infer<typeof sessionSchema>;
const sessionsResponseSchema = z.object({ sessions: z.array(z.json()) });
const sessionAuthSchema = z.object({
	authenticated: z.boolean().optional().catch(false),
	token: z.string().nullable().optional().catch(null),
});
const sessionMutationSchema = z.object({
	error: z.string().optional().catch(undefined),
	success: z.boolean().optional().catch(undefined),
});
const sessionErrorSchema = z.instanceof(Error);

function requestSessionMutation(
	target: ApiTarget,
	path: string,
	options: RequestOptions
) {
	return request(target, path, options, appResponseValueSchema).then((raw) =>
		sessionMutationSchema.parse(raw)
	);
}
interface SessionSnapshot {
	authTarget: ApiTarget | null;
	sessions: Session[];
	signedIn: boolean;
}

type LoadState = "loading" | "ready" | "signedOut" | "error";

function decodeSession(
	value: z.infer<typeof sessionsResponseSchema>["sessions"][number]
): Session | null {
	const parsed = sessionSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
function errorText(
	error: Parameters<typeof sessionErrorSchema.safeParse>[0]
): string {
	const parsed = sessionErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}

function deviceName(userAgent: string | null): string {
	if (!userAgent) {
		return "Unknown device";
	}
	if (userAgent.includes("Chrome")) {
		return "Chrome";
	}
	if (userAgent.includes("Firefox")) {
		return "Firefox";
	}
	if (userAgent.includes("Safari")) {
		return "Safari";
	}
	if (userAgent.includes("Edge")) {
		return "Edge";
	}
	return userAgent.slice(0, 40);
}

function formatCreatedAt(value: string | null): string {
	if (!value) {
		return "created date unavailable";
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp)
		? `Created ${new Date(timestamp).toLocaleString()}`
		: "created date unavailable";
}

async function listSessions(
	authTarget: ApiTarget,
	signal?: AbortSignal
): Promise<Session[]> {
	const response = sessionsResponseSchema.safeParse(
		await request(
			authTarget,
			"/api/sessions",
			{ signal },
			appResponseValueSchema
		)
	);
	if (!response.success) {
		throw new Error("The account service returned an invalid sessions list.");
	}
	const wire = response.data;
	const sessions = wire.sessions
		.map(decodeSession)
		.filter((session): session is Session => session !== null);
	if (wire.sessions.length > 0 && sessions.length === 0) {
		throw new Error(
			"The account service returned no readable session records."
		);
	}
	return sessions;
}

async function readSessionSnapshot(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<SessionSnapshot> {
	const status = sessionAuthSchema.parse(
		await request(
			target,
			"/api/auth/status",
			{ signal },
			coreAuthStatusWireSchema
		)
	);
	const token = status.authenticated ? status.token?.trim() : null;
	if (!token) {
		return { authTarget: null, sessions: [], signedIn: false };
	}
	const authTarget = accountBackendTarget(token);
	return {
		authTarget,
		sessions: await listSessions(authTarget, signal),
		signedIn: true,
	};
}

/** Better Auth session list and revoke controls for the active account. */
export function SessionsPanel({ active }: { active: boolean }) {
	const { target } = useCore();
	const theme = useTheme();
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const [sessions, setSessions] = useState<Session[]>([]);
	const [authTarget, setAuthTarget] = useState<ApiTarget | null>(null);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [confirmingAll, setConfirmingAll] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const requestIdRef = useRef(0);
	const loadControllerRef = useRef<AbortController | null>(null);
	const mutationControllerRef = useRef<AbortController | null>(null);

	const load = useCallback(async () => {
		loadControllerRef.current?.abort();
		const controller = new AbortController();
		loadControllerRef.current = controller;
		const requestId = ++requestIdRef.current;
		setLoadState("loading");
		setError(null);
		setNotice(null);
		setConfirmingAll(false);
		try {
			const snapshot = await readSessionSnapshot(target, controller.signal);
			if (controller.signal.aborted || requestId !== requestIdRef.current) {
				return;
			}
			setAuthTarget(snapshot.authTarget);
			setSessions(snapshot.sessions);
			setSelectedIndex((index) =>
				snapshot.sessions.length === 0
					? 0
					: Math.min(index, snapshot.sessions.length - 1)
			);
			setLoadState(snapshot.signedIn ? "ready" : "signedOut");
		} catch (loadError) {
			if (!controller.signal.aborted && requestId === requestIdRef.current) {
				setLoadState("error");
				setError(
					tf("Couldn't load sessions: {error}", { error: errorText(loadError) })
				);
			}
		} finally {
			if (loadControllerRef.current === controller) {
				loadControllerRef.current = null;
			}
		}
	}, [target]);

	useEffect(() => {
		if (!active) {
			return;
		}
		void load();
		return () => {
			requestIdRef.current += 1;
			loadControllerRef.current?.abort();
			mutationControllerRef.current?.abort();
			loadControllerRef.current = null;
			mutationControllerRef.current = null;
		};
	}, [active, load]);

	const revokeOne = useCallback(async () => {
		const selected = sessions[selectedIndex];
		if (!(selected && authTarget) || busy) {
			return;
		}
		if (selected.isCurrent) {
			setNotice("This device's session can't be revoked here.");
			return;
		}
		const controller = new AbortController();
		mutationControllerRef.current = controller;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await requestSessionMutation(
				authTarget,
				`/api/sessions/${encodeURIComponent(selected.id)}`,
				{ method: "DELETE", signal: controller.signal }
			);
			if (result.success !== true) {
				throw new Error(
					result.error ?? "The account service did not confirm the revocation."
				);
			}
			const refreshed = await listSessions(authTarget, controller.signal);
			if (refreshed.some((session) => session.id === selected.id)) {
				throw new Error(
					"The session is still active after the revoke request."
				);
			}
			setSessions(refreshed);
			setSelectedIndex((index) =>
				Math.min(index, Math.max(0, refreshed.length - 1))
			);
			setNotice("Session revoked and confirmed.");
		} catch (mutationError) {
			if (!controller.signal.aborted) {
				setError(
					tf("Couldn't revoke this session: {error}. Press r to reload.", {
						error: errorText(mutationError),
					})
				);
			}
		} finally {
			if (mutationControllerRef.current === controller) {
				mutationControllerRef.current = null;
				setBusy(false);
			}
		}
	}, [authTarget, busy, selectedIndex, sessions]);

	const revokeOthers = useCallback(async () => {
		const currentSessionId = sessions.find((session) => session.isCurrent)?.id;
		if (!authTarget || busy) {
			return;
		}
		if (!currentSessionId) {
			setError(
				"The account service did not identify this device's session. Press r to reload before revoking others."
			);
			return;
		}
		const controller = new AbortController();
		mutationControllerRef.current = controller;
		setBusy(true);
		setError(null);
		setNotice(null);
		setConfirmingAll(false);
		try {
			const result = await requestSessionMutation(authTarget, "/api/sessions", {
				method: "DELETE",
				signal: controller.signal,
			});
			if (result.success !== true) {
				throw new Error(
					result.error ?? "The account service did not confirm the revocation."
				);
			}
			const refreshed = await listSessions(authTarget, controller.signal);
			if (
				!refreshed.some(
					(session) => session.id === currentSessionId && session.isCurrent
				) ||
				refreshed.some((session) => session.id !== currentSessionId)
			) {
				throw new Error(
					"The account service did not confirm that other sessions ended."
				);
			}
			setSessions(refreshed);
			setSelectedIndex(0);
			setNotice("Other sessions revoked and confirmed.");
		} catch (mutationError) {
			if (!controller.signal.aborted) {
				setError(
					tf("Couldn't revoke other sessions: {error}. Press r to reload.", {
						error: errorText(mutationError),
					})
				);
			}
		} finally {
			if (mutationControllerRef.current === controller) {
				mutationControllerRef.current = null;
				setBusy(false);
			}
		}
	}, [authTarget, busy, sessions]);

	useKeyboard((key) => {
		if (!active || busy) {
			return;
		}
		const name = key.name?.toLowerCase();
		if (confirmingAll) {
			if (name === "y" || name === "return") {
				void revokeOthers();
			} else if (name === "n" || name === "c") {
				setConfirmingAll(false);
				setNotice("Session revocation cancelled.");
			}
			return;
		}
		if (name === "r") {
			void load();
			return;
		}
		if (loadState !== "ready") {
			return;
		}
		if (name === "up") {
			setSelectedIndex((index) => Math.max(0, index - 1));
		} else if (name === "down") {
			setSelectedIndex((index) =>
				Math.min(Math.max(0, sessions.length - 1), index + 1)
			);
		} else if (name === "x") {
			void revokeOne();
		} else if (name === "a") {
			if (sessions.length <= 1) {
				setNotice("There are no other sessions to revoke.");
			} else {
				setNotice(null);
				setConfirmingAll(true);
			}
		}
	});

	const themeColors = theme.colors;
	const visibleStart = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(SESSION_WINDOW / 2),
			sessions.length - SESSION_WINDOW
		)
	);
	const visibleSessions = sessions.slice(
		visibleStart,
		visibleStart + SESSION_WINDOW
	);

	return (
		<Card
			subtitle="Revoke browser sessions · your current device stays signed in"
			title="Sessions & devices"
		>
			{loadState === "loading" ? (
				<text fg={themeColors.mutedForeground}>Loading sessions…</text>
			) : null}
			{loadState === "error" ? (
				<box flexDirection="column" gap={1}>
					<text fg={themeColors.error}>{error}</text>
					<text fg={themeColors.mutedForeground}>Press r to retry.</text>
				</box>
			) : null}
			{loadState === "signedOut" ? (
				<text fg={themeColors.mutedForeground}>
					Sign in from Settings → Account to manage browser sessions.
				</text>
			) : null}
			{loadState === "ready" && sessions.length === 0 ? (
				<text fg={themeColors.mutedForeground}>
					You're signed in on this device, but no browser sessions were
					returned.
				</text>
			) : null}
			{loadState === "ready" && sessions.length > 0 ? (
				<box flexDirection="column" gap={1}>
					{visibleSessions.map((session, visibleIndex) => {
						const index = visibleStart + visibleIndex;
						const selected = index === selectedIndex;
						const current = session.isCurrent;
						return (
							<box flexDirection="column" key={session.id}>
								<box flexDirection="row" gap={1}>
									<text
										fg={
											selected
												? themeColors.primary
												: themeColors.mutedForeground
										}
									>
										{selected ? "›" : " "}
									</text>
									<text
										fg={selected ? themeColors.primary : themeColors.foreground}
									>
										{selected ? (
											<b>{deviceName(session.userAgent)}</b>
										) : (
											deviceName(session.userAgent)
										)}
									</text>
									{current ? (
										<text fg={themeColors.success}>This device</text>
									) : null}
								</box>
								<text fg={themeColors.mutedForeground}>
									{session.ipAddress ? `${session.ipAddress} · ` : ""}
									{formatCreatedAt(session.createdAt)}
								</text>
							</box>
						);
					})}
					{sessions.length > SESSION_WINDOW ? (
						<text fg={themeColors.mutedForeground}>
							{tf("Showing {start}–{end} of {total}", {
								start: String(visibleStart + 1),
								end: String(visibleStart + visibleSessions.length),
								total: String(sessions.length),
							})}
						</text>
					) : null}
				</box>
			) : null}
			{confirmingAll ? (
				<box marginTop={1}>
					<text fg={themeColors.warning}>
						Revoke all other sessions? This device stays signed in. Press y to
						confirm or n to cancel.
					</text>
				</box>
			) : null}
			{error && loadState === "ready" ? (
				<box marginTop={1}>
					<text fg={themeColors.error}>{error}</text>
				</box>
			) : null}
			{notice ? (
				<box marginTop={1}>
					<text fg={themeColors.success}>{notice}</text>
				</box>
			) : null}
			{busy ? (
				<box marginTop={1}>
					<text fg={themeColors.mutedForeground}>
						Saving and checking the session list…
					</text>
				</box>
			) : null}
			<box marginTop={1}>
				<text fg={themeColors.mutedForeground}>
					{confirmingAll
						? "y confirm · n cancel"
						: "↑↓ select · x revoke selected · a revoke others · r refresh · j/k Settings panels"}
				</text>
			</box>
		</Card>
	);
}
