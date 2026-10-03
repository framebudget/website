export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Verifies a Turnstile token with Cloudflare's siteverify. Sends only the
 * secret and the token (never the visitor's IP). True only for `success: true`;
 * a missing secret, a network error or any other answer is a failure.
 */
export async function verifyTurnstile(secret: string | undefined, token: string): Promise<boolean> {
  if (!secret) return false;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
    });
    if (!response.ok) return false;
    const outcome: unknown = await response.json();
    return typeof outcome === "object" && outcome !== null && (outcome as { success?: unknown }).success === true;
  } catch {
    return false;
  }
}
