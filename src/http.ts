/** Request and response helpers shared by the API endpoints. */

/** UTC `YYYY-MM-DD` of a timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Bare status, no body, no details. */
export const status = (code: number) => new Response(null, { status: code });

/**
 * Lets any origin read the response of a public endpoint, without credentials.
 * Only for answers with nothing private in them: the report and calibration
 * endpoints. The lab stays same-origin.
 */
export function allowAnyOrigin(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  return response;
}

/**
 * Same-origin check: the Origin header must equal the request origin. Some
 * browsers omit Origin on same-origin beacons; Sec-Fetch-Site then vouches.
 */
export function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === url.origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** Reads at most `limit` bytes; returns null (and stops reading) past it. */
async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Reads a JSON body: 415 unless the Content-Type is one of `types`, 413 past
 * `limit` bytes (declared or actually read), 400 when missing or not UTF-8 JSON.
 * Returns the parsed value, or the bare failure response.
 */
export async function readJson(request: Request, limit: number, types: readonly string[]): Promise<{ json: unknown } | Response> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!types.includes(type)) return status(415);
  const length = request.headers.get("content-length");
  if (length !== null && !(Number(length) <= limit)) return status(413);
  if (!request.body) return status(400);
  const bytes = await readLimited(request.body, limit);
  if (!bytes) return status(413);
  try {
    return { json: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return status(400);
  }
}
