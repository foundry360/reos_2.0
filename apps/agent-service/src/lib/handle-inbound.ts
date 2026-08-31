import type { ContactContext } from "@/lib/coordinator";
import { runInboundAgent } from "@/lib/run-inbound-agent";
import { resolveInboundContact } from "@/lib/db/contacts";

export interface InboundSms {
  from: string;
  body: string;
  to?: string;
}

export interface OutboundSms {
  reply: string;
  playbook: string;
  contactId?: string;
}

export async function handleInboundSms(sms: InboundSms): Promise<OutboundSms> {
  const ctx: ContactContext = await resolveInboundContact({
    channel: "sms",
    from: sms.from,
    to: sms.to,
  });

  const result = await runInboundAgent({
    ctx,
    body: sms.body,
    channel: "sms",
  });

  return {
    reply: result.reply,
    playbook: result.playbook,
    contactId: result.contactId,
  };
}
