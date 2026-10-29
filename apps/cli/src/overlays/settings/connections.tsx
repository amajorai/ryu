import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
/* @jsxImportSource @opentui/react */

import { useKeyboard } from "@opentui/react";
import { request } from "@ryuhq/core-client/client";
import {
	type ComposioConnection,
	type ComposioToolkit,
	fetchComposioConnections,
	fetchComposioStatus,
	fetchComposioToolkits,
} from "@ryuhq/core-client/composio";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { Card } from "@/components/ui/card.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../../core/CoreContext.tsx";
import { tf } from "../../i18n/translate.ts";

type AccessLevel = "risk_based" | "read_only" | "write" | "full";

interface PendingConnection {
	id: string;
	redirectUrl: string;
	status: string;
	toolkit: string;
}

const connectionInitiateSchema = z.object({
	connection_id: z.string().refine((value) => value.trim().length > 0),
	redirect_url: z.string().refine((value) => value.trim().length > 0),
	status: z.json().optional(),
});
const connectionStatusSchema = z.object({
	active: z.boolean().optional().catch(undefined),
	status: z.json().optional(),
});
type ConnectionStatusValue = z.infer<typeof connectionStatusSchema>["status"];
const connectionStatusStringSchema = z.string();
const connectionErrorSchema = z.instanceof(Error);

const ACCESS_LEVELS: readonly AccessLevel[] = [
	"risk_based",
	"read_only",
	"write",
	"full",
];

const ACCESS_LABELS = {
	risk_based: "Risk-based",
	read_only: "Read-only",
	write: "Write",
	full: "Full",
} satisfies Record<AccessLevel, string>;

function errorMessage(
	error: Parameters<typeof connectionErrorSchema.safeParse>[0]
): string {
	const parsed = connectionErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}

function normalizeStatus(value: ConnectionStatusValue): string {
	const parsed = connectionStatusStringSchema.safeParse(value);
	return parsed.success && parsed.data.trim() ? parsed.data : "Unknown";
}

function connectionForToolkit(
	connections: readonly ComposioConnection[],
	toolkit: string
): ComposioConnection | null {
	let match: ComposioConnection | null = null;
	for (const connection of connections) {
		if (connection.toolkit !== toolkit) {
			continue;
		}
		if (!match || (connection.active && !match.active)) {
			match = connection;
		}
	}
	return match;
}

