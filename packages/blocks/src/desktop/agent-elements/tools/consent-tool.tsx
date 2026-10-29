import { useLiteralMessages } from "@ryu/i18n/react";
import { memo } from "react";
import {
	type ConsentHostValue,
	useConsentHost,
} from "../consent-host-context.tsx";
import {
	ConnectAppCard,
	type ConsentFollowUp,
	ConsentUnavailableCard,
	PluginInstallCard,
} from "./consent-cards.tsx";
import {
	type ConnectAppRequest,
	type ConsentRequestKind,
	connectRequestFromInput,
	type PluginInstallRequest,
	pluginRequestFromInput,
} from "./consent-tool.ts";
import { GenericTool } from "./generic-tool.tsx";

export { consentRequestKind } from "./consent-tool.ts";

type ParsedRequest =
	| { kind: "connect_app"; request: ConnectAppRequest }
	| { kind: "install_plugin"; request: PluginInstallRequest };

function parseRequest(
	kind: ConsentRequestKind,
	input: unknown
): ParsedRequest | null {
	if (kind === "connect_app") {
		const request = connectRequestFromInput(input);
		return request ? { kind, request } : null;
	}
	const request = pluginRequestFromInput(input);
	return request ? { kind, request } : null;
}

function HostedConsentCard({
	onFollowUp,
	parsed,
	toolCallId,
	useActions,
}: {
	onFollowUp: ConsentFollowUp;
	parsed: ParsedRequest;
	toolCallId?: string;
	useActions: ConsentHostValue["useActions"];
}) {
	const actions = useActions();
	if (parsed.kind === "connect_app") {
		return (
			<ConnectAppCard
				actions={actions}
				onFollowUp={onFollowUp}
				request={parsed.request}
				toolCallId={toolCallId}
			/>
		);
	}
	return (
		<PluginInstallCard
			actions={actions}
			onFollowUp={onFollowUp}
			request={parsed.request}
			toolCallId={toolCallId}
		/>
	);
}

/**
 * Inline card for `consent.connect_app` / `consent.install_plugin`. The user's
 * decision goes back to the agent through `onFollowUp` as their next message.
 * Without a host or a follow-up channel, the card is read-only.
 */
export const ConsentTool = memo(function ConsentTool({
	kind,
	onFollowUp,
	part,
}: {
	kind: ConsentRequestKind;
	onFollowUp?: ConsentFollowUp;
	part: { input?: unknown; state?: string; toolCallId?: string };
}) {
	const host = useConsentHost();
	const tl = useLiteralMessages();
	const streaming = part.state === "input-streaming";
	// Core rejected the call (the agent sees the error): never offer an action
	// for a request that did not go through.
	const rejected = part.state === "output-error";
	const parsed = streaming || rejected ? null : parseRequest(kind, part.input);
	if (!parsed) {
		if (streaming) {
			return <GenericTool isPending title="Preparing request" />;
		}
		// Core rejects the same malformed shapes, so the agent already sees the
		// error; keep the row quiet rather than drawing a half card.
		return (
			<GenericTool
				isError={part.state === "output-error"}
				isPending={false}
				title={kind === "connect_app" ? "Connect request" : "Plugin request"}
			/>
		);
	}
	// An actionable card needs both the host (to act) and a way to send the
	// answer back (the agent ended its turn to wait for it). A chat that lacks
	// either, such as a builder panel, gets the read-only card instead.
	if (!(host && onFollowUp)) {
		return (
			<ConsentUnavailableCard
				reason={parsed.request.reason}
				title={
					parsed.kind === "connect_app"
						? tl("Connect {app}?", { app: parsed.request.app })
						: "Install a plugin?"
				}
			/>
		);
	}
	return (
		<HostedConsentCard
			onFollowUp={onFollowUp}
			parsed={parsed}
			toolCallId={part.toolCallId}
			useActions={host.useActions}
		/>
	);
});
