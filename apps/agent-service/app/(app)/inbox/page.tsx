import { redirect } from "next/navigation";

/** Legacy route — conversations will live under leads. */
export default function InboxRedirectPage() {
  redirect("/leads");
}
