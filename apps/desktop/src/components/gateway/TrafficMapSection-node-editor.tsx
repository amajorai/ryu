// Per-node detail panels for the Gateway dialog's Traffic map: the copy and
// shortcuts each canvas node shows when selected.

import type { CanvasNode } from "@ryu/blocks/desktop/gateway-canvas/model.ts";
import type { LiteralMessage } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { ReactNode } from "react";
import { GuardrailPoliciesSection } from "@/src/components/gateway/GuardrailPoliciesSection.tsx";

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

export interface EditorContext {
	canConfigure: boolean;
	onNavigate: (section: string) => void;
	renderSafetyFilters: () => ReactNode;
	tl: LiteralMessage;
}

export function nodeEditor(
	node: CanvasNode,
	context: EditorContext
): ReactNode {
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
					{context.tl(
						"Requests that arrived on {routes}. Point a client at this node from API and traffic.",
						{ routes: node.detail ?? context.tl("these routes") }
					)}
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
