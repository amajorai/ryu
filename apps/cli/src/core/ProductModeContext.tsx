/* @jsxImportSource @opentui/react */

import { appResponseValueSchema } from "@ryuhq/core-client/app-request-json";
import {
	type ApiTarget,
	request as coreRequest,
	type RequestOptions,
} from "@ryuhq/core-client/client";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useOverlay } from "../overlays/OverlayHost.tsx";
import { useToast } from "../ui/toast.tsx";
import { useWorkspace } from "../workspace/WorkspaceContext.tsx";
import { useCore } from "./CoreContext.tsx";
import { fetchManagedNodes } from "./managedNodes.ts";
import { loadNodes, type Node } from "./nodes.ts";
import {
	activateProductMode,
	isKnownUnmanagedTarget,
	type ProductMode,
	type ProductModeIssue,
	type ProductModePreference,
	readProductModePreference,
	resolveStartupProductMode,
	type StartupRealm,
	withProductMode,
	withProductModeSurface,
	withStartupRealm,
	writeProductModePreference,
} from "./productMode.ts";

interface ProductModeContextValue {
	checkConsoleAccess: () => Promise<boolean>;
	consoleAccessStatus: "unknown" | "checking" | "available" | "denied";
	consoleAccessTargetKey: string;
	effectiveMode: ProductMode;
	issue: ProductModeIssue | null;
	modePreference: ProductModePreference;
	modeStatus: "checking" | "ready" | "switching" | "needs-attention";
	retry: () => Promise<boolean>;
	selectMode: (mode: ProductMode) => Promise<boolean>;
	setManagedNode: (node: Node | null) => void;
	setStartupRealm: (startupRealm: StartupRealm) => void;
	startupRealmSaveError: string | null;
}

const ProductModeContext = createContext<ProductModeContextValue | null>(null);

function targetKey(target: ApiTarget): string {
	return `${target.url.replace(/\/$/, "")}\u0000${target.token ?? ""}\u0000${target.userJwt ?? ""}`;
}

