import type { ApiTarget } from "@ryuhq/core-client/client";
import { createResourceId } from "@ryuhq/core-client/ids";
import {
	RealtimeConnection,
	type RealtimeOptions,
} from "@ryuhq/core-client/realtime";
import { waitForApplicationRealtime } from "./application-realtime-lifetime.ts";
import { ApplicationRealtimeQueue } from "./application-realtime-queue.ts";
import type { HostServices } from "./rpc.ts";

type Connection = Pick<
	RealtimeConnection,
	"connect" | "close" | "sendEvent" | "publishPresence"
>;
type RealtimeServices = Pick<
	HostServices,
	| "realtimeConnect"
	| "realtimeClose"
	| "realtimePublish"
	| "realtimePresence"
	| "realtimeSubscribe"
>;

/** Own all room handles for one companion document; disposal fences late joins. */
export function buildApplicationRealtimeServices(
	target: ApiTarget,
	pluginId: string,
	getJwt: () => Promise<string | null>,
	createConnection: (
		target: ApiTarget,
		options: RealtimeOptions
	) => Connection = (target, options) =>
		new RealtimeConnection(target, options),
	createId: () => string = createResourceId
) {
	const lifetime = new AbortController();
	const sessions = new Map<
		string,
		{ connection: Connection; queue: ApplicationRealtimeQueue }
	>();
	const getSession = (id: string) => {
		const session = sessions.get(id);
		if (!session) {
			throw new Error("realtime connection is not available");
		}
		return session;
	};
	const close = (id: string) => {
		const session = sessions.get(id);
		sessions.delete(id);
		session?.queue.end();
		session?.connection.close();
	};
	return {
		dispose: () => {
			lifetime.abort();
			for (const id of sessions.keys()) {
				close(id);
			}
		},
		services: {
			realtimeConnect: async ({ room_id }) => {
				if (lifetime.signal.aborted) {
					throw new Error("companion document is closed");
				}
				if (sessions.size >= 32) {
					throw new Error("Too many companion room connections");
				}
				const jwt = await waitForApplicationRealtime(getJwt(), lifetime.signal);
				if (lifetime.signal.aborted) {
					throw new Error("companion document is closed");
				}
				if (sessions.size >= 32) {
					throw new Error("Too many companion room connections");
				}
				const id = createId();
				const queue = new ApplicationRealtimeQueue();
				let resolveJoin!: (ack: {
					access: "read" | "write";
					memberId: string;
					presence: unknown[];
					roomId: string;
				}) => void;
				let rejectJoin!: (error: Error) => void;
				const join = new Promise<Parameters<typeof resolveJoin>[0]>(
					(resolve, reject) => {
						resolveJoin = resolve;
						rejectJoin = reject;
					}
				);
				void join.catch(() => undefined);
				const timer = setTimeout(
					() => rejectJoin(new Error("realtime join timed out")),
					15_000
				);
				try {
					const connection = createConnection(target, {
						appId: pluginId,
						clientId: createId(),
						kind: "application",
						roomId: room_id,
						jwt,
						handlers: {
							onJoinAck: resolveJoin,
							onError: () =>
								rejectJoin(new Error("realtime connection failed")),
							onClose: (event) => {
								queue.close({
									type: "close",
									code: event.code,
									reason: event.reason,
								});
								sessions.delete(id);
								rejectJoin(
									new Error(`realtime closed: ${event.reason || event.code}`)
								);
							},
							onNamedEvent: ({ name, data }) => {
								if (!queue.push({ type: "event", name, data })) {
									close(id);
								}
							},
							onPresence: (data) => {
								if (!queue.push({ type: "presence", data })) {
									close(id);
								}
							},
							onResyncRequired: ({ dropped, reason }) => {
								if (!queue.push({ type: "resync_required", dropped, reason })) {
									close(id);
								}
							},
						},
					});
					sessions.set(id, { connection, queue });
					connection.connect();
					const ack = await waitForApplicationRealtime(join, lifetime.signal);
					return {
						access: ack.access,
						connection_id: id,
						member_id: ack.memberId,
						presence: ack.presence,
						room_id: ack.roomId,
					};
				} catch (error) {
					close(id);
					throw error;
				} finally {
					clearTimeout(timer);
				}
			},
			realtimeClose: async ({ connection_id }) => close(connection_id),
			realtimePublish: async ({ connection_id, event, data }) =>
				getSession(connection_id).connection.sendEvent(event, data),
			realtimePresence: async ({ connection_id, data }) =>
				getSession(connection_id).connection.publishPresence(data),
			realtimeSubscribe: async ({ connection_id }, emit, signal) => {
				const session = getSession(connection_id);
				try {
					while (!signal.aborted) {
						const item = await session.queue.take(signal);
						if (item === null) {
							return;
						}
						emit(JSON.stringify(item));
					}
				} finally {
					close(connection_id);
				}
			},
		},
	} satisfies { services: RealtimeServices; dispose: () => void };
}
