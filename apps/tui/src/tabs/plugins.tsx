/* @jsxImportSource @opentui/react */
// Plugins tab — the REAL plugin lifecycle surface, backed by Core's `/api/plugins`
// (a plugin.json bundle + its installed/enabled record), NOT the sidecar catalog
// that `apps.tsx` browses (`/api/catalog` + `/api/setup`). It mirrors apps/desktop's
// Extensions page (useApps) over the terminal:
//   - data:      GET /api/plugins -> AppInfo[] (manifests merged with lifecycle state;
//                includes not-yet-installed manifests, which is the install-from-catalog
//                path — install a row with installed===false).
//   - install:   POST /api/plugins/:id/install   (row not installed)
//   - enable:    POST /api/plugins/:id/enable     (installed, disabled)
//   - disable:   POST /api/plugins/:id/disable    (installed, enabled)
//   - uninstall: POST /api/plugins/:id/uninstall  (installed)
//   - update:    POST /api/plugins/:id/update     (installed)
//   - keys:      j/k or ↑/↓ navigate · i install · e enable/disable · D uninstall ·
//                u update · C cascade the last blocked destructive action · r refresh
//
// Typed refusals are surfaced READABLY: the core-client already folds
// describeDependencyError() into `err.message`, so a `blocked_by_dependents` disable
// prints "X is needed by Y. Disable Y first." and a built-in uninstall prints Core's
// message; we branch only to OFFER the follow-up (C to cascade, or "disable instead").
// Because the tui set X-Ryu-Surface=cli at entry, this list is already surface-filtered
// by Core. The tab owns its keys in an `active`-gated handler so the shell/store shell
// and this tab never both react (parity with apps.tsx).

import { useKeyboard } from "@opentui/react";
import type { ApiTarget } from "@ryuhq/core-client/client";
import {
	type AppInfo,
	type AppLifecycleError,
	type DependencyError,
	disableApp,
	enableApp,
	fetchApps,
	installApp,
	uninstallApp,
	updateApp,
} from "@ryuhq/core-client/plugins";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "@/components/ui/theme-provider.tsx";
import { useCore } from "../core/CoreContext.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import type { TabProps } from "./types.ts";

const NAME_WIDTH = 20;
const STATE_WIDTH = 12;
const LIST_HEIGHT = 16;

type ThemeValue = ReturnType<typeof useTheme>;

// A destructive action the dependency graph refused, remembered so pressing C can
// retry the SAME action with cascade:true (disable/uninstall the dependents too).
interface PendingCascade {
	id: string;
	kind: "disable" | "uninstall";
	name: string;
}

// The shape core-client throws: `Object.assign(new Error(msg), AppLifecycleError)`.
// We read the typed fields to decide which follow-up to OFFER (the readable line is
// already `err.message`), never by string-parsing prose.
type LifecycleErrorLike = Partial<AppLifecycleError> & { message: string };

function asLifecycleError(err: unknown): LifecycleErrorLike {
	if (err instanceof Error) {
		const e = err as Error & Partial<AppLifecycleError>;
		return {
			message: e.message,
			builtIn: e.builtIn,
			dependencyError: e.dependencyError ?? null,
			hint: e.hint ?? null,
			gatewayUnreachable: e.gatewayUnreachable,
			grantsDenied: e.grantsDenied,
		};
	}
	return { message: String(err) };
}

/** True when the refusal was a 409 `blocked_by_dependents` — the one case a cascade
 *  retry resolves. */
function blockedByDependents(err: LifecycleErrorLike): boolean {
	const dep: DependencyError | null | undefined = err.dependencyError;
	return dep?.code === "blocked_by_dependents";
}

// ── State labelling ───────────────────────────────────────────────────────────

interface StateChip {
	color: (t: ThemeValue) => string;
	label: string;
}

