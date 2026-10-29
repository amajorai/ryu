// The proof uses the production Desktop Core request clients but runs outside
// the Next.js app. Only the two auth constants are imported by those clients;
// session/JWT behavior is supplied explicitly by the local proof host target.
export const BACKEND_URL = "http://127.0.0.1:5291";
export const TOKEN_KEY = "ryu_session_token";
