import { redirect } from "next/navigation";

import { requireAuth } from "@/lib/auth/authorize";

export const metadata = { title: "Administration" };

export const dynamic = "force-dynamic";

/**
 * The old admin organization index — superseded by /org, which lists
 * every organization the caller belongs to (admin or member).
 */
export default async function AdminPage() {
  await requireAuth();
  redirect("/org");
}
