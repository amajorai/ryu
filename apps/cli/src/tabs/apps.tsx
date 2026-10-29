import type { z } from "zod";
import {
	nativeErrorMessage as errText,
	humanizeError,
} from "../core/native-errors.ts";
import {
	type sidecarCatalogItemSchema,
	sidecarCatalogSchema,
} from "../core/sidecar-catalog.ts";
/* @jsxImportSource @opentui/react */
// Apps tab - the TS port of apps/cli's "Apps" tab (apps/cli/src/{app.rs,ui.rs,main.rs}).
// It browses Core's sidecar catalog and installs/uninstalls catalog items:
//   - data:    GET /api/catalog -> json.sidecars (RemoteCatalogItem[])
//   - install: POST /api/setup/:name/install  (only when not installed/installing)
//   - remove:  POST /api/setup/:name/uninstall (only when installed)
//   - keys:    j/k or ↑/↓ navigate, i install, D uninstall, r refresh
//   - D opens an inline ConfirmPrompt (Cancel by default; y confirms, n/Esc cancels)
//     and the uninstall request is only sent once confirmed.
// Each row mirrors the Rust layout: name, category, an installed marker, the
// install-state status, and the resolved version. termcn is used for presentation;
// interactive keys are owned here in a gated handler so the shell and this tab never
// both react.

import { useKeyboard } from "@opentui/react";
import {
	type ApiTarget,
	apiUrl,
	fetchForTarget,
	makeHeaders,
} from "@ryuhq/core-client/client";
import { installSidecar } from "@ryuhq/core-client/plugins";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { tf } from "../i18n/translate.ts";
import { ConfirmPrompt } from "../ui/ConfirmPrompt.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { ListPosition, SelectableRow } from "../ui/SelectableRow.tsx";
import { useToast } from "../ui/toast.tsx";
import { useListWindow } from "../ui/useListWindow.ts";
import type { TabProps } from "./types.ts";

const NAME_WIDTH = 16;
const CATEGORY_WIDTH = 10;
// Background poll cadence while an install is in flight, matching apps/cli's 2s
// auto-refresh of the catalog while the Apps tab is active. The Rust loop polls
// unconditionally; here it runs only while a row is "installing" so a Core-side
// install->installed transition surfaces without the user pressing r, without
// churning the network on a static catalog.
const INSTALLING_POLL_MS = 2000;

// One installable item from Core's sidecar catalog. Mirrors apps/cli's
// `RemoteCatalogItem` - only the fields the list surfaces are kept.
interface CatalogItem {
	category: string;
	installedVersion: string | null;
	installState: string;
	latestVersion: string | null;
	name: string;
}

// Wire shape (snake_case as serialized by Core), the `sidecars` array of
// `GET /api/catalog`.
type CatalogItemWire = z.infer<typeof sidecarCatalogItemSchema>;

function toItem(wire: CatalogItemWire): CatalogItem {
	return {
		name: wire.name ?? "",
		category: wire.category ?? "",
		installState: wire.install_state ?? "",
		installedVersion: wire.installed_version ?? null,
		latestVersion: wire.latest_version ?? null,
	};
}

// GET /api/catalog -> json.sidecars. Core-client has no typed reader for this
// endpoint, so it is fetched directly with the shared HTTP primitives. Throws on a
// non-2xx response so the caller can surface the error (parity with the Rust client).
async function fetchCatalog(
	target: ApiTarget,
	signal?: AbortSignal
): Promise<CatalogItem[]> {
	const resp = await fetchForTarget(target)(apiUrl(target, "/api/catalog"), {
		headers: makeHeaders(target.token, target.userJwt),
		signal,
	});
	if (!resp.ok) {
		throw new Error(`/api/catalog failed: ${resp.status}`);
	}
	const json = sidecarCatalogSchema.parse(await resp.json());
	return (json.sidecars ?? []).map(toItem);
}

// POST /api/setup/:name/uninstall. Core-client exposes installSidecar but no
// uninstall counterpart, so this mirrors its raw fetch + status-only check (no
// body parse, so a non-JSON response body is never a false failure).
async function uninstallSidecar(
	target: ApiTarget,
	name: string
): Promise<void> {
	const resp = await fetchForTarget(target)(
		apiUrl(target, `/api/setup/${name}/uninstall`),
		{
			method: "POST",
			headers: makeHeaders(target.token, target.userJwt),
		}
	);
	if (!resp.ok) {
		throw new Error(`/api/setup/${name}/uninstall failed: ${resp.status}`);
	}
}

