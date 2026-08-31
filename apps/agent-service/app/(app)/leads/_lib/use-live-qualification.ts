"use client";

import { useEffect, useId, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type LiveQualification = {
  intent: string | null;
  targetLocation: string | null;
  propertyType: string | null;
  budget: string | null;
  timeline: string | null;
  financingStatus: string | null;
  mustHaves: string | null;
  motivation: string | null;
  preferences: string | null;
  aiSummary: string | null;
  score: number | null;
  temperature: string | null;
};

const SELECT =
  "intent, target_location, property_type, budget, timeline, financing_status, must_haves, motivation, preferences, ai_summary, qualification_score, lead_temperature";

function mapRow(row: Record<string, unknown>): LiveQualification {
  return {
    intent: typeof row.intent === "string" ? row.intent : null,
    targetLocation:
      typeof row.target_location === "string" ? row.target_location : null,
    propertyType:
      typeof row.property_type === "string" ? row.property_type : null,
    budget: typeof row.budget === "string" ? row.budget : null,
    timeline: typeof row.timeline === "string" ? row.timeline : null,
    financingStatus:
      typeof row.financing_status === "string" ? row.financing_status : null,
    mustHaves: typeof row.must_haves === "string" ? row.must_haves : null,
    motivation: typeof row.motivation === "string" ? row.motivation : null,
    preferences: typeof row.preferences === "string" ? row.preferences : null,
    aiSummary: typeof row.ai_summary === "string" ? row.ai_summary : null,
    score:
      typeof row.qualification_score === "number"
        ? row.qualification_score
        : null,
    temperature:
      typeof row.lead_temperature === "string" ? row.lead_temperature : null,
  };
}

/** Keep Additional Info / Score cards in sync while the agent writes CRM fields. */
export function useLiveQualification(
  contactId: string,
  initial: LiveQualification,
): LiveQualification {
  const instanceId = useId().replace(/:/g, "");
  const [fields, setFields] = useState(initial);

  useEffect(() => {
    setFields(initial);
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only on contact change

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function pull() {
      const { data, error } = await supabase
        .from("contacts")
        .select(SELECT)
        .eq("id", contactId)
        .maybeSingle();
      if (cancelled || error || !data) return;
      setFields(mapRow(data as Record<string, unknown>));
    }

    async function start() {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (token) await supabase.realtime.setAuth(token);
      if (cancelled) return;

      // Unique topic per hook instance — Additional Info + Score both subscribe.
      channel = supabase
        .channel(`person-qualification:${contactId}:${instanceId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "contacts",
            filter: `id=eq.${contactId}`,
          },
          (payload) => {
            setFields(mapRow(payload.new as Record<string, unknown>));
          },
        )
        .subscribe();
    }

    void start();
    void pull();
    const pollId = window.setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [contactId, instanceId]);

  return fields;
}
