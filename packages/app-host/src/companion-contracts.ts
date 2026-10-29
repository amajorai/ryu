/** Complete generic Companion protocol owners. Module-local consumers select
 * their native window realm; importing these types does not augment global Window.
 */
import type { RyuNodeShareOrigin } from "./app-bridge.ts";
import type { CompanionThemeBridge } from "./companion-theme.ts";
import type { RyuJsonValue } from "./json-values.ts";

export interface TokenTableEvent {
	data: RyuJsonValue | undefined;
	name: string;
}
export interface TokenTablePresence {
	data: RyuJsonValue | undefined;
}

export interface TokenTableConnectionInfo {
	access: "read" | "write";
	memberId: string;
	presence: RyuJsonValue[];
	roomId: string;
}

export interface TokenTableConnection extends TokenTableConnectionInfo {
	close(): Promise<void>;
	publish(name: string, data: RyuJsonValue | undefined): Promise<void>;
	publishPresence(data: RyuJsonValue | undefined): Promise<void>;
}

export interface TokenTableConnectHandlers<
	Event = TokenTableEvent,
	Presence = TokenTablePresence,
> {
	onClose?: (event: { code: number; reason: string }) => void;
	onError?: (cause: unknown) => void;
	onEvent?: (event: Event) => void;
	onPresence?: (presence: Presence) => void;
	onResyncRequired?: (notice: { dropped?: number; reason: string }) => void;
}

export interface TokenTableApi<
	Handlers = TokenTableConnectHandlers,
	Connection = TokenTableConnection,
> {
	connect(input: { roomId: string }, handlers?: Handlers): Promise<Connection>;
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

export interface RyuCompanionWindowApi<
	I18n = RyuCompanionI18n,
	Realtime = RealtimeAppApi,
	TokenTable = TokenTableApi,
> extends CompanionThemeBridge {
	i18n?: I18n;
	node?: {
		shareOrigins(): Promise<RyuNodeShareOrigin[]>;
	};
	realtime: Realtime;
	/** @deprecated Use `realtime`; retained for Token Table compatibility. */
	tokenTable: TokenTable;
}