export function AppsTab({ active }: TabProps) {
	const { target } = useCore();
	const theme = useTheme();
	const { notify } = useToast();

	const [items, setItems] = useState<CatalogItem[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);

	// Track the latest request so a stale resolve cannot clobber fresh data.
	const reqRef = useRef(0);
	const lifetimeRef = useRef(false);
	const scopeRef = useRef({ target, active });
	scopeRef.current = { target, active };
	const inFlightRef = useRef<AbortController | null>(null);

	const runLoad = useCallback(
		(background = false) => {
			if (
				!(lifetimeRef.current && scopeRef.current.active) ||
				scopeRef.current.target !== target
			) {
				return;
			}
			if (background && inFlightRef.current) {
				return;
			}
			inFlightRef.current?.abort();
			const controller = new AbortController();
			inFlightRef.current = controller;
			const reqId = ++reqRef.current;
			if (!background) {
				setLoading(true);
			}
			setError(null);
			fetchCatalog(target, controller.signal)
				.then((next) => {
					if (controller.signal.aborted || reqRef.current !== reqId) {
						return;
					}
					setItems(next);
					setIndex((i) =>
						next.length === 0 ? 0 : Math.min(i, next.length - 1)
					);
					setLoaded(true);
				})
				.catch((err) => {
					if (controller.signal.aborted || reqRef.current !== reqId) {
						return;
					}
					setError(errText(err));
					setLoaded(true);
				})
				.finally(() => {
					if (inFlightRef.current === controller) {
						inFlightRef.current = null;
					}
					if (reqRef.current === reqId) {
						setLoading(false);
					}
				});
		},
		[target]
	);

	// Lazy first load on activation, plus reload on a node switch (url/token).
	useEffect(() => {
		if (!active) {
			return;
		}
		lifetimeRef.current = true;
		runLoad();
		return () => {
			lifetimeRef.current = false;
			reqRef.current++;
			inFlightRef.current?.abort();
			inFlightRef.current = null;
		};
	}, [active, runLoad]);

	// While a row is installing, poll the catalog so the Core-side
	// installing->installed (or failed) transition surfaces on its own (parity
	// with apps/cli's periodic refresh_catalog while the tab is active).
	const hasInstalling = items.some((it) => it.installState === "installing");
	useEffect(() => {
		if (!(active && hasInstalling)) {
			return;
		}
		const id = setInterval(() => runLoad(true), INSTALLING_POLL_MS);
		return () => clearInterval(id);
	}, [active, hasInstalling, runLoad]);

	// Install the selected catalog item, then refresh to reflect the new state.
	// Guarded so an already-installed/installing item is a no-op (parity with
	// apps/cli's do_install_catalog_item).
	const doInstall = useCallback(
		(item: CatalogItem) => {
			if (
				item.installState === "installed" ||
				item.installState === "installing"
			) {
				notify(
					tf("{name} is already {installState}", {
						name: item.name,
						installState: item.installState,
					}),
					"info"
				);
				return;
			}
			setBusy(item.name);
			setNotice(`Installing ${item.name}…`);
			installSidecar(target, item.name)
				.then(() => {
					setNotice(`Installed ${item.name}`);
					runLoad();
				})
				.catch((err) => {
					setNotice(null);
					notify(
						tf("install failed: {error}", { error: errText(err) }),
						"error"
					);
				})
				.finally(() => setBusy(null));
		},
		[target, notify, runLoad]
	);

	// Uninstall the selected catalog item, then refresh. Guarded so only an
	// installed item is removed (parity with do_uninstall_catalog_item). Core-client
	// exposes installSidecar but no uninstall helper, so POST it directly.
	const doUninstall = useCallback(
		(item: CatalogItem) => {
			if (item.installState !== "installed") {
				notify(tf("{name} is not installed", { name: item.name }), "info");
				return;
			}
			setBusy(item.name);
			setNotice(`Uninstalling ${item.name}…`);
			uninstallSidecar(target, item.name)
				.then(() => {
					setNotice(`Uninstalled ${item.name}`);
					runLoad();
				})
				.catch((err) => {
					setNotice(null);
					notify(
						tf("uninstall failed: {error}", { error: errText(err) }),
						"error"
					);
				})
				.finally(() => setBusy(null));
		},
		[target, notify, runLoad]
	);

	const selected = items[index];

	// The catalog item waiting on the uninstall ConfirmPrompt. While it is set, the
	// tab's own keys are ignored so y/n/r reach only the prompt.
	const [confirmItem, setConfirmItem] = useState<CatalogItem | null>(null);

	const askUninstall = (item: CatalogItem) => {
		if (item.installState !== "installed") {
			notify(tf("{name} is not installed", { name: item.name }), "info");
			return;
		}
		setConfirmItem(item);
	};

	// Run an install/uninstall action against the current row, ignoring the key
	// while nothing is selected or another action is in-flight.
	const activate = (run: (item: CatalogItem) => void) => {
		if (selected && !busy) {
			run(selected);
		}
	};

	useKeyboard((key) => {
		if (!active || confirmItem) {
			return;
		}
		const { name } = key;
		if (name === "up" || name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (name === "down" || name === "j") {
			setIndex((i) => Math.min(Math.max(0, items.length - 1), i + 1));
		} else if (name === "i") {
			activate(doInstall);
		} else if (name === "D" || (name === "d" && key.shift)) {
			activate(askUninstall);
		} else if (name === "r") {
			runLoad();
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading catalog…" />;
	}
	if (error) {
		return (
			<ErrorView message={humanizeError(error, { url: target.url })} onRetry />
		);
	}

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			minHeight={0}
			paddingLeft={1}
			paddingTop={1}
		>
			<box flexShrink={0} paddingBottom={1}>
				<text fg={theme.colors.foreground}>
					<b>Apps</b>
				</text>
			</box>
			{notice ? (
				<box flexShrink={0} paddingBottom={1}>
					<text fg={theme.colors.success}>{notice}</text>
				</box>
			) : null}
			{items.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>
					no catalog items - press r to refresh
				</text>
			) : (
				<CatalogList busy={busy} index={index} items={items} theme={theme} />
			)}
			{confirmItem ? (
				<box flexShrink={0} paddingTop={1}>
					<ConfirmPrompt
						active={active}
						confirmLabel="Uninstall"
						consequence={`${confirmItem.name} will be removed from this node; reinstall it to use it again.`}
						onCancel={() => setConfirmItem(null)}
						onConfirm={() => {
							setConfirmItem(null);
							doUninstall(confirmItem);
						}}
						title={tf("Uninstall {name}?", { name: confirmItem.name })}
					/>
				</box>
			) : (
				<box flexShrink={0} paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						↑↓ navigate · i install · D uninstall · r refresh
					</text>
				</box>
			)}
		</box>
	);
}

type ThemeValue = ReturnType<typeof useTheme>;

// Maps an install_state to its display icon, label and color (parity with the
// status column in apps/cli's render_apps_content).
function statusFor(state: string, theme: ThemeValue) {
	if (state === "failed") {
		return { icon: "✗", label: "failed", color: theme.colors.error };
	}
	if (state === "installing") {
		return { icon: "◌", label: "installing", color: theme.colors.info };
	}
	if (state === "installed") {
		return { icon: "●", label: "installed", color: theme.colors.success };
	}
	return { icon: " ", label: "-", color: theme.colors.mutedForeground };
}

function CatalogRow({
	item,
	selected,
	busy,
	theme,
}: {
	busy: boolean;
	item: CatalogItem;
	selected: boolean;
	theme: ThemeValue;
}) {
	const installed = item.installState === "installed";
	const status = statusFor(item.installState, theme);
	const version = item.installedVersion ?? item.latestVersion ?? "";
	const name = item.name.padEnd(NAME_WIDTH);
	const statusText = `${busy ? "◌" : status.icon} ${busy ? "working" : status.label}`;
	const muted = selected
		? theme.colors.selectionForeground
		: theme.colors.mutedForeground;
	// Status tones are tuned for the page background; on the selection
	// background they fall below text contrast, so the selected row uses the
	// selection foreground (the icon and label still carry the state).
	const onSelection = (color: string) =>
		selected ? theme.colors.selectionForeground : color;
	return (
		<SelectableRow selected={selected}>
			<text
				fg={
					selected ? theme.colors.selectionForeground : theme.colors.foreground
				}
				flexShrink={0}
			>
				{selected ? <b>{name}</b> : name}
			</text>
			<text fg={muted} flexShrink={0}>
				{item.category.padEnd(CATEGORY_WIDTH)}
			</text>
			<text
				fg={onSelection(installed ? theme.colors.success : muted)}
				flexShrink={0}
			>
				{installed ? "[✓]" : "   "}
			</text>
			<text
				fg={onSelection(busy ? theme.colors.info : status.color)}
				flexShrink={0}
			>
				{statusText}
			</text>
			{version ? (
				<text fg={muted} truncate wrapMode="none">
					{version}
				</text>
			) : null}
		</SelectableRow>
	);
}

function CatalogList({
	items,
	index,
	busy,
	theme,
}: {
	busy: string | null;
	index: number;
	items: CatalogItem[];
	theme: ThemeValue;
}) {
	// Window the rows to the measured space so the selection stays visible
	// without a focus-capturing scrollbox (which would fight the shell for arrow
	// keys).
	const { start, end, onSizeChange } = useListWindow({
		count: items.length,
		index,
		linesPerRow: 1,
	});
	const visible = items.slice(start, end);

	return (
		<>
			<box
				flexBasis={0}
				flexDirection="column"
				flexGrow={1}
				minHeight={0}
				onSizeChange={onSizeChange}
				overflow="hidden"
			>
				{visible.map((item, i) => {
					const absolute = start + i;
					return (
						<CatalogRow
							busy={busy === item.name}
							item={item}
							key={`${item.name}-${absolute}`}
							selected={absolute === index}
							theme={theme}
						/>
					);
				})}
			</box>
			<ListPosition
				count={items.length}
				index={index}
				visible={visible.length}
			/>
		</>
	);
}
