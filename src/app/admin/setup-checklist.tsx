import Link from "next/link";

import type { OrganizationSetup } from "@/lib/domain/setup";

/**
 * Dismissible onboarding checklist for a new organization. Rendered
 * only while it is useful: disappears entirely once every item is done,
 * collapses to a quiet "show" link once dismissed. Advisory only — each
 * item is a link to the place the work happens, and optional structure
 * (units, vendors, qualifications) is marked optional rather than
 * demanded.
 */
export function SetupChecklist({
  setup,
  dismissAction,
  restoreAction,
}: {
  setup: OrganizationSetup;
  dismissAction: () => Promise<void>;
  restoreAction: () => Promise<void>;
}) {
  if (setup.complete) return null;

  if (setup.dismissed) {
    return (
      <form action={restoreAction} className="mt-4 text-right">
        <button
          type="submit"
          className="text-xs text-neutral-400 hover:text-neutral-600 hover:underline"
        >
          Show setup checklist
        </button>
      </form>
    );
  }

  return (
    <section
      aria-labelledby="setup-heading"
      className="mt-6 rounded-md border border-neutral-300 bg-neutral-50 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          id="setup-heading"
          className="text-sm font-semibold text-neutral-800"
        >
          Set up {setup.doneCount > 0 ? "your organization" : "SARbase"} —{" "}
          {setup.doneCount} of {setup.totalCount} done
        </h2>
        <form action={dismissAction}>
          <button
            type="submit"
            className="text-xs text-neutral-500 hover:text-neutral-800 hover:underline"
          >
            Hide checklist
          </button>
        </form>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        The records most organizations want before going operational. Guidance
        only — nothing here is required, and items marked optional can be
        skipped entirely.
      </p>
      <ul className="mt-3 space-y-1.5">
        {setup.items.map((item) => (
          <li key={item.id} className="flex items-baseline gap-2 text-sm">
            <span
              aria-hidden="true"
              className={item.done ? "text-green-700" : "text-neutral-400"}
            >
              {item.done ? "✓" : "○"}
            </span>
            {item.done ? (
              <span className="text-neutral-400 line-through">
                {item.label}
              </span>
            ) : (
              <Link
                href={item.href}
                className="font-medium text-neutral-800 hover:underline"
              >
                {item.label}
              </Link>
            )}
            {item.optional && !item.done && (
              <span className="text-xs text-neutral-400">(optional)</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
