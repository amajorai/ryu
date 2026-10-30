import { RefreshIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Item } from "@ryu/ui/components/item.tsx";
import { safeMediaUrl } from "@ryu/ui/lib/safe-media-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { apiUrl, makeHeaders } from "@/src/lib/api/client.ts";

// ── Simulator sidecar panel (@ryu/simulator) ───────────────────────────────

const SIMULATOR_PLUGIN_ID = "@ryu/simulator";
const SIM_BASE = "/api/ext/@ryu/simulator";
const SIM_POLL_MS = 1500;

type SimPlatform = "ios" | "android";

interface SimDevice {
	id: string;
	kind: "simulator" | "emulator";
	name: string;
	os: string;
	platform: SimPlatform;
	state: "booted" | "shutdown" | "unknown";
}

interface SimPlatformCap {
	available: boolean;
	interactive: boolean;
	reason?: string;
}

interface SimCapabilities {
	android: SimPlatformCap;
	ios: SimPlatformCap;
}

// Feature-detected simulator tab: when the `@ryu/simulator` app is enabled, drive its
// device-control sidecar (simctl/adb) through Core's ext-proxy. When disabled, prompt to
// enable it. Availability of each platform is a RUNTIME probe from the sidecar, never an
// OS sniff on the desktop — iOS shows only on a Mac node with Xcode; Android wherever the
// SDK is installed on the connected node.
export function SimulatorTabPanel() {
	const { apps } = useApps();
	const enabled = apps.some((a) => a.id === SIMULATOR_PLUGIN_ID && a.enabled);
	if (!enabled) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-xs">
				<HugeiconsIcon className="size-5" icon={SmartPhone01Icon} />
				<p className="max-w-xs">
					Enable the <span className="font-medium">Simulators</span> app to
					drive iOS Simulators and Android Emulators from here.
				</p>
			</div>
		);
	}
	return <SimulatorSidecarPanel />;
}