/** Core-backed Composio connection workflow for Settings → Connections. */
export function ConnectionsPanel({
	active,
	onNavigationOwnershipChange,
}: {
	active: boolean;
	onNavigationOwnershipChange: (owned: boolean) => void;
}) {
	const { target } = useCore();
	const theme = useTheme();
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
	const [connections, setConnections] = useState<ComposioConnection[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [accessLevel, setAccessLevel] = useState<AccessLevel>("risk_based");
	const [pending, setPending] = useState<PendingConnection | null>(null);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const requestIdRef = useRef(0);
	const mountedRef = useRef(false);

	const runLoad = useCallback(async () => {
		const requestId = ++requestIdRef.current;
		setLoading(true);
		setError(null);
		setNotice(null);
		try {
			const status = await fetchComposioStatus(target);
			if (requestIdRef.current !== requestId) {
				return;
			}
			setConfigured(status.configured);
			if (!status.configured) {
				setToolkits([]);
				setConnections([]);
				setPending(null);
				return;
			}

			const [nextToolkits, nextConnections] = await Promise.all([
				fetchComposioToolkits(target),
				fetchComposioConnections(target),
			]);
			if (requestIdRef.current !== requestId) {
				return;
			}
			setToolkits(nextToolkits);
			setConnections(nextConnections);
			setSelectedIndex((index) =>
				Math.min(index, Math.max(0, nextToolkits.length - 1))
			);
		} catch (loadError) {
			if (requestIdRef.current === requestId) {
				setError(errorMessage(loadError));
			}
		} finally {
			if (requestIdRef.current === requestId) {
				setLoading(false);
			}
		}
	}, [target]);

	useEffect(() => {
		if (!active) {
			return;
		}
		mountedRef.current = true;
		onNavigationOwnershipChange(true);
		void runLoad();
		return () => {
			mountedRef.current = false;
			requestIdRef.current++;
			onNavigationOwnershipChange(false);
		};
	}, [active, onNavigationOwnershipChange, runLoad]);

	const selectedToolkit = toolkits[selectedIndex] ?? null;
	const selectedConnection = useMemo(
		() =>
			selectedToolkit
				? connectionForToolkit(connections, selectedToolkit.slug)
				: null,
		[selectedToolkit, connections]
	);

	const startConnection = useCallback(async () => {
		if (!selectedToolkit || selectedConnection?.active || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const response = await request(
				target,
				"/api/composio/connections/initiate",
				{
					method: "POST",
					body: {
						access_level: accessLevel,
						toolkit: selectedToolkit.slug,
					},
				},
				appResponseValueSchema
			);
			const parsed = connectionInitiateSchema.safeParse(response);
			if (!parsed.success) {
				throw new Error(
					"Core did not return a connection id and redirect URL."
				);
			}
			const result = parsed.data;
			const redirect = new URL(result.redirect_url);
			if (redirect.protocol !== "https:") {
				throw new Error("Core returned a non-HTTPS connection URL.");
			}
			if (!mountedRef.current) {
				return;
			}
			const status = normalizeStatus(result.status ?? "INITIATED");
			setPending({
				id: result.connection_id,
				redirectUrl: redirect.toString(),
				status,
				toolkit: selectedToolkit.name,
			});
			setNotice(
				tf(
					"Open this URL to authorize {toolkitName}, then press p to check status.",
					{ toolkitName: selectedToolkit.name }
				)
			);
		} catch (connectError) {
			if (mountedRef.current) {
				setError(
					tf("Could not start the connection: {error}", {
						error: errorMessage(connectError),
					})
				);
			}
		} finally {
			if (mountedRef.current) {
				setBusy(false);
			}
		}
	}, [accessLevel, busy, selectedConnection?.active, selectedToolkit, target]);

	const checkConnection = useCallback(async () => {
		if (!pending || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const status = connectionStatusSchema.parse(
				await request(
					target,
					`/api/composio/connections/${encodeURIComponent(pending.id)}`,
					{},
					appResponseValueSchema
				)
			);
			if (!mountedRef.current) {
				return;
			}
			const nextStatus = normalizeStatus(status.status);
			if (status.active === true) {
				setPending(null);
				setNotice(
					tf("{toolkit} connection confirmed. Refreshing connections…", {
						toolkit: pending.toolkit,
					})
				);
				await runLoad();
			} else {
				setPending({ ...pending, status: nextStatus });
				setNotice(
					tf(
						"Connection is {status}. Complete authorization, then press p to check again.",
						{ status: nextStatus }
					)
				);
			}
		} catch (statusError) {
			if (mountedRef.current) {
				setError(
					tf("Could not check the connection: {error}", {
						error: errorMessage(statusError),
					})
				);
			}
		} finally {
			if (mountedRef.current) {
				setBusy(false);
			}
		}
	}, [busy, pending, runLoad, target]);

	useKeyboard((key) => {
		if (!active || loading || busy) {
			return;
		}
		if (key.name === "up") {
			setSelectedIndex((index) => Math.max(0, index - 1));
		} else if (key.name === "down") {
			setSelectedIndex((index) => Math.min(toolkits.length - 1, index + 1));
		} else if (key.name === "r") {
			void runLoad();
		} else if (key.name === "v") {
			setAccessLevel((current) => {
				const currentIndex = ACCESS_LEVELS.indexOf(current);
				return (
					ACCESS_LEVELS[(currentIndex + 1) % ACCESS_LEVELS.length] ??
					"risk_based"
				);
			});
		} else if (key.name === "c") {
			void startConnection();
		} else if (key.name === "p") {
			void checkConnection();
		}
	});

	return (
		<Card
			subtitle="Connect an account once, then attach its actions to an agent."
			title="Connections"
		>
			{loading ? (
				<text fg={theme.colors.mutedForeground}>
					Loading Composio connections…
				</text>
			) : null}
			{error ? (
				<text fg={theme.colors.error}>
					{tf("Could not load connections: {error}", { error })}
				</text>
			) : null}
			{configured === false ? (
				<box flexDirection="column" gap={1}>
					<text fg={theme.colors.mutedForeground}>
						Composio is not configured on this Core node. Set its key in Gateway
						→ Keys, then press r to retry.
					</text>
				</box>
			) : null}
			{configured && !loading && toolkits.length === 0 && !error ? (
				<text fg={theme.colors.mutedForeground}>
					Core returned no integrations for this node.
				</text>
			) : null}
			{configured && toolkits.length > 0 ? (
				<box flexDirection="column" gap={0}>
					<text fg={theme.colors.mutedForeground}>
						{tf("New connection access: {accessLevel} · press v to change", {
							accessLevel: ACCESS_LABELS[accessLevel],
						})}
					</text>
					<text fg={theme.colors.mutedForeground}>
						Full permits every action. Start with Risk-based or Read-only when
						unsure.
					</text>
					<scrollbox height={12} marginTop={1}>
						{toolkits.map((toolkit, index) => {
							const connection = connectionForToolkit(
								connections,
								toolkit.slug
							);
							const selected = index === selectedIndex;
							const state = connection?.active
								? `connected · ${ACCESS_LABELS[connection.accessLevel]}`
								: connection
									? normalizeStatus(connection.status)
									: "not connected";
							return (
								<box flexDirection="row" gap={1} key={toolkit.slug}>
									<text
										fg={
											selected
												? theme.colors.primary
												: theme.colors.mutedForeground
										}
									>
										{selected ? "›" : " "}
									</text>
									<text
										fg={
											selected ? theme.colors.primary : theme.colors.foreground
										}
									>
										{toolkit.name} ({toolkit.slug}) · {state}
									</text>
								</box>
							);
						})}
					</scrollbox>
				</box>
			) : null}
			{pending ? (
				<box flexDirection="column" gap={0} marginTop={1}>
					<text fg={theme.colors.warning}>
						{tf("{toolkit} authorization · {status}", {
							toolkit: pending.toolkit,
							status: pending.status,
						})}
					</text>
					<text fg={theme.colors.foreground}>
						Open this URL in your browser:
					</text>
					<text fg={theme.colors.primary}>{pending.redirectUrl}</text>
				</box>
			) : null}
			{notice ? <text fg={theme.colors.success}>{notice}</text> : null}
		</Card>
	);
}
