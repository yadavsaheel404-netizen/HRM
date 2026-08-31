import { queryOptions, useSuspenseQuery } from "@tanstack/react-query";
import { getSessionActor } from "@/lib/session.functions";
import type { Actor, PermissionKey } from "@/lib/permissions";

export const actorQueryOptions = queryOptions({
  queryKey: ["session-actor"],
  queryFn: () => getSessionActor(),
  staleTime: 30_000,
});

export function useActor(): Actor & { can: (permission: PermissionKey) => boolean } {
  const { data } = useSuspenseQuery(actorQueryOptions);
  return {
    ...(data as Actor),
    can: (permission: PermissionKey) => (data as Actor).permissions.includes(permission),
  };
}
