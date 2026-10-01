"use client";

import { useActionState } from "react";

import type { ActionState } from "../admin/actions";

/**
 * The token-gated response buttons (issue #14). Deliberately minimal
 * and thumb-friendly: two large tap targets, no navigation, no other
 * invitees' data. Resubmitting the same choice is idempotent; choosing
 * the other option records a changed response.
 */
export function TokenResponseForm({
  action,
  currentResponse,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  currentResponse: "COMING" | "UNAVAILABLE" | null;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const base =
    "w-full rounded-lg px-6 py-4 text-base font-semibold disabled:opacity-60";
  return (
    <form action={formAction} className="space-y-3">
      <button
        type="submit"
        name="response"
        value="COMING"
        disabled={pending}
        aria-pressed={currentResponse === "COMING"}
        className={`${base} ${
          currentResponse === "COMING"
            ? "bg-green-800 text-white"
            : "bg-green-700 text-white hover:bg-green-800"
        }`}
      >
        {pending && currentResponse !== "COMING"
          ? "Recording…"
          : currentResponse === "COMING"
            ? "I'm coming ✓"
            : "I'm coming"}
      </button>
      <button
        type="submit"
        name="response"
        value="UNAVAILABLE"
        disabled={pending}
        aria-pressed={currentResponse === "UNAVAILABLE"}
        className={`${base} border ${
          currentResponse === "UNAVAILABLE"
            ? "border-amber-400 bg-amber-100 text-amber-900"
            : "border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50"
        }`}
      >
        {currentResponse === "UNAVAILABLE" ? "Unavailable ✓" : "Unavailable"}
      </button>
      {state.message && (
        <p className="text-sm text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
