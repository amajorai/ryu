export function useRouter() {
	return { push: () => undefined };
}

// The rendered admin page's own location stands in for the Next.js route; the
// harness never navigates, so one parsed query is as stable as Next's.
const searchParams = new URLSearchParams(window.location.search);

export function usePathname() {
	return window.location.pathname;
}

export function useSearchParams() {
	return searchParams;
}
