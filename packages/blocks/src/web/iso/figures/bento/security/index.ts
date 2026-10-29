import type { BentoDrawings } from "../card.ts";
import { drawing as diagnostics } from "./diagnostics.tsx";
import { drawing as encryptedSecrets } from "./encrypted-secrets.tsx";
import { drawing as firewallInspection } from "./firewall-inspection.tsx";
import { drawing as sandboxedPluginCode } from "./sandboxed-plugin-code.tsx";
import { drawing as separateKeys } from "./separate-keys.tsx";
import { drawing as supportAccessStartsOff } from "./support-access-starts-off.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Separate keys": separateKeys,
	"Encrypted secrets": encryptedSecrets,
	"Sandboxed plugin code": sandboxedPluginCode,
	"Support access starts off": supportAccessStartsOff,
	"Firewall inspection": firewallInspection,
	Diagnostics: diagnostics,
};
