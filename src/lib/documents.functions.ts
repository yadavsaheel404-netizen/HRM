import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "./actor.server";
import {
  canAccessEmployeeDocuments,
  DOCUMENT_TYPE_LABELS,
  isValidOwnedDocumentPath,
  type DocumentType,
} from "./permissions";

function isStoragePrivilegeError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const msg = String((error as { message?: string }).message ?? "");
  const code = String((error as { code?: string; statusCode?: string }).code ?? (error as { statusCode?: string }).statusCode ?? "");
  return (
    code === "42501" ||
    /relieving_cases|permission denied/i.test(msg)
  );
}

async function assertCanAccessDocumentOwner(
  supabase: Parameters<typeof requirePermission>[0],
  actorId: string,
  ownerId: string,
) {
  if (actorId === ownerId) return;
  const [{ data: roleRows }, { data: hasReadAll }] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", actorId),
    supabase.rpc("has_permission", { _user_id: actorId, _permission: "documents:read:all" }),
  ]);
  const actorRoles = (roleRows ?? []).map((r) => r.role);
  const actorPerms = hasReadAll === true ? ["documents:read:all"] : [];
  if (!canAccessEmployeeDocuments(actorId, ownerId, actorRoles, actorPerms)) {
    throw new Error(
      "Forbidden: sensitive employee documents can only be opened by the employee, HR, or Super Admin.",
    );
  }
}

/**
 * Documents live in a private bucket keyed by user id. Reads are always via
 * short-lived signed URLs — no file is ever publicly addressable.
 */
export const createDocumentUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { docType: string; fileName: string }) => {
    if (!input?.docType) throw new Error("Choose a document type.");
    const fileName = String(input.fileName ?? "").trim();
    if (!fileName) throw new Error("A file name is required.");
    if (!/\.(pdf|png|jpe?g|webp|docx?)$/i.test(fileName)) {
      throw new Error("Only PDF, Word or image files are accepted.");
    }
    return { docType: input.docType, fileName };
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "documents:upload:self");
    const safeName = data.fileName.replace(/[^\w.\-]+/g, "_");
    const path = `${context.userId}/${data.docType}/${Date.now()}_${safeName}`;
    const { data: signed, error } = await context.supabase.storage
      .from("employee-documents")
      .createSignedUploadUrl(path);
    if (error) throw error;
    return { path, token: signed.token };
  });

export const registerDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { docType: string; path: string; fileName: string }) => {
    if (!input?.docType || !input?.path) throw new Error("Missing upload details.");
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "documents:upload:self");
    if (!data.path.startsWith(`${context.userId}/`)) {
      throw new Error("Forbidden: documents can only be filed under your own record.");
    }

    // Check for any earlier copy of the same document type.
    const { data: existingDocs } = await context.supabase
      .from("documents")
      .select("id, file_path, status")
      .eq("user_id", context.userId)
      .eq("doc_type", data.docType as never);

    if ((existingDocs ?? []).some((d) => d.status === "verified")) {
      throw new Error("A verified document cannot be replaced unless returned by HR.");
    }

    // Earlier versions (and their files) are preserved: the DB history trigger
    // records the replaced row (status, HR note, file path) before it is removed
    // from the "current documents" view, so past review decisions stay auditable.
    await context.supabase
      .from("documents")
      .delete()
      .eq("user_id", context.userId)
      .eq("doc_type", data.docType as never);

    const { data: insertedDoc, error } = await context.supabase
      .from("documents")
      .insert({
        user_id: context.userId,
        doc_type: data.docType as never,
        file_path: data.path,
        file_name: data.fileName,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "document.uploaded",
      entityType: "document",
      entityId: data.path,
      detail: { docType: data.docType },
    });

    // Notify HR reviewers with direct deep link to Employee Profile -> Documents
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { notify } = await import("./daily-queries.server");
      const [{ data: uploader }, { data: hrRoles }] = await Promise.all([
        supabaseAdmin.from("profiles").select("full_name").eq("id", context.userId).maybeSingle(),
        supabaseAdmin.from("user_roles").select("user_id").eq("role", "hr"),
      ]);
      const empName = uploader?.full_name?.trim() || "An employee";
      const docLabel = DOCUMENT_TYPE_LABELS[data.docType as DocumentType] ?? "KYC Document";
      const docId = insertedDoc?.id ?? null;
      const actionUrl = docId
        ? `/workforce/${context.userId}?section=documents&docId=${docId}`
        : `/workforce/${context.userId}?section=documents`;
      const recipients = Array.from(
        new Set((hrRoles ?? []).map((r) => r.user_id).filter((id) => id && id !== context.userId)),
      );
      await Promise.all(
        recipients.map((hrId) =>
          notify(supabaseAdmin, {
            userId: hrId,
            actorId: context.userId,
            type: "kyc.submitted",
            title: `${empName} uploaded ${docLabel}`,
            body: "Document uploaded and pending KYC review.",
            entityType: "document",
            entityId: docId,
            section: "documents",
            actionLabel: "Review Documents",
            actionUrl,
            metadata: {
              employeeId: context.userId,
              docType: data.docType,
              ...(docId ? { docId } : {}),
            },
          }),
        ),
      );
    } catch {
      // In-app notification delivery is best-effort and must never fail upload registration.
    }

    // Resubmission after a correction request → "under review" in-app notice.
    const { drainKycNotificationsSafely } = await import("./kyc/kyc-notifications.server");
    await drainKycNotificationsSafely(context.userId);
    return { ok: true };
  });

