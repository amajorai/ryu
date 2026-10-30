import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Item, ItemContent, ItemTitle } from "@ryu/ui/components/item.tsx";
import { parseRyuDeepLink } from "@ryuhq/protocol/deep-link";
import { useState } from "react";
import { invokeWhenReady } from "@/src/lib/tauri-ready.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";

/** Strip the `http(s)://` scheme from a node URL for display / naming. */
const URL_SCHEME = /^https?:\/\//;

const LINK_ERROR = "That doesn't look like a Ryu connection string.";
const ADD_FAILED = "Couldn't add this computer. Check the URL and token.";
const RAW_ERROR_SHAPE = /[{}[\]<>]|\b(?:[45]\d\d|ECONN\w+|ENOTFOUND)\b/;

/**
 * One sentence for a failed add. A message that already reads as a sentence
 * (a plan-cap notice, a duplicate address) passes through; raw shapes (JSON,
 * markup, status codes, socket errors, long traces) map to ADD_FAILED. The raw
 * text stays on the line's tooltip for support.
 */
function addErrorSentence(raw: string): string {
	const message = raw.replace(/^Error:\s*/, "").trim();
	if (!message || message.length > 160 || RAW_ERROR_SHAPE.test(message)) {
		return ADD_FAILED;
	}
	return message;
}

export function AddNodeDialog({
	open,
	onClose,
}: {
	open: boolean;
	onClose: () => void;
}) {
	const addNode = useNodeStore((s) => s.addNode);
	const nodes = useNodeStore((s) => s.nodes);
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [token, setToken] = useState("");
	const [link, setLink] = useState("");
	const [error, setError] = useState<string | null>(null);
	// LAN discovery, folded in from the node dropdown: sweep the local /24 for
	// reachable Core nodes and add one in a click — right where you'd otherwise
	// type its address by hand.
	const [scanning, setScanning] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredNode[] | null>(null);

	// One line instead of three boxes: a `ryu://nodes/connect?…` connection string
	// carries address, label and (when the sender had one) bearer, so copying a
	// node between surfaces is a paste rather than a transcription. The grammar is
	// owned by `@ryuhq/protocol/deep-link` — parsed here, never re-implemented.
	// It only PRE-FILLS: the user still presses Add, so a string from a hostile
	// clipboard can never connect on its own.
	const handleLinkChange = (value: string) => {
		setLink(value);
		if (!value.trim()) {
			return;
		}
		const parsed = parseRyuDeepLink(value);
		if (parsed?.kind !== "node") {
			setError(LINK_ERROR);
			return;
		}
		setName(parsed.name);
		setUrl(parsed.url);
		setToken(parsed.token ?? "");
		setError(null);
	};

	const handleAdd = async () => {
		setError(null);
		try {
			await addNode(name.trim(), url.trim(), token.trim() || undefined);
			setName("");
			setUrl("");
			setToken("");
			setLink("");
			onClose();
		} catch (e) {
			setError(String(e));
		}
	};

	const handleScanLan = async () => {
		setScanning(true);
		setDiscovered(null);
		try {
			const found =
				await invokeWhenReady<DiscoveredNode[]>("discover_lan_nodes");
			// Drop URLs already configured so the picker only shows new candidates.
			const knownUrls = new Set(nodes.map((n) => n.url.replace(/\/$/, "")));
			setDiscovered(
				found.filter((d) => !knownUrls.has(d.url.replace(/\/$/, "")))
			);
		} catch {
			setDiscovered([]);
		} finally {
			setScanning(false);
		}
	};

	const handleAddDiscovered = async (node: DiscoveredNode) => {
		// Name from host AND profile. Host alone was enough while discovery swept a
		// single port; now that every profile's port is swept, one machine can
		// return several nodes and a host-only name would collide — the canary node
		// would silently fail to add because release already took the name.
		const hostPort = node.url.replace(URL_SCHEME, "");
		const host = hostPort.split(":")[0] ?? "node";
		const suffix =
			node.profile && node.profile !== "release" ? `-${node.profile}` : "";
		const discoveredName = `node-${host.replace(/\./g, "-")}${suffix}`;
		try {
			await addNode(discoveredName, node.url);
		} catch {
			// Already added or a name clash — drop it from the picker either way.
		}
		setDiscovered((prev) => prev?.filter((d) => d.url !== node.url) ?? null);
	};

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle className="font-sans font-semibold text-lg tracking-tight">
						Add computer
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Input
							aria-label="Connection string"
							id="node-link"
							onChange={(e) => handleLinkChange(e.target.value)}
							placeholder="ryu://nodes/connect?url=…"
							value={link}
							variant="code-caption"
						/>
						<p className="text-(length:--text-detail) text-muted-foreground leading-(--text-detail--line-height)">
							Paste a connection string, or enter the details below.
						</p>
					</div>
					<Input
						aria-label="Name"
						id="node-name"
						onChange={(e) => setName(e.target.value)}
						placeholder="Name"
						value={name}
					/>
					<Input
						aria-label="URL"
						id="node-url"
						onChange={(e) => setUrl(e.target.value)}
						placeholder="URL"
						value={url}
					/>
					<Input
						aria-label="Token"
						id="node-token"
						onChange={(e) => setToken(e.target.value)}
						placeholder="Token (optional)"
						value={token}
					/>
					{error && (
						<p className="text-sm text-status-destructive" title={error}>
							{error === LINK_ERROR ? error : addErrorSentence(error)}
						</p>
					)}
					<div className="flex flex-col gap-1">
						<Button
							className="self-start"
							disabled={scanning}
							onClick={() => {
								handleScanLan();
							}}
							size="sm"
							variant="ghost-muted"
						>
							<HugeiconsIcon className="size-4" icon={Search01Icon} />
							{scanning ? "Scanning local network…" : "Scan local network"}
						</Button>
						{discovered !== null && discovered.length === 0 && !scanning && (
							<p className="text-(length:--text-detail) px-2 text-muted-foreground">
								No new computers found.
							</p>
						)}
						{discovered?.map((d) => (
							<Item
								className="h-8 rounded-lg px-2 py-0 hover:bg-muted"
								key={d.url}
								render={
									<button
										onClick={() => {
											handleAddDiscovered(d);
										}}
										type="button"
									/>
								}
								size="sm"
							>
								<span
									aria-hidden
									className="size-1.5 shrink-0 rounded-full bg-success"
								/>
								<ItemContent className="min-w-0">
									<ItemTitle
										className="truncate font-normal"
										title={d.url.replace(URL_SCHEME, "")}
									>
										{d.url.replace(URL_SCHEME, "")}
									</ItemTitle>
								</ItemContent>
								<span className="shrink-0 text-muted-foreground/70 text-xs tabular-nums">
									{d.latency_ms}ms
								</span>
							</Item>
						))}
					</div>
				</div>
				<DialogFooter>
					<Button onClick={onClose} variant="ghost">
						Cancel
					</Button>
					<Button
						disabled={!(name.trim() && url.trim())}
						onClick={handleAdd}
						variant="mono"
					>
						Add computer
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** A reachable Core found by the sweep (mirrors the Rust DiscoveredNode). */
interface DiscoveredNode {
	latency_ms: number;
	/** Which profile answered, derived from the PORT it was found on. Discovery
	 *  now sweeps every profile's port, so one host can legitimately return
	 *  several nodes and they must be distinguishable. */
	profile?: string;
	url: string;
}
