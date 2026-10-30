import { useLiteralMessages } from "@ryu/i18n/react";
import { useCallback, useEffect, useRef } from "react";
import { sileo } from "sileo";
import { WEB_URL } from "@/lib/app-urls.ts";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { loadOnboardingAgents } from "./OnboardingPage.agents.tsx";
import type { useOnboardingAgentsStep } from "./OnboardingPage.agents-step.ts";
import {
	ROTATE_INTERVAL_MS,
	ROTATING_SUBTITLES,
} from "./OnboardingPage.copy.ts";
import type { useOnboardingLocalProgress } from "./OnboardingPage.local-progress.ts";
import {
	adoptManagedNode,
	nodeNameForUrl,
	normalizeNodeUrl,
	probeNodeUrl,
	refreshLocalNode,
	STAGE_PREPARING,
	startLocalCore,
} from "./OnboardingPage.local-stack.ts";
import type { useOnboardingNodeSetup } from "./OnboardingPage.node-setup.ts";
import type { useOnboardingPhase } from "./OnboardingPage.phase.ts";
import type { useOnboardingFlowState } from "./OnboardingPage.state.ts";

type OnboardingNodeChoiceInput = Pick<
	ReturnType<typeof useOnboardingLocalProgress>,
	"activateOnboardingNode" | "localReport"
> &
	Pick<
		ReturnType<typeof useOnboardingAgentsStep>,
		"beginLocalSetup" | "showAgentsStep"
	> &
	Pick<
		ReturnType<typeof useOnboardingFlowState>,
		| "cancelledRef"
		| "doneStatusRef"
		| "liveStatusRef"
		| "localChecking"
		| "managedBusy"
		| "remoteChecking"
		| "setLocalChecking"
		| "setLocalError"
		| "setLocalPercent"
		| "setLocalUnreachable"
		| "setLoopLine"
		| "setManagedBusy"
		| "setMode"
		| "setRemoteChecking"
		| "setRemoteError"
	> &
	Pick<
		ReturnType<typeof useOnboardingPhase>,
		| "entitlement"
		| "hydrateCloudNodes"
		| "phase"
		| "setPhase"
		| "updateNodeToken"
	> &
	Pick<ReturnType<typeof useOnboardingNodeSetup>, "goToFeatures">;

