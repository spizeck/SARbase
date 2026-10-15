"use client";

import { useActionState, useRef, useState } from "react";

import type {
  ActionState,
  DirectUploadCompletion,
  DirectUploadDeclared,
  PreparedUploadResult,
} from "./actions";

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

/* ------------------------------------------------------------------ */
/* Direct-to-store upload plumbing                                      */
/*                                                                      */
/* Upload forms first ask the server for a scoped upload grant. When   */
/* the configured storage provider supports direct uploads the browser */
/* PUTs the file straight to object storage (keeping bytes off the     */
/* hosting platform's request-body limit); otherwise the form falls    */
/* back to the classic FormData server action — same result either way.*/
/* ------------------------------------------------------------------ */

type PrepareUploadFn = (
  input: DirectUploadDeclared & { reason?: string | null },
) => Promise<PreparedUploadResult>;

interface DocumentFieldValues {
  title?: string | null;
  category?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  notes?: string | null;
  description?: string | null;
  versionNote?: string | null;
}

function textField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * POST the file directly to the granted URL as multipart form data —
 * the signed fields first (they are the grant), the file content last
 * (presigned POST policies require the file field to come last).
 * XMLHttpRequest is used deliberately — fetch() cannot report upload
 * progress in browsers.
 */
function postFileDirectly(
  url: string,
  fields: Record<string, string>,
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };
    xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300 });
    xhr.onerror = () => resolve({ ok: false });
    xhr.ontimeout = () => resolve({ ok: false });
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) {
      body.append(name, value);
    }
    body.append("file", file);
    xhr.open("POST", url);
    xhr.send(body);
  });
}

interface DirectFlowState {
  busy: boolean;
  statusText: string | null;
  progress: number | null;
  result: ActionState | null;
}

const IDLE_FLOW: DirectFlowState = {
  busy: false,
  statusText: null,
  progress: null,
  result: null,
};

/**
 * Shared submit flow for every file-upload form: prepare → direct PUT
 * (with progress) → finalize, or fall back to the proxied server action
 * when the provider cannot direct-upload. FormData text fields reach
 * the server through `prepare`/`finalize` closures — the file input is
 * the only thing that takes the object-store path.
 */
function useDirectUpload(handlers: {
  prepare: (
    declared: DirectUploadDeclared,
    formData: FormData,
  ) => Promise<PreparedUploadResult>;
  finalize: (
    completion: DirectUploadCompletion,
    formData: FormData,
  ) => Promise<ActionState>;
}) {
  const [flow, setFlow] = useState<DirectFlowState>(IDLE_FLOW);

  async function submit(form: HTMLFormElement, resubmit: () => void) {
    const formData = new FormData(form);
    const file = formData.get("file");
    // An unset file input arrives as a nameless 0-byte File; a named
    // empty file proceeds and fails policy server-side instead.
    if (!(file instanceof File) || (!file.name && file.size === 0)) {
      setFlow({
        ...IDLE_FLOW,
        result: { fieldErrors: { file: ["Choose a file to upload."] } },
      });
      return;
    }
    const declared: DirectUploadDeclared = {
      name: file.name,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    };

    setFlow({
      busy: true,
      statusText: "Preparing upload…",
      progress: null,
      result: null,
    });
    try {
      const prepared = await handlers.prepare(declared, formData);
      if (prepared.status === "proxied") {
        setFlow(IDLE_FLOW);
        // The provider cannot direct-upload: hand the submission back
        // to the form's native action so the proxied server action runs
        // through the ordinary useActionState path (with its own reset).
        resubmit();
        return;
      }
      if (prepared.status === "error") {
        setFlow({ ...IDLE_FLOW, result: prepared.error });
        return;
      }

      setFlow({
        busy: true,
        statusText: "Uploading…",
        progress: 0,
        result: null,
      });
      const put = await postFileDirectly(
        prepared.upload.url,
        prepared.upload.fields,
        file,
        (fraction) =>
          setFlow((current) => ({ ...current, progress: fraction })),
      );
      if (!put.ok) {
        setFlow({
          ...IDLE_FLOW,
          result: {
            message: "The upload could not be completed. Please try again.",
          },
        });
        return;
      }

      setFlow({
        busy: true,
        statusText: "Finishing…",
        progress: null,
        result: null,
      });
      const result = await handlers.finalize(
        {
          ...declared,
          stagingKey: prepared.upload.stagingKey,
          finalKey: prepared.upload.finalKey,
          ticket: prepared.upload.ticket,
        },
        formData,
      );
      setFlow({ ...IDLE_FLOW, result });
      if (!result.message && !result.fieldErrors) {
        form.reset();
      }
    } catch {
      setFlow({
        ...IDLE_FLOW,
        result: {
          message: "The upload could not be completed. Please try again.",
        },
      });
    }
  }

  return { flow, submit };
}

/**
 * Submit handler for a direct-upload form: the hook's flow runs first;
 * when it signals "proxied" the form re-submits NATIVELY so the
 * server action goes through React's form-action machinery (pending
 * state and uncontrolled-input reset) rather than a manual dispatch.
 */
function useDirectUploadSubmit(direct: ReturnType<typeof useDirectUpload>) {
  const resubmitRef = useRef(false);
  return (event: React.FormEvent<HTMLFormElement>) => {
    if (resubmitRef.current) {
      resubmitRef.current = false;
      return;
    }
    event.preventDefault();
    const form = event.currentTarget;
    void direct.submit(form, () => {
      resubmitRef.current = true;
      form.requestSubmit();
    });
  };
}

