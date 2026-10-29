import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

/**
 * Core mints message ids as UUID v4 (`uuid::Uuid::new_v4()` in
 * `ConversationStore::append_message`). The AI SDK's client-side `generateId`
 * produces a 16-character base58-ish string with no dashes, so the two id spaces
 * cannot collide.
 */
const SERVER_MESSAGE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a message id came from Core and can therefore carry a reaction.
 *
 * The composer puts a message on screen — hoverable, with a client-generated id
 * — well before Core has persisted it and assigned the real one. Reacting in
 * that window is a guaranteed 404: Core deliberately ships NO retarget fallback,
 * because silently re-pointing a reaction at whichever row the server created
 * later is how a reaction lands on the wrong message. So the affordance stays
 * hidden until the id is real, rather than the 404 being caught after the fact.
 *
 * A shape test rather than a set of "ids we have seen from the server", because
 * that set would have to be threaded through every component that renders a
 * message. It fails CLOSED both ways: an unrecognized id simply gets no
 * affordance, and no client id can pass.
 *
 * Kept in its own dependency-free module so it can be unit-tested without
 * pulling the whole `@ryu/ui` component graph into the test runner.
 */
export function isServerAssignedMessageId(
	messageId: string | undefined
): messageId is string {
	return isNativeText(messageId) && SERVER_MESSAGE_ID.test(messageId);
}