export const getDocumentDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { documentId: string }) => {
    if (!input?.documentId) throw new Error("A document id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: doc, error } = await context.supabase
      .from("documents")
      .select("id, user_id, doc_type, file_path")
      .eq("id", data.documentId)
      .maybeSingle();
    if (error) throw error;
    if (!doc) throw new Error("Document not found or not visible to you.");

    await assertCanAccessDocumentOwner(context.supabase, context.userId, doc.user_id);

    if (!isValidOwnedDocumentPath(doc.user_id, doc.file_path)) {
      throw new Error("Invalid document path.");
    }

    let signedUrl: string | null = null;
    const { data: signed, error: signError } = await context.supabase.storage
      .from("employee-documents")
      .createSignedUrl(doc.file_path, 120);

    if (signError) {
      // Fallback only when authorization already succeeded above and Storage RLS hits an
      // unrelated SQL grant error (e.g. legacy relieving_cases storage policy before migration).
      if (!isStoragePrivilegeError(signError)) {
        throw signError;
      }
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: adminSigned, error: adminErr } = await supabaseAdmin.storage
        .from("employee-documents")
        .createSignedUrl(doc.file_path, 120);
      if (adminErr) throw adminErr;
      signedUrl = adminSigned?.signedUrl ?? null;
    } else {
      signedUrl = signed?.signedUrl ?? null;
    }

    if (!signedUrl) {
      throw new Error("Could not generate a signed document URL.");
    }

    if (context.userId !== doc.user_id) {
      const { writeAudit } = await import("./audit.server");
      await writeAudit(context.supabase, {
        actorId: context.userId,
        action: "document.downloaded",
        entityType: "document",
        entityId: doc.id,
        detail: { ownerId: doc.user_id, docType: doc.doc_type },
      });
    }

    return { url: signedUrl };
  });

export const reviewDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((input: { documentId: string; approve: boolean; note?: string }) => {
    if (!input?.documentId) throw new Error("A document id is required.");
    const note = String(input.note ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 500);
    if (!input.approve && !note) {
      throw new Error("Add a correction reason when rejecting a document.");
    }
    return { documentId: String(input.documentId), approve: input.approve === true, note };
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "documents:verify:all");
    const [{ data: isHr }, { data: isSuper }] = await Promise.all([
      context.supabase.rpc("has_role", { _user_id: context.userId, _role: "hr" }),
      context.supabase.rpc("has_role", { _user_id: context.userId, _role: "super_admin" }),
    ]);
    if (isHr !== true && isSuper !== true) {
      throw new Error("Forbidden: only HR or Super Admin can verify employee KYC documents.");
    }

    const { data: doc, error: loadError } = await context.supabase
      .from("documents")
      .select("id, user_id, doc_type, status")
      .eq("id", data.documentId)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!doc) throw new Error("Document not found or not visible to you.");
    if (doc.user_id === context.userId) {
      throw new Error("You cannot review your own KYC documents.");
    }

    const nextStatus = data.approve ? "verified" : "rejected";
    // Idempotent: repeated Verify clicks change nothing and emit no new events/emails.
    if (doc.status === nextStatus && data.approve) {
      return { ok: true, unchanged: true };
    }

    const { error } = await context.supabase
      .from("documents")
      .update({
        status: nextStatus,
        review_note: data.approve ? null : data.note,
        reviewed_by: context.userId,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", data.documentId);
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: data.approve ? "document.verified" : "document.rejected",
      entityType: "document",
      entityId: data.documentId,
      detail: { ownerId: doc.user_id, docType: doc.doc_type, previousStatus: doc.status, hasNote: Boolean(data.note) },
    });

    // The decision is committed. Deliver any due KYC notification afterwards —
    // an SMTP problem can never roll back or fail the review itself.
    const { drainKycNotificationsSafely } = await import("./kyc/kyc-notifications.server");
    await drainKycNotificationsSafely(doc.user_id);
    return { ok: true, unchanged: false };
  });

export const listMyDocuments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("documents")
      .select("id, doc_type, file_name, file_path, status, review_note, reviewed_at, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  });
