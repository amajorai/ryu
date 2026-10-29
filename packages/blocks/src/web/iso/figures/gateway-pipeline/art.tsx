import { Solid } from "../../kit/react/draw.tsx";
import { GATES, PARCEL_PATHS, TRACK } from "./geometry.ts";
import { GatewayPipelineLive } from "./live.tsx";
import { DESCRIPTION } from "./model.ts";

/**
 * Static parts of the figure, built on the server and handed to the live component in
 * painter's order: the track and every far post sit behind the request, and every near
 * post and lintel in front of it. Each gate's parts carry `data-stage` so the live
 * component can step up the one the request is passing.
 */

const BEHIND = (
	<g key="behind">
		<Solid crease="none" paths={TRACK} tone="lo" />
		{GATES.map((gate) => (
			<g data-stage={gate.stage} key={gate.stage}>
				<Solid crease="none" paths={gate.far} tone="mid" />
			</g>
		))}
	</g>
);

const PARCEL = <Solid crease="faint" lit paths={PARCEL_PATHS} tone="hi" />;

const IN_FRONT = (
	<g key="in-front">
		{GATES.map((gate) => (
			<g data-stage={gate.stage} key={gate.stage}>
				<Solid crease="none" paths={gate.near} tone="mid" />
				<Solid crease="none" paths={gate.lintel} tone="mid" />
			</g>
		))}
	</g>
);

export function GatewayPipelineArt() {
	return (
		<GatewayPipelineLive
			behind={BEHIND}
			description={DESCRIPTION}
			inFront={IN_FRONT}
			parcel={PARCEL}
		/>
	);
}
