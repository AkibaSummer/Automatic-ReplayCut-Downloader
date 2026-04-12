# 交互与实现规范（约定）

本文件用于沉淀本项目后续开发需要长期遵守的规范，避免“体验不一致 / 点了没反应 / 状态不可信”等问题。

## 1. 操作提示（Toast）

- 所有用户可见的关键操作必须提供 3 态反馈：进行中 / 成功 / 失败。
- 禁止使用 `alert(...)` 或浏览器默认提示作为交互反馈；统一使用前端自带的 toast 系统。
- 操作 toast 的文案要求：
  - 明确动作对象（例如“正在删除文件”“正在缓存 m3u8”）。
  - 成功时给出口语化结果或摘要；失败时显示可读错误（来自后端 `error` 字段或网络错误）。

## 2. 悬浮提示（Tooltip）

- 禁止使用 HTML `title` 系统 tooltip。
- 统一使用项目内自定义 Tooltip 组件（样式一致、不会被鼠标遮挡）。
- Tooltip 内容应解释“这个按钮做什么、会影响什么”，避免技术术语堆叠。

## 3. 状态与进度

- 状态必须可被 UI 可靠渲染，且前后端字段含义一致。
- 进度展示要求：
  - 下载进度不得回退；必要时做防回退钳制。
  - 合并（merge）阶段必须有独立进度（与下载进度区分），避免“合并耗时完全不可感知”。
- `deleted` 状态用于表达“曾下载完成但本地文件已不存在”，不得与 `failed` 混淆；并允许重新下载。

## 4. 后端接口与字段

- JSON 字段统一使用 `snake_case`（例如 `already_up_to_date`）。
- 与文件系统相关的接口必须做安全校验：
  - 仅允许操作 `output_dir` 目录下的文件（例如删除视频文件），防止越权删除任意路径。

## 5. 合并与时长校验

- 合并产物必须做时长校验；若异常（例如几百小时）必须自动尝试更稳妥的修复路径再决定是否成功：
  - 优先 remux 修复时间戳，再不行再走重编码兜底。
- 如可获得 m3u8 的分片时长信息，应优先用其推导期望时长，用于校验与进度换算。

## 6. 数据持久化与可恢复

- 与用户体验直接相关的信息应可恢复：
  - 暂停状态的进度、速度信息不应在刷新/重启后丢失。
  - m3u8 URL 与内容在获取后应持久化；当发生变化时以最后一次保存为准。

## 7. 架构与代码职责划分 (Architecture Conventions)

- **API 接口层极简原则**: `pkg/api` 下的路由 Handler 仅负责处理 HTTP 请求打解包与极少的组装逻辑，禁止包含针对文件系统的详细操纵或文件改名等业务行为。
- **公共逻辑抽离原则**: 若有一段文件操作、正则匹配或其他纯计算逻辑块被多处（如 Worker 层和 API 层）独立使用，必须抽取到 `pkg/utils` 共享包内以杜绝代码拷贝导致的潜在 Bug。
- **文件隔离要求**: 严禁将底层平台依赖（如调用 `windows.GetDiskFreeSpaceEx`）与其他业务代码相混，应独立封装在 `pkg/utils/disk_windows.go` 这类专用文件中。

## 8. 前后端通信与状态同步最佳实践 (Frontend Polling and State Sync Strategies)

- **禁止无脑定时器**: 前端系统禁止针对 API 接口滥用盲目的 `setInterval` 轮询探测。
- **按需降频逻辑 (Dynamic Back-off)**: 对于磁盘、容量等只有在运行特定任务时才会变化的数据，必须结合当前业务的活跃状态来智能轮询（例如：有正在下载的录播任务时15s一刷，闲置时降为60s，或甚至暂停查询直到下次重新 focus 页面）。
- **复用长连接 (WebSocket Reuse)**: 对于检查服务器健康与后台存活状态，应**优先依赖**已建立的 `WebSocket` 长连接其本身的事件通信（即 `onclose`、`onerror`）来获知掉线情况，而非采用激进的短轮询 HTTP 心跳包去消耗过多并发连接。

## 9. UI 组件规范 (UI Components Conventions)

- **开关按钮 (Toggle Switch)**:
  - 为了保持整体视觉统一，开关控制（如“开启代理”）不应使用原生的 `<input type="checkbox">`。
  - 应当统一使用基于 `<button role="switch">` 的 Tailwind 样式组件。包含一个外层轮廓盒（与其他操作按钮高度、边框对齐），并在内部实现圆角矩形与滑块动画（`translate-x`），且需支持 `t('key')` 国际化文案：
    ```tsx
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => setChecked(!checked)}
      className="flex items-center gap-2 cursor-pointer px-3 py-2 bg-white border border-slate-300 text-sm font-medium text-slate-700 rounded-lg hover:bg-slate-50 transition focus:outline-none focus:ring-2 focus:ring-[var(--color-bili-blue)] focus:ring-offset-1"
    >
      <div className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-[var(--color-bili-blue)]' : 'bg-slate-300'}`}>
        <span className={`inline-block h-3 w-3 transform rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </div>
      <span>{t('your.i18n.key')}</span>
    </button>
    ```

- **按钮与图标规范 (Button Icons)**:
  - 为了提供友好的视觉提示，左侧栏或其他主要操作按钮必须搭配语义对应的 Lucide 图标。例如，普通管理类用 `<Wrench>`，清理等带破坏/释放空间性质的操作应更换为 `<Eraser>` 或 `<Trash2>`，而不是复用一个图标。

- **多语言国际化 (i18n Strictness)**:
  - **所有的** UI 提示内容（包括但不限于弹窗 Toast、按钮文案、兜底的错误提示文字如“Copy Failed”，以及模态框的标题和空状态等）必须通过 `t('...')` 获取，并在对应的 `zh.json` 与 `en.json` 中定义好。
  - 严禁在页面结构或状态更新逻辑中直接硬编码中文/英文字符串。即使是拼装的字符串（如“共清理了 xx 条”）也推荐使用 i18n 的插值 `{t('key', { count })}` 来实现。

## 10. 状态机与防越权断言 (State Machine Integrity)
- **绝对隔离原则**: `not_downloaded` 和 `failed` 状态属于特殊的沙盒（Sandbox）状态。
  - `not_downloaded` 作为被动初始化的默认态，防止新录播大规模突发下载占用网络。
  - `failed` 作为放弃态，绝不可能被“重新同步（SyncAll）”或“全部继续（ResumeAll）”等操作卷入排队。
- **添加新状态的规范**: 若未来需要拓展新的 DB Status（如 `archived` 或 `exporting`），开发者**必须**同步执行以下前端绑定：
  1. 在 `frontend/src/locales/` 下分别建立完整的字典映射。
  2. 在 `frontend/src/App.tsx` 中将其合并到 `statusColor(status)` 的 UI Badge 颜色返回方法中。
  3. 审查它在 `['pending', 'failed', 'deleted', 'not_downloaded'].includes(displayStatus)` 单项操作（开始/暂停/恢复）动态判定数组中的行为边界。如果缺失，控制控件将直接渲染失效或完全丢失。
