import { redirect } from "next/navigation";

/** The knowledge base grew into the wiki. */
export default function KnowledgeBaseMoved() {
  redirect("/wiki");
}
