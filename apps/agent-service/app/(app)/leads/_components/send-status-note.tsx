import { presentDeliveryStatus, presentSendStatus, type EmailDeliveryStatus } from "@/lib/messaging/send-status-label";
import type { MessageSendStatus } from "../_lib/person-detail-types";
import styles from "@/components/shell/shell.module.css";

/**
 * " · Sending…" / " · Not sent" / " · Not confirmed" after an outbound message's time; once sent,
 * an email's delivery (" · Delivered", " · Not delivered (bounced)", …) when Resend reported it.
 */
export function SendStatusNote({
  status,
  createdAt,
  now,
  deliveryStatus,
}: {
  status: MessageSendStatus | null | undefined;
  createdAt: string | null | undefined;
  now: number;
  deliveryStatus?: EmailDeliveryStatus | null;
}) {
  const presentation = presentSendStatus(status, createdAt, now) ?? presentDeliveryStatus(deliveryStatus);
  if (!presentation) return null;
  return (
    <span className={presentation.problem ? styles.personMessageSendProblem : undefined} suppressHydrationWarning>
      {" · "}
      {presentation.label}
    </span>
  );
}
