// apps/desktop/src/components/settings/EmailAlertsSettings.tsx
//
// Self-host email + policy-alert delivery settings. Two cards:
//   1. SMTP transport   the node's BYO outbound relay (host/port/user/pass/from/
//                        STARTTLS) plus a Test-send button.
//   2. Alert delivery   the node-level recipients (emails + webhook URLs) that
//                        policy alerts fan out to.
//
// Both write to Core routes on the ACTIVE node, gated self-host-only: a managed
// (Ryu Cloud) node has its transport and recipients configured by the control
// plane, so the editable cards are hidden and a short note takes their place.
//
// AlertTier note: which tier fires (Silent/Warn/Fanout/Email) is decided by the
// gateway config (PUT /v1/config on the budget + firewall rules); this card owns
// only the DELIVERY targets and routes whatever tier the gateway sets.

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { AlertDeliveryCard } from "./EmailAlertsSettings-alert-delivery-card.tsx";
import { SmtpTransportCard } from "./EmailAlertsSettings-smtp-card.tsx";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export function EmailAlertsSettings() {
	// Subscribe reactively so switching to a managed node hides the cards live.
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	const nodeKey = `${node.name}:${node.url}`;
	const isManaged = Boolean(node.managed);

	if (isManaged) {
		return (
			<SettingsSection
				caption="This is a Ryu Cloud node. Its outbound email relay and alert recipients are managed for you in the cloud dashboard."
				title="Email & alerts"
			>
				<SettingsCard className="py-3">
					<p className="text-muted-foreground text-sm">
						Email transport and alert delivery are configured by Ryu Cloud for
						managed nodes.
					</p>
				</SettingsCard>
			</SettingsSection>
		);
	}

	return (
		<div>
			<SettingsSection
				caption="Your node's outbound relay for alert and test emails. Nothing sends until it is set."
				title="SMTP transport"
			>
				<div className="flex items-center gap-1.5 py-1 text-detail text-muted-foreground">
					<HugeiconsIcon icon={Mail01Icon} size={14} />
					<span>
						Credentials stay on this node and are never sent to Ryu Cloud.
					</span>
				</div>
				<SmtpTransportCard key={nodeKey} target={target} />
			</SettingsSection>

			<SettingsSection
				caption="Who receives policy alerts on this node. Gateway config sets which alerts fire."
				title="Alert delivery"
			>
				<AlertDeliveryCard key={nodeKey} target={target} />
			</SettingsSection>
		</div>
	);
}
