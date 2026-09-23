export interface ResendPayloadRecipient {
  email: string;
  name?: string | null;
}

function formatRecipient(recipient: ResendPayloadRecipient): string {
  return recipient.name
    ? `${recipient.name.replace(/[\r\n<>]/g, " ").trim()} <${recipient.email}>`
    : recipient.email;
}

function formatMailbox(name: string, email: string): string {
  const clean = name.replace(/[\r\n<>]/g, " ").trim();
  return clean ? `${clean} <${email}>` : email;
}

export function buildResendPayload(params: {
  senderEmail: string;
  senderProductName: string;
  agentName: string;
  agentEmail: string;
  to: ResendPayloadRecipient[];
  cc: ResendPayloadRecipient[];
  subject: string;
  bodyHtml: string;
}) {
  // Display name is the agent only so inboxes show a person, not noreply@.
  // The technical From address remains the verified Resend sender.
  const fromName = params.agentName.trim() || params.senderProductName.trim() || "REOS";
  return {
    payload: {
      from: formatMailbox(fromName, params.senderEmail),
      to: params.to.map(formatRecipient),
      cc: params.cc.length > 0 ? params.cc.map(formatRecipient) : undefined,
      reply_to: params.agentEmail,
      subject: params.subject,
      html: params.bodyHtml,
    },
    fromName,
  };
}
