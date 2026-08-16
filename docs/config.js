/**
 * The one piece of Google configuration this page needs.
 *
 * An OAuth Client ID is a public identifier, not a secret: it is sent to
 * Google in the sign-in URL and is visible to anyone who opens this page or
 * reads this file. That is by design, and it is the ONLY Google credential
 * that may ever live here.
 *
 * Never put a client secret, a refresh token, a service account key or an API
 * key in this folder. Everything under docs/ is published verbatim; anything
 * written here is readable by every visitor.
 *
 * Each viewer signs in as themselves and reads their own Drive. Nothing about
 * the person who published the page is involved.
 *
 * Leave it empty and the player simply carries on as a local-folder player:
 * the Drive option is shown, explained and disabled.
 */

// Paste your OAuth Client ID here. This is a public identifier, not a secret.
export const GOOGLE_CLIENT_ID = '255524276418-kbqh9s9aifghj0r3qlv3r2qqrllad8kk.apps.googleusercontent.com';
