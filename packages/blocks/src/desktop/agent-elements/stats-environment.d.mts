/** Native object receivers projected through only the two slots this operator reads.
 * Each slot admits the complete native value domain; unrelated fields and callable identity remain opaque.
 */
export interface StatsEnvironmentObject {
	CCSTATUSLINE_CONTEXT_SIZE_FALLBACK?: StatsEnvironmentSlot;
	env?: StatsEnvironmentSlot;
}

/** The complete non-null native property receiver domain, including callable objects. */
export type StatsEnvironmentReceiver =
	| string
	| number
	| boolean
	| bigint
	| symbol
	| StatsEnvironmentObject;

/** Environment slots remain opaque native values until their individual consumer decodes them. */
export type StatsEnvironmentSlot = StatsEnvironmentReceiver | null | undefined;

export function readStatsEnvironmentSlot(
	receiver: StatsEnvironmentReceiver,
	key: "env" | "CCSTATUSLINE_CONTEXT_SIZE_FALLBACK"
): StatsEnvironmentSlot;
