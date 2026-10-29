// The bouncy accordion now lives in @ryu/ui so the desktop panels and the
// marketing blocks share one implementation. This path stays as a re-export so
// existing desktop imports keep working.
export {
	BouncyAccordion,
	type BouncyAccordionClassNames,
	type BouncyAccordionItem,
	type BouncyAccordionProps,
} from "@ryu/ui/components/bouncy-accordion.tsx";
