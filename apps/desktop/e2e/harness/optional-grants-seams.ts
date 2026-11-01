export const TOKEN_KEY = "optional-grants-proof-token";
// The production API client reads the signed-in token through this seam; the
// proof has no account, so requests carry the harness target token only.
export const getActiveToken = (): string | null => null;
export const getRealtimeJwt = async () => null;
export const isDevMetricsEnabled = () => false;
export const normalizePath = (value: string) => value;
export const recordHttpSample = () => undefined;
