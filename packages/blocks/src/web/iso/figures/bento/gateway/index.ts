import type { BentoDrawings } from "../card.ts";
import { drawing as budgetsAndCost } from "./budgets-and-cost.tsx";
import { drawing as evalsAndAudit } from "./evals-and-audit.tsx";
import { drawing as keyVault } from "./key-vault.tsx";
import { drawing as routingWithFallback } from "./routing-with-fallback.tsx";
import { drawing as securityFirewall } from "./security-firewall.tsx";
import { drawing as sensitiveData } from "./sensitive-data.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Security firewall": securityFirewall,
	"Sensitive data": sensitiveData,
	"Routing with fallback": routingWithFallback,
	"Budgets and cost": budgetsAndCost,
	"Evals and audit": evalsAndAudit,
	"Key vault": keyVault,
};
