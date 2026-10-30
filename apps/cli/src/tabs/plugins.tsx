import { humanizeError } from "../core/native-errors.ts";
/* @jsxImportSource @opentui/react */
// Plugins tab — the REAL plugin lifecycle surface, backed by Core's `/api/plugins`
// (a manifest.json bundle + its installed/enabled record), NOT the sidecar catalog
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
//   - D and C are destructive, so they open an inline ConfirmPrompt first (Cancel is
//     the default; y confirms, n/Esc cancels) and nothing is sent until confirmed.
//
// Typed refusals are surfaced READABLY: the core-client already folds
// describeDependencyError() into `err.message`, so a `blocked_by_dependents` disable
// prints "X is needed by Y. Disable Y first." and a built-in uninstall prints Core's
// message; we branch only to OFFER the follow-up (C to cascade, or "disable instead").
// Because the tui set X-Ryu-Surface=cli at entry, this list is already surface-filtered
// by Core. The tab owns its keys in an `active`-gated handler so the shell/store shell
// and this tab never both react (parity with apps.tsx).

import { useKeyboard } from "@opentui/react";
import {
	type AppInfo,
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
import { tf } from "../i18n/translate.ts";
import { ConfirmPrompt } from "../ui/ConfirmPrompt.tsx";
import { ErrorView } from "../ui/ErrorView.tsx";
import { Loading } from "../ui/Loading.tsx";
import { useToast } from "../ui/toast.tsx";
import {
	asLifecycleError,
	blockedByDependents,
	type LifecycleErrorLike,
	type PendingCascade,
	type PendingConfirm,
} from "./plugins-lifecycle.ts";
import { PluginList } from "./plugins-list.tsx";
import type { TabProps } from "./types.ts";

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
			.catch((err) => {
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
		(verb: string, app: AppInfo, e: LifecycleErrorLike) => {
			pendingCascade.current = null;
			if (
				blockedByDependents(e) &&
				(verb === "disable" || verb === "uninstall")
			) {
				const dep = e.dependencyError;
				pendingCascade.current = {
					dependents:
						dep?.code === "blocked_by_dependents" ? dep.dependents : [],
					id: app.id,
					kind: verb,
					name: app.name,
				};
				notify(
					tf("{message} — press C to {verb} dependents too.", {
						message: e.message,
						verb,
					}),
					"warning"
				);
				return;
			}
			if (e.builtIn) {
				notify(
					tf("{message} — it is built in; disable it instead.", {
						message: e.message,
					}),
					"warning"
				);
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
		<T,>(
			verb: string,
			app: AppInfo,
			run: () => Promise<T>,
			opts?: { keepCascade?: boolean; onOk?: (result: T) => void }
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
				.catch((err) => reportFailure(verb, app, asLifecycleError(err)))
				.finally(() => setBusy(null));
		},
		[notify, runLoad, reportFailure]
	);

	const doInstall = useCallback(
		(app: AppInfo) => {
			if (app.installed) {
				notify(tf("{name} is already installed", { name: app.name }), "info");
				return;
			}
			mutate("install", app, () => installApp(target, app.id));
		},
		[target, notify, mutate]
	);

	const doToggle = useCallback(
		(app: AppInfo) => {
			if (!app.installed) {
				notify(
					tf("{name} is not installed — press i to install", {
						name: app.name,
					}),
					"info"
				);
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
				notify(tf("{name} is not installed", { name: app.name }), "info");
				return;
			}
			mutate("uninstall", app, () => uninstallApp(target, app.id), {
				onOk: (result) => {
					const r = result;
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
				notify(tf("{name} is not installed", { name: app.name }), "info");
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
			mutate(
				"disable",
				app,
				() => disableApp(target, app.id, { cascade: true }),
				{
					keepCascade: true,
				}
			);
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

	// A destructive action waiting on the inline ConfirmPrompt. While it is set, the
	// tab's own keys are ignored so y/n/r reach only the prompt.
	const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

	const selected = apps[index];

	const activate = (run: (app: AppInfo) => void) => {
		if (selected && !busy) {
			run(selected);
		}
	};

	const askUninstall = () => {
		if (!selected || busy) {
			return;
		}
		if (!selected.installed) {
			notify(tf("{name} is not installed", { name: selected.name }), "info");
			return;
		}
		const app = selected;
		setConfirm({
			title: `Uninstall ${app.name}?`,
			consequence: `${app.name} will be removed from this node; reinstall it to use it again.`,
			confirmLabel: "Uninstall",
			run: () => doUninstall(app),
		});
	};

	const askCascade = () => {
		if (busy) {
			return;
		}
		const pending = pendingCascade.current;
		if (!pending) {
			notify("Nothing to cascade", "info");
			return;
		}
		const verb = pending.kind === "disable" ? "Disable" : "Uninstall";
		const verbs = pending.kind === "disable" ? "disables" : "uninstalls";
		const who =
			pending.dependents.length > 0
				? pending.dependents.join(", ")
				: `every plugin that depends on ${pending.name}`;
		setConfirm({
			title: tf("{verb} {name} and its dependents?", {
				verb,
				name: pending.name,
			}),
			consequence: `Also ${verbs} ${who}.`,
			confirmLabel: `${verb} all`,
			run: doCascade,
		});
	};

	useKeyboard((key) => {
		if (!active || confirm) {
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
			askUninstall();
		} else if (name === "C" || (name === "c" && key.shift)) {
			askCascade();
		} else if (name === "r") {
			runLoad();
		}
	});

	if (loading && !loaded) {
		return <Loading label="Loading plugins…" />;
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
					<b>Plugins</b>
				</text>
			</box>
			{apps.length === 0 ? (
				<text fg={theme.colors.mutedForeground}>
					no plugins — press r to refresh
				</text>
			) : (
				<PluginList apps={apps} busy={busy} index={index} theme={theme} />
			)}
			{confirm ? (
				<box flexShrink={0} paddingTop={1}>
					<ConfirmPrompt
						active={active}
						confirmLabel={confirm.confirmLabel}
						consequence={confirm.consequence}
						onCancel={() => setConfirm(null)}
						onConfirm={() => {
							setConfirm(null);
							confirm.run();
						}}
						title={confirm.title}
					/>
				</box>
			) : (
				<box flexShrink={0} paddingTop={1}>
					<text fg={theme.colors.mutedForeground}>
						↑↓ navigate · i install · e enable/disable · D uninstall · u update
						· C cascade · r refresh
					</text>
				</box>
			)}
		</box>
	);
}
