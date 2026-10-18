# Example: first mission, end to end

Assume a repository at `D:\work\demo` with a clean `main` branch and one file `README.md`.

```
/tower on
tower_init repoRoot=D:\work\demo
```

`s` is a placeholder for tool JSON arguments; DSH accepts the object form:

```json
{"repoRoot":"D:\\work\\demo","missions":[{"title":"Add greeting","scope":["src/**"],"tasks":["write src/greet.txt","commit the change"],"kind":"build"}]}
```

`tower_plan` returns `M1`. Spawn the worker:

```json
{"repoRoot":"D:\\work\\demo","missionId":"M1","role":"worker"}
```

Wait for the worker's final report (delivered to this session) or check `tower_roster`. The worker
creates `src/greet.txt`, commits on `tower/m1-add-greeting`, marks both tasks done, and calls
`tower_complete`.

Spawn the reviewer:

```json
{"repoRoot":"D:\\work\\demo","missionId":"M1","role":"reviewer"}
```

The read-only reviewer inspects `tower_diff`, then calls `tower_review` with:

```json
{"repoRoot":"D:\\work\\demo","missionId":"M1","status":"clean","merge":"merge","findings":"none","decision":"single in-scope file; content correct"}
```

Gate and merge:

```json
{"repoRoot":"D:\\work\\demo","missionId":"M1"}
```

Call `tower_preflight` with the same arguments; expect `ok: true`. Then `tower_merge`, and finally
`tower_teardown` with `{"repoRoot":"D:\\work\\demo"}`.

```
/tower off
```

Typical expected output after merge:

```json
{"ok":true,"mergedCommit":"<sha>","baseTip":"<old>","branchTip":"<sha>","parents":["<old>","<sha>"]}
```

If the merge hook is slow, add `"timeoutMs": 1800000` to `tower_merge`; if a merge commit landed but the
call failed, re-run `tower_merge` and it records the existing commit instead of merging again.
