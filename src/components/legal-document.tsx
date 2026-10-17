import type { LegalDocument } from "@/lib/legal/documents";

/**
 * Renders a LegalDocument: table of contents + anchored sections.
 * Server component — plain semantic HTML, no interactivity required.
 */
export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  return (
    <article>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{doc.title}</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Version {doc.version}
          {doc.effectiveDate
            ? ` · Effective ${doc.effectiveDate}`
            : " · Not yet in effect"}
        </p>
        {doc.status === "draft" && (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Draft — this document is under legal review and has not been
            adopted. It is provided for transparency only.
          </p>
        )}
      </header>

      <nav aria-label="Contents" className="mt-8">
        <h2 className="text-sm font-medium text-neutral-800">Contents</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-6 text-sm">
          {doc.sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-neutral-700 underline-offset-4 hover:text-neutral-900 hover:underline"
              >
                {section.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-8 space-y-8">
        {doc.sections.map((section) => (
          <section key={section.id} aria-labelledby={section.id}>
            <h2
              id={section.id}
              className="text-lg font-semibold text-neutral-900 [scroll-margin-top:4rem]"
            >
              {section.heading}
            </h2>
            <div className="mt-2 space-y-3 text-sm leading-6 text-neutral-700">
              {section.blocks.map((block, i) =>
                block.type === "p" ? (
                  <p key={i}>{block.text}</p>
                ) : (
                  <ul key={i} className="list-disc space-y-1 pl-6">
                    {block.items?.map((item, j) => (
                      <li key={j}>{item}</li>
                    ))}
                  </ul>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}
