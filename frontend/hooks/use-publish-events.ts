import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { JobLine, JobStatus, StatusResponse } from "../../src/types";
import { queryKeys } from "../query-keys";

export function usePublishEvents() {
  const queryClient = useQueryClient();
  const [lines, setLines] = useState<JobLine[]>([]);

  useEffect(() => {
    const events = new EventSource("/api/publish/stream");
    events.addEventListener("status", (event) => {
      const job = JSON.parse((event as MessageEvent).data) as JobStatus;
      queryClient.setQueryData<StatusResponse>(queryKeys.status, (current) =>
        current ? { ...current, job } : current,
      );
    });
    events.addEventListener("line", (event) => {
      const line = JSON.parse((event as MessageEvent).data) as JobLine;
      setLines((current) => [...current.slice(-299), line]);
    });
    return () => events.close();
  }, [queryClient]);

  return lines;
}
