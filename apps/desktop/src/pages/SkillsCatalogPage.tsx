import SkillsCatalogSection from "@/src/components/store/SkillsCatalogSection.tsx";

/**
 * Standalone Skills route. The catalog itself lives in
 * {@link SkillsCatalogSection} (also embedded in the Store page).
 */
export default function SkillsCatalogPage() {
	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="min-h-0 flex-1 overflow-hidden">
				<SkillsCatalogSection />
			</div>
		</div>
	);
}