function chipFor(app: AppInfo): StateChip {
	if (!app.installed) {
		return { label: "available", color: (t) => t.colors.mutedForeground };
	}
	if (app.enabled) {
		return { label: "enabled", color: (t) => t.colors.success };
	}
	return { label: "disabled", color: (t) => t.colors.muted };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PluginsTab({ active }: TabProps) {
	const { target, url, token } = useCore();
	const theme = useTheme();
	const { notify } = useToast();

	const [apps, setApps] = useState<AppInfo[]>([]);
	const [index, setIndex] = useState(0);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const pendingCascade = useRef<PendingCascade | null>(null);

	// Track the latest request so a stale resolve cannot clobber fresh data (parity
	// with apps.tsx). Reload also fires on a node switch (url/token in deps).
	const reqRef = useRef(0);

	const runLoad = useCallback(() => {
		const reqId = ++reqRef.current;
		setLoading(true);
		setError(null);
		fetchApps(target)
			.then((next) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setApps(next);
				setIndex((i) => (next.length === 0 ? 0 : Math.min(i, next.length - 1)));
				setLoaded(true);
			})
			.catch((err: unknown) => {
				if (reqRef.current !== reqId) {
					return;
				}
				setError(asLifecycleError(err).message);
				setLoaded(true);
			})
			.finally(() => {
				if (reqRef.current === reqId) {
					setLoading(false);
				}
			});
		// url+token participate so a node switch reloads; target carries both.
	}, [target]);

	useEffect(() => {
		if (active) {
			runLoad();
		}
		// url/token are the primitive form of target; listed so a node switch reloads.
	}, [active, runLoad, url, token]);

	// Surface a typed refusal readably and, when a cascade would resolve it, remember
	// the action so C can retry it. Returns nothing; callers already cleared busy.
	const reportFailure = useCallback(
		(verb: string, app: AppInfo, err: unknown) => {
			const e = asLifecycleError(err);
			pendingCascade.current = null;
			if (blockedByDependents(e) && (verb === "disable" || verb === "uninstall")) {
				pendingCascade.current = { id: app.id, kind: verb, name: app.name };
				notify(`${e.message} — press C to ${verb} dependents too.`, "warning");
				return;
			}
			if (e.builtIn) {
				notify(`${e.message} — it is built in; disable it instead.`, "warning");
				return;
			}
			const hint = e.hint ? ` (${e.hint})` : "";
			notify(`${verb} failed: ${e.message}${hint}`, "error");
		},
		[notify]
	);

	// Run a lifecycle mutation against `app`, clearing any stale cascade offer on a
	// fresh (non-cascade) action, refreshing on success, and reporting typed refusals.
	const mutate = useCallback(
		(
			verb: string,
			app: AppInfo,
			run: () => Promise<unknown>,
			opts?: { keepCascade?: boolean; onOk?: (result: unknown) => void }
		) => {
			if (!opts?.keepCascade) {
				pendingCascade.current = null;
			}
			setBusy(app.id);
			run()
				.then((result) => {
					opts?.onOk?.(result);
					if (!opts?.onOk) {
						notify(`${verb} ${app.name}`, "success");
					}
					runLoad();
				})
				.catch((err: unknown) => reportFailure(verb, app, err))
				.finally(() => setBusy(null));
		},
		[notify, runLoad, reportFailure]
	);

	const doInstall = useCallback(
		(app: AppInfo) => {
			if (app.installed) {
				notify(`${app.name} is already installed`, "info");
				return;
			}
			mutate("install", app, () => installApp(target, app.id));
		},
		[target, notify, mutate]
	);

	const doToggle = useCallback(
		(app: AppInfo) => {
			if (!app.installed) {
				notify(`${app.name} is not installed — press i to install`, "info");
				return;
			}
			if (app.enabled) {
				mutate("disable", app, () => disableApp(target, app.id));
			} else {
				mutate("enable", app, () => enableApp(target, app.id));
			}
		},
		[target, notify, mutate]
	);

	const doUninstall = useCallback(
		(app: AppInfo) => {
			if (!app.installed) {
				notify(`${app.name} is not installed`, "info");
				return;
			}
			mutate("uninstall", app, () => uninstallApp(target, app.id), {
				onOk: (result) => {
					const r = result as {
						disabled?: string[];
						externallyManaged?: boolean;
						notice?: string;
					};
					if (r.externallyManaged && r.notice) {
						notify(r.notice, "warning");
					} else {
						const also = r.disabled?.length
							? ` (disabled ${r.disabled.join(", ")})`
							: "";
						notify(`Uninstalled ${app.name}${also}`, "success");
					}
				},
			});
		},
		[target, notify, mutate]
	);

	const doUpdate = useCallback(
		(app: AppInfo) => {
			if (!app.installed) {
				notify(`${app.name} is not installed`, "info");
				return;
			}
			mutate("update", app, () => updateApp(target, app.id));
		},
		[target, notify, mutate]
	);

	// Retry the last dependency-blocked destructive action with cascade:true.
	const doCascade = useCallback(() => {
		const pending = pendingCascade.current;
		if (!pending) {
			notify("Nothing to cascade", "info");
			return;
		}
		const app = apps.find((a) => a.id === pending.id);
		if (!app) {
			pendingCascade.current = null;
			return;
		}
		if (pending.kind === "disable") {
			mutate("disable", app, () => disableApp(target, app.id, { cascade: true }), {
				keepCascade: true,
			});
		} else {
			mutate(
				"uninstall",
				app,
				() => uninstallApp(target, app.id, { cascade: true }),
				{ keepCascade: true }
			);
		}
		pendingCascade.current = null;
	}, [apps, target, notify, mutate]);

	const selected = apps[index];

	const activate = (run: (app: AppInfo) => void) => {
		if (selected && !busy) {
			run(selected);
		}
	};

	useKeyboard((key) => {
		if (!active) {
			return;
		}
		const { name } = key;
		if (name === "up" || name === "k") {
			setIndex((i) => Math.max(0, i - 1));
		} else if (name === "down" || name === "j") {
			setIndex((i) => Math.min(Math.max(0, apps.length - 1), i + 1));
		} else if (name === "i") {
			activate(doInstall);
		} else if (name === "e") {
			activate(doToggle);
		} else if (name === "u") {
			activate(doUpdate);
		} else if (name === "D" || (name === "d" && key.shift)) {
			activate(doUninstall);
		} else if (name === "C" || (name === "c" && key.shift)) {
			if (!busy) {
				doCascade();
			}
		} else if (name === "r") {
			runLoad();
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading plugins…" />;
	}
	if (error) {
		return <ErrorView message={error} />;
	}

	return (
		<box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
			<box paddingBottom={1}>
				<text fg={theme.colors.foreground}>
					<b>Plugins</b>
				</text>
			</box>
			{apps.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>
					no plugins — press r to refresh
				</text>
			) : (
				<PluginList busy={busy} index={index} apps={apps} theme={theme} />
			)}
			<box paddingTop={1}>
				<text fg={theme.colors.mutedForeground}>
					↑↓ navigate · i install · e enable/disable · D uninstall · u update · C
					cascade · r refresh
				</text>
			</box>
		</box>
	);
}

function PluginRow({
	app,
	selected,
	busy,
	theme,
}: {
	app: AppInfo;
	busy: boolean;
	selected: boolean;
	theme: ThemeValue;
}) {
	const chip = chipFor(app);
	const name = app.name.padEnd(NAME_WIDTH);
	const stateText = (busy ? "working" : chip.label).padEnd(STATE_WIDTH);
	const version = app.installedVersion ?? app.version ?? "";
	return (
		<box flexDirection="row" gap={1}>
			<text fg={selected ? theme.colors.primary : theme.colors.muted}>
				{selected ? "›" : " "}
			</text>
			<text fg={selected ? theme.colors.primary : theme.colors.foreground}>
				{selected ? <b>{name}</b> : name}
			</text>
			<text fg={busy ? theme.colors.info : chip.color(theme)}>{stateText}</text>
			{app.builtIn ? (
				<text fg={theme.colors.mutedForeground}>[built-in]</text>
			) : null}
			{version ? (
				<text fg={theme.colors.mutedForeground}>{version}</text>
			) : null}
		</box>
	);
}

function PluginList({
	apps,
	index,
	busy,
	theme,
}: {
	apps: AppInfo[];
	busy: string | null;
	index: number;
	theme: ThemeValue;
}) {
	// Window the rows so the selection stays visible without a focus-capturing
	// scrollbox (which would fight the shell for arrow keys) — parity with apps.tsx.
	const start = Math.max(
		0,
		Math.min(
			index - Math.floor(LIST_HEIGHT / 2),
			Math.max(0, apps.length - LIST_HEIGHT)
		)
	);
	const visible = apps.slice(start, start + LIST_HEIGHT);

	return (
		<box flexDirection="column">
			{visible.map((app, i) => {
				const absolute = start + i;
				return (
					<PluginRow
						app={app}
						busy={busy === app.id}
						key={app.id}
						selected={absolute === index}
						theme={theme}
					/>
				);
			})}
			{apps.length > visible.length ? (
				<text fg={theme.colors.mutedForeground}>
					{`${index + 1}/${apps.length}`}
				</text>
			) : null}
		</box>
	);
}
