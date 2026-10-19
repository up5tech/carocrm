import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../api/client.js';

/**
 * Client access to the signed-in user's preferences (PLAN_Phase_20_Settings_UX.md §5.9, §20.10).
 *
 * A preference is the server's value, not a copy: one query key per name, a write invalidates them
 * all, and `value === undefined` (query loading) is distinct from `value === null` (the user never set
 * it), so a consumer can keep its own default until the server answers.
 */
export function usePreference<T>(name: string): {
  /** The stored value, `undefined` while loading, `null` when the user never set one. */
  value: T | null | undefined;
  saving: boolean;
  save: (value: T) => void;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['preferences', name],
    queryFn: () => api.preference(name),
    staleTime: 60_000,
  });
  const writer = useMutation({
    mutationFn: (value: T) => api.savePreference(name, value),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['preferences'] });
    },
  });
  return {
    value: query.isPending ? undefined : ((query.data?.value as T | null) ?? null),
    saving: writer.isPending,
    save: (value: T) => {
      writer.mutate(value);
    },
  };
}
