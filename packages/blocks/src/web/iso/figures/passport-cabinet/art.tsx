import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import { Line, Solid } from "../../kit/react/draw.tsx";
import { CABINET_ART, SITE_ART, TRAY_ART } from "./geometry.ts";
import { PassportCabinetLive } from "./live.tsx";
import { describePassport, passportLabel } from "./model.ts";

/**
 * The static drawing, far to near: the cabinet with the keys still hanging on it and the
 * one empty box, the site, the agent's tray. The taken key and the page are drawn by
 * the live component on top.
 */
const STATIC = (
	<>
		<Solid crease="none" paths={CABINET_ART.body} tone="mid">
			<Line d={CABINET_ART.empty} tone="mid" />
		</Solid>
		{CABINET_ART.keys.map((key) => (
			<Solid crease="none" key={key.id} paths={key.solid} tone="lo" />
		))}
		<Solid crease="none" paths={SITE_ART.body} tone="mid" />
		<Solid crease="none" paths={TRAY_ART.body} tone="mid" />
	</>
);

export function PassportCabinetArt() {
	const tl = useLiteralMessages();
	const locale = useOptionalI18n()?.locale;
	return (
		<PassportCabinetLive
			description={describePassport(tl, locale)}
			label={passportLabel(tl)}
		>
			{STATIC}
		</PassportCabinetLive>
	);
}
