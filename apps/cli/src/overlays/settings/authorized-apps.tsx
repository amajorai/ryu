/* @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import { type ApiTarget, request } from "@ryuhq/core-client/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { coreAuthStatusWireSchema } from "../../core/auth-status-wire.ts";
import { accountBackendTarget } from "../../core/authBackend.ts";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";

const authorizedAppSchema = z.object({
	clientId: z.string(),
	clientName: z.string(),
	scopes: z.string(),
});
type AuthorizedApp = z.infer<typeof authorizedAppSchema>;
const authorizedAppsResponseSchema = z.object({ apps: z.array(z.json()) });
const authorizedAppAuthSchema = z.object({
	authenticated: z.boolean().optional().catch(false),
	token: z.string().optional().catch(undefined),
});
const authorizedAppMutationSchema = z.object({
	success: z.boolean().optional().catch(undefined),
});
async function listApps(
	target: ApiTarget,
	signal: AbortSignal
): Promise<AuthorizedApp[]> {
	const response = authorizedAppsResponseSchema.safeParse(
		await request(target, "/api/oauth-apps", { signal }, appResponseValueSchema)
	);
	if (!response.success) {
		throw new Error("Invalid authorized applications response.");
	}
	return response.data.apps.map((value) => {
		const parsed = authorizedAppSchema.safeParse(value);
		if (!parsed.success) {
			throw new Error("Invalid authorized application.");
		}
		return parsed.data;
	});
}
export function AuthorizedAppsPanel({ active }: { active: boolean }) {
	const { target } = useCore();
	const theme = useTheme();
	const [apps, setApps] = useState<AuthorizedApp[]>([]);
	const [selected, setSelected] = useState(0);
	const [state, setState] = useState<
		"loading" | "ready" | "signedOut" | "error"
	>("loading");
	const [message, setMessage] = useState("");
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const controllerRef = useRef<AbortController | null>(null);
	const authRef = useRef<ApiTarget | null>(null);
	const load = useCallback(async () => {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		setState("loading");
		setMessage("");
		setConfirm(false);
		authRef.current = null;
		try {
			const status = authorizedAppAuthSchema.parse(
				await request(
					target,
					"/api/auth/status",
					{ signal: controller.signal },
					coreAuthStatusWireSchema
				)
			);
			if (!(status.authenticated && status.token)) {
				if (!controller.signal.aborted) {
					setState("signedOut");
				}
				return;
			}
			const authTarget = accountBackendTarget(status.token);
			const rows = await listApps(authTarget, controller.signal);
			if (controller.signal.aborted) {
				return;
			}
			authRef.current = authTarget;
			setApps(rows);
			setSelected((index) => Math.min(index, Math.max(0, rows.length - 1)));
			setState("ready");
		} catch (error) {
			if (!controller.signal.aborted) {
				setState("error");
				setMessage(String(error instanceof Error ? error.message : error));
			}
		}
	}, [target]);
	useEffect(() => {
		if (!active) {
			return;
		}
		void load();
		return () => {
			controllerRef.current?.abort();
			authRef.current = null;
		};
	}, [active, load]);
	const revoke = async () => {
		const app = apps[selected];
		const authTarget = authRef.current;
		if (!(app && authTarget) || busy) {
			return;
		}
		const controller = new AbortController();
		controllerRef.current = controller;
		setBusy(true);
		setMessage("");
		try {
			const result = authorizedAppMutationSchema.parse(
				await request(
					authTarget,
					`/api/oauth-apps/${encodeURIComponent(app.clientId)}`,
					{ method: "DELETE", signal: controller.signal },
					appResponseValueSchema
				)
			);
			if (result.success !== true) {
				throw new Error("Revocation was not confirmed.");
			}
			const rows = await listApps(authTarget, controller.signal);
			if (rows.some((row) => row.clientId === app.clientId)) {
				throw new Error("Application remains authorized after revocation.");
			}
			if (controller.signal.aborted) {
				return;
			}
			setApps(rows);
			setSelected((index) => Math.min(index, Math.max(0, rows.length - 1)));
			setConfirm(false);
			setMessage("Authorization revoked and confirmed.");
		} catch (error) {
			if (!controller.signal.aborted) {
				setMessage(
					tf("Could not revoke: {error}", {
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
	useKeyboard((key) => {
		if (!active || busy) {
			return;
		}
		if (confirm) {
			if (key.name === "y") {
				void revoke();
			} else if (key.name === "n") {
				setConfirm(false);
				setMessage("");
			}
			return;
		}
		if (key.name === "r") {
			void load();
		} else if (key.name === "up") {
			setSelected((index) => Math.max(0, index - 1));
		} else if (key.name === "down") {
			setSelected((index) => Math.min(Math.max(0, apps.length - 1), index + 1));
		} else if (key.name === "x" && state === "ready" && apps[selected]) {
			setConfirm(true);
		}
	});
	return (
		<Card
			subtitle="Applications granted access to your account"
			title="Authorized Apps"
		>
			{state === "loading" ? (
				<text>Loading authorized applications…</text>
			) : null}
			{state === "signedOut" ? (
				<text>Sign in from Settings → Account to manage applications.</text>
			) : null}
			{state === "ready" && apps.length === 0 ? (
				<text>No authorized applications.</text>
			) : null}
			{state === "ready" ? (
				<scrollbox height={12}>
					{apps.map((app, index) => (
						<box flexDirection="column" key={app.clientId}>
							<text
								fg={
									selected === index
										? theme.colors.primary
										: theme.colors.foreground
								}
							>
								{selected === index ? "› " : "  "}
								{app.clientName}
							</text>
							<text fg={theme.colors.mutedForeground}>
								{" "}
								{app.scopes || "No scopes"}
							</text>
						</box>
					))}
				</scrollbox>
			) : null}
			{message ? (
				<text
					fg={
						state === "error" || message.startsWith("Could not")
							? theme.colors.error
							: theme.colors.success
					}
				>
					{message}
				</text>
			) : null}
			<text fg={theme.colors.mutedForeground}>
				{busy
					? "Revoking…"
					: confirm
						? tf("Revoke {clientName}? y confirm · n cancel", {
								clientName: String(apps[selected]?.clientName),
							})
						: "↑↓ applications · x revoke · r reload · j/k panels"}
			</text>
		</Card>
	);
}
