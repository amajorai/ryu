import { SpaceFileDropzone } from "@/src/components/spaces/SpaceFileDropzone.tsx";

export function SpaceUploadPanel({
	onUploadComplete,
	spaceId,
}: {
	onUploadComplete?: () => void;
	spaceId: string;
}) {
	return (
		<section
			aria-labelledby="space-upload-title"
			className="rounded-lg border bg-card p-4"
			data-testid="space-upload-panel"
		>
			<h2 className="font-medium text-sm" id="space-upload-title">
				Add files
			</h2>
			<div className="mt-3">
				<SpaceFileDropzone
					onUploadComplete={onUploadComplete}
					spaceId={spaceId}
				/>
			</div>
		</section>
	);
}
