/**
 * Typed companion bridge for generic application-room realtime.
 *
 * The implementation is installed inside the null-origin iframe by
 * `third-party-plugin.ts`. These types intentionally contain no node target,
 * bearer token, JWT, or websocket URL: the trusted desktop host owns all of
 * those values and exposes only this opaque room connection.
 */

import type { RyuNodeShareOrigin } from "./app-bridge.ts";

export interface TokenTableEvent {
	data: unknown;
	name: string;
}
export interface TokenTablePresence {
	data: unknown;
}

export interface TokenTableConnectionInfo {
	access: "read" | "write";
	memberId: string;
	presence: unknown[];
	roomId: string;
}

export interface TokenTableConnection extends TokenTableConnectionInfo {
	close(): Promise<void>;
	publish(name: string, data: unknown): Promise<void>;
	publishPresence(data: unknown): Promise<void>;
}

export interface TokenTableConnectHandlers {
	onClose?: (event: { code: number; reason: string }) => void;
	onError?: (error: unknown) => void;
	onEvent?: (event: TokenTableEvent) => void;
	onPresence?: (presence: TokenTablePresence) => void;
	onResyncRequired?: (notice: { dropped?: number; reason: string }) => void;
}

export interface TokenTableApi {
	connect(
		input: { roomId: string },
		handlers?: TokenTableConnectHandlers
	): Promise<TokenTableConnection>;
}

/** Generic names for the application-room contract. Token Table aliases remain
 * exported so existing companions continue to type-check unchanged. */
export type RealtimeAppEvent = TokenTableEvent;
export type RealtimeAppPresence = TokenTablePresence;
export type RealtimeAppConnectionInfo = TokenTableConnectionInfo;
export type RealtimeAppConnection = TokenTableConnection;
export type RealtimeAppConnectHandlers = TokenTableConnectHandlers;
export type RealtimeAppApi = TokenTableApi;

/** Generic app-facing locale primitive installed alongside realtime. */
export interface RyuCompanionI18n {
	get(): Promise<{
		direction: "ltr" | "rtl";
		locale: string;
		packId: string | null;
		packName: string | null;
		packVersion: string | null;
	}>;
	subscribe(options: {
		onChange: (snapshot: {
			direction: "ltr" | "rtl";
			locale: string;
			packId: string | null;
			packName: string | null;
			packVersion: string | null;
		}) => void;
	}): { dispose(): void };
	translate(input: {
		defaultMessage: string;
		id: string;
		values?: Record<string, string | number | boolean | null>;
	}): Promise<string>;
}

export interface RealtimeResourceChannel {
	close(): Promise<void>;
	publishChanged(data?: unknown): Promise<void>;
	publishPresence(data: unknown): Promise<void>;
}

export interface RealtimeResourceOptions {
	onChanged: (data: unknown) => void | Promise<void>;
	onError?: (error: unknown) => void;
	onPresence?: (data: unknown) => void;
	roomId: string;
}

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
				const envelope =
					typeof data === "object" && data !== null
						? (data as { data?: unknown; source_member_id?: unknown })
						: null;
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
			connection.publish("resource.changed", {
				data,
				source_member_id: memberId,
			}),
		publishPresence: (data) => connection.publishPresence(data),
	};
}

export interface RyuCompanionWindowApi {
	i18n?: RyuCompanionI18n;
	node?: {
		shareOrigins(): Promise<RyuNodeShareOrigin[]>;
	};
	realtime: RealtimeAppApi;
	/** @deprecated Use `realtime`; retained for Token Table compatibility. */
	tokenTable: TokenTableApi;
	[key: string]: unknown;
}

declare global {
	interface Window {
		ryu?: RyuCompanionWindowApi;
	}
}
