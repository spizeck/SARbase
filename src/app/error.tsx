"use client";

import { useEffect } from "react";

/**
 * Segment error boundary. Shows a generic message plus the error digest —
 * the non-sensitive reference an operator can search for in server logs —
 * never the error text or stack (those can echo request data).
 *
 * When the observability module is installed, report `error` to the
 * client error tracker here (see modules/observability).
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Extension point: captureClientError(error, { digest: error.digest })
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        The page could not be loaded. Please try again.
      </p>
      {error.digest && (
        <p className="mt-2 text-xs text-neutral-500">
          Reference: {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={reset}
        className="mx-auto mt-6 rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm hover:bg-neutral-50"
      >
        Try again
      </button>
    </main>
  );
}
