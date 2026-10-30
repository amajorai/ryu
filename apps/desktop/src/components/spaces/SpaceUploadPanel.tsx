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
			className="flex flex-col gap-3"
			data-testid="space-upload-panel"
		>
			<h2 className="font-semibold text-sm" id="space-upload-title">
				Add files
			</h2>
			<SpaceFileDropzone
				onUploadComplete={onUploadComplete}
				spaceId={spaceId}
			/>
		</section>
	);
}
