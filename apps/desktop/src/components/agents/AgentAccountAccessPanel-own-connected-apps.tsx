import { Link01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AccountAccessRows,
	AgentOwnConnectedAppsCard,
} from "@ryu/blocks/desktop/agent-account-access.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { type ReactNode, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import {
	type AccountRow,
	accountKey,
	toggleAccountKey,
} from "@/src/components/agents/AgentAccountAccessPanel-account-keys.ts";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import {
	useComposioToolkits,
	useDisconnectAgentComposioConnection,
	useInitiateAgentComposioConnection,
} from "@/src/hooks/useComposioCatalog.ts";
import { ApiError } from "@/src/lib/api/client.ts";
import { isAgentComposioUnsupported } from "@/src/lib/api/composio.ts";
import type { ConnectionAccessLevel } from "@/src/lib/connection-permissions.ts";

/** A message for a failed request, preferring Core's own words. */
function errorMessage(cause: unknown, fallback: string): string {
	if (cause instanceof ApiError) {
		return cause.serverMessage ?? cause.message;
	}
	return cause instanceof Error ? cause.message : fallback;
}

/**
 * Why the agent's connected apps did not load. A 409 is Core saying the saved
 * agent may not hold apps of its own, so its words are shown; anything else
 * gets the generic line.
 */
export function connectedAppsErrorMessage(cause: unknown): string {
	if (
		cause instanceof ApiError &&
		cause.status === 409 &&
		cause.serverMessage
	) {
		return cause.serverMessage;
	}
	return "Couldn't load this agent's connected apps.";
}

/**
 * Apps connected to the agent's own Composio identity, with Connect app and a
 * Disconnect action per app. Only for a saved agent with its own identity.
 */
export function OwnConnectedApps({
	accountAccess,
	agentId,
	composioConfigured,
	disabled,
	error,
	loading,
	needsSave,
	onAccountAccessChange,
	onToggle,
	rows,
}: {
	accountAccess: string[] | null;
	agentId: string | null;
	composioConfigured: boolean;
	disabled: boolean;
	error: unknown;
	loading: boolean;
	/** The agent is saved as Acts as you, so Core holds no apps for it yet. */
	needsSave: boolean;
	onAccountAccessChange: (next: string[] | null) => void;
	onToggle: (key: string, allowed: boolean) => void;
	rows: AccountRow[];
}) {
	const tl = useLiteralMessages();
	const [picking, setPicking] = useState(false);
	const [toolkit, setToolkit] = useState("");
	const [permissionOpen, setPermissionOpen] = useState(false);
	const toolkits = useComposioToolkits(picking && composioConfigured);
	const initiate = useInitiateAgentComposioConnection(agentId);
	const disconnect = useDisconnectAgentComposioConnection(agentId);
	const unsupported = isAgentComposioUnsupported(error);
	const canConnect =
		agentId !== null &&
		composioConfigured &&
		!needsSave &&
		!unsupported &&
		!disabled;
	const toolkitName =
		toolkits.data?.find((candidate) => candidate.slug === toolkit)?.name ??
		toolkit;

	const handleConnect = async (accessLevel: ConnectionAccessLevel) => {
		const started = await initiate.mutateAsync({ accessLevel, toolkit });
		// Core adds the account to a limited agent's saved list; add it to the
		// list being edited too, so saving the editor keeps it.
		if (accountAccess !== null && started.connectionId) {
			onAccountAccessChange(
				toggleAccountKey(
					accountAccess,
					accountKey.agentComposio(started.connectionId),
					true
				)
			);
		}
		if (!started.redirectUrl) {
			throw new Error("Composio did not return a connect link.");
		}
		await openExternal(started.redirectUrl);
		setPicking(false);
		setToolkit("");
		sileo.success({
			title: tl("Connecting {toolkitName} for this agent…", { toolkitName }),
			description:
				"Authorize in your browser with the account the agent should use. It turns active here when you return.",
		});
	};

	const handleDisconnect = async (row: AccountRow) => {
		if (!row.id) {
			return;
		}
		try {
			await disconnect.mutateAsync(row.id);
		} catch (cause) {
			sileo.error({
				title: "Couldn't disconnect the app",
				description: errorMessage(cause, "Try again."),
			});
			return;
		}
		if (accountAccess !== null) {
			onAccountAccessChange(toggleAccountKey(accountAccess, row.key, false));
		}
	};

	let body: ReactNode;
	if (agentId === null) {
		body = (
			<p className="text-muted-foreground text-sm">
				Save the agent first. You can then connect apps to its own identity.
			</p>
		);
	} else if (!composioConfigured) {
		body = (
			<p className="text-muted-foreground text-sm">
				Composio isn't set up on this node.
			</p>
		);
	} else if (needsSave) {
		body = (
			<p className="text-muted-foreground text-sm">
				Save to connect apps for this agent.
			</p>
		);
	} else if (unsupported) {
		body = (
			<p className="text-muted-foreground text-sm">
				The Connect service on this node doesn't allow apps for agents.
			</p>
		);
	} else if (error) {
		body = (
			<p className="text-muted-foreground text-sm">
				{connectedAppsErrorMessage(error)}
			</p>
		);
	} else {
		body = (
			<AccountAccessRows
				accountAccess={accountAccess}
				disabled={disabled}
				empty="No apps connected to this agent yet."
				loading={loading}
				onToggle={onToggle}
				rows={rows}
				trailing={(row) => (
					<Button
						aria-label={tl("Disconnect {title}", { title: row.title })}
						disabled={disabled || disconnect.isPending}
						onClick={() => handleDisconnect(row)}
						size="sm"
						variant="ghost"
					>
						Disconnect
					</Button>
				)}
			/>
		);
	}

	return (
		<AgentOwnConnectedAppsCard
			connectAction={
				canConnect && !picking ? (
					<Button onClick={() => setPicking(true)} size="sm" variant="ghost">
						<HugeiconsIcon className="size-4" icon={Link01Icon} />
						Connect app
					</Button>
				) : null
			}
			picker={
				canConnect && picking ? (
					<div className="flex flex-wrap items-center gap-2">
						<NativeSelect
							aria-label="App to connect"
							disabled={toolkits.isLoading}
							onChange={(event) => setToolkit(event.target.value)}
							size="sm"
							value={toolkit}
						>
							<NativeSelectOption value="">
								{toolkits.isLoading ? "Loading apps…" : "Choose an app"}
							</NativeSelectOption>
							{(toolkits.data ?? []).map((candidate) => (
								<NativeSelectOption key={candidate.slug} value={candidate.slug}>
									{candidate.name}
								</NativeSelectOption>
							))}
						</NativeSelect>
						<Button
							disabled={!toolkit || initiate.isPending}
							loading={initiate.isPending}
							onClick={() => setPermissionOpen(true)}
							size="sm"
						>
							Continue
						</Button>
						<Button
							onClick={() => {
								setPicking(false);
								setToolkit("");
							}}
							size="sm"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
				) : null
			}
		>
			{body}
			<ConnectionPermissionDialog
				connectionName={toolkitName}
				connectionType="Composio"
				onConfirm={handleConnect}
				onOpenChange={setPermissionOpen}
				open={permissionOpen}
			/>
		</AgentOwnConnectedAppsCard>
	);
}
