import type { BentoDrawings } from "../card.ts";
import { drawing as auditAndAccountability } from "./audit-and-accountability.tsx";
import { drawing as rulesOnModelCalls } from "./rules-on-model-calls.tsx";
import { drawing as scopedAgentAccess } from "./scoped-agent-access.tsx";
import { drawing as selfHostCoreAndTheGateway } from "./self-host-core-and-the-gateway.tsx";
import { drawing as yourIdentityProvider } from "./your-identity-provider.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Your identity provider": yourIdentityProvider,
	"Scoped agent access": scopedAgentAccess,
	"Rules on model calls": rulesOnModelCalls,
	"Audit and accountability": auditAndAccountability,
	"Self-host Core and the Gateway": selfHostCoreAndTheGateway,
};