/** The local, remote, and managed node picks, and the rotating status line. */
export function useOnboardingNodeChoice({
	activateOnboardingNode,
	beginLocalSetup,
	cancelledRef,
	doneStatusRef,
	entitlement,
	goToFeatures,
	hydrateCloudNodes,
	liveStatusRef,
	localChecking,
	localReport,
	managedBusy,
	phase,
	remoteChecking,
	setLocalChecking,
	setLocalError,
	setLocalPercent,
	setLocalUnreachable,
	setLoopLine,
	setManagedBusy,
	setMode,
	setPhase,
	setRemoteChecking,
	setRemoteError,
	showAgentsStep,
	updateNodeToken,
}: OnboardingNodeChoiceInput) {
	const tl = useLiteralMessages();
	const tlRef = useRef(tl);
	tlRef.current = tl;
	// Local pick. Three things it owns:
	//
	// 1. Bring Core up. The app no longer requires (or auto-installs) a local Core
	//    to open, so this pick is where one is installed and started —
	//    `startLocalCore` is a no-op when it is already running, which is the
	//    common case in dev and for a returning user.
	// 2. Resolve the LOCAL node explicitly instead of `getActiveNode()`, whose
	//    default may already be a cloud node — the button labelled "local" was
	//    otherwise able to run local setup against the CLOUD node.
	// 3. Confirm it answers before committing. `waitForLocalStack` swallows every
	//    error and proceeds anyway after 45s, so an unreachable node used to end
	//    with the user inside a fully broken app and onboarding marked complete.
	//    Instead fall BACK to `choose`, where the other two paths are still offered.
	//
	// The pick leaves the fork immediately for the `installing` phase. Everything
	// after the press — the 160 MB download, Core's boot, the local-stack wait — is
	// one continuous wait with one progress bar and one status line, rather than a
	// second progress surface bolted onto the choice card. The card only has to
	// render the FAILURE, which is the one outcome that returns here.
	const handleChooseLocal = useCallback(() => {
		if (localChecking) {
			return;
		}
		setMode("local");
		setLocalChecking(true);
		// Seed the bar before the first await so the phase's flat placeholder never
		// flashes ahead of the real download and then jumps backwards.
		liveStatusRef.current = "Getting Ryu ready…";
		doneStatusRef.current = [];
		setLocalPercent(STAGE_PREPARING);
		setPhase("installing");
		(async () => {
			// `startLocalCore` resolves only once `/api/health` on the local Core
			// answered, so this IS the reachability proof — no second probe, and no
			// dependency on `nodes.json` existing yet (on a fresh install the file is
			// written a few lines below, by `setDefault`).
			const started = await startLocalCore(
				() => cancelledRef.current,
				localReport,
				tlRef.current
			);
			if (cancelledRef.current) {
				return;
			}
			setLocalChecking(false);
			if (!started.ok) {
				setLocalError(started.error ?? null);
				setLocalUnreachable(true);
				setPhase("choose");
				return;
			}
			setLocalError(null);
			setLocalUnreachable(false);
			// Resolve the local node only NOW. Core has just booted, and on a first
			// run that boot is what minted `node-auth.token`; the store was hydrated
			// before it existed, so anything captured earlier is tokenless and every
			// Core call made with it 401s.
			const node = await refreshLocalNode();
			// Point the app at the node we just verified, so the rest of onboarding
			// and the app itself talk to it rather than a stale cloud default.
			await activateOnboardingNode(node);
			await beginLocalSetup().catch(() => undefined);
		})().catch(() => {
			if (!cancelledRef.current) {
				setLocalChecking(false);
				setLocalUnreachable(true);
				setPhase("choose");
			}
		});
	}, [activateOnboardingNode, beginLocalSetup, localChecking, localReport]);
	// The only in-product path to a local node: the desktop app hosts it.
	const handleDownloadDesktop = useCallback(() => {
		openExternal(`${WEB_URL}/download`).catch(() => undefined);
	}, []);
	// Open the connect form. Nothing is committed here — the address is probed on
	// submit, and only a node that answers is written to nodes.json.
	const handleChooseRemote = useCallback(() => {
		setRemoteError(null);
		setMode("remote");
		setPhase("connect");
	}, []);
	const handleBackFromConnect = useCallback(() => {
		if (remoteChecking) {
			return;
		}
		setRemoteError(null);
		setMode(null);
		setPhase("choose");
	}, [remoteChecking]);
	// Adopt a node the user already runs (their team's server, another machine on
	// the LAN or mesh). Probe first, persist second: a node that never answered
	// would otherwise sit in the picker forever. Once adopted we run the SAME
	// agent detection the local path does — a company node is a full Core with a
	// real catalog, unlike a managed node, which runs its own inference — but skip
	// `waitForLocalStack`, which polls a local install this device does not have.
	const handleConnectRemote = useCallback(
		(rawUrl: string, token: string) => {
			if (remoteChecking) {
				return;
			}
			const url = normalizeNodeUrl(rawUrl);
			if (url === "") {
				setRemoteError("Enter the node's address.");
				return;
			}
			setRemoteChecking(true);
			setRemoteError(null);
			(async () => {
				const online = await probeNodeUrl(url, token);
				if (cancelledRef.current) {
					return;
				}
				if (!online) {
					setRemoteChecking(false);
					setRemoteError(
						"Couldn't reach a Ryu node there. Check the address, the port, and that the node is running — and the token if it needs one."
					);
					return;
				}

				const state = useNodeStore.getState();
				const existing = state.nodes.find(
					(n) => n.url.replace(/\/+$/, "") === url
				);
				let name = existing?.name;
				const normalizedToken = token.trim() || null;
				if (
					existing &&
					!existing.managed &&
					normalizedToken !== existing.token
				) {
					try {
						await updateNodeToken(existing.name, normalizedToken);
					} catch (err) {
						if (cancelledRef.current) {
							return;
						}
						setRemoteChecking(false);
						setRemoteError(
							err instanceof Error
								? err.message
								: "Couldn't update this node's token. Try again."
						);
						return;
					}
				}
				if (!name) {
					name = nodeNameForUrl(
						url,
						state.nodes.map((n) => n.name)
					);
					try {
						await state.addNode(name, url, token === "" ? undefined : token);
					} catch (err) {
						if (cancelledRef.current) {
							return;
						}
						setRemoteChecking(false);
						setRemoteError(
							err instanceof Error
								? err.message
								: "Couldn't save this node. Try again."
						);
						return;
					}
				}
				if (cancelledRef.current) {
					return;
				}
				// Route the rest of onboarding — and the app — at the node we just
				// verified. A cloud-shaped node isn't in nodes.json, so the shared
				// activation helper falls back to an in-memory default when needed.
				const activeNode = await activateOnboardingNode({
					name,
					token: normalizedToken,
					url,
				});
				setRemoteChecking(false);

				const node =
					useNodeStore
						.getState()
						.nodes.find((n) => n.name === activeNode.name) ?? activeNode;
				const result = await loadOnboardingAgents(toTarget(node));
				if (cancelledRef.current) {
					return;
				}
				showAgentsStep(node, result);
			})().catch(() => {
				if (!cancelledRef.current) {
					setRemoteChecking(false);
					setRemoteError("Couldn't connect to that node. Try again.");
				}
			});
		},
		[activateOnboardingNode, remoteChecking, showAgentsStep, updateNodeToken]
	);
	// Managed (Ryu Cloud) pick. Gated on the plan entitlement: if not entitled
	// (or the plan is still resolving to not-entitled) this is an upsell that
	// deep-links to web pricing and stays on the choice screen. When entitled it
	// adopts an already-provisioned org node (never provisions from the desktop):
	// poll the control plane briefly, then set it as the active node; if none
	// exists yet, deep-link to the org servers page and continue on local so the
	// user is never stranded waiting on a server to come up.
	const handleChooseManaged = useCallback(async () => {
		if (!entitlement?.managedInference) {
			openExternal(`${WEB_URL}/pricing`).catch(() => undefined);
			return;
		}
		if (managedBusy) {
			return;
		}
		setMode("managed");
		setManagedBusy(true);
		const adopted = await adoptManagedNode(
			hydrateCloudNodes,
			() => cancelledRef.current
		);
		if (cancelledRef.current) {
			return;
		}
		setManagedBusy(false);

		if (adopted) {
			// Managed/cloud nodes live in memory only (never in nodes.json), so the
			// Rust set_default_node rejects their name. Try the persisted path for
			// parity, then fall back to an in-memory default so chat routes to the
			// adopted node this session.
			await activateOnboardingNode(adopted);
			// A managed node runs its own inference; skip local CLI-agent detection
			// and go straight to the feature wizard.
			goToFeatures([]);
			return;
		}

		// Entitled, but no node is provisioned yet. Provisioning is web + webhook
		// driven (never from the desktop), so point them at the org servers page
		// and continue on local so onboarding still completes.
		sileo.success({
			title: "Provisioning continues on the web",
			description:
				"Buy or start a Ryu Cloud computer in your browser. It appears here once it registers.",
		});
		openExternal(`${WEB_URL}/organizations`).catch(() => undefined);
		// Fall back to the local path so onboarding still completes — which now
		// means actually bringing a local Core up, since the app no longer starts
		// one at boot. Same explicit local-node resolution as the local pick;
		// `getActiveNode()` here could be the cloud node we just failed to adopt.
		setMode("local");
		// Same `localChecking` bookkeeping the direct local pick does. Without it
		// this path showed no download progress at all, and — because `coreFailed`
		// is `coreStatus === "stopped" && mode === "local" && !localChecking` —
		// flipping `mode` to "local" after App.tsx's startup grace had elapsed
		// replaced the running 160 MB download with the "Couldn't start Ryu"
		// restart screen.
		setLocalChecking(true);
		liveStatusRef.current = "Getting Ryu ready…";
		setLocalPercent(STAGE_PREPARING);
		setPhase("installing");
		startLocalCore(() => cancelledRef.current, localReport, tlRef.current)
			.then((started) => {
				setLocalChecking(false);
				if (!started.ok || cancelledRef.current) {
					setLocalError(started.error ?? null);
					setLocalUnreachable(true);
					setPhase("choose");
					return undefined;
				}
				// Re-read and activate the local node after the boot that mints its
				// token; the managed node may still be the previous default.
				return refreshLocalNode()
					.then((node) => activateOnboardingNode(node))
					.then(() => beginLocalSetup());
			})
			.catch(() => undefined);
	}, [
		entitlement,
		managedBusy,
		hydrateCloudNodes,
		activateOnboardingNode,
		goToFeatures,
		beginLocalSetup,
		localReport,
	]);
	// Cycle the header line while a long auto-advancing phase is on screen, so the
	// view never looks frozen — but alternate the flavour copy with the REAL state
	// of the work: what is downloading right now, or the last thing that finished.
	// A pure flavour loop is indistinguishable from a hang, and it was hiding two
	// entire install legs (gateway, local engine) behind "Teaching Ryu to think".
	useEffect(() => {
		const flavour = ROTATING_SUBTITLES.get(phase);
		if (!flavour) {
			setLoopLine(null);
			return;
		}
		let tick = 0;
		let flavourIndex = 0;
		const advance = () => {
			const real =
				liveStatusRef.current ?? doneStatusRef.current.at(-1) ?? null;
			// Every other tick is the real line, when there is one. The flavour index
			// advances only on flavour turns, so nothing is skipped — and on a phase
			// with no real state to report (the cloud paths) every tick is flavour and
			// the loop behaves exactly as it did before.
			if (tick % 2 === 1 && real) {
				setLoopLine(real);
			} else {
				setLoopLine(flavour[flavourIndex % flavour.length] ?? null);
				flavourIndex += 1;
			}
			tick += 1;
		};
		advance();
		const id = setInterval(advance, ROTATE_INTERVAL_MS);
		return () => clearInterval(id);
	}, [phase]);
	return {
		handleBackFromConnect,
		handleChooseLocal,
		handleChooseManaged,
		handleChooseRemote,
		handleConnectRemote,
		handleDownloadDesktop,
	};
}
