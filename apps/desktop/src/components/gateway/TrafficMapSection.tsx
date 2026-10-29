// The Gateway dialog's "Traffic map" section (managed guardrails spec 07.7):
// the shared live canvas bound to this node's gateway. Topology comes from the
// gateway's config and health, pulses from Core's traffic relay, and each
// node's panel renders the same settings the dialog's own sections save
// (safety filters through `PUT /v1/config`, named policies through the
// control plane), so a change made on the map is the same change.

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
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Maximize2, Minimize2 } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { BACKEND_URL } from "@/lib/auth-client.ts";
import { GuardrailPoliciesSection } from "@/src/components/gateway/GuardrailPoliciesSection.tsx";
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

function Copy({ children }: { children: ReactNode }) {
	return (
		<p className="text-muted-foreground text-sm leading-snug">{children}</p>
	);
}

function GoTo({
	label,
	onNavigate,
	section,
}: {
	label: string;
	onNavigate: (section: string) => void;
	section: string;
}) {
	return (
		<Button
			className="w-fit"
			onClick={() => onNavigate(section)}
			size="sm"
			type="button"
			variant="secondary"
		>
			{label}
		</Button>
	);
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
			}),
		[canConfigure, onNavigate, renderSafetyFilters]
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
					className="size-7 text-muted-foreground"
					data-traffic-map-expand=""
					onClick={() => setExpanded((open) => !open)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{expanded ? (
						<Minimize2 aria-hidden="true" className="size-4" />
					) : (
						<Maximize2 aria-hidden="true" className="size-4" />
					)}
				</Button>
			}
		/>
	);

	return (
		<div className="flex flex-col gap-3">
			<p className="px-3.5 text-muted-foreground text-sm leading-snug">
				{TRAFFIC_MAP_CAPTION}
			</p>
			{canViewTraffic ? null : (
				<p className="px-3.5 text-muted-foreground text-sm leading-snug">
					Watching live requests needs permission to view the audit log on this
					node. The map still shows how requests are routed.
				</p>
			)}
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

interface EditorContext {
	canConfigure: boolean;
	onNavigate: (section: string) => void;
	renderSafetyFilters: () => ReactNode;
}

function nodeEditor(node: CanvasNode, context: EditorContext): ReactNode {
	const { onNavigate } = context;
	if (node.kind === "scope") {
		return (
			<div className="flex flex-col gap-3">
				<Copy>
					Policies assigned to the organization, a team, a member, a key or an
					agent apply to requests through your organization's gateways and keys.
					Each layer can only tighten the ones above it.
				</Copy>
				<GuardrailPoliciesSection />
			</div>
		);
	}
	switch (node.id) {
		case "stage:node":
		case "stage:inspector":
		case "stage:evaluator":
			return (
				<div className="flex flex-col gap-3">
					<Copy>
						{context.canConfigure
							? "These are this node's own safety filters. Saving here saves the same settings as the Safety filters section."
							: "These are this node's own safety filters. You can view them; changing them needs permission to configure this gateway."}
					</Copy>
					<GoTo
						label="Open Safety filters"
						onNavigate={onNavigate}
						section="guardrails"
					/>
					{context.renderSafetyFilters()}
				</div>
			);
		case "stage:platform_floor":
			return (
				<div className="flex flex-col gap-3">
					<Copy>
						Managed by Ryu. The platform floor screens requests that spend a
						Ryu-held credential, such as Ryu credits. It cannot be changed or
						turned off here.
					</Copy>
					<Copy>
						Requests that use your own provider keys or subscriptions are not
						screened by it, so on a self-hosted node it usually sees nothing.
					</Copy>
				</div>
			);
		case "stage:standing":
			return (
				<Copy>
					Ryu can warn, slow down, restrict or suspend Ryu-managed traffic for
					an account that breaks the usage policy. Requests through your own
					keys are not affected. Banning a person is always a human decision.
				</Copy>
			);
		case "stage:rate_limit":
			return (
				<div className="flex flex-col gap-3">
					<Copy>
						Requests over a key's or client's rate limit are refused before any
						other check runs.
					</Copy>
					<GoTo label="Open API keys" onNavigate={onNavigate} section="keys" />
				</div>
			);
		case "stage:budget":
			return (
				<div className="flex flex-col gap-3">
					<Copy>
						Requests past a spending cap are refused or downgraded, as the cap
						says.
					</Copy>
					<GoTo
						label="Open Spending limits"
						onNavigate={onNavigate}
						section="budgets"
					/>
				</div>
			);
		case "stage:route":
			return (
				<div className="flex flex-col gap-3">
					<Copy>
						The router picks the provider for each request and answers repeats
						from the cache.
					</Copy>
					<GoTo
						label="Open Model routing"
						onNavigate={onNavigate}
						section="routing"
					/>
				</div>
			);
		default:
			break;
	}
	if (node.kind === "provider") {
		return (
			<div className="flex flex-col gap-3">
				<Copy>
					{node.id === "provider:other"
						? "Requests served by a provider the gateway did not list at startup."
						: "Requests this provider served. Its health comes from the gateway's circuit breaker: a provider that keeps failing is paused and retried."}
				</Copy>
				<GoTo
					label="Open AI providers"
					onNavigate={onNavigate}
					section="providers"
				/>
			</div>
		);
	}
	if (node.kind === "surface") {
		return (
			<div className="flex flex-col gap-3">
				<Copy>
					Requests that arrived on {node.detail ?? "these routes"}. Point a
					client at this node from API and traffic.
				</Copy>
				<GoTo
					label="Open API and traffic"
					onNavigate={onNavigate}
					section="api"
				/>
			</div>
		);
	}
	if (node.id === "infra:control_plane") {
		return (
			<Copy>
				Your organization's named policies and account standing come from the
				Ryu control plane.
			</Copy>
		);
	}
	if (node.id === "infra:core") {
		return (
			<Copy>
				Ryu Core relays this gateway's live feed to the desktop. The feed names
				layers and codes only, never request text.
			</Copy>
		);
	}
	return (
		<Copy>
			Every request to this node passes through here before any check runs.
		</Copy>
	);
}
