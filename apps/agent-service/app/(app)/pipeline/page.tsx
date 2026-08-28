import { redirect } from "next/navigation";

/** Legacy route — opportunities replaces pipeline. */
export default function PipelineRedirectPage() {
  redirect("/opportunities");
}
