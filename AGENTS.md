# Agent Rules

## Todolist Memo Protocol

本项目使用 `todolist_memo` 作为跨会话持久执行记忆。

### 启动

每次开始或恢复工作时必须：

1. 阅读本文件；
2. 阅读 `todolist_memo/README.md`；
3. 阅读 `todolist_memo/EXECUTION_PLAN.md` 当前状态和断点；
4. 若存在 `IN_PROGRESS` 主任务，阅读对应 `todolist_memo/tasks/<TASK-ID>.md`；
5. 运行 `git status --short`；
6. 运行计划校验器；
7. 从当前活动子任务断点继续，而不是依赖历史聊天。

### 执行模式

执行模式必须记录在 `todolist_memo/EXECUTION_PLAN.md`：

```text
single_task
stage
continuous
project
```

- `single_task`：关闭当前主任务后停止；
- `stage`：当前阶段内自动领取下一任务，阶段完成后停止；
- `continuous`：跨阶段自动领取可执行任务；
- `project`：持续执行到整个计划完成或无法继续。

用户未指定时默认使用 `continuous`。每个主任务通过 Reviewer 验收后，必须自动跨阶段领取下一个依赖满足的任务。切换模式必须更新主计划、断点和 Plan Change Log。

### 规划

复杂工作先由当前可用的最强模型担任 Planner，审计项目，拆分阶段、主任务和子任务，定义依赖、范围、输出和验收，并写入主计划。编程 Agent 不得在计划外进行大范围修改。

### 执行

- 默认最多一个主任务为 `IN_PROGRESS`；
- 同一主任务默认最多一个子任务为 `IN_PROGRESS`；
- 每个活动主任务和子任务必须有最新断点；
- Executor 只执行已批准任务包；
- 每完成一个子任务，核对验收后标记完成并切换断点；
- 每完成一个主任务，由 Reviewer 独立复核后标记 `[x] DONE`。

### 状态

只允许 `TODO`、`IN_PROGRESS`、`BLOCKED`、`DONE`、`CANCELLED`。只有 `DONE` 使用 `[x]`。禁止直接 `TODO → DONE`。

### 任务关闭后的自动领取

Reviewer 关闭任务并更新证据、统计和计划后，必须根据执行模式处理：

- `single_task`：将执行控制状态设为 `PAUSED` 后停止；
- `stage`：当前阶段仍有依赖满足的 `TODO` 时，立即领取下一任务；
- `continuous`：整个计划仍有依赖满足的 `TODO` 时，立即领取下一任务；
- `project`：持续领取，直到全部任务完成或无法继续。

自动领取时必须：

1. 选择依赖全部 `DONE` 的最高优先级 `TODO`；
2. 将其设置为 `IN_PROGRESS`；
3. 设置当前阶段、当前任务和当前子任务；
4. 创建或更新任务日志；
5. 写入初始断点；
6. 保持执行控制状态为 `RUNNING`；
7. 运行计划校验器；
8. 继续执行。

在允许自动继续的模式下，不得仅因为上一任务完成而结束，也不得只留下
“下一候选任务”而不实际领取。

只有达到模式边界、无可执行任务、出现阻塞、需要用户信息、需要高风险外部操作、
计划与仓库冲突、连续验证失败或上下文不足时才可停止。停止前必须写入精确断点，
并把执行控制状态设为 `PAUSED`、`BLOCKED` 或 `COMPLETED`。

### 唯一状态源

`todolist_memo/EXECUTION_PLAN.md` 是主任务状态、依赖、当前进度和统计的唯一动态事实源。任务日志保存细节，但不能覆盖主计划状态。

### 断点

中断前必须记录已完成、当前位置、未完成、修改文件、未提交修改、真实命令结果、错误/风险、下一步精确操作、需读文件和恢复命令。禁止只写“继续开发”。

### 完成

任务只有在目标、验收、测试、证据、文档和计划同步完成后，才能由 Reviewer 标记 `DONE`。预计结果和 Executor 自报成功不能作为完成证据。
