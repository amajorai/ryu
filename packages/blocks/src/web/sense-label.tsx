"use client";

import { useOptionalI18n } from "@ryu/i18n/react";

/**
 * One keyed word sense (`en-messages-senses*.ts`) as a client island, for
 * server-rendered pages. The DOM localizer would read the bare English word in
 * its catalog sense (the bare "Guide" is the verb, ja 指示), so the word is
 * resolved by id and opted out of the localizer. Outside a provider it renders
 * the English `children`.
 */
export function SenseLabel({ children, id }: { children: string; id: string }) {
	const label = useOptionalI18n()?.t(id, {}, children) ?? children;
	return <span data-ryu-i18n="off">{label}</span>;
}
