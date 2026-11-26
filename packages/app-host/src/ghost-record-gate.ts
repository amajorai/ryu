import type { HostServices } from "./rpc.ts";

/**
 * Companions reviewed to record desktop input through the host.
 *
 * A recording observes the person's keyboard and pointer across the whole
 * desktop and returns the captured events, typed text included. The
 * `ghost:record` grant is approvable for any app id, and Core sees only the
 * owner's node token on `/api/recipes/record/*`, so the host is the one place
 * that knows which frame asked. An id is a claim an installed app can copy, so
 * the caller must also be the exact manifest compiled into Core (the
 * `first_party` provenance on its contributions row). Desktop and mobile both
 * apply this, so neither client is the softer door.
 */
const REVIEWED_RECORDING_OWNERS: ReadonlySet<string> = new Set([
	"@ryu/workflows",
	"@ryu/recipes",
]);

/** The host verbs that start, observe or end a desktop recording. */
export const GHOST_RECORDING_VERBS = [
	"ghostRecordStart",
	"ghostRecordStatus",
	"ghostRecordStop",
] as const satisfies readonly (keyof HostServices)[];

export type GhostRecordingServices = Pick<
	HostServices,
	(typeof GHOST_RECORDING_VERBS)[number]
>;

/** Who is asking, as the host knows it. Nothing here comes from the frame. */
export interface GhostRecordingCaller {
	/** Core-derived: true only for a manifest compiled into the Core binary. */
	compiledManifest: boolean;
	/** The mounted frame, stable for as long as that frame lives. */
	frame: string;
	/** The node whose recorder is driven. A node holds one recording at a time. */
	node: string;
	pluginId: string;
}

/** Which frame started the recording that runs on each node. */
export type GhostRecordingSessions = Map<string, string>;

const HOST_SESSIONS: GhostRecordingSessions = new Map();

const NOT_REVIEWED =
	"Only the reviewed Workflows and Recipes apps can record desktop actions from an app.";
const NOT_THE_STARTER =
	"This recording was started somewhere else. It has been stopped and its result was discarded.";

export function isReviewedRecordingOwner(
	caller: Pick<GhostRecordingCaller, "compiledManifest" | "pluginId">
): boolean {
	return (
		caller.compiledManifest === true &&
		REVIEWED_RECORDING_OWNERS.has(caller.pluginId)
	);
}

function refuseRecording(): Promise<never> {
	return Promise.reject(new Error(NOT_REVIEWED));
}

/**
 * Wraps the three recording verbs for one caller.
 *
 * Any caller that is not a reviewed owner gets a refusal for all three, and the
 * node is never asked. A reviewed owner keeps them, with the session tied to
 * the frame that started it: only that frame reads the task and counters from
 * status and the captured events from stop. Another reviewed frame learns only
 * whether the recorder is busy. It may still end the recording, because ending
 * a capture is always the safe direction, but the result is dropped.
 */
export function gateGhostRecording(
	caller: GhostRecordingCaller,
	services: GhostRecordingServices,
	sessions: GhostRecordingSessions = HOST_SESSIONS
): GhostRecordingServices {
	if (!isReviewedRecordingOwner(caller)) {
		return {
			ghostRecordStart: refuseRecording,
			ghostRecordStatus: refuseRecording,
			ghostRecordStop: refuseRecording,
		};
	}
	const {
		ghostRecordStart: start,
		ghostRecordStatus: status,
		ghostRecordStop: stop,
	} = services;
	const startedHere = () => sessions.get(caller.node) === caller.frame;
	return {
		ghostRecordStart:
			start &&
			(async (input) => {
				const state = await start(input);
				if (state.recording) {
					sessions.set(caller.node, caller.frame);
				}
				return state;
			}),
		ghostRecordStatus:
			status &&
			(async () => {
				const mine = startedHere();
				const state = await status();
				if (!state.recording) {
					sessions.delete(caller.node);
				}
				return mine ? state : { recording: state.recording };
			}),
		ghostRecordStop:
			stop &&
			(async () => {
				const mine = startedHere();
				const result = await stop();
				sessions.delete(caller.node);
				if (!mine) {
					throw new Error(NOT_THE_STARTER);
				}
				return result;
			}),
	};
}
