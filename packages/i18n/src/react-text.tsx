"use client";

import { useSyncExternalStore } from "react";
import { formatMessage, type MessageValuesInput } from "./format.ts";
import { messageIdForLiteral } from "./literal-catalog.ts";
import {
	companionLiteralRemote,
	type LiteralRemote,
} from "./literal-remote.ts";
import { useOptionalI18n } from "./react-context.tsx";

// `tl()`: whole-sentence literal messages. The literal text hooks
// (`I18nText`, `useLocalizedString`, `useLocalizedText`) live beside the
// context in `react-context.tsx`.

export type LiteralMessage = (
	source: string,
	values?: MessageValuesInput
) => string;

const subscribeNowhere = () => () => undefined;
const noVersion = () => 0;

/** The Companion host's literal answers, re-rendering when one arrives. */
function useLiteralRemote(): LiteralRemote | null {
	const remote = companionLiteralRemote();
	useSyncExternalStore(
		remote?.subscribe ?? subscribeNowhere,
		remote?.version ?? noVersion,
		noVersion
	);
	return remote;
}

/**
 * `tl(source, values)`: translate a whole English sentence (an ICU message
 * such as "Applied {count, plural, one {# change} other {# changes}}.") by its
 * text, then fill its values. Use it where copy interpolates data, so the
 * sentence translates as one unit instead of DOM fragments. Untranslated or
 * provider-less copy still formats in English. Inside a Companion frame,
 * which has no official catalog, the host translates the sentence; English
 * shows until its answer arrives.
 */
export function useLiteralMessages(): LiteralMessage {
	const i18n = useOptionalI18n();
	const remote = useLiteralRemote();
	return (source, values = {}) => {
		const locale = i18n?.locale ?? "en";
		const id = messageIdForLiteral(source);
		const translated = i18n ? i18n.t(id, values, source) : source;
		// The runtime returns unknown literal copy verbatim; format it here.
		const local =
			translated === source
				? formatMessage(source, values, locale)
				: translated;
		const hosted = remote?.resolve({
			english: local,
			hasLocalPack: (packId) =>
				i18n?.availablePacks.some((pack) => pack.id === packId) ?? false,
			id,
			localOutput: translated,
			source,
			values,
		});
		return hosted ?? local;
	};
}
