import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";

export function ProjectMappingSection({
	mappingOrganizationId,
	mappingProjectId,
	setMappingOrganizationId,
	setMappingProjectId,
}: {
	mappingOrganizationId: string;
	mappingProjectId: string;
	setMappingOrganizationId: (value: string) => void;
	setMappingProjectId: (value: string) => void;
}) {
	return (
		<section className="flex flex-col gap-3 border-t pt-4">
			<div>
				<h3 className="font-medium text-sm">Managed project mapping</h3>
				<p className="text-muted-foreground text-xs">
					Map this local folder to a control-plane project. The folder path
					stays on this node.
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="project-mapping-organization">Organization ID</Label>
					<Input
						id="project-mapping-organization"
						onChange={(event) => setMappingOrganizationId(event.target.value)}
						placeholder="Organization ID"
						value={mappingOrganizationId}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="project-mapping-project">Project ID</Label>
					<Input
						id="project-mapping-project"
						onChange={(event) => setMappingProjectId(event.target.value)}
						placeholder="Project ID"
						value={mappingProjectId}
					/>
				</div>
			</div>
		</section>
	);
}
