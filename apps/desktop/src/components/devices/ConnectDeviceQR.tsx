import { useLiteralMessages } from "@ryu/i18n/react";
import { ExpandableQRCode } from "@ryu/ui/components/qr-code.tsx";
import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";
import { useEffect, useState } from "react";
import { nodeSettingsLabel } from "@/src/components/gateway/GatewayNodeScopePicker.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import { isLocalNode } from "@/src/store/useNodeStore.ts";

const LOOPBACK_HOST =
	/^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
const URL_PORT = /:(\d+)(?:\/|$)/;
const DEFAULT_CORE_PORT = "7980";

/** Swap a loopback host for this device's Wi-Fi address, keeping the port. */
function withDetectedHost(nodeUrl: string, wifiAddress: string): string {
	const port = nodeUrl.match(URL_PORT)?.[1] ?? DEFAULT_CORE_PORT;
	return `http://${wifiAddress}:${port}`;
}

function ConnectDeviceQR() {
	const tl = useLiteralMessages();
	// The settings dialog's scoped computer (or the active node outside it). The
	// QR carries this computer's credential, so the caption names it.
	const node = useActiveNode();
	const [host, setHost] = useState(node.url);

	// Re-seed the editable address when the active node changes, and — because a
	// phone can't reach a localhost address — try to auto-fill the address other
	// devices on the same Wi-Fi use to reach this device.
	useEffect(() => {
		setHost(node.url);
		if (!LOOPBACK_HOST.test(node.url)) {
			return;
		}
		let cancelled = false;
		invokeWhenReady<string>("get_lan_ip")
			.then((wifiAddress) => {
				if (!cancelled && wifiAddress) {
					setHost(withDetectedHost(node.url, wifiAddress));
				}
			})
			.catch(() => {
				// No reachable address detected (offline / no Wi-Fi); the user can
				// still type the address in the field below.
			});
		return () => {
			cancelled = true;
		};
	}, [node.url]);

	const trimmedHost = host.trim();
	const isLoopback = LOOPBACK_HOST.test(trimmedHost);
	const link = trimmedHost
		? buildRyuDeepLink({
				kind: "node",
				name: node.name,
				url: trimmedHost,
				token: node.token,
			})
		: "";

	return (
		<div className="flex flex-col items-center gap-3">
			<p className="text-muted-foreground text-sm">
				{isLocalNode(node)
					? "Scan with the Ryu mobile app to connect this device."
					: tl("Scan with the Ryu mobile app to connect {nodeName}.", {
							nodeName: nodeSettingsLabel(node),
						})}
			</p>
			<div className="w-full space-y-1">
				<label
					className="type-caption text-muted-foreground"
					htmlFor="connect-device-address"
				>
					Address other devices use to reach this device
				</label>
				<input
					aria-label="Address other devices use to reach this device"
					className="w-full rounded-md border px-2 py-1 text-sm"
					id="connect-device-address"
					onChange={(e) => setHost(e.target.value)}
					placeholder="http://192.168.1.50:7980"
					value={host}
				/>
			</div>
			{isLoopback && (
				<p className="type-caption text-status-warning">
					This address only works on this device. Enter the address other
					devices on the same Wi-Fi use to reach it, for example
					http://192.168.1.50:7980.
				</p>
			)}
			{link && <ExpandableQRCode size={180} value={link} />}
		</div>
	);
}

export { ConnectDeviceQR };
