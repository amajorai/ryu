import { useOptionalI18n } from "@ryu/i18n/react";

/**
 * The ends of a heatmap's intensity legend ("Less ... More"). They read through
 * keyed senses: the bare catalog "Less" and "More" are show-less and overflow
 * menu toggles (ja "閉じる", "その他").
 */
export function useHeatmapLegendWords(): { less: string; more: string } {
	const i18n = useOptionalI18n();
	return {
		less: i18n?.t("heatmap.less", {}, "Less") ?? "Less",
		more: i18n?.t("heatmap.more", {}, "More") ?? "More",
	};
}
