import { Suspense } from "react";
import { redirect } from "next/navigation";

import { getAuthContext } from "@/lib/auth/context";
import { tryParseFirebaseClientEnvironment } from "@/lib/env";

import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const ctx = await getAuthContext();
  if (ctx) {
    redirect("/account");
  }

  // Resolved on the server and handed down as a prop: reading process.env
  // inside the client component is not a stable SSR/hydration boundary.
  const firebaseConfigured = tryParseFirebaseClientEnvironment() !== null;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        Sign in to SARbase
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        Sign in with the account your organization provisioned. SARbase has no
        public registration.
      </p>
      <div className="mt-6">
        <Suspense>
          <LoginForm configured={firebaseConfigured} />
        </Suspense>
      </div>
    </main>
  );
}
