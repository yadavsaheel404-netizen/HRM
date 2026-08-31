import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, requireSelfOrPermission } from "./actor.server";

/**
 * Documents live in a private bucket keyed by user id. Reads are always via
 * short-lived signed URLs — no file is ever publicly addressable.
 */
export const createDocumentUploadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { docType: string; fileName: string }) => {
    if (!input?.docType) throw new Error("Choose a document type.");
    const fileName = String(input.fileName ?? "").trim();
    if (!fileName) throw new Error("A file name is required.");
    if (!/\.(pdf|png|jpe?g|webp|docx?)$/i.test(fileName)) {
      throw new Error("Only PDF, Word or image files are accepted.");
    }
    return { docType: input.docType, fileName };
  })
  .handler(async ({ data, context }) => {
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
  .inputValidator((input: { docType: string; path: string; fileName: string }) => {
    if (!input?.docType || !input?.path) throw new Error("Missing upload details.");
    return input;
  })
  .handler(async ({ data, context }) => {
    if (!data.path.startsWith(`${context.userId}/`)) {
      throw new Error("Forbidden: documents can only be filed under your own record.");
    }

    // Replace any earlier copy of the same document type.
    await context.supabase
      .from("documents")
      .delete()
      .eq("user_id", context.userId)
      .eq("doc_type", data.docType as never);

    const { error } = await context.supabase.from("documents").insert({
      user_id: context.userId,
      doc_type: data.docType as never,
      file_path: data.path,
      file_name: data.fileName,
      status: "pending",
    });
    if (error) throw error;

    const { writeAudit } = await import("./audit.server");
    await writeAudit(context.supabase, {
      actorId: context.userId,
      action: "document.uploaded",
      entityType: "document",
      entityId: data.path,
      detail: { docType: data.docType },
    });
    return { ok: true };
  });

export const getDocumentDownloadUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { documentId: string }) => {
    if (!input?.documentId) throw new Error("A document id is required.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: doc, error } = await context.supabase
      .from("documents")
      .select("user_id, file_path")
      .eq("id", data.documentId)
      .maybeSingle();
    if (error) throw error;
    if (!doc) throw new Error("Document not found or not visible to you.");

    await requireSelfOrPermission(
      context.supabase,
      context.userId,
      doc.user_id,
      "documents:read:all",
    );

    const { data: signed, error: signError } = await context.supabase.storage
      .from("employee-documents")
      .createSignedUrl(doc.file_path, 120);
    if (signError) throw signError;
    return { url: signed.signedUrl };
  });

export const reviewDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { documentId: string; approve: boolean; note?: string }) => {
    if (!input?.documentId) throw new Error("A document id is required.");
    if (!input.approve && !input.note?.trim()) {
      throw new Error("Add a reason when rejecting a document.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "documents:verify:all");
    const { error } = await context.supabase
      .from("documents")
      .update({
        status: data.approve ? "verified" : "rejected",
        review_note: data.note ?? null,
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
      detail: { note: data.note ?? null },
    });
    return { ok: true };
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
