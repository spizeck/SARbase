"use client";

import { useEffect } from "react";

/**
 * Last-resort boundary for failures in the root layout itself, where
 * app/error.tsx cannot render. It must provide its own <html>/<body> and
 * cannot rely on globals.css (the failing layout owns the stylesheet
 * import), so styling is inline and minimal. Same non-sensitive contract
 * as app/error.tsx: digest only, no error text.
 */
export default function GlobalError({
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
    <html lang="en">
      <body
        style={{
          margin: 0,
          display: "flex",
          minHeight: "100vh",
          alignItems: "center",
          justifyContent: "center",
          fontFamily:
            'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          backgroundColor: "#ffffff",
          color: "#171717",
        }}
      >
        <main
          style={{ maxWidth: "24rem", padding: "1.5rem", textAlign: "center" }}
        >
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>
            Something went wrong
          </h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.875rem" }}>
            The page could not be loaded. Please try again.
          </p>
          {error.digest && (
            <p style={{ marginTop: "0.5rem", fontSize: "0.75rem" }}>
              Reference: {error.digest}
            </p>
          )}
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1.5rem",
              padding: "0.5rem 1rem",
              fontSize: "0.875rem",
              border: "1px solid #d4d4d4",
              borderRadius: "0.375rem",
              backgroundColor: "#fff",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
