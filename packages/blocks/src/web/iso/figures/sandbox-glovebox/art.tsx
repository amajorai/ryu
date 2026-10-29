import { Line, Solid } from "../../kit/react/draw.tsx";
import { BOX_ART, HATCH_ART } from "./geometry.ts";
import { SandboxGloveboxLive } from "./live.tsx";
import { DESCRIPTION, LABEL } from "./model.ts";

/**
 * The static parts, built on the server and handed to the live component in painter's
 * order: the sealed box with its three faint blanked roof ports, then the hatch chamber.
 */
const BOX = (
	<g key="box">
		<Solid crease="none" paths={BOX_ART.body} tone="mid" />
		<Line d={BOX_ART.blanks} tone="lo" />
		<Solid crease="none" paths={HATCH_ART.chamber} tone="mid" />
		<path className="sgb-mouth" d={HATCH_ART.mouth} />
		<Line d={HATCH_ART.mouth} tone="lo" />
	</g>
);

const TRAY = (
	<Solid crease="none" key="tray" paths={HATCH_ART.tray} tone="lo" />
);

export function SandboxGloveboxArt() {
	return (
		<SandboxGloveboxLive
			box={BOX}
			description={DESCRIPTION}
			door={<Solid crease="none" paths={HATCH_ART.door} tone="mid" />}
			label={LABEL}
			tray={TRAY}
		/>
	);
}
