import type { BentoDrawings } from "../../card.ts";
import { drawing as intakeStructuring } from "./intake-structuring.tsx";
import { drawing as patientMessages } from "./patient-messages.tsx";
import { drawing as protocolLookup } from "./protocol-lookup.tsx";
import { drawing as visitDocumentation } from "./visit-documentation.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Visit documentation": visitDocumentation,
	"Intake structuring": intakeStructuring,
	"Protocol lookup": protocolLookup,
	"Patient messages": patientMessages,
};
