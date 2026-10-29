// apps/desktop/src/components/settings/DesktopRouteSettings.tsx
//
// "Route traffic through this computer" (Gateway settings → Network). When on,
// the user's own cloud nodes send their browser and cloud-task web traffic out
// through this desktop, so sites see this computer's network and IP address.
//
// The setting always targets the LOCAL Core, whatever node is active: this
// desktop is the exit. Core dials out to each node with the node credentials
// supplied here (and refreshed by the node store); see
// `apps/core/src/local_egress/` for the tunnel and its fail-closed rules.

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { Switch } from "@ryu/ui/components/switch.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { sileo } from "sileo";
import { getActiveUserId } from "@/lib/auth-client.ts";
import {
	configureDesktopRoute,
	type DesktopRouteLink,
	type DesktopRouteStatus,
	desktopDeviceName,
	fetchDesktopRoute,
	routableNodes,
} from "@/src/lib/api/local-egress.ts";
import {
	fetchManagedNodes,
	type ManagedNode,
} from "@/src/lib/api/managed-nodes.ts";
import { isLocalNode, useNodeStore } from "@/src/store/useNodeStore.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

const STATUS_POLL_MS = 5000;

function describeLink(link: DesktopRouteLink, tl: LiteralMessage): string {
	switch (link.state) {
		case "connected":
			return "Routing through this computer.";
		case "connecting":
			return "Connecting…";
		case "offline":
			return tl(
				"Not connected: {error}. Its traffic is paused until this computer reconnects.",
				{ error: link.error }
			);
		case "disabled_by_admin":
			return "Your team admin has turned off local traffic routing. This node routes traffic through the cloud.";
		case "unauthorized":
			return "Sign in again to reconnect this node.";
		default:
			return "";
	}
}

/** The short right-hand value of a node's row; `describeLink` is its visible
 *  explanation when the node needs attention. */
function linkLabel(link: DesktopRouteLink): string {
	switch (link.state) {
		case "connected":
			return "Connected";
		case "connecting":
			return "Connecting…";
		case "offline":
			return "Paused";
		case "disabled_by_admin":
			return "Off by admin";
		case "unauthorized":
			return "Sign in again";
		default:
			return "";
	}
}

/** The row's visible description: only the states that need the user's attention. */
function linkExplanation(
	link: DesktopRouteLink,
	tl: LiteralMessage
): ReactNode {
	switch (link.state) {
		case "offline":
			// The connection error is runtime text: a node, so the settings
			// formatter never reads braces in it as placeholders.
			return <span>{describeLink(link, tl)}</span>;
		case "disabled_by_admin":
		case "unauthorized":
			return describeLink(link, tl);
		default:
			return undefined;
	}
}

function useLocalTarget() {
	const localNodes = useNodeStore((state) => state.localNodes);
	const local = localNodes.find((node) => isLocalNode(node));
	return useMemo(
		() =>
			local
				? { url: local.url, token: local.token ?? null, userJwt: null }
				: null,
		[local]
	);
}

export function DesktopRouteSettings() {
	const tl = useLiteralMessages();
	const target = useLocalTarget();
	const [status, setStatus] = useState<DesktopRouteStatus | null>(null);
	const [managed, setManaged] = useState<ManagedNode[]>([]);
	const [saving, setSaving] = useState(false);

	const refresh = useCallback(async () => {
		if (!target) {
			return;
		}
		try {
			setStatus(await fetchDesktopRoute(target));
		} catch {
			// An older Core without this route hides the section.
			setStatus(null);
		}
	}, [target]);

	useEffect(() => {
		let cancelled = false;
		fetchManagedNodes()
			.then((nodes) => {
				if (!cancelled && nodes) {
					setManaged(nodes);
				}
			})
			.catch(() => undefined);
		refresh().catch(() => undefined);
		const timer = setInterval(() => {
			refresh().catch(() => undefined);
		}, STATUS_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [refresh]);

	const owned = useMemo(
		() => routableNodes(managed, getActiveUserId()),
		[managed]
	);
	const names = useMemo(
		() => new Map(managed.map((node) => [node.id, node.name])),
		[managed]
	);

	if (!(target && status)) {
		return null;
	}

	const links = status.nodes;
	const lockedByAdmin =
		links.length > 0 &&
		links.every((link) => link.state === "disabled_by_admin");

	const handleToggle = async (enabled: boolean) => {
		setSaving(true);
		try {
			// Turning on needs fresh credentials; turning off sends them too so Core
			// can tell each node to return to its cloud path.
			const fresh = (await fetchManagedNodes()) ?? managed;
			setManaged(fresh);
			const nodes = routableNodes(fresh, getActiveUserId());
			setStatus(
				await configureDesktopRoute(target, {
					enabled,
					deviceName: desktopDeviceName(),
					nodes,
				})
			);
			if (enabled && nodes.length === 0) {
				sileo.warning({
					title: "No cloud nodes to route",
					description:
						"Routing applies to cloud nodes you own. It starts automatically when you have one.",
				});
			}
		} catch (error) {
			sileo.error({
				title: "Could not change traffic routing",
				description:
					error instanceof Error ? error.message : "Try again in a moment.",
			});
		} finally {
			setSaving(false);
		}
	};

	return (
		<SettingsSection
			caption="Send your cloud nodes' web traffic through this computer, so sites see this computer's IP address. Ryu must stay open on this computer while it is on."
			title="Traffic routing"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<Switch
							aria-label="Route traffic through this computer"
							checked={status.enabled && !lockedByAdmin}
							disabled={saving || lockedByAdmin}
							id="local-egress-route-enabled"
							onCheckedChange={handleToggle}
						/>
					}
					description={
						lockedByAdmin
							? "Disabled by your admin. You can't turn this on."
							: "Your cloud nodes' browser tabs and cloud tasks use this computer's network. While it is on and this computer is asleep or offline, their web traffic pauses instead of using the cloud. Private and local network addresses stay blocked."
					}
					title="Route traffic through this computer"
				/>
				{status.enabled && !lockedByAdmin && owned.length === 0 ? (
					<SettingsItem
						description="You don't own any cloud nodes yet. Routing starts automatically when you do."
						title="Cloud nodes"
					/>
				) : null}
				{status.enabled
					? links.map((link) => (
							// One card of node rows: the state reads as the row's value, and
							// a state that needs attention explains itself in plain sight
							// (the connection error included), not only in a tooltip.
							<SettingsItem
								actions={
									<span className="text-muted-foreground text-sm">
										{linkLabel(link)}
									</span>
								}
								description={linkExplanation(link, tl)}
								key={link.nodeId}
								title={names.get(link.nodeId) ?? "Cloud node"}
							/>
						))
					: null}
			</SettingsGroup>
		</SettingsSection>
	);
}
