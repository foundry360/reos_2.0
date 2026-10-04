import OpenAI from "openai";
import { getOpenAIApiKey, getOpenAIModel } from "@/lib/admin/platform-credentials";
import { samplingParams } from "@/lib/agent/run-lead-agent";
import { getRecentMessages } from "@/lib/db/contacts";
import { meterUsage } from "@/lib/llm/usage-meter";
import { createJourneyAIExecutor, type JourneyAIExecutor } from "./ai";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Journey AI steps on the platform's configured OpenAI credentials and model,
 * the same ones the lead agent and email/comment analysis use. The journey
 * runtime owns retries, so the client doesn't retry on its own.
 */
export function createLiveJourneyAIExecutor(): JourneyAIExecutor {
  return createJourneyAIExecutor({
    model: {
      isConfigured: async () => Boolean(await getOpenAIApiKey()),
      async complete({ system, user }) {
        const apiKey = await getOpenAIApiKey();
        if (!apiKey) throw new Error("AI isn't configured for REOS yet.");
        const model = getOpenAIModel();
        const client = new OpenAI({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
        const completion = await client.chat.completions.create({
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          ...samplingParams(model, 700),
        });
        meterUsage(model, completion.usage);
        const content = completion.choices[0]?.message?.content;
        if (!content) throw new Error("The AI returned no answer.");
        return content;
      },
    },
    conversation: {
      // The executor only asks for contacts the tenant-scoped lead loader returned.
      recent: (_tenantId, contactId) => getRecentMessages(contactId),
    },
  });
}
