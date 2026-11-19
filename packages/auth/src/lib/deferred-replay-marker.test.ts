import { expect, test } from "bun:test";
import {
	deferredReplayHeaders,
	REPLAY_HEADER,
	REPLAY_MARKER,
} from "./deferred-replay-marker.ts";

test("the replay headers carry this process's unguessable marker", () => {
	expect(REPLAY_MARKER).toMatch(/^[0-9a-f-]{36}$/);
	expect(deferredReplayHeaders().get(REPLAY_HEADER)).toBe(REPLAY_MARKER);
});
