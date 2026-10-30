import {
	Copy01Icon,
	ViewIcon,
	ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { ExpandableQRCode } from "@ryu/ui/components/qr-code.tsx";
import { buildRyuDeepLink } from "@ryuhq/protocol/deep-link";
import { useEffect, useState } from "react";
import { sileo } from "sileo";
import type { Node } from "@/src/store/useNodeStore.ts";
import { computerName } from "./NodeSelector-status.tsx";

const LOOPBACK_HOST =
	/\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
const URL_PORT = /:(\d+)(?:\/|$)/;

/** Swap a loopback host for a reachable one (mesh MagicDNS) when we have it. */
function shareableUrl(nodeUrl: string, magicDnsName: string | null): string {
	if (LOOPBACK_HOST.test(nodeUrl) && magicDnsName) {
		const port = nodeUrl.match(URL_PORT)?.[1] ?? "7980";
		return `http://${magicDnsName}:${port}`;
	}
	return nodeUrl;
}

/**
 * Shows a `ryu://nodes/connect` deep link for one node — copy it (desktop/mobile
 * open it directly; the Chrome extension takes a paste) or scan the QR on a
 * phone. The address is editable because the saved URL is often loopback, which
 * no other device can reach; we pre-fill the mesh name when there is one and
 * otherwise prompt the user for this machine's LAN IP / Tailscale name.
 */
export function ShareNodeDialog({
	node,
	magicDnsName,
	open,
	onClose,
}: {
	node: Node | null;
	magicDnsName: string | null;
	open: boolean;
	onClose: () => void;
}) {
	const tl = useLiteralMessages();
	const [host, setHost] = useState("");
	const [revealToken, setRevealToken] = useState(false);

	// Re-seed the editable address whenever a different node is shared.
	useEffect(() => {
		if (node) {
			setHost(shareableUrl(node.url, magicDnsName));
			setRevealToken(false);
		}
	}, [node, magicDnsName]);

	if (!node) {
		return null;
	}

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

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(link);
			sileo.success({ title: "Connect link copied" });
		} catch {
			sileo.error({ title: "Could not copy to clipboard" });
		}
	};

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{tl("Connect a computer to {name}", { name: computerName(node) })}
					</DialogTitle>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1">
						<p className="text-muted-foreground text-xs">
							Address other computers use to reach this computer
						</p>
						<Input
							aria-label="Shareable address"
							onChange={(e) => setHost(e.target.value)}
							placeholder="http://192.168.1.50:7980"
							size="lg"
							value={host}
						/>
						{isLoopback && (
							<p className="text-status-warning text-xs">
								Other devices can't reach a localhost address. Enter this
								machine's LAN IP (e.g. 192.168.1.50) or Tailscale name.
							</p>
						)}
					</div>

					{node.token && (
						<div className="space-y-1">
							<div className="flex items-center justify-between">
								<p className="text-muted-foreground text-xs">
									Token (included in the link)
								</p>
								<button
									className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
									onClick={() => setRevealToken((v) => !v)}
									type="button"
								>
									<HugeiconsIcon
										icon={revealToken ? ViewOffSlashIcon : ViewIcon}
										size={12}
									/>
									{revealToken ? "Hide" : "Show"}
								</button>
							</div>
							<p className="truncate rounded-md bg-muted/40 px-2 py-1 font-mono text-muted-foreground text-xs">
								{revealToken ? node.token : "•".repeat(16)}
							</p>
						</div>
					)}

					{link && (
						<>
							<div className="flex items-center gap-2">
								<Input
									aria-label="Connect link"
									readOnly
									size="lg"
									typography="caption"
									value={link}
									variant="code"
								/>
								<Button onClick={copy} size="sm" variant="secondary">
									<HugeiconsIcon icon={Copy01Icon} size={14} />
									Copy
								</Button>
							</div>
							<div className="flex flex-col items-center gap-2 pt-1">
								<ExpandableQRCode size={160} value={link} />
								<p className="text-muted-foreground text-xs">
									Scan with the Ryu mobile app
								</p>
							</div>
						</>
					)}
				</div>
				<DialogFooter>
					<Button onClick={onClose} variant="ghost">
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
