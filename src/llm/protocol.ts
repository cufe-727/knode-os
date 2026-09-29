import { LlmProtocol } from '../config.js';

/** What a negotiation settles on — 'auto' is a preference, not a wire. */
export type WireProtocol = Exclude<LlmProtocol, 'auto'>;

/**
 * Which wire each OpenAI-compatible endpoint speaks.
 *
 * knode-os prefers the Responses API: reasoning models return their thinking
 * as a first-class `reasoning` output item there, while Chat Completions can
 * only smuggle it through a non-standard `message.reasoning_content` that
 * every router spells differently. But "OpenAI-compatible" in the wild means
 * Chat Completions far more often than it means Responses, so the preference
 * has to survive an endpoint that has never heard of `/responses`.
 *
 * Hence one probe per endpoint per process, cached here. The cache holds the
 * in-flight promise rather than the settled value so that the eight extraction
 * calls a sync pass fires concurrently share a single probe instead of racing
 * eight of them.
 */
const negotiated = new Map<string, Promise<WireProtocol>>();

/** Endpoints, not models, have routes — two models on one relay share a verdict. */
function endpointKey(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Ask an endpoint whether it has a `/responses` route, without spending tokens
 * on the answer.
 *
 * The probe sends a valid model and no input at all: a route that exists
 * rejects that with a validation error (400/422), a route that does not exist
 * answers 404/405/501. Sending `{}` instead would be cheaper still but does not
 * discriminate — a relay that resolves the model before the body reports a
 * missing model as 404 too, which reads exactly like a missing route.
 *
 * Anything else — a network failure, a 401, a gateway 502 — says nothing about
 * the route. Those answer 'chat' without being cached, so the real call runs on
 * the wire that is likeliest to exist and reports the real error itself, and
 * the next call probes again rather than living with a verdict formed during an
 * outage.
 */
async function probe(baseUrl: string, apiKey: string, model: string): Promise<{ wire: WireProtocol; cache: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${endpointKey(baseUrl)}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model }),
    });
  } catch {
    return { wire: 'chat', cache: false };
  }
  // drain: an undrained body keeps the socket out of the pool
  await res.text().catch(() => '');
  if (res.status === 404 || res.status === 405 || res.status === 501) return { wire: 'chat', cache: true };
  if (res.ok || res.status === 400 || res.status === 422) return { wire: 'responses', cache: true };
  return { wire: 'chat', cache: false };
}

/**
 * Settle on a wire for this endpoint. An explicit protocol is obeyed without a
 * probe — including 'responses', where a missing route must surface as the
 * error it is rather than as a quiet downgrade.
 */
export async function negotiateProtocol(
  endpoint: { baseUrl: string; apiKey: string; model: string },
  configured: LlmProtocol = 'auto',
): Promise<WireProtocol> {
  if (configured && configured !== 'auto') return configured;
  // no model means no probe that can tell a missing route from a missing model
  if (!endpoint.model || !endpoint.baseUrl) return 'chat';

  const key = endpointKey(endpoint.baseUrl);
  const cached = negotiated.get(key);
  if (cached) return cached;

  const pending = probe(key, endpoint.apiKey, endpoint.model).then(({ wire, cache }) => {
    if (!cache) negotiated.delete(key);
    return wire;
  });
  negotiated.set(key, pending);
  return pending;
}

/**
 * Record that `/responses` answered a real call with "no such route".
 *
 * The probe can be right when it runs and wrong later — a relay upgraded, a
 * base URL repointed at a plain llama.cpp — so the first call that finds the
 * route gone downgrades the endpoint for the rest of the process instead of
 * paying the same failed round-trip on every call after it.
 */
export function demoteToChat(baseUrl: string): void {
  negotiated.set(endpointKey(baseUrl), Promise.resolve('chat'));
}

/** Tests share a process; a verdict from one fake endpoint must not leak into the next. */
export function resetProtocolCache(): void {
  negotiated.clear();
}