/** Live upload status — determinate progress while bytes move. */
function UploadStatus({ flow }: { flow: DirectFlowState }) {
  if (!flow.busy) return null;
  const percent =
    flow.progress === null ? null : Math.round(flow.progress * 100);
  return (
    <div className="space-y-1" role="status" aria-live="polite">
      <p className="text-xs text-neutral-600">
        {percent === null ? flow.statusText : `Uploading… ${percent}%`}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-200">
        <div
          className={`h-full rounded bg-neutral-700 transition-[width] duration-200 ${
            percent === null ? "w-1/3 animate-pulse" : ""
          }`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Upload a file onto a record. `requireReason` renders a required reason
 * field — used when the target touches a CLOSED incident's evidence set.
 * The accept list is a client hint only; the server revalidates type,
 * extension, signature, and size.
 */
export function AttachmentUploadForm({
  action,
  prepare,
  finalize,
  requireReason = false,
  idPrefix = "attach",
}: {
  action: BoundAction;
  prepare: PrepareUploadFn;
  finalize: (
    completion: DirectUploadCompletion & {
      description?: string | null;
      reason?: string | null;
    },
  ) => Promise<ActionState>;
  requireReason?: boolean;
  idPrefix?: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const direct = useDirectUpload({
    prepare: (declared, formData) =>
      prepare({ ...declared, reason: textField(formData, "reason") }),
    finalize: (completion, formData) =>
      finalize({
        ...completion,
        description: textField(formData, "description"),
        reason: textField(formData, "reason"),
      }),
  });
  const onSubmit = useDirectUploadSubmit(direct);
  const busy = pending || direct.flow.busy;
  const view = direct.flow.result ?? state;
  return (
    <form action={formAction} className="space-y-3" onSubmit={onSubmit}>
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
          aria-invalid={Boolean(view.fieldErrors?.file)}
          aria-describedby={`${idPrefix}-file-error`}
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          PDF, JPEG, PNG, WebP, text, CSV, DOCX, or XLSX — up to 25 MB.
        </p>
        <FieldError
          id={`${idPrefix}-file-error`}
          errors={view.fieldErrors?.file}
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
            aria-invalid={Boolean(view.fieldErrors?.reason)}
            aria-describedby={`${idPrefix}-reason-error`}
            className={inputClass}
          />
          <FieldError
            id={`${idPrefix}-reason-error`}
            errors={view.fieldErrors?.reason}
          />
        </div>
      )}
      {view.message && (
        <p className={errorClass} role="alert">
          {view.message}
        </p>
      )}
      <UploadStatus flow={direct.flow} />
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? "Uploading…" : "Upload"}
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
  prepare,
  finalize,
}: {
  action: BoundAction;
  prepare: PrepareUploadFn;
  finalize: (
    completion: DirectUploadCompletion,
    document: DocumentFieldValues,
  ) => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const direct = useDirectUpload({
    prepare: (declared) => prepare(declared),
    finalize: (completion, formData) =>
      finalize(completion, {
        title: textField(formData, "title"),
        category: textField(formData, "category"),
        effectiveOn: textField(formData, "effectiveOn"),
        expiresOn: textField(formData, "expiresOn"),
        notes: textField(formData, "notes"),
        description: textField(formData, "description"),
        versionNote: textField(formData, "versionNote"),
      }),
  });
  const onSubmit = useDirectUploadSubmit(direct);
  const busy = pending || direct.flow.busy;
  const view = direct.flow.result ?? state;
  return (
    <form action={formAction} className="space-y-4" onSubmit={onSubmit}>
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
            aria-invalid={Boolean(view.fieldErrors?.title)}
            aria-describedby="doc-title-error"
            className={inputClass}
          />
          <FieldError id="doc-title-error" errors={view.fieldErrors?.title} />
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
            aria-invalid={Boolean(view.fieldErrors?.expiresOn)}
            aria-describedby="doc-expires-error"
            className={inputClass}
          />
          <FieldError
            id="doc-expires-error"
            errors={view.fieldErrors?.expiresOn}
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
          aria-invalid={Boolean(view.fieldErrors?.file)}
          aria-describedby="doc-file-error"
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm`}
        />
        <p className="mt-1 text-xs text-neutral-500">
          PDF, JPEG, PNG, WebP, text, CSV, DOCX, or XLSX — up to 25 MB.
        </p>
        <FieldError id="doc-file-error" errors={view.fieldErrors?.file} />
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
      {view.message && (
        <p className={errorClass} role="alert">
          {view.message}
        </p>
      )}
      <UploadStatus flow={direct.flow} />
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? "Uploading…" : "Add document"}
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
export function DocumentVersionUploadForm({
  action,
  prepare,
  finalize,
}: {
  action: BoundAction;
  prepare: PrepareUploadFn;
  finalize: (
    completion: DirectUploadCompletion,
    input: { note?: string | null },
  ) => Promise<ActionState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  const direct = useDirectUpload({
    prepare: (declared) => prepare(declared),
    finalize: (completion, formData) =>
      finalize(completion, { note: textField(formData, "note") }),
  });
  const onSubmit = useDirectUploadSubmit(direct);
  const busy = pending || direct.flow.busy;
  const view = direct.flow.result ?? state;
  return (
    <form action={formAction} className="space-y-3" onSubmit={onSubmit}>
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
          aria-invalid={Boolean(view.fieldErrors?.file)}
          aria-describedby="doc-version-file-error"
          className={`${inputClass} file:mr-3 file:rounded file:border-0 file:bg-neutral-100 file:px-3 file:py-1 file:text-sm`}
        />
        <FieldError
          id="doc-version-file-error"
          errors={view.fieldErrors?.file}
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
      {view.message && (
        <p className={errorClass} role="alert">
          {view.message}
        </p>
      )}
      <UploadStatus flow={direct.flow} />
      <button type="submit" disabled={busy} className={buttonClass}>
        {busy ? "Uploading…" : "Upload new version"}
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