function SimulatorSidecarPanel() {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const [caps, setCaps] = useState<SimCapabilities | null>(null);
	const [devices, setDevices] = useState<SimDevice[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [shot, setShot] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const headers = useMemo(
		() => makeHeaders(node.token ?? null, node.userJwt),
		[node.token, node.userJwt]
	);
	const selected = devices.find((d) => d.id === selectedId) ?? null;

	const call = useCallback(
		async (path: string, init?: RequestInit) => {
			const resp = await fetch(
				apiUrl(
					{ url: node.url, token: node.token, userJwt: node.userJwt ?? null },
					path
				),
				{ headers, ...init }
			);
			if (!resp.ok) {
				throw new Error(`${resp.status}`);
			}
			return resp;
		},
		[node.url, node.token, headers]
	);

	const refresh = useCallback(async () => {
		setError(null);
		try {
			const [capResp, devResp] = await Promise.all([
				call(`${SIM_BASE}/capabilities`),
				call(`${SIM_BASE}/devices`),
			]);
			setCaps(
				/* SAFETY: The simulator capabilities success route returns DeviceDriver.probe with its typed per-platform capability fields. */ (await capResp.json()) as SimCapabilities
			);
			const data =
				/* SAFETY: The simulator devices success route wraps DeviceDriver.list typed Device records in devices; call rejects errors. */ (await devResp.json()) as {
					devices: SimDevice[];
				};
			setDevices(data.devices);
			setSelectedId((prev) => prev ?? data.devices[0]?.id ?? null);
		} catch (e) {
			setError(
				e instanceof Error
					? tl("Simulator sidecar unreachable ({message})", {
							message: e.message,
						})
					: "error"
			);
		}
	}, [call, tl]);

	useEffect(() => {
		refresh().catch(() => undefined);
	}, [refresh]);

	const screenshot = useCallback(
		async (id: string) => {
			try {
				const resp = await call(
					`${SIM_BASE}/devices/${encodeURIComponent(id)}/screenshot`
				);
				const data =
					/* SAFETY: The simulator screenshot success route serializes the PNG buffer as base64 image; call rejects error responses. */ (await resp.json()) as {
						image: string;
					};
				setShot(`data:image/png;base64,${data.image}`);
			} catch {
				// A shutdown device has no screen — keep the last frame, don't error-spam.
			}
		},
		[call]
	);

	// Live screenshot polling while a booted device is selected (matches the browser
	// panel's screenshot-preview MVP; live video is a followup).
	useEffect(() => {
		if (selected?.state !== "booted") {
			return;
		}
		let cancelled = false;
		const tick = () => {
			if (!cancelled) {
				screenshot(selected.id).catch(() => undefined);
			}
		};
		tick();
		const h = setInterval(tick, SIM_POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(h);
		};
	}, [selected, screenshot]);

	const action = useCallback(
		async (
			id: string,
			path: string,
			body?: Parameters<typeof JSON.stringify>[0]
		) => {
			setBusy(true);
			setError(null);
			try {
				await call(`${SIM_BASE}/devices/${encodeURIComponent(id)}/${path}`, {
					method: "POST",
					headers: body
						? { ...headers, "Content-Type": "application/json" }
						: headers,
					body: body ? JSON.stringify(body) : undefined,
				});
				await refresh();
			} catch (e) {
				setError(e instanceof Error ? e.message : "action failed");
			} finally {
				setBusy(false);
			}
		},
		[call, headers, refresh]
	);

	// Map a click on the screenshot to device pixel coordinates and tap there (Android
	// only — iOS has no simctl coordinate tap).
	const tapAt = useCallback(
		(e: ReactMouseEvent<HTMLImageElement>) => {
			if (selected?.platform !== "android") {
				return;
			}
			const img = e.currentTarget;
			if (!(img.naturalWidth && img.naturalHeight)) {
				return;
			}
			const rect = img.getBoundingClientRect();
			const x = Math.round(
				((e.clientX - rect.left) / rect.width) * img.naturalWidth
			);
			const y = Math.round(
				((e.clientY - rect.top) / rect.height) * img.naturalHeight
			);
			action(selected.id, "tap", { x, y }).catch(() => undefined);
		},
		[selected, action]
	);

	const canTap =
		selected?.platform === "android" && selected.state === "booted";

	return (
		<div className="flex h-full flex-col">
			{/* Toolbar */}
			<div className="flex h-10 shrink-0 items-center gap-1 border-border border-b px-2">
				<HugeiconsIcon
					className="size-3.5 shrink-0 text-muted-foreground"
					icon={SmartPhone01Icon}
				/>
				<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
					{selected
						? `${selected.name} — ${selected.os}`
						: "No device selected"}
				</span>
				{selected && selected.state !== "booted" && (
					<button
						className="h-7 rounded-lg px-2 text-xs transition-colors duration-150 hover:bg-muted hover:duration-0 disabled:opacity-50"
						disabled={busy}
						onClick={() => action(selected.id, "boot").catch(() => undefined)}
						type="button"
					>
						Boot
					</button>
				)}
				{selected?.state === "booted" && (
					<>
						{selected.platform === "android" && (
							<>
								<button
									className="h-7 rounded-lg px-2 text-xs transition-colors duration-150 hover:bg-muted hover:duration-0 disabled:opacity-50"
									disabled={busy}
									onClick={() =>
										action(selected.id, "key", { key: "home" }).catch(
											() => undefined
										)
									}
									type="button"
								>
									Home
								</button>
								<button
									className="h-7 rounded-lg px-2 text-xs transition-colors duration-150 hover:bg-muted hover:duration-0 disabled:opacity-50"
									disabled={busy}
									onClick={() =>
										action(selected.id, "key", { key: "back" }).catch(
											() => undefined
										)
									}
									type="button"
								>
									Back
								</button>
							</>
						)}
						<button
							className="h-7 rounded-lg px-2 text-xs transition-colors duration-150 hover:bg-muted hover:duration-0 disabled:opacity-50"
							disabled={busy}
							onClick={() =>
								action(selected.id, "shutdown").catch(() => undefined)
							}
							type="button"
						>
							Shutdown
						</button>
					</>
				)}
				<Button
					aria-label="Refresh devices"
					onClick={() => refresh().catch(() => undefined)}
					size="icon-sm"
					variant="ghost-muted"
				>
					<HugeiconsIcon className="size-4" icon={RefreshIcon} />
				</Button>
			</div>

			<div className="flex min-h-0 flex-1">
				{/* Device list */}
				<div className="w-52 shrink-0 overflow-y-auto border-border border-r p-1 text-sm">
					<SimDeviceList
						caps={caps}
						devices={devices}
						onSelect={(id) => {
							setSelectedId(id);
							setShot(null);
						}}
						selectedId={selectedId}
					/>
				</div>

				{/* Device screen */}
				<div className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-2">
					{error ? (
						<p className="text-center text-muted-foreground text-xs">{error}</p>
					) : shot ? (
						// sidecar screenshot data URI, not a static asset.
						// the device screen is the interactive surface (Android tap).
						<img
							alt="Device screen"
							className={cn(
								"max-h-full max-w-full rounded-lg border border-border",
								canTap && "cursor-crosshair"
							)}
							onClick={canTap ? tapAt : undefined}
							src={safeMediaUrl(shot) ?? undefined}
						/>
					) : (
						<p className="max-w-xs text-center text-muted-foreground text-xs">
							{selected
								? selected.state === "booted"
									? "Loading device screen…"
									: "Boot the device to see its screen."
								: "Select a device to preview its screen. Live embedding is a followup."}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

// The grouped device list: iOS + Android sections, each showing an unavailable-reason
// line when the connected node can't run that platform.
function SimDeviceList({
	caps,
	devices,
	selectedId,
	onSelect,
}: {
	caps: SimCapabilities | null;
	devices: SimDevice[];
	onSelect: (id: string) => void;
	selectedId: string | null;
}) {
	const sections: Array<{ platform: SimPlatform; label: string }> = [
		{ platform: "ios", label: "iOS Simulators" },
		{ platform: "android", label: "Android Emulators" },
	];
	return (
		<>
			{sections.map(({ platform, label }) => {
				const cap = caps?.[platform];
				const list = devices.filter((d) => d.platform === platform);
				return (
					<div key={platform}>
						<div className="flex h-7 items-center px-2 text-detail text-muted-foreground">
							{label}
						</div>
						{cap && !cap.available ? (
							<p className="px-2 pb-2 text-muted-foreground text-xs">
								{cap.reason ?? "Not available on this node."}
							</p>
						) : list.length === 0 ? (
							<p className="px-2 pb-2 text-muted-foreground text-xs">
								No devices found.
							</p>
						) : (
							list.map((d) => (
								<Item
									className={cn(
										"h-8 flex-nowrap gap-2 rounded-lg px-2 py-0 text-left",
										d.id === selectedId ? "bg-accent" : "hover:bg-muted"
									)}
									key={d.id}
									onClick={() => onSelect(d.id)}
									render={<button type="button" />}
									size="sm"
								>
									<span
										className={cn(
											"size-1.5 shrink-0 rounded-full",
											d.state === "booted"
												? "bg-status-success"
												: "bg-muted-foreground/70"
										)}
									/>
									<span className="min-w-0 flex-1 truncate" title={d.name}>
										{d.name}
									</span>
									<span className="shrink-0 text-muted-foreground text-xs">
										{d.os}
									</span>
								</Item>
							))
						)}
					</div>
				);
			})}
		</>
	);
}
