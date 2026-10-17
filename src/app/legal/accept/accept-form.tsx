"use client";

import { useActionState } from "react";

import { acceptTermsAction, type AcceptTermsState } from "./actions";

/**
 * Explicit, un-prechecked Terms acceptance. The checkbox is required
 * — the browser blocks submission, and the server independently
 * verifies the submitted value, so passive use or a hidden default
 * can never record acceptance.
 */
export function AcceptTermsForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(
    async (prev: AcceptTermsState, formData: FormData) =>
      acceptTermsAction(prev, formData),
    {},
  );

  return (
    <form action={formAction}>
      {next && <input type="hidden" name="next" value={next} />}
      <div className="flex items-start gap-3">
        <input
          id="accept_terms"
          name="accept_terms"
          type="checkbox"
          required
          className="mt-1 h-4 w-4 shrink-0"
        />
        <label htmlFor="accept_terms" className="text-sm text-neutral-700">
          I have read and accept the SARbase Terms of Service. I understand the
          Privacy Policy describes how my information is processed and that
          accepting these Terms is not consent to marketing messages.
        </label>
      </div>

      {state.error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {pending ? "Recording…" : "Accept and continue"}
      </button>
    </form>
  );
}
