# Bilibili Automatic Replay Manager (自动录播下载与管控系统)

![Bilibili Replay Manager Dashboard](https://img.shields.io/badge/Status-Active-brightgreen) ![React UI](https://img.shields.io/badge/UI-React_Vite-blue) ![Go Backend](https://img.shields.io/badge/Backend-Golang-cyan)

Bilibili Automatic Replay Manager 是一套从底层并发架构到现代化前端（React + TailwindCSS）完全彻底重构的高度自治系统。旨在**全自动监听并提取** B 站指定直播间的生成录播资源，并通过**安全、可靠、强容错**的状态机队列管道进行并发下载与合流。

## 🪐 整体架构与技术底座

- **后端中枢驱动 (Backend)**：采用原生 `Golang` 构建高并发协程。所有的下载指令受本地 Semaphore 并发锁限制，内置强大的任务调度器来调配网络流量，并通过 WebSockets 直接对前端做无刷新实时推送。依靠 SQLite 来进行轻快透明的本地数据图谱留存。
- **动态防抖融合前端 (Frontend)**：抛弃古老的粗刷方案，基于 `React 18 + Vite`，以及全面铺排的国际化 `i18n` 语库重制。页面高度丝滑响应所有的指令收发操作，并利用 TailwindCSS 实现了极其养眼的基础现代面板展示。
- **底层合并引擎 (Merge)**：自带二进制打包的 `FFmpeg`，利用协程缓冲管线无损连接分片下载与合并进度。

## ✨ 核心特性

- **被动发现与沙箱隔离 (Passive Staging)**：
  系统在后台静默轮询更新时，为了绝对保护使用者的网络流量和硬盘空间，新发现的录播资源默认均放置在 `未下载 (not_downloaded)` 沙盒状态。你可以按需选择**单体列队**或是利用左侧操作板**一键全部唤醒入队 (Download Unfinished)**。

- **完美断点续传感知 (File-Level Breakpoint Resumption)**：
  因意外关机、手动暂停而停止的 `ts` 下载队列绝对不需要重头再来！所有的区块资源会在本地建立安全 `.tmp` 追踪，重新续跑一瞬间即可越过旧区块直接继承上一段落的末尾进度。

- **三段式退避内敛重试 (Exponential Fail-Over Backoffs)**：
  对抗 B 站偶尔的 HTTP 网络丢包/接口抽风。底层网络管线发生 `panic` 或报错时，非但保住排队坑位而且能分别执行如 5 秒、15 秒梯度的“原地隐层重试”。直到 3 次机会全部蒸发后，平稳降落到特殊的 `failed` 失败状态栏，由你决定是放弃还是通过特供入口去全军打捞。

- **绝对上下文穿透截停 (Context-bounded Immediate Cancellation)**：
  用户通过界面发出的暂停指令 (Pause)，将不受到任何冗余代码阻碍，直接穿透 Go 语言底侧触发网络流的协程级终结（`context.CancelFunc`）。做到真正的随点随停！

- **抗僵尸防越权同步 (Zombie & Ghost Prevention)**：
  系统具有自我巡逻机制。意外断电时被遗忘的数据库虚假 "downloading" 会被心跳捕获程序瞬间强拆为初始待命。并且无论你怎么点 "SyncAll" 或重启系统，已经 `failed` 或 `deleted` 的死亡任务永远不会像丧尸一样复活挤占网速。

## 🚀 快速上手教程

### ⚡ 基础启动操作
```bash
# 后端编译与启动 (保证存在 config.yaml 参数覆盖)
cd cmd && go build -o ../bin/main.exe
cd ../bin && ./main.exe

# 前端工程
cd frontend
npm install
npm run dev # 或者构建为 npm run build 后交由 Go 挂载
```

### 🎮 系统运行模式流转与说明 (User Workflow)
使用方式极简单。后台默默捕获的新鲜录播，默认以灰色 `未下载` 展示。
当你决定腾出手边的网速去收割他们时：
1. **单个入列**：对着卡片的**绿色播放按钮**点击，它会进入等待列队 `pending` 并听候发落。
2. **批量收割**：点击左侧面板的 `一键下载未完成 (Download Unfinished)` 按钮。
3. **路况控制**：
   - 随性分配网络。点击全局 `暂停所有进行中任务`（所有下载全部冻结掉落至 `paused` 沉睡，网络切断）。
   - 或者干脆点击单个录播旁边的 `暂停按钮` 单杀掉它，将其网络槽位移交给后面 `pending` 着的兄弟项目。
   - 等网速宽裕，再点击 `恢复所有挂起任务`，之前沉睡或排队的项目立马回到赛场。

## 📖 关于项目环境配置
参考根目录的 `config.yaml.example` 编写 `config.yaml`。其中可配置包含：
- **最大并发数** (`MaxConcurrentDownloads`)。
- **默认存放与拉取路径**。
- **请求频率控制** 和监控直播间的配置数组等。
