import { DesktopCatalogHost } from "@/src/components/store/catalog-host.tsx";
import ModelsCatalogSection from "@/src/components/store/ModelsCatalogSection.tsx";

/**
 * Standalone Models route. The catalog itself lives in
 * {@link ModelsCatalogSection} (also embedded in the Store page), which now reads
 * its Core-node hooks + install layer through the shared CatalogHost seam — so
 * this standalone route mounts {@link DesktopCatalogHost} the same way StorePage
 * does.
 */
export default function ModelCatalogPage() {
	return (
		<DesktopCatalogHost>
			<div className="flex h-full flex-col overflow-hidden">
				<div className="min-h-0 flex-1 overflow-hidden">
					<ModelsCatalogSection />
				</div>
			</div>
		</DesktopCatalogHost>
	);
}
