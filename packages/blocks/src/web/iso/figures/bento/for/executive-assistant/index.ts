import type { BentoDrawings } from "../../card.ts";
import { drawing as calendarManagement } from "./calendar-management.tsx";
import { drawing as followUpsAndTasks } from "./follow-ups-and-tasks.tsx";
import { drawing as inboxTriage } from "./inbox-triage.tsx";
import { drawing as meetingPrep } from "./meeting-prep.tsx";
import { drawing as travelCoordination } from "./travel-coordination.tsx";
import { drawing as writeInTheirVoice } from "./write-in-their-voice.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"Inbox triage": inboxTriage,
	"Calendar management": calendarManagement,
	"Meeting prep": meetingPrep,
	"Travel coordination": travelCoordination,
	"Follow-ups and tasks": followUpsAndTasks,
	"Write in their voice": writeInTheirVoice,
};
