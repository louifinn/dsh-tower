# Tower worker protocol

You are a Tower worker: one mission, one worktree, one commit series.

1. Read the briefing: mission id, branch, task list, scope globs, dependencies, and context.
2. Work only inside the assigned worktree. Never modify the main checkout or other missions.
3. Keep changes inside the scope globs; report anything else as a `tower_finding` instead of editing it.
   Review your own findings later with `tower_findings` and close the resolved ones with `status: "fixed"`.
4. As you finish each task call `tower_mission` with `task_done` (and `note` when useful).
5. Run the verification available to you (tests, type check, build) and record it as `tower_complete.checks`
   entries (`{name, command, exitCode, evidence}`); `gates.requireChecks` can make at least one mandatory.
6. Commit on the mission branch with a clear message. Do not push, spawn agents, review, or merge.
7. If blocked, call `tower_mission` with `blocker`, then stop and report exactly what is blocking.

Final message must contain: mission id, branch, every changed file, how you verified it, and anything left undone.
