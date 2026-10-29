/**
 * Typed companion bridge for generic application-room realtime.
 *
 * The implementation is installed inside the null-origin iframe by
 * `third-party-plugin.ts`. These types intentionally contain no node target,
 * bearer token, JWT, or websocket URL: the trusted desktop host owns all of
 * those values and exposes only this opaque room connection.
 */

import { z } from "zod";
import type * as CompanionProtocol from "./companion-contracts.ts";
import type { RyuJsonValue } from "./rpc.ts";

/** These public interfaces remain declaration-merging targets in this module.
 * The pure protocol owns their fields; generic ports retain public nested symbols.
 */
export interface TokenTableEvent extends CompanionProtocol.TokenTableEvent {}
export interface TokenTablePresence
	extends CompanionProtocol.TokenTablePresence {}
export interface TokenTableConnectionInfo
	extends CompanionProtocol.TokenTableConnectionInfo {}
export interface TokenTableConnection
	extends TokenTableConnectionInfo,
		Pick<
			CompanionProtocol.TokenTableConnection,
			"close" | "publish" | "publishPresence"
		> {}
export interface TokenTableConnectHandlers
	extends CompanionProtocol.TokenTableConnectHandlers<
		TokenTableEvent,
		TokenTablePresence
	> {}
export interface TokenTableApi
	extends CompanionProtocol.TokenTableApi<
		TokenTableConnectHandlers,
		TokenTableConnection
	> {}

/** Generic names for the application-room contract. Token Table aliases remain
 * exported so existing companions continue to type-check unchanged. */
export type RealtimeAppEvent = TokenTableEvent;
export type RealtimeAppPresence = TokenTablePresence;
export type RealtimeAppConnectionInfo = TokenTableConnectionInfo;
export type RealtimeAppConnection = TokenTableConnection;
export type RealtimeAppConnectHandlers = TokenTableConnectHandlers;
export type RealtimeAppApi = TokenTableApi;

/** Generic app-facing locale primitive installed alongside realtime. */
export interface RyuCompanionI18n extends CompanionProtocol.RyuCompanionI18n {}

export interface RealtimeResourceChannel {
	close(): Promise<void>;
	publishChanged(data?: RyuJsonValue): Promise<void>;
	publishPresence(data: RyuJsonValue | undefined): Promise<void>;
}

export interface RealtimeResourceOptions {
	onChanged: (data: RyuJsonValue | undefined) => void | Promise<void>;
	onError?: (cause: unknown) => void;
	onPresence?: (data: RyuJsonValue | undefined) => void;
	roomId: string;
}

const resourceChangedEnvelopeSchema = z.object({
	data: z.json().optional(),
	source_member_id: z.unknown().optional(),
});

/**
 * Join an app-owned resource room using snapshot-first semantics. The app's
 * existing governed API stays authoritative; `resource.changed` only tells
 * peers to refetch it. Echoes from this concrete membership are suppressed.
 */
export async function openRealtimeResource(
	options: RealtimeResourceOptions
): Promise<RealtimeResourceChannel> {
	let memberId = "";
	const realtime = window.ryu?.realtime;
	if (!realtime) {
		throw new Error("The app realtime bridge is unavailable.");
	}
	const connection = await realtime.connect(
		{ roomId: options.roomId },
		{
			onError: options.onError,
			onEvent: ({ data, name }) => {
				if (name !== "resource.changed") {
					return;
				}
				const parsed = resourceChangedEnvelopeSchema.safeParse(data);
				const envelope = parsed.success ? parsed.data : null;
				if (envelope?.source_member_id === memberId) {
					return;
				}
				void options.onChanged(envelope?.data);
			},
			onPresence: ({ data }) => options.onPresence?.(data),
			onResyncRequired: () => {
				void options.onChanged(undefined);
			},
		}
	);
	memberId = connection.memberId;
	return {
		close: () => connection.close(),
		publishChanged: (data) =>
			connection.publish(
				"resource.changed",
				data === undefined
					? { source_member_id: memberId }
					: { data, source_member_id: memberId }
			),
		publishPresence: (data) => connection.publishPresence(data),
	};
}

export interface RyuCompanionWindowApi
	extends CompanionProtocol.RyuCompanionWindowApi<
		RyuCompanionI18n,
		RealtimeAppApi,
		TokenTableApi
	> {}

declare global {
	interface Window {
		ryu?: RyuCompanionWindowApi;
	}
}
