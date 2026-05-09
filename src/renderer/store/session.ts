// session.ts — Zustand store for the logged-in worker.
//
// Convention (Section 1 of CLAUDE.md): selectors return primitives,
// never new object literals — that triggers an infinite re-render loop
// because Zustand uses Object.is for equality.

import { create } from 'zustand';
import type { SessionInfo, WorkerRole } from '../../shared/types/ipc';

interface SessionState {
  workerId: string | null;
  workerRole: WorkerRole | null;
  fullName: string | null;

  setSession: (s: SessionInfo | null) => void;
  clear: () => void;
}

export const useSession = create<SessionState>((set) => ({
  workerId: null,
  workerRole: null,
  fullName: null,

  setSession: (s) => set({
    workerId:   s?.workerId ?? null,
    workerRole: s?.role ?? null,
    fullName:   s?.fullName ?? null,
  }),
  clear: () => set({ workerId: null, workerRole: null, fullName: null }),
}));
