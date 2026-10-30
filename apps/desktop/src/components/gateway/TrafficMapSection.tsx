// The Gateway dialog's "Traffic map" section (managed guardrails spec 07.7):
// the shared live canvas bound to this node's gateway. Topology comes from the
// gateway's config and health, pulses from Core's traffic relay, and each
// node's panel renders the same settings the dialog's own sections save
// (safety filters through `PUT /v1/config`, named policies through the
// control plane), so a change made on the map is the same change.

import {
	ArrowExpand02Icon,
	ArrowShrink02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { GatewayCanvas } from "@ryu/blocks/desktop/gateway-canvas/gateway-canvas.tsx";
import {
	type CanvasAssignment,
	type CanvasFeedState,
	type CanvasNode,
	type GatewayCanvasAdapter,
	indexTopology,
	type TrafficPulse,
} from "@ryu/blocks/desktop/gateway-canvas/model.ts";
import { policyCanvasAssignment } from "@ryu/blocks/desktop/gateway-canvas/policy-assignment.ts";
import type {
	PolicyScopeOptions,
	PolicyView,
} from "@ryu/blocks/desktop/guardrails/policy-model.ts";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BACKEND_URL } from "@/lib/auth-client.ts";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import { nodeEditor } from "@/src/components/gateway/TrafficMapSection-node-editor.tsx";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	fetchGatewayConfig,
	type GatewayStatus,
	subscribeGatewayTraffic,
} from "@/src/lib/api/gateway.ts";
import {
	desktopPolicyWorkspaceClient,
	loadPolicyScopeOptions,
	runGuardrailWrite,
} from "@/src/lib/api/guardrail-policies.ts";
import { fetchMyPermissions } from "@/src/lib/api/org.ts";
import {
	getOrgSessionToken,
	hasOrgAuth,
	useActiveOrgId,
} from "@/src/lib/api/orgs.ts";
import {
	buildLocalTopology,
	followGatewayTraffic,
} from "@/src/lib/gateway-traffic-map.ts";

const SESSION = { baseUrl: BACKEND_URL, token: getOrgSessionToken };

export const TRAFFIC_MAP_CAPTION =
	"Requests to this gateway as they happen: where each came from, which layer allowed or refused it, and which provider served it. Select any part of the map for its numbers and settings.";

interface TrafficMapSectionProps {
	canConfigure: boolean;
	canViewTraffic: boolean;
	/** Switch the dialog to another section. */
	onNavigate: (section: string) => void;
	reachable: boolean;
	/** The dialog's own Safety filters editor, for the node filter stages. */
	renderSafetyFilters: () => ReactNode;
	status: GatewayStatus | null;
	target: ApiTarget;
}

function emptyScopeOptions(orgId: string): PolicyScopeOptions {
	return {
		agent: [],
		key: [],
		member: [],
		org: [{ id: orgId, label: "This organization" }],
		team: [],
	};
}

interface OrgPolicies {
	/** Drag-to-assign, when the viewer may configure the organization. */
	assignment: CanvasAssignment | undefined;
	/** Policies assigned per scope kind, for the policy layer details. */
	counts: Partial<Record<string, number>>;
	stepUpDialog: ReactNode;
}

/**
 * The signed-in organization's named policies: assignment counts for the
 * layer details and, for editors, the drag-to-assign binding that writes
 * through the same client and step-up prompt as Guardrail policies.
 */
