// The Gateway dialog's "Guardrail policies" section: the organization's named
// policies and their assignments (managed guardrails spec 06.7), rendered by
// the shared workspace in `@ryu/blocks/desktop/guardrails` and bound here to
// the control plane with the desktop session bearer.
//
// Named policies belong to the organization, not to this node. The node's
// own firewall baseline stays under "Safety filters" and remains the bottom
// layer on this machine.

import type { PolicyScopeOptions } from "@ryu/blocks/desktop/guardrails/policy-model.ts";
import { PolicyWorkspace } from "@ryu/blocks/desktop/guardrails/policy-workspace.tsx";
import {
	SettingsCard,
	SettingsSection,
} from "@ryu/blocks/desktop/settings-items.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { BACKEND_URL } from "@/lib/auth-client.ts";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
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

type Access = "loading" | "allowed" | "denied" | "error";

const SESSION = { baseUrl: BACKEND_URL, token: getOrgSessionToken };

function emptyOptions(orgId: string): PolicyScopeOptions {
	return {
		agent: [],
		key: [],
		member: [],
		org: [{ id: orgId, label: "This organization" }],
		team: [],
	};
}

const SECTION_CAPTION =
	"Write a policy once and assign it to the organization, a team, a member, a key or an agent. Policies apply to requests through your organization's gateways and keys. This node's own baseline stays under Safety filters.";

export function GuardrailPoliciesSection() {
	const signedIn = hasOrgAuth();
	const orgId = useActiveOrgId();

	if (!signedIn) {
		return (
			<SettingsSection caption={SECTION_CAPTION} title="Guardrail policies">
				<SettingsCard className="text-muted-foreground text-sm">
					Sign in to manage your organization's guardrail policies.
				</SettingsCard>
			</SettingsSection>
		);
	}
	if (!orgId) {
		return (
			<SettingsSection caption={SECTION_CAPTION} title="Guardrail policies">
				<SettingsCard className="text-muted-foreground text-sm">
					Choose an organization to manage its guardrail policies.
				</SettingsCard>
			</SettingsSection>
		);
	}
	return <OrgGuardrailPolicies key={orgId} orgId={orgId} />;
}

function OrgGuardrailPolicies({ orgId }: { orgId: string }) {
	const [access, setAccess] = useState<Access>("loading");
	const [scopeOptions, setScopeOptions] = useState<PolicyScopeOptions>(() =>
		emptyOptions(orgId)
	);
	const stepUp = useStepUp();

	useEffect(() => {
		let cancelled = false;
		fetchMyPermissions(orgId)
			.then((permissions) => {
				if (!cancelled) {
					setAccess(
						permissions.includes("gateway.configure") ? "allowed" : "denied"
					);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setAccess("error");
				}
			});
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
	}, [orgId]);

	const client = useMemo(
		() => desktopPolicyWorkspaceClient(SESSION, orgId),
		[orgId]
	);
	const { guard } = stepUp;
	const runWrite = useCallback(
		<T,>(action: () => Promise<T>) =>
			runGuardrailWrite<T>((scope, run) => guard(scope, run), action),
		[guard]
	);

	let body: ReactNode;
	if (access === "loading") {
		body = <SkeletonRows rows={3} />;
	} else if (access === "denied") {
		body = (
			<SettingsCard className="text-muted-foreground text-sm">
				Managing guardrail policies needs permission to configure the gateway in
				this organization. Ask an organization admin.
			</SettingsCard>
		);
	} else if (access === "error") {
		body = (
			<SettingsCard className="text-muted-foreground text-sm">
				Could not check your permissions in this organization. Close and reopen
				settings to retry.
			</SettingsCard>
		);
	} else {
		body = (
			<PolicyWorkspace
				canEdit
				client={client}
				orgKey={orgId}
				runWrite={runWrite}
				scopeOptions={scopeOptions}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<p className="px-3.5 text-muted-foreground text-sm leading-snug">
				{SECTION_CAPTION}
			</p>
			{body}
			{stepUp.dialog}
		</div>
	);
}
