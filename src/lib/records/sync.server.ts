// Server-only synchronization and KYC metadata aggregation helpers for Employee Records.
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isMissingSchemaResourceError } from "../schema-compat.server";
import type { KycSummarySnapshot } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adminDb = () => supabaseAdmin as unknown as SupabaseClient<any>;

/**
 * Safely calls PostgreSQL `sync_profile_to_employee_record` after Onboarding,
 * Workforce updates, or Relieving events. Swallows missing-schema errors if
 * migration 20261125120000 has not been applied yet so operational HR flows
 * are never disrupted.
 */
export async function syncProfileToEmployeeRecordSafe(
  profileId: string | null | undefined,
  actorId?: string | null,
): Promise<string | null> {
  if (!profileId) return null;
  try {
    const { data, error } = await adminDb().rpc("sync_profile_to_employee_record", {
      _profile_id: profileId,
      _actor_id: actorId ?? null,
    });
    if (error) {
      if (isMissingSchemaResourceError(error)) return null;
      console.error("[records-sync] sync_profile_to_employee_record failed:", error.message);
      return null;
    }
    return typeof data === "string" ? data : null;
  } catch (err) {
    console.error("[records-sync] unexpected error syncing profile:", err);
    return null;
  }
}

/**
 * Reconciles every non-protected Workforce profile into Employee Records.
 */
export async function syncAllWorkforceToRecords(actorId: string): Promise<{
  schemaReady: boolean;
  synced: number;
  skippedProtected: number;
  syncedAt: string;
}> {
  const { data, error } = await adminDb().rpc("sync_all_workforce_to_employee_records", {
    _actor_id: actorId,
  });
  if (error) {
    if (isMissingSchemaResourceError(error)) {
      return {
        schemaReady: false,
        synced: 0,
        skippedProtected: 0,
        syncedAt: new Date().toISOString(),
      };
    }
    throw new Error(`Workforce synchronization failed: ${error.message}`);
  }
  const obj = (data ?? {}) as {
    synced?: number;
    skippedProtected?: number;
    syncedAt?: string;
  };
  return {
    schemaReady: true,
    synced: Number(obj.synced ?? 0),
    skippedProtected: Number(obj.skippedProtected ?? 0),
    syncedAt: String(obj.syncedAt ?? new Date().toISOString()),
  };
}

/**
 * Loads non-sensitive KYC verification counts across a batch of profile IDs.
 */
export async function loadKycSummaryMap(
  profileIds: readonly string[],
): Promise<Map<string, KycSummarySnapshot>> {
  const ids = [...new Set(profileIds.filter(Boolean))];
  const map = new Map<string, KycSummarySnapshot>();
  if (ids.length === 0) return map;

  const [{ data: kycStates, error: stateErr }, { data: docs }] = await Promise.all([
    adminDb()
      .from("employee_kyc_state")
      .select("user_id, status, required_count, verified_count, pending_count, rejected_count, missing_count, completed_at")
      .in("user_id", ids),
    adminDb()
      .from("documents")
      .select("user_id")
      .in("user_id", ids),
  ]);

  const uploadedCounts = new Map<string, number>();
  for (const d of (docs ?? []) as { user_id: string }[]) {
    uploadedCounts.set(d.user_id, (uploadedCounts.get(d.user_id) ?? 0) + 1);
  }

  if (!stateErr && Array.isArray(kycStates)) {
    for (const row of kycStates as {
      user_id: string;
      status: string;
      required_count: number;
      verified_count: number;
      pending_count: number;
      rejected_count: number;
      missing_count: number;
      completed_at: string | null;
    }[]) {
      map.set(row.user_id, {
        status: row.status,
        requiredCount: row.required_count ?? 5,
        uploadedCount: uploadedCounts.get(row.user_id) ?? 0,
        verifiedCount: row.verified_count ?? 0,
        pendingCount: row.pending_count ?? 0,
        rejectedCount: row.rejected_count ?? 0,
        missingCount: row.missing_count ?? 5,
        completedAt: row.completed_at,
      });
    }
  }

  for (const id of ids) {
    if (!map.has(id) && (uploadedCounts.get(id) ?? 0) > 0) {
      const up = uploadedCounts.get(id) ?? 0;
      map.set(id, {
        status: "incomplete",
        requiredCount: 5,
        uploadedCount: up,
        verifiedCount: 0,
        pendingCount: up,
        rejectedCount: 0,
        missingCount: Math.max(0, 5 - up),
        completedAt: null,
      });
    }
  }

  return map;
}