function useOrgPolicies(): OrgPolicies {
	const signedIn = hasOrgAuth();
	const orgId = useActiveOrgId();
	const [policies, setPolicies] = useState<PolicyView[]>([]);
	const [canAssign, setCanAssign] = useState(false);
	const [scopeOptions, setScopeOptions] = useState<PolicyScopeOptions | null>(
		null
	);
	const [reloadKey, setReloadKey] = useState(0);
	const stepUp = useStepUp();

	const baseClient = useMemo(
		() => (orgId ? desktopPolicyWorkspaceClient(SESSION, orgId) : null),
		[orgId]
	);

	// `reloadKey` is a reload trigger, not a value read here.
	useEffect(() => {
		if (!(signedIn && orgId && baseClient)) {
			setPolicies([]);
			return;
		}
		let cancelled = false;
		baseClient
			.list()
			.then((next) => {
				if (!cancelled) {
					setPolicies(next);
				}
			})
			// A viewer without gateway.configure cannot list policies; the map
			// still shows every layer, just without counts.
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [baseClient, orgId, reloadKey, signedIn]);

	useEffect(() => {
		if (!(signedIn && orgId)) {
			setCanAssign(false);
			setScopeOptions(null);
			return;
		}
		let cancelled = false;
		setScopeOptions(emptyScopeOptions(orgId));
		fetchMyPermissions(orgId)
			.then((permissions) => {
				if (!cancelled) {
					setCanAssign(permissions.includes("gateway.configure"));
				}
			})
			.catch(() => undefined);
		loadPolicyScopeOptions(SESSION, orgId)
			.then((next) => {
				if (!cancelled) {
					setScopeOptions(next);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [orgId, signedIn]);

	const counts = useMemo(() => {
		const next: Partial<Record<string, number>> = {};
		for (const policy of policies) {
			for (const assignment of policy.assignments) {
				const kind = assignment.scope.kind;
				next[kind] = (next[kind] ?? 0) + 1;
			}
		}
		return next;
	}, [policies]);

	const { guard } = stepUp;
	const runWrite = useCallback(
		<T,>(action: () => Promise<T>) =>
			runGuardrailWrite<T>((scope, run) => guard(scope, run), action),
		[guard]
	);
	const assignment = useMemo(() => {
		if (!(canAssign && baseClient && scopeOptions && policies.length > 0)) {
			return;
		}
		return policyCanvasAssignment({
			client: {
				assign: async (input) => {
					const result = await baseClient.assign(input);
					setReloadKey((key) => key + 1);
					return result;
				},
			},
			policies,
			runWrite,
			scopeOptions,
		});
	}, [baseClient, canAssign, policies, runWrite, scopeOptions]);

	return { assignment, counts, stepUpDialog: stepUp.dialog };
}

export function TrafficMapSection({
	canConfigure,
	canViewTraffic,
	onNavigate,
	reachable,
	renderSafetyFilters,
	status,
	target,
}: TrafficMapSectionProps) {
	const [pipelineStages, setPipelineStages] = useState<string[] | undefined>();
	const [expanded, setExpanded] = useState(false);
	const inlineMapRef = useRef<HTMLDivElement>(null);
	const orgPolicies = useOrgPolicies();
	const assignedPolicies = orgPolicies.counts;
	const signedIn = hasOrgAuth();
	const tl = useLiteralMessages();

	useEffect(() => {
		if (!reachable) {
			return;
		}
		const controller = new AbortController();
		fetchGatewayConfig(target, controller.signal)
			.then((config) => setPipelineStages(config.pipeline_stages))
			// An older gateway or a failed read keeps the default stage set.
			.catch(() => undefined);
		return () => controller.abort();
	}, [reachable, target]);

	const health = status?.health ?? null;
	const providerHealth = status?.metrics?.providerHealth;
	const topology = useMemo(
		() =>
			buildLocalTopology({
				assignedPolicies,
				gatewayReachable: reachable,
				pipelineStages,
				providerHealth,
				providers: health?.providers ?? [],
				signedIn,
			}),
		[
			assignedPolicies,
			health?.providers,
			pipelineStages,
			providerHealth,
			reachable,
			signedIn,
		]
	);
	const indexRef = useRef(indexTopology(topology));
	useEffect(() => {
		indexRef.current = indexTopology(topology);
	}, [topology]);

	const feedEnabled = reachable && canViewTraffic;
	const [feed, setFeed] = useState<CanvasFeedState>({ status: "off" });
	useEffect(() => {
		if (!reachable) {
			setFeed({ message: "Gateway unreachable", status: "unavailable" });
		} else if (!canViewTraffic) {
			setFeed({ status: "denied" });
		}
	}, [canViewTraffic, reachable]);

	const subscribe = useCallback(
		(onPulse: (pulse: TrafficPulse) => void) => {
			if (!feedEnabled) {
				return () => undefined;
			}
			return followGatewayTraffic(
				(onEvent, onError, onEnd, onOpen) =>
					subscribeGatewayTraffic(target, onEvent, onError, onEnd, onOpen),
				() => indexRef.current,
				onPulse,
				setFeed
			);
		},
		[feedEnabled, target]
	);

	const renderEditor = useCallback(
		(node: CanvasNode): ReactNode =>
			nodeEditor(node, {
				canConfigure,
				onNavigate,
				renderSafetyFilters,
				tl,
			}),
		[canConfigure, onNavigate, renderSafetyFilters, tl]
	);

	const adapter = useMemo<GatewayCanvasAdapter>(
		() => ({
			assignment: orgPolicies.assignment,
			canEdit: canConfigure,
			renderEditor,
			subscribe,
			topology,
		}),
		[canConfigure, orgPolicies.assignment, renderEditor, subscribe, topology]
	);

	const canvas = (
		<GatewayCanvas
			adapter={adapter}
			feed={feed}
			label="Live map of this gateway's traffic"
			toolbar={
				<Button
					aria-label={expanded ? "Shrink map" : "Expand map"}
					className="text-muted-foreground"
					data-traffic-map-expand=""
					onClick={() => setExpanded((open) => !open)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{expanded ? (
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={ArrowShrink02Icon}
						/>
					) : (
						<HugeiconsIcon
							aria-hidden="true"
							className="size-4"
							icon={ArrowExpand02Icon}
						/>
					)}
				</Button>
			}
		/>
	);

	return (
		<div className="flex flex-col gap-3">
			<p className="text-detail text-muted-foreground">
				<CaptionInfo detail={TRAFFIC_MAP_CAPTION}>
					{canViewTraffic
						? "Select any part of the map for its numbers and settings."
						: "Live requests need audit-log access; routing still shows."}
				</CaptionInfo>
			</p>
			<div
				className="h-[min(620px,calc(85vh-180px))] min-h-[360px] overflow-hidden rounded-xl border border-border bg-muted/20"
				data-traffic-map=""
				ref={inlineMapRef}
			>
				{expanded ? (
					<div className="flex size-full items-center justify-center text-muted-foreground text-sm">
						The map is open in a larger view.
					</div>
				) : (
					canvas
				)}
			</div>
			<Dialog onOpenChange={setExpanded} open={expanded}>
				<DialogContent
					className="!w-[96vw] !max-w-none flex h-[92vh] flex-col gap-2 overflow-hidden p-3"
					// The button that opened this view unmounted with the inline map;
					// return focus to its remounted copy, not to the settings dialog.
					finalFocus={() =>
						inlineMapRef.current?.querySelector<HTMLElement>(
							"[data-traffic-map-expand]"
						) ?? true
					}
					showCloseButton={false}
				>
					<DialogTitle className="sr-only">Traffic map</DialogTitle>
					<DialogDescription className="sr-only">
						{TRAFFIC_MAP_CAPTION}
					</DialogDescription>
					<div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/20">
						{expanded ? canvas : null}
					</div>
				</DialogContent>
			</Dialog>
			{orgPolicies.stepUpDialog}
		</div>
	);
}
