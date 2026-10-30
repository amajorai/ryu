// apps/desktop/src/components/store/InstalledSection-controller.ts
//
// State, sidecar polling, and lifecycle handlers behind the Store's Installed
// section.

import { useLiteralMessages } from "@ryu/i18n/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useActiveNodeGetter } from "@/src/hooks/useActiveNode.ts";
import { useApps } from "@/src/hooks/useApps.ts";
import { usePluginSettingsOpener } from "@/src/hooks/usePluginSettingsOpener.ts";
import { usePluginSettingsTabs } from "@/src/hooks/usePluginSettingsTabs.ts";
import { useStandaloneApps } from "@/src/hooks/useStandaloneApps.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AppInfo,
	fetchAppLifecycleCapabilities,
	fetchSidecarDetails,
	type SidecarSandboxStatus,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import { primaryAgentId } from "./InstalledSection-categories.ts";

const SIDECAR_POLL_MS = 5000;

/** Everything `InstalledSection` reads before it renders. */
export function useInstalledSectionController() {
	const tl = useLiteralMessages();
	const navigate = useNavigate();
	const {
		apps,
		loading,
		error,
		install,
		toggle,
		toggleError,
		clearToggleError,
		reload,
		uninstall,
	} = useApps();
	const getActiveNode = useActiveNodeGetter();
	const activeNode = getActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const lifecycleCapabilities = useQuery({
		queryFn: () => fetchAppLifecycleCapabilities(target),
		queryKey: ["plugins", "lifecycle-capabilities", activeNode.url],
		staleTime: 30_000,
	});
	const { byPlugin: settingsByPlugin } = usePluginSettingsTabs();
	const {
		install: installStandalone,
		installedAppIds,
		open: openStandalone,
		uninstall: uninstallStandalone,
	} = useStandaloneApps();
	// Where each row's settings live (Gateway dialog vs App Settings, at its own
	// tab). Resolved once for the whole list and read per row below.
	const settingsOpener = usePluginSettingsOpener();

	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pending, setPending] = useState<Record<string, boolean>>({});
	const [sidecarStatus, setSidecarStatus] = useState<Record<string, boolean>>(
		{}
	);
	const [sidecarSandbox, setSidecarSandbox] = useState<
		Record<string, SidecarSandboxStatus>
	>({});

	const pollSidecarStatus = useCallback(async () => {
		const node = getActiveNode();
		const nodeTarget: ApiTarget = {
			url: node.url,
			token: node.token,
			userJwt: node.userJwt ?? null,
		};
		try {
			const details = await fetchSidecarDetails(nodeTarget);
			const running: Record<string, boolean> = {};
			const sandbox: Record<string, SidecarSandboxStatus> = {};
			for (const [name, detail] of Object.entries(details)) {
				running[name] = detail.running;
				if (detail.sandbox) {
					sandbox[name] = detail.sandbox;
				}
			}
			setSidecarStatus(running);
			setSidecarSandbox(sandbox);
		} catch {
			// Non-fatal: status stays at last known value.
		}
	}, [getActiveNode]);

	useEffect(() => {
		pollSidecarStatus().catch(() => {
			// Best-effort initial poll.
		});
		const id = setInterval(() => {
			pollSidecarStatus().catch(() => {
				// Best-effort interval poll.
			});
		}, SIDECAR_POLL_MS);
		return () => clearInterval(id);
	}, [pollSidecarStatus]);

	const setPendingFor = (id: string, val: boolean) =>
		setPending((prev) => ({ ...prev, [id]: val }));

	const handleInstall = async (app: AppInfo) => {
		setPendingFor(app.id, true);
		try {
			await install(app.id);
			await toggle(app.id, true);
		} catch {
			toast.error("Couldn't install this app", {
				description: "Check your connection and try again.",
			});
		} finally {
			setPendingFor(app.id, false);
		}
	};

	const handleToggle = async (app: AppInfo, checked: boolean) => {
		if (!app.installed) {
			return;
		}
		setPendingFor(app.id, true);
		try {
			await toggle(app.id, checked);
		} finally {
			setPendingFor(app.id, false);
		}
	};

	const handleUninstall = async (
		app: AppInfo,
		options?: { deleteStorage?: boolean }
	) => {
		setPendingFor(app.id, true);
		try {
			await uninstall(app.id, options);
		} finally {
			setPendingFor(app.id, false);
		}
	};

	// Built-in sidecar apps (Ghost/Shadow) have no enable/disable record — their
	// "enabled" IS the sidecar running-state, so the card's Enable/Disable maps to
	// start/stop, then re-polls the live status.
	const handleSidecar = async (app: AppInfo, action: "start" | "stop") => {
		if (!app.sidecarName) {
			return;
		}
		setPendingFor(app.id, true);
		try {
			await (action === "start"
				? startSidecar(target, app.sidecarName)
				: stopSidecar(target, app.sidecarName));
			await pollSidecarStatus();
		} finally {
			setPendingFor(app.id, false);
		}
	};

	const handleLaunch = (app: AppInfo) => {
		const agentId = primaryAgentId(app);
		if (agentId) {
			localStorage.setItem("ryu_default_agent", agentId);
		}
		navigate("/chat");
	};

	const standaloneTarget = (app: AppInfo) => ({
		appId: app.id,
		name: app.name,
		version: app.installedVersion ?? app.version,
	});

	const handleInstallStandalone = async (app: AppInfo) => {
		try {
			const appTarget = standaloneTarget(app);
			await installStandalone(appTarget);
			await openStandalone(appTarget);
			toast.success("Standalone app installed", {
				description: tl(
					"{name} now opens in its own window and keeps using the same Ryu data.",
					{ name: app.name }
				),
			});
		} catch (error) {
			toast.error("Couldn't install the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
	};

	const handleOpenStandalone = async (app: AppInfo) => {
		try {
			await openStandalone(standaloneTarget(app));
		} catch (error) {
			toast.error("Couldn't open the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
	};

	const handleRemoveStandalone = async (app: AppInfo) => {
		try {
			await uninstallStandalone(app.id);
			toast.success("Standalone app removed", {
				description: tl(
					"{name} is still installed inside Ryu with all of its data.",
					{ name: app.name }
				),
			});
		} catch (error) {
			toast.error("Couldn't remove the standalone app", {
				description:
					error instanceof Error ? error.message : "Please try again.",
			});
		}
	};

	const visibleApps = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) {
			return apps;
		}
		return apps.filter(
			(a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
		);
	}, [apps, query]);

	const selectedApp = selectedId
		? (apps.find((a) => a.id === selectedId) ?? null)
		: null;

	return {
		clearToggleError,
		error,
		handleInstall,
		handleInstallStandalone,
		handleLaunch,
		handleOpenStandalone,
		handleRemoveStandalone,
		handleSidecar,
		handleToggle,
		handleUninstall,
		installedAppIds,
		lifecycleCapabilities,
		loading,
		navigate,
		pending,
		pollSidecarStatus,
		query,
		reload,
		selectedApp,
		selectedId,
		setQuery,
		setSelectedId,
		settingsByPlugin,
		settingsOpener,
		sidecarSandbox,
		sidecarStatus,
		target,
		toggleError,
		visibleApps,
	};
}
