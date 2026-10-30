import { localDayKey } from "@ryuhq/protocol/interfaces";
import {
	boardDate,
	boardTime,
	flightDuration,
} from "./departures-model-format.ts";
import type { Flight, FlightLamp } from "./departures-model-types.ts";

// ---------------------------------------------------------------------------
// Flight details timeline
// ---------------------------------------------------------------------------

export type TimelineState = "current" | "done" | "next";

export interface TimelineStep {
	/** A second line: what the step means, or how long it has lasted. */
	detail: string | null;
	key: string;
	label: string;
	state: TimelineState;
	/** The clock time of the step, with the day when it is not today. */
	time: string | null;
	/** Which lamp colour the step's marker takes. */
	tone: FlightLamp;
}

/** "12:55", or "Mon 5 Oct 12:55" off today. */
export function stampFor(time: number, now: number): string {
	return localDayKey(new Date(time)) === localDayKey(new Date(now))
		? boardTime(time)
		: `${boardDate(time)} ${boardTime(time)}`;
}

/** A finished routine run: when it left, and how it came back. */
function routineRunTimeline(flight: Flight, now: number): TimelineStep[] {
	const steps: TimelineStep[] = [
		{
			detail: flight.schedule,
			key: "departed",
			label: "Departed",
			state: "done",
			time:
				flight.departedAt === null ? null : stampFor(flight.departedAt, now),
			tone: "off",
		},
	];
	if (flight.status === "delayed") {
		steps.push(
			{
				detail: "The run did not finish",
				key: "delayed",
				label: "Delayed",
				state: "current",
				time: stampFor(flight.time, now),
				tone: "alert",
			},
			{
				detail: "Write to the gate to run it again now",
				key: "retry",
				label: "Rebook",
				state: "next",
				time: null,
				tone: "idle",
			}
		);
		return steps;
	}
	steps.push({
		detail: flight.remark || null,
		key: "arrived",
		label: "Arrived",
		state: "done",
		time: stampFor(flight.time, now),
		tone: "off",
	});
	return steps;
}

/**
 * The trip so far, oldest first. Only steps the snapshot can back are timed:
 * a thread carries one timestamp (its last update), so earlier steps are
 * named without a time rather than given an invented one.
 */
export function flightTimeline(flight: Flight, now: number): TimelineStep[] {
	if (flight.eventId !== null && flight.status !== "scheduled") {
		return routineRunTimeline(flight, now);
	}
	const at = stampFor(flight.time, now);
	const elapsed = flightDuration(now - flight.time);
	const gate = flight.gateLabel || null;
	switch (flight.status) {
		case "scheduled":
			return [
				{
					detail: flight.schedule ?? "Runs once",
					key: "scheduled",
					label: "Scheduled",
					state: "done",
					time: null,
					tone: "off",
				},
				{
					detail: "The conversation opens when the run starts",
					key: "departs",
					label: "Departs",
					state: "next",
					time: at,
					tone: "idle",
				},
			];
		case "boarding":
			return [
				{
					detail: "Your message",
					key: "boarded",
					label: "Boarded",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: gate
						? `Waiting for ${gate} · ${elapsed}`
						: "No gate assigned",
					key: "departure",
					label: "Departure",
					state: "current",
					time: null,
					tone: "hold",
				},
			];
		case "in-flight":
			return [
				{
					detail: gate ? `${gate} started the run` : "The run started",
					key: "departed",
					label: "Departed",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: elapsed,
					key: "airborne",
					label: "Airborne",
					state: "current",
					time: null,
					tone: "go",
				},
				{
					detail:
						flight.etaAt === null
							? "No finished runs to estimate from yet"
							: "Estimated from recent runs",
					key: "eta",
					label:
						flight.etaAt !== null && flight.etaAt < now ? "Overdue" : "ETA",
					state: "next",
					time:
						flight.etaAt === null ? null : `${boardTime(flight.etaAt)} est.`,
					tone: "idle",
				},
			];
		case "delayed":
			return [
				{
					detail: flight.remark || "The last run did not finish",
					key: "delayed",
					label: "Delayed",
					state: "current",
					time: at,
					tone: "alert",
				},
				{
					detail: "Reply in the conversation to try again",
					key: "retry",
					label: "Rebook",
					state: "next",
					time: null,
					tone: "idle",
				},
			];
		case "landed":
		case "at-gate":
			return [
				{
					detail: gate ? `${gate} replied` : "Reply received",
					key: "landed",
					label: "Landed",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: `Waiting on you · ${elapsed}`,
					key: "gate",
					label: "At gate",
					state: "current",
					time: null,
					tone: "hold",
				},
			];
		default:
			if (flight.quiet) {
				// Nothing was sent, so nothing landed: one step, not a landing.
				return [
					{
						detail: "No messages yet",
						key: "not-started",
						label: "Not started",
						state: "current",
						time: at,
						tone: "idle",
					},
				];
			}
			return [
				{
					detail: null,
					key: "landed",
					label: "Landed",
					state: "done",
					time: at,
					tone: "off",
				},
				{
					detail: `On the ground ${elapsed}`,
					key: "arrived",
					label: "Arrived",
					state: "done",
					time: null,
					tone: "off",
				},
			];
	}
}
