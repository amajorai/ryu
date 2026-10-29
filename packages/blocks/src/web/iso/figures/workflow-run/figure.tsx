import { WorkflowRunArt } from "./art.tsx";
import "../../kit/iso.css";
import "../shared/quiet.css";
import "./workflow-run.css";

export interface WorkflowRunFigureProps {
	className?: string;
}

/**
 * One Ryu workflow run as a marble rolling through its nodes, a checkpoint pin rising on
 * each node as it finishes. No words around it: the description is for assistive tech
 * only. Follows the site's light/dark theme.
 */
export function WorkflowRunFigure({ className }: WorkflowRunFigureProps) {
	const base = "iso iso-quiet wfr";
	return (
		<figure className={className ? `${base} ${className}` : base}>
			<WorkflowRunArt />
		</figure>
	);
}
