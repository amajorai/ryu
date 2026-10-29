/**
 * The useful-state fixture every game test, the story harness and the
 * screenshots share: re-exported from the protocol's canonical file (do
 * not duplicate the data here). `FIXTURE_NOW` is the fixture's default
 * "now"; `FIXTURE_CLOCK` pins clock labels to en-GB in UTC.
 */
export {
	FIXTURE_AGENT_IDS,
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW_MS,
	FIXTURE_NOW_MS as FIXTURE_NOW,
	FIXTURE_PRIVATE_STRINGS,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "@ryuhq/protocol/interfaces-fixture";
