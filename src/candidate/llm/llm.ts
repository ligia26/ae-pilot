/**
 * The only place the app talks to Corti Models (via the provided lib/corti.ts).
 * corti-s1 reasons before answering, so no token cap is sent unless
 * CORTI_MAX_TOKENS is set; an empty completion is retried once, and an expired
 * token is refreshed and retried once.
 */
import { chat, type ChatMessage } from "../../../lib/corti.ts";
import { canRefresh, ensureCortiToken } from "./corti-auth.ts";

export type { ChatMessage };
export type LlmFn = (messages: ChatMessage[]) => Promise<string>;

export function cortiLlm(model = process.env.CORTI_MODEL): LlmFn {
  const maxTokens = process.env.CORTI_MAX_TOKENS ? Number(process.env.CORTI_MAX_TOKENS) : undefined;
  const once = async (messages: ChatMessage[]) => {
    await ensureCortiToken();
    try {
      return await chat({ model, messages, temperature: 0.1, maxTokens });
    } catch (e) {
      if (!canRefresh() || !/HTTP (401|403)/.test((e as Error).message)) throw e;
      await ensureCortiToken(true);
      return chat({ model, messages, temperature: 0.1, maxTokens });
    }
  };
  return async (messages) => {
    let res = await once(messages);
    if (!res.content.trim()) res = await once(messages);
    if (!res.content.trim()) throw new Error(`empty completion from ${res.model} (finish_reason: ${res.finishReason ?? "unknown"})`);
    return res.content;
  };
}
