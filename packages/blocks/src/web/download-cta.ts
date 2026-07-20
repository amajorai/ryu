export const DOWNLOAD_CTA_HREF = "/download";

export function isDownloadCtaLink(cta: {
	external?: boolean;
	href: string;
}): boolean {
	return cta.href === DOWNLOAD_CTA_HREF && !cta.external;
}
