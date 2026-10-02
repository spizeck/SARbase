"use client";

import { useActionState } from "react";

import type { ActionState } from "./actions";

/**
 * Forms for attachments and organization documents (issue #16).
 *
 * Uploaded files are documentary records — these forms collect the file,
 * optional human context, and (for closed-incident mutations) a required
 * reason. Nothing here inspects or classifies file contents.
 */

const inputClass =
  "mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
const labelClass = "block text-sm font-medium text-neutral-800";
const errorClass = "mt-1 text-sm text-red-700";
const buttonClass =
  "rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50";
const secondaryButtonClass =
  "rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50";

function FieldError({ id, errors }: { id: string; errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p id={id} className={errorClass} role="alert">
      {errors.join(" ")}
    </p>
  );
}

type BoundAction = (
  prev: ActionState,
  formData: FormData,
) => Promise<ActionState>;

/**
 * Upload a file onto a record. `requireReason` renders a required reason
 * field — used when the target touches a CLOSED incident's evidence set.
 * The accept list is a client hint only; the server revalidates type,
 * extension, signature, and size.
 */
export function AttachmentUploadForm({
  action,
  requireReason = false,
  idPrefix = "attach",
}: {
  action: BoundAction;
  requireReason?: boolean;
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor={`${idPrefix}-file`} className={labelClass}>
          File
        </label>
        <input
          id={`${idPrefix}-file`}
          name="file"
          type="file"
          required
          accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.log,.md,.csv,.docx,.xlsx"
          aria-invalid={Boolean(state.fieldErrors?.file)}
          aria-describedby={`${idPrefix}-file-error`}
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          PDF, JPEG, PNG, WebP, text, CSV, DOCX, or XLSX — up to 25 MB.
        </p>
        <FieldError
          id={`${idPrefix}-file-error`}
          errors={state.fieldErrors?.file}
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-description`} className={labelClass}>
          Description <span className="text-neutral-500">(optional)</span>
        </label>
        <input
          id={`${idPrefix}-description`}
          name="description"
          type="text"
          maxLength={500}
          placeholder="e.g. service invoice from dealer"
          className={inputClass}
        />
      </div>
      {requireReason && (
        <div>
          <label htmlFor={`${idPrefix}-reason`} className={labelClass}>
            Reason <span className="text-red-700">(required)</span>
          </label>
          <input
            id={`${idPrefix}-reason`}
            name="reason"
            type="text"
            required
            maxLength={500}
            placeholder="Why is this file being added to a closed incident?"
            aria-invalid={Boolean(state.fieldErrors?.reason)}
            aria-describedby={`${idPrefix}-reason-error`}
            className={inputClass}
          />
          <FieldError
            id={`${idPrefix}-reason-error`}
            errors={state.fieldErrors?.reason}
          />
        </div>
      )}
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Uploading…" : "Upload"}
      </button>
    </form>
  );
}

/**
 * Unlink an attachment from its record — the file record and audit trail
 * survive; only the link goes away. A reason field appears when the
 * parent is a closed incident.
 */
export function UnlinkAttachmentForm({
  action,
  requireReason = false,
}: {
  action: BoundAction;
  requireReason?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      {requireReason && (
        <input
          name="reason"
          type="text"
          required
          maxLength={500}
          placeholder="Reason (required)"
          aria-label="Reason for removing this file"
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
        />
      )}
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-neutral-500 hover:text-red-700 disabled:opacity-50"
      >
        {pending ? "Removing…" : "Remove from record"}
      </button>
      {state.message && (
        <span className="text-xs text-red-700" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}

/**
 * Permanently delete a file — tombstones the metadata record and removes
 * the stored object. History rows still show the file existed.
 */
export function DeleteAttachmentForm({
  action,
  requireReason = false,
}: {
  action: BoundAction;
  requireReason?: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      {requireReason && (
        <input
          name="reason"
          type="text"
          required
          maxLength={500}
          placeholder="Reason (required)"
          aria-label="Reason for deleting this file"
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
        />
      )}
      <button
        type="submit"
        disabled={pending}
        className="text-xs font-medium text-neutral-500 hover:text-red-700 disabled:opacity-50"
      >
        {pending ? "Deleting…" : "Delete file"}
      </button>
      {state.message && (
        <span className="text-xs text-red-700" role="alert">
          {state.message}
        </span>
      )}
    </form>
  );
}

/* -------- Organization documents -------- */

interface DocumentDefaults {
  title?: string;
  category?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
}

/**
 * Create an organization document with its first file version — used on
 * the documents list page.
 */
export function OrganizationDocumentCreateForm({
  action,
}: {
  action: BoundAction;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="doc-title" className={labelClass}>
            Title
          </label>
          <input
            id="doc-title"
            name="title"
            type="text"
            required
            maxLength={200}
            aria-invalid={Boolean(state.fieldErrors?.title)}
            aria-describedby="doc-title-error"
            className={inputClass}
          />
          <FieldError id="doc-title-error" errors={state.fieldErrors?.title} />
        </div>
        <div>
          <label htmlFor="doc-category" className={labelClass}>
            Category <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="doc-category"
            name="category"
            type="text"
            maxLength={60}
            placeholder="e.g. SOP, Insurance, Manual"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="doc-effective" className={labelClass}>
            Effective date <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="doc-effective"
            name="effectiveOn"
            type="date"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="doc-expires" className={labelClass}>
            Expiry date <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="doc-expires"
            name="expiresOn"
            type="date"
            aria-invalid={Boolean(state.fieldErrors?.expiresOn)}
            aria-describedby="doc-expires-error"
            className={inputClass}
          />
          <FieldError
            id="doc-expires-error"
            errors={state.fieldErrors?.expiresOn}
          />
        </div>
      </div>
      <div>
        <label htmlFor="doc-file" className={labelClass}>
          File
        </label>
        <input
          id="doc-file"
          name="file"
          type="file"
          required
          accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.log,.md,.csv,.docx,.xlsx"
          aria-invalid={Boolean(state.fieldErrors?.file)}
          aria-describedby="doc-file-error"
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          PDF, JPEG, PNG, WebP, text, CSV, DOCX, or XLSX — up to 25 MB.
        </p>
        <FieldError id="doc-file-error" errors={state.fieldErrors?.file} />
      </div>
      <div>
        <label htmlFor="doc-notes" className={labelClass}>
          Notes <span className="text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="doc-notes"
          name="notes"
          rows={2}
          maxLength={2000}
          className={inputClass}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Uploading…" : "Add document"}
      </button>
    </form>
  );
}

/** Edit document metadata — files change only via new versions. */
export function OrganizationDocumentEditForm({
  action,
  defaults,
}: {
  action: BoundAction;
  defaults: DocumentDefaults;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="doc-edit-title" className={labelClass}>
            Title
          </label>
          <input
            id="doc-edit-title"
            name="title"
            type="text"
            required
            maxLength={200}
            defaultValue={defaults.title}
            aria-invalid={Boolean(state.fieldErrors?.title)}
            aria-describedby="doc-edit-title-error"
            className={inputClass}
          />
          <FieldError
            id="doc-edit-title-error"
            errors={state.fieldErrors?.title}
          />
        </div>
        <div>
          <label htmlFor="doc-edit-category" className={labelClass}>
            Category <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="doc-edit-category"
            name="category"
            type="text"
            maxLength={60}
            defaultValue={defaults.category ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="doc-edit-effective" className={labelClass}>
            Effective date <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="doc-edit-effective"
            name="effectiveOn"
            type="date"
            defaultValue={defaults.effectiveOn ?? undefined}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="doc-edit-expires" className={labelClass}>
            Expiry date <span className="text-neutral-500">(optional)</span>
          </label>
          <input
            id="doc-edit-expires"
            name="expiresOn"
            type="date"
            defaultValue={defaults.expiresOn ?? undefined}
            aria-invalid={Boolean(state.fieldErrors?.expiresOn)}
            aria-describedby="doc-edit-expires-error"
            className={inputClass}
          />
          <FieldError
            id="doc-edit-expires-error"
            errors={state.fieldErrors?.expiresOn}
          />
        </div>
      </div>
      <div>
        <label htmlFor="doc-edit-notes" className={labelClass}>
          Notes <span className="text-neutral-500">(optional)</span>
        </label>
        <textarea
          id="doc-edit-notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={defaults.notes ?? undefined}
          className={inputClass}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Saving…" : "Save details"}
      </button>
    </form>
  );
}

/** Upload the next version of a document's file. */
export function DocumentVersionUploadForm({ action }: { action: BoundAction }) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="doc-version-file" className={labelClass}>
          Replacement file
        </label>
        <input
          id="doc-version-file"
          name="file"
          type="file"
          required
          accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.log,.md,.csv,.docx,.xlsx"
          aria-invalid={Boolean(state.fieldErrors?.file)}
          aria-describedby="doc-version-file-error"
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm`}
        />
        <FieldError
          id="doc-version-file-error"
          errors={state.fieldErrors?.file}
        />
      </div>
      <div>
        <label htmlFor="doc-version-note" className={labelClass}>
          Version note <span className="text-neutral-500">(optional)</span>
        </label>
        <input
          id="doc-version-note"
          name="note"
          type="text"
          maxLength={200}
          placeholder="e.g. 2026 renewal, board revision 4"
          className={inputClass}
        />
      </div>
      {state.message && (
        <p className={errorClass} role="alert">
          {state.message}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Uploading…" : "Upload new version"}
      </button>
    </form>
  );
}

/** Archive/restore a document — never deletes files. */
export function DocumentStatusButton({
  action,
  label,
}: {
  action: () => Promise<ActionState>;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(() => action(), {});
  return (
    <form action={formAction}>
      <button type="submit" disabled={pending} className={secondaryButtonClass}>
        {pending ? "Working…" : label}
      </button>
      {state.message && (
        <p className="mt-1 text-xs text-red-700" role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