export function ProductModeProvider({ children }: { children: ReactNode }) {
	const { target, setTarget } = useCore();
	const { openTab, panes, focusedPaneId, splitActive, tabs } = useWorkspace();
	const activePane = panes.find((pane) => pane.id === focusedPaneId);
	const activePath = tabs.find(
		(tab) => tab.id === activePane?.activeTabId
	)?.path;
	const activePathRef = useRef(activePath);
	activePathRef.current = activePath;
	const { openOverlay } = useOverlay();
	const { notify } = useToast();
	const [authSourceTarget] = useState(target);
	const [modePreference, setModePreference] = useState(
		readProductModePreference
	);
	const [startupRealmSaveError, setStartupRealmSaveError] = useState<
		string | null
	>(null);
	const latestModePreference = useRef(modePreference);
	latestModePreference.current = modePreference;
	const initialTargetKey = targetKey(target);
	const [consoleAccess, setConsoleAccess] = useState<{
		status: ProductModeContextValue["consoleAccessStatus"];
		targetKey: string;
	}>(() => ({
		status: isKnownUnmanagedTarget(
			target,
			loadNodes().nodes.map((node) => node.url)
		)
			? "available"
			: "unknown",
		targetKey: initialTargetKey,
	}));
	const startupMode = resolveStartupProductMode(modePreference);
	const [initialConsoleUnmanaged] = useState(
		() =>
			startupMode === "console" &&
			isKnownUnmanagedTarget(
				target,
				loadNodes().nodes.map((node) => node.url)
			)
	);
	const [effectiveMode, setEffectiveMode] = useState<ProductMode>(
		startupMode === "console" && !initialConsoleUnmanaged ? "bot" : startupMode
	);
	const [modeStatus, setModeStatus] = useState<
		ProductModeContextValue["modeStatus"]
	>(initialConsoleUnmanaged ? "ready" : "checking");
	const [issue, setIssue] = useState<ProductModeIssue | null>(null);
	const [managedNode, setManagedNode] = useState<Node | null>(null);
	const latestTarget = useRef(target);
	latestTarget.current = target;
	const latestManagedNode = useRef(managedNode);
	latestManagedNode.current = managedNode;
	const requestSequence = useRef(0);
	const requestController = useRef<AbortController | null>(null);
	const consoleAccessController = useRef<AbortController | null>(null);
	const consoleAccessSequence = useRef(0);
	const consoleAccessRequest = useRef<{
		controller: AbortController;
		promise: Promise<boolean>;
		targetKey: string;
	} | null>(null);
	const bootstrapped = useRef(false);
	const lastAttemptedMode = useRef(startupMode);
	const lastVerifiedTarget = useRef("");
	const programmaticTarget = useRef("");
	useEffect(
		() => () => {
			requestController.current?.abort();
			consoleAccessController.current?.abort();
			requestSequence.current += 1;
			consoleAccessSequence.current += 1;
			bootstrapped.current = false;
		},
		[]
	);

	const knownUnmanagedTarget = useCallback((candidate: ApiTarget) => {
		const configuredUrls = loadNodes().nodes.map((node) => node.url);
		return (
			isKnownUnmanagedTarget(candidate, configuredUrls) &&
			!latestManagedNode.current?.managed
		);
	}, []);

	const checkConsoleAccess = useCallback((): Promise<boolean> => {
		const activeTarget = latestTarget.current;
		const activeTargetKey = targetKey(activeTarget);
		if (knownUnmanagedTarget(activeTarget)) {
			consoleAccessController.current?.abort();
			consoleAccessRequest.current = null;
			setConsoleAccess({ status: "available", targetKey: activeTargetKey });
			return Promise.resolve(true);
		}

		const existingRequest = consoleAccessRequest.current;
		if (existingRequest?.targetKey === activeTargetKey) {
			return existingRequest.promise;
		}
		existingRequest?.controller.abort();
		const controller = new AbortController();
		consoleAccessController.current = controller;
		const sequence = ++consoleAccessSequence.current;
		setConsoleAccess({ status: "checking", targetKey: activeTargetKey });
		const request = (
			requestTarget: ApiTarget,
			path: string,
			options?: RequestOptions
		) =>
			coreRequest(
				requestTarget,
				path,
				{
					...options,
					signal: controller.signal,
				},
				appResponseValueSchema
			);
		const fetchNodes = (requestTarget: ApiTarget) =>
			fetchManagedNodes(requestTarget, controller.signal);
		const pendingRequest = {
			controller,
			promise: Promise.resolve(false),
			targetKey: activeTargetKey,
		};
		const promise = activateProductMode("console", {
			activeTarget,
			authSourceTarget,
			knownUnmanagedTarget: false,
			preference: latestModePreference.current,
			request,
			fetchManagedNodes: fetchNodes,
		})
			.then((result) => {
				if (
					sequence === consoleAccessSequence.current &&
					!controller.signal.aborted &&
					targetKey(latestTarget.current) === activeTargetKey
				) {
					setConsoleAccess({
						status: result.ok ? "available" : "denied",
						targetKey: activeTargetKey,
					});
				}
				return result.ok;
			})
			.catch(() => {
				if (
					sequence === consoleAccessSequence.current &&
					!controller.signal.aborted &&
					targetKey(latestTarget.current) === activeTargetKey
				) {
					setConsoleAccess({
						status: "denied",
						targetKey: activeTargetKey,
					});
				}
				return false;
			})
			.finally(() => {
				if (consoleAccessRequest.current === pendingRequest) {
					consoleAccessRequest.current = null;
				}
			});
		pendingRequest.promise = promise;
		consoleAccessRequest.current = pendingRequest;
		return promise;
	}, [authSourceTarget, knownUnmanagedTarget]);

	useEffect(() => {
		const activeTargetKey = targetKey(target);
		const accessRequest = consoleAccessRequest.current;
		if (accessRequest?.targetKey !== activeTargetKey) {
			accessRequest?.controller.abort();
			consoleAccessController.current = null;
			consoleAccessRequest.current = null;
			consoleAccessSequence.current += 1;
		}
		setConsoleAccess({
			status: knownUnmanagedTarget(target) ? "available" : "unknown",
			targetKey: activeTargetKey,
		});
	}, [knownUnmanagedTarget, target]);

	const applyMode = useCallback(
		async (
			mode: ProductMode,
			{ persistMode, startup }: { persistMode: boolean; startup: boolean }
		): Promise<boolean> => {
			requestController.current?.abort();
			const controller = new AbortController();
			requestController.current = controller;
			const sequence = ++requestSequence.current;
			lastAttemptedMode.current = mode;
			const knownUnmanaged = knownUnmanagedTarget(latestTarget.current);
			const safeConsoleStartup =
				startup && mode === "console" && knownUnmanaged;
			setModeStatus(
				safeConsoleStartup ? "ready" : startup ? "checking" : "switching"
			);
			setIssue(null);
			if (mode === "console") {
				setConsoleAccess({
					status: "checking",
					targetKey: targetKey(latestTarget.current),
				});
			}
			const request = (
				requestTarget: ApiTarget,
				path: string,
				options?: RequestOptions
			) =>
				coreRequest(
					requestTarget,
					path,
					{
						...options,
						signal: controller.signal,
					},
					appResponseValueSchema
				);
			const fetchNodes = (requestTarget: ApiTarget) =>
				fetchManagedNodes(requestTarget, controller.signal);
			const result = await activateProductMode(mode, {
				activeTarget: latestTarget.current,
				authSourceTarget,
				knownUnmanagedTarget: knownUnmanaged,
				preference: modePreference,
				request,
				fetchManagedNodes: fetchNodes,
			});
			if (sequence !== requestSequence.current) {
				return false;
			}
			if (mode === "console") {
				setConsoleAccess({
					status: result.ok ? "available" : "denied",
					targetKey: targetKey(latestTarget.current),
				});
			}
			if (!result.ok) {
				setIssue(result.issue);
				setModeStatus(startup ? "needs-attention" : "ready");
				if (startup && mode === "console") {
					// Console is fail-closed for an unverified managed node. Bot is the
					// safe fallback surface while its own plan gate is checked.
					setEffectiveMode("bot");
					const fallback = await activateProductMode("bot", {
						activeTarget: latestTarget.current,
						authSourceTarget,
						knownUnmanagedTarget: knownUnmanaged,
						preference: modePreference,
						request,
						fetchManagedNodes: fetchNodes,
					});
					if (fallback.ok && sequence === requestSequence.current) {
						if (fallback.target !== latestTarget.current) {
							programmaticTarget.current = targetKey(fallback.target);
						}
						setTarget(fallback.target);
						setManagedNode(
							fallback.target.userJwt
								? {
										name: "managed",
										url: fallback.target.url,
										token: fallback.target.token,
										userJwt: fallback.target.userJwt,
										managed: true,
									}
								: null
						);
						setIssue(result.issue);
						setModeStatus("needs-attention");
						if (activePathRef.current !== fallback.surface) {
							openTab(fallback.surface);
						}
					} else if (!fallback.ok) {
						setIssue(fallback.issue);
					}
				}
				if (startup) {
					openOverlay("product-mode");
				}
				return false;
			}

			if (result.target !== latestTarget.current) {
				programmaticTarget.current = targetKey(result.target);
				setTarget(result.target);
			}
			setManagedNode(
				result.target.userJwt
					? {
							name: result.target.url,
							url: result.target.url,
							token: result.target.token,
							userJwt: result.target.userJwt,
							managed: true,
						}
					: null
			);
			setEffectiveMode(mode);
			setIssue(result.notice ?? null);
			setModeStatus("ready");
			if (mode === "bot" && result.notice) {
				notify(result.notice.message, "warning");
			}
			if (mode === "bot" && panes.length > 1) {
				splitActive();
			}
			if (activePathRef.current !== result.surface) {
				openTab(result.surface);
			}
			if (persistMode) {
				const next = withProductMode(modePreference, mode, result.surface);
				setModePreference(writeProductModePreference(next));
			}
			return true;
		},
		[
			authSourceTarget,
			knownUnmanagedTarget,
			modePreference,
			notify,
			openOverlay,
			openTab,
			panes.length,
			splitActive,
			setTarget,
		]
	);

	useEffect(() => {
		if (bootstrapped.current) {
			return;
		}
		bootstrapped.current = true;
		lastVerifiedTarget.current = targetKey(target);
		void applyMode(startupMode, { persistMode: false, startup: true });
	}, [applyMode, startupMode, target]);

	useEffect(() => {
		const nextTargetKey = targetKey(target);
		if (!bootstrapped.current || nextTargetKey === lastVerifiedTarget.current) {
			return;
		}
		lastVerifiedTarget.current = nextTargetKey;
		if (programmaticTarget.current === nextTargetKey) {
			programmaticTarget.current = "";
			return;
		}
		if (
			effectiveMode !== "console" &&
			lastAttemptedMode.current !== "console"
		) {
			return;
		}
		requestController.current?.abort();
		const controller = new AbortController();
		requestController.current = controller;
		const sequence = ++requestSequence.current;
		// Remove the Console surface immediately while authority is checked for
		// the newly selected node; a stale admin result must never leave its page
		// visible on a node where this account is only a member.
		setEffectiveMode("bot");
		setModeStatus("checking");
		setConsoleAccess({ status: "checking", targetKey: nextTargetKey });
		if (activePathRef.current !== modePreference.surfaces.bot) {
			openTab(modePreference.surfaces.bot);
		}
		void activateProductMode("console", {
			activeTarget: target,
			authSourceTarget,
			knownUnmanagedTarget: knownUnmanagedTarget(target),
			preference: modePreference,
			request: (
				requestTarget: ApiTarget,
				path: string,
				options?: RequestOptions
			) =>
				coreRequest(
					requestTarget,
					path,
					{
						...options,
						signal: controller.signal,
					},
					appResponseValueSchema
				),
			fetchManagedNodes: (requestTarget) =>
				fetchManagedNodes(requestTarget, controller.signal),
		}).then((result) => {
			if (sequence !== requestSequence.current) {
				return;
			}
			setConsoleAccess({
				status: result.ok ? "available" : "denied",
				targetKey: nextTargetKey,
			});
			if (!result.ok) {
				// A node can change from local/unmanaged to managed after the TUI
				// starts. Never leave Console surfaces visible while its role check
				// is unresolved or denied.
				setEffectiveMode("bot");
				setIssue(result.issue);
				setModeStatus("needs-attention");
				if (panes.length > 1) {
					splitActive();
				}
				openTab(modePreference.surfaces.bot);
				openOverlay("product-mode");
				return;
			}
			const wasBot = effectiveMode === "bot";
			setEffectiveMode("console");
			setIssue(null);
			setModeStatus("ready");
			if (wasBot && activePathRef.current !== result.surface) {
				openTab(result.surface);
			}
		});
	}, [
		activateProductMode,
		authSourceTarget,
		effectiveMode,
		knownUnmanagedTarget,
		modePreference,
		openOverlay,
		openTab,
		panes.length,
		splitActive,
		target,
	]);

	useEffect(() => {
		if (modeStatus !== "ready" || !activePath) {
			return;
		}
		if (modePreference.surfaces[effectiveMode] === activePath) {
			return;
		}
		const next = withProductModeSurface(
			modePreference,
			effectiveMode,
			activePath
		);
		setModePreference(writeProductModePreference(next));
	}, [activePath, effectiveMode, modePreference, modeStatus]);

	const selectMode = useCallback(
		(mode: ProductMode) =>
			applyMode(mode, { persistMode: true, startup: false }),
		[applyMode]
	);
	const setStartupRealm = useCallback((startupRealm: StartupRealm) => {
		try {
			const saved = writeProductModePreference(
				withStartupRealm(latestModePreference.current, startupRealm)
			);
			latestModePreference.current = saved;
			setModePreference(saved);
			setStartupRealmSaveError(null);
		} catch {
			setStartupRealmSaveError(
				"Could not save startup realm. Check the CLI configuration directory and select the realm again."
			);
		}
	}, []);
	const retry = useCallback(
		() =>
			applyMode(lastAttemptedMode.current, {
				persistMode: true,
				startup: false,
			}),
		[applyMode]
	);
	const value = useMemo<ProductModeContextValue>(
		() => ({
			checkConsoleAccess,
			consoleAccessStatus:
				consoleAccess.targetKey === targetKey(target)
					? consoleAccess.status
					: "unknown",
			consoleAccessTargetKey: targetKey(target),
			effectiveMode,
			issue,
			modePreference,
			modeStatus,
			retry,
			selectMode,
			setStartupRealm,
			startupRealmSaveError,
			setManagedNode,
		}),
		[
			checkConsoleAccess,
			consoleAccess,
			effectiveMode,
			issue,
			modePreference,
			modeStatus,
			retry,
			selectMode,
			setStartupRealm,
			startupRealmSaveError,
			target,
		]
	);
	return (
		<ProductModeContext.Provider value={value}>
			{children}
		</ProductModeContext.Provider>
	);
}

export function useCliProductMode(): ProductModeContextValue {
	const context = useContext(ProductModeContext);
	if (!context) {
		throw new Error(
			"useCliProductMode must be used within ProductModeProvider"
		);
	}
	return context;
}
