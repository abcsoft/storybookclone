// Helpers for the ADM-20 re-authentication flow (V2 Phase 6).
//
// A high-risk admin action (refund, role change, privacy decision, template
// publish, feature flag, export) needs a single-use confirmation that the page's
// own GET handler issued. A test that wants the action to SUCCEED therefore has
// to do what a browser does: load the page, take the challenge from the form, and
// submit it with the operator's current password. A test that wants to prove the
// control works simply omits it.

/** The value of a hidden input in rendered admin HTML. */
export function hiddenFieldValue(html: string, name: string): string | null {
  const match = html.match(new RegExp(`name="${name}"\\s+value="([^"]*)"`))
  return match ? match[1] : null
}

/** Does the page render a usable confirmation field? */
export function hasReauthChallenge(html: string): boolean {
  return !!hiddenFieldValue(html, 'reauth_challenge')
}

/**
 * The two fields a high-risk POST must carry. Throws if the page did not offer a
 * confirmation — that is a real failure (the form would be unusable), not
 * something to paper over.
 */
export function reauthFields(html: string, password: string): Record<string, string> {
  const challenge = hiddenFieldValue(html, 'reauth_challenge')
  if (!challenge) throw new Error('the rendered admin page carried no re-auth challenge')
  return { reauth_challenge: challenge, current_password: password }
}

/** Every challenge id on a page (a list screen issues one per high-risk form). */
export function reauthChallenges(html: string): string[] {
  return [...html.matchAll(/name="reauth_challenge"\s+value="([^"]*)"/g)].map((m) => m[1])
}
