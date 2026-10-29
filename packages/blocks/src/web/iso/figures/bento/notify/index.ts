import type { BentoDrawings } from "../card.ts";
import { drawing as actionLinks } from "./action-links.tsx";
import { drawing as liveActivities } from "./live-activities.tsx";
import { drawing as muteAndSilence } from "./mute-and-silence.tsx";
import { drawing as structuredEvents } from "./structured-events.tsx";
import { drawing as survivesRestarts } from "./survives-restarts.tsx";
import { drawing as webhookDelivery } from "./webhook-delivery.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Survives restarts": survivesRestarts,
	"Live activities": liveActivities,
	"Mute and silence": muteAndSilence,
	"Structured events": structuredEvents,
	"Webhook delivery": webhookDelivery,
	"Action links": actionLinks,
};
