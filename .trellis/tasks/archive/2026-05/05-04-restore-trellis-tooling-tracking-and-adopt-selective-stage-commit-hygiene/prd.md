# Restore Trellis tooling tracking and adopt selective-stage commit hygiene

## Goal

撤回上一个 commit (`f5739b6`) 中把 `.claude/`、`.trellis/`、`AGENTS.md`
从 git tracking 移除的副作用——把它们重新加回 tracked，恢复
`.gitignore` 的原始形态，并改用「精准 stage 而非 git add -A」的 commit
习惯，使得未来 commit 时只会带上插件相关文件，而 Trellis 工具仍然伴随
仓库存在。

## Requirements

- [x] 恢复 `.claude/`、`.trellis/`（除原本就 ignored 的 `.claude/worktrees/`）、`AGENTS.md` 到 git tracking。
- [x] `.gitignore` 恢复成此 commit 之前的内容（仅含 `node_modules/`、`.claude/worktrees/`、`*.tgz`）。
- [x] 提交一个 revert / restore commit。
- [x] 不影响插件功能代码（`index.ts`、`family-table.ts`、tests 等保持
      `f5739b6` 状态）。

## Acceptance Criteria

- [ ] `git ls-files` 中重新出现 `.claude/`、`.trellis/`、`AGENTS.md` 的条目。
- [ ] `.gitignore` 与 `f5739b6` 之前的内容一致。
- [ ] `npm run typecheck` / `validate:manifest` / `test:reasoning-profile` 仍然全绿。
- [ ] 工作目录干净，restore commit 落库。

## Technical Approach

最直接的方式：把 `f5739b6^:.gitignore` 还原，并把那次 commit 中删掉的
所有 `.claude/`、`.trellis/`、`AGENTS.md` 路径用 `git checkout f5739b6^ -- <path>`
拉回来重新 stage。然后 commit。

或者更等价的：`git revert f5739b6 --no-commit`，然后剔除掉 plugin 代码部分
的反向修改（仅保留 untrack 反向修改），但这更复杂；选前者。

具体步骤：
1. `git checkout f5739b6^ -- .gitignore .claude .trellis AGENTS.md`
2. `git add .gitignore .claude .trellis AGENTS.md`
3. 验证 `npm run typecheck` 等全绿
4. 提交 commit message 大致："chore: restore Trellis tooling tracking; switch to selective-stage commit hygiene"

## Decision (ADR-lite)

**Context:** 上次提交把 `.claude/`、`.trellis/`、`AGENTS.md` 从 tracking 移除并
gitignored 了。owner 反馈过头——他想要的是「commit 时只带插件相关文件」，而不是
彻底从仓库剥离 Trellis 工具。

**Decision:** 恢复 tracking，未来 commit 时改用 `git add <files>` 精准 stage 而非
全量。

**Consequences:**
- ✅ Clone 后 Trellis 工具直接可用，不丢配置。
- ✅ 仓库继续承载 AI 助手协作上下文。
- ⚠️ 提交时需要主动避免 `git add -A`/`.`，要列出具体路径。

## Out of Scope

- 修改插件功能代码。
- 修改 .github/、bugs/、tsconfig 等其他文件。

## Technical Notes

- 受影响 commit：`f5739b6 feat: data-driven xhigh/max reasoning detection via family table`
- 之前的 `.gitignore` 内容（来自 `f5739b6^`）：
  ```
  node_modules/
  .claude/worktrees/
  *.tgz
  ```
- 受影响路径：
  - `.gitignore`
  - `.claude/agents/*`、`.claude/commands/trellis/*`、`.claude/hooks/*`、
    `.claude/settings.json`、`.claude/skills/*`
  - `.trellis/.gitignore`、`.trellis/.template-hashes.json`、`.trellis/.version`、
    `.trellis/config.yaml`、`.trellis/scripts/*`、`.trellis/spec/*`、
    `.trellis/tasks/00-bootstrap-guidelines/*`、`.trellis/tasks/05-01-*`（旧任务）、
    `.trellis/workflow.md`、`.trellis/workspace/*`
  - `AGENTS.md`
