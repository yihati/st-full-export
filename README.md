# 全量导出（st-full-export）

一个 SillyTavern 第三方前端扩展：**一键把当前角色卡与群组关联的全部对话汇总成单个文件，一键把所有角色卡打包成单个 ZIP**。

不依赖任何服务端插件、第三方库或外部网络，所有导出都在浏览器本地完成。

> 主兼容目标为 **SillyTavern 1.15.0**（已按该版本源码核对），同时兼容 **1.19.1**。导出范围与未覆盖的情况见「[导出范围与数据兼容性](#导出范围与数据兼容性)」。

## 为什么需要全量导出

SillyTavern 自带的导出大多按单个角色或单段聊天进行，角色和聊天一多，逐个导出既繁琐又容易遗漏；角色卡文件也分散在数据目录中。

本扩展提供两个「全量」入口：一次汇总角色卡与群组关联的全部对话，一次打包所有角色卡。适合换机迁移、定期备份、归档留存，或者把内容交给脚本做二次处理。

## 目录

- [功能一览](#功能一览)
- [安装](#安装)
- [使用](#使用)
- [三种对话格式怎么选](#三种对话格式怎么选)
- [角色卡 ZIP 结构](#角色卡-zip-结构)
- [导出范围与数据兼容性](#导出范围与数据兼容性)
- [隐私提醒](#隐私提醒)
- [常见问题](#常见问题)
- [兼容性说明](#兼容性说明)
- [开发者说明](#开发者说明)

## 功能一览

- **功能 A：导出全部对话**
  - 汇总**当前角色卡与群组关联的全部聊天记录**，输出为**单个文件**（范围说明见下文）。
  - 支持三种格式：JSON（完整备份，默认）、JSONL（每行一条聊天）、TXT（纯文本阅读）。
  - 可选是否包含群聊；长任务显示进度条与当前处理项，运行中可随时取消。
  - 导出前会先尝试保存当前聊天；空聊天会被跳过并计数，只有元数据的聊天会标记保留。
- **功能 B：导出全部角色卡**
  - 输出为**单个 ZIP**，每张卡一个原始 PNG 文件（卡数据内嵌在 PNG 中，可直接拖回 ST 导入）。
  - ZIP 根目录附带 `index.json`（元数据与失败清单）和 `README.txt`（中文说明）。
  - 可选「同时附带 JSON 卡数据」，在 `json/<卡名>.json` 追加每张卡的 JSON。
- **通用能力**
  - 单次任务内的失败不会中断整体导出，结束后统一汇总，失败详情可折叠查看。
  - 两个导出按钮互斥运行：任务进行中按钮禁用，避免重复触发。
  - 面板挂在 SillyTavern 扩展设置区域，标题为「全量导出」。

## 安装

本扩展是**纯前端扩展**：不需要 Node 服务端插件，不需要修改 `config.yaml`，不需要安装任何依赖。安装就是把目录放进正确位置，然后刷新页面。

### 推荐：SillyTavern 1.15.0（本扩展的主兼容目标）

把扩展目录解压/复制到：

```
SillyTavern/public/scripts/extensions/third-party/st-full-export/
```

### SillyTavern 1.19.x

两种位置任选其一（源码核对两者都可用，同名扩展以用户目录优先）：

- 全局（所有用户可用）：`SillyTavern/public/scripts/extensions/third-party/st-full-export/`
- 当前用户：`SillyTavern/data/<user-handle>/extensions/st-full-export/`

> `<user-handle>` 是当前 SillyTavern 用户的 handle（数据目录名，默认通常是 `default-user`）。
> 1.15.0 的源码里也存在 `data/<handle>/extensions` 这条用户扩展路径，两种方式都能被同一 URL 挂载；不确定时优先用 `public/scripts/extensions/third-party/`。

### 目录名说明

本 README 以 `st-full-export` 为例；SillyTavern 并不强制第三方扩展的文件夹名，只要该目录根部有 `manifest.json` 即可。目录层级放错（不在 `third-party/` 或用户 `extensions/` 下）时不会被识别。

### 启用步骤

1. 刷新 SillyTavern 页面（建议 `Ctrl+F5` 强制刷新，避免加载到旧缓存）。
2. 打开「扩展程序 / Extensions」设置。
3. 在第三方扩展列表中确认「全量导出」已启用（开关打开）。
4. 面板出现在扩展设置区域，即可开始使用。

## 使用

### 导出全部对话

1. 在「全量导出」面板中，从下拉框选择格式：`JSON`、`JSONL` 或 `TXT`。
2. 按需勾选「包含群聊」。
3. 点击「导出全部对话」。
4. 等待进度条走完，期间不要关闭页面。
5. 完成后浏览器自动下载一个文件，文件名形如：

```
sillytavern-chats-YYYYMMDD-HHmmss.json
sillytavern-chats-YYYYMMDD-HHmmss.jsonl
sillytavern-chats-YYYYMMDD-HHmmss.txt
```

时间戳为本机本地时间。面板会显示统计信息、文件名以及失败数量。文件保存位置由浏览器决定（默认通常是「下载」目录）。

导出开始前，扩展会先调用 SillyTavern 的"保存聊天"（`ctx.saveChat`），尽量把最新消息写入磁盘；如果保存失败，面板会提示但继续导出。若当前有生成任务正在运行，面板顶部会常驻提示「当前有生成任务，导出可能不含最新消息」。

### 导出全部角色卡

1. 按需勾选「同时附带 JSON 卡数据」。
2. 点击「导出全部角色卡 ZIP」。
3. 等待进度条走完。
4. 浏览器下载一个文件：

```
sillytavern-characters-YYYYMMDD-HHmmss.zip
```

### 取消与失败详情

- 任务运行中会出现「取消」按钮。点击后任务尽快停止，**已下载或已生成的数据不会保存，浏览器不会产生文件**。
- 结束后若失败数大于 0，可展开失败详情，查看每一条失败的原因；失败不会中断其余条目的导出。
- **登录 / CSRF 失效会中止整次导出**：HTTP 401，或 403 且响应明确包含 CSRF 证据（如 `Invalid CSRF token`），或接口以 2xx 返回登录页 HTML 时，扩展会停止并提示刷新页面重新登录，不会下载空文件。除此之外的 404 / 500 / 502 / 504 等失败（包括 HTML 错误页、非 CSRF 的 403）只跳过对应条目并汇总到失败详情。

## 三种对话格式怎么选

| 格式 | 内容 | 适用场景 | 注意事项 |
| --- | --- | --- | --- |
| JSON | 完整导出，包含原始消息对象、swipes、`extra`、`chat_metadata` 等 | 长期备份、完整存档 | 体积最大；最终文件在内存中生成 |
| JSONL | 每行一条聊天记录 | 脚本/命令行逐行处理 | 不是单个 JSON 数组；**不比 JSON 省内存** |
| TXT | 纯文本，便于直接阅读 | 只想看内容、发给别人阅读 | 仅导出**当前 swipe**，不保留格式细节 |

**推荐**：长期备份用 JSON；二次处理或超大库用 JSONL；只想阅读用 TXT。

JSONL 的每一行都是一个完整的聊天对象 JSON，字段与 JSON 格式中 `chats` 数组的单条记录一致；行与行之间以换行分隔，没有外层数组。

> **JSONL 并不比 JSON 更省内存，也不是流式写入**：两种格式都会先把全部聊天记录读入内存，再一次性生成文件；JSONL 的优势只是行式结构便于脚本处理。
>
> **JSONL 不含 `stats` 与 `failures`**：它只有聊天记录本身，方便逐行处理。统计数字与失败清单只出现在面板结果、JSON（`stats` / `failures` 字段）和 TXT（统计行 / 末尾失败汇总）里。需要保留失败信息时请用 JSON 或 TXT。

### JSON 顶层结构

```json
{
  "format": "sillytavern-all-chats",
  "format_version": 1,
  "exported_at": "2026-01-01T00:00:00.000Z",
  "generator": "st-full-export 1.0.0",
  "stats": {
    "characters": 12,
    "groups": 2,
    "chats": 37,
    "messages": 4821,
    "failures": 0,
    "skipped_empty": 1
  },
  "chats": [],
  "failures": []
}
```

- `format`：固定标识，便于脚本识别。
- `format_version`：当前为 `1`，后续结构变化时会递增。
- `exported_at`：导出时间（ISO 8601）。
- `generator`：生成器标识与版本。
- `stats`：本次导出的统计信息（`characters`、`groups`、`chats`、`messages`、`failures`，以及被跳过的空聊天数 `skipped_empty`）。
- `chats`：聊天记录数组。
- `failures`：失败清单数组。

单条聊天记录的主要字段：

| 字段 | 说明 |
| --- | --- |
| `kind` | 记录类型：`character`（角色卡聊天）或 `group`（群聊） |
| `character` | 角色聊天时为 `{ name, avatar }`，群聊记录为 `null` |
| `group` | 群聊记录为 `{ id, name, members }`，角色聊天为 `null` |
| `file_name` | 聊天文件名 |
| `file_id` | 聊天文件标识 |
| `chat_metadata` | 原始聊天元数据 |
| `messages` | 原始消息对象数组（`send_date` 等字段原样保留，不做转换） |
| `message_count` | 消息条数 |
| `last_message` | 最后一条非空 `mes` 的 ≤300 字文本预览（不是完整消息对象） |
| `header_only` | 仅在该聊天只有元数据、没有消息时为 `true`（字段缺省表示正常聊天） |

## 角色卡 ZIP 结构

```
sillytavern-characters-YYYYMMDD-HHmmss.zip
├── Momo.png            ← 原始角色卡 PNG（含卡数据）
├── 另一个角色.png
├── index.json          ← 导出时间、数量、每张卡的 avatar/name/文件大小、失败清单
├── README.txt          ← 压缩包内的中文说明
└── json/               ← 仅当勾选「同时附带 JSON 卡数据」时存在
    └── Momo.json
```

### 为什么 PNG 可以直接再导入

SillyTavern 的角色卡数据以 base64 形式保存在 PNG 的 `tEXt` chunk 中：关键字为 `chara`，V3 卡为 `ccv3`。本扩展下载的是**磁盘上的原始 PNG 字节**，不重写、不清洗、不重新编码。因此把 ZIP 里的 PNG 拖回 SillyTavern 的「导入角色卡」，即可还原卡数据。

`/api/characters/export` 这类接口会重新生成 PNG，本扩展**故意不使用**，以免破坏原始字节。

### JSON 卡数据也能导入

`json/` 里是卡数据的 JSON 文本，可用于查看、编辑或二次处理。SillyTavern 也支持导入 JSON 角色卡，但 **JSON 无卡面图**（导入后没有头像图片）；不同版本的 JSON 导入支持略有差异。需要完整备份（卡面图 + 卡数据）时请使用 PNG。

> `json/<卡名>.json` 的文件名取自 avatar 文件名主干（不是卡片的显示名）；改名过的卡两者可能不同。

### 失败清单（index.json 的 failures）

一张卡可能只失败一半：

- **PNG 下载失败**：压缩包里没有该 PNG；
- **可选 JSON 获取失败**：PNG 仍在包里，只是缺少 `json/<卡名>.json`。

可结合 index.json 中的 `file` / `json_file` 字段判断。全部 PNG 都失败时，扩展会报错中止，不会生成只有 index/README 的空 ZIP。

### 内存与体积（单 ZIP 限制）

本扩展采用**单个 ZIP**（不自动分卷）：所有 PNG 会先进入浏览器内存，最后生成一个下载文件。角色卡达到数百张或数百 MB 时，可能触发浏览器内存不足、页面卡顿甚至标签页崩溃。扩展**没有内建的分批/选择功能**；只能手工处理：先移走/备份一部分角色的 `chats` 或 `characters` 目录再导出，或直接备份 SillyTavern 的 `data/<handle>/characters/` 目录。

## 导出范围与数据兼容性

### 导出范围（重要）

本扩展能枚举的是 SillyTavern 前端与接口能看到的聊天：

- **包含**：当前角色卡列表里每个角色的全部聊天，以及群组列表里每个群在 `group.chats` / `group.chat_id` 中列出的群聊。
- **不包含**：已删除角色卡遗留的孤儿聊天、`chats/` 根目录下遗留的聊天文件、不属于任何 group 记录的孤儿群聊等——纯前端（只调用 ST 现有接口）无法枚举它们，需要直接备份数据目录。
- 因此请不要把它当成"磁盘上 100% 全部聊天"的镜像；角色卡的 ZIP 导出不受聊天孤儿问题的限制。

### 旧版本聊天文件

- SillyTavern 1.15.0 起保存聊天时会在文件首行写入 metadata（header）行。
- 旧版本创建、且从未被 1.15+ 重写过的聊天文件没有这一行，首行就是普通消息。本扩展**按内容探测** header：没有 `mes` 字段且带有 `chat_metadata` / `user_name` / `character_name` / `create_date` 才当作 header，否则整份文件按消息处理，**不会丢掉第一条消息**。
- 同一聊天文件里可能混有 ISO 与旧版 humanized 的 `send_date`（如 `2024-1-1@12h00m00s123ms`）：JSON/JSONL 会原样保留，TXT 里无法解析的时间也原样显示，不强行转换。

### 空聊天与 header_only

- 0 条消息且没有可保留的 metadata：跳过该聊天，并在 `stats.skipped_empty` / TXT 统计里计数。
- 只有 header 且 metadata 非空：保留为一条记录，`messages: []`、`message_count: 0`，并标记 `header_only: true`，避免丢失聊天元数据。
- 群聊中的多条聊天按群聊 id 的可解析时间（humanized 或毫秒时间戳）从新到旧排序；无法解析时间的排在后面。角色聊天按最后消息时间从新到旧排序。

### 群聊与隐藏角色

- 群聊记录是否参与对话导出，由「包含群聊」开关控制。
- 群聊中的成员头像**不会单独导出**；群聊记录里引用的是成员卡文件名。
- 在 SillyTavern 中被隐藏或被排除的角色，只要仍在当前角色卡列表中，其聊天会照常导出。
- 当前正在编辑但尚未保存的聊天：导出前会先尝试保存一次；仍以磁盘上的文件为准。

## 隐私提醒

导出文件包含**导出范围内的全部聊天内容、角色卡数据，以及可能包含 API 配置性文本的元数据**。

- 文件在浏览器本地生成，**不会上传到任何服务器**，也不会向外部地址发起请求。
- 导出范围仅限当前角色卡与群组关联的聊天，不包含孤儿聊天（见上一节）。
- 本扩展导出的是磁盘原始 PNG，可能保留 `fav`（收藏）、`chat`（上次打开的聊天文件）等本地字段；对外分享前请先检查。
- 请妥善保管导出文件，不要随意分享或上传到公共网盘、公共仓库。
- 导出的 ZIP/JSON 可能体积较大，其中内容敏感，建议加密存储。

## 常见问题

**Q：导出时提示 401 / 未登录？**

A：SillyTavern 登录状态已过期。刷新页面并重新登录后重试；本扩展复用浏览器已有的同源会话。

**Q：导出时提示 403 / CSRF 校验失败？**

A：通常是会话或 CSRF token 过期，刷新页面（建议 `Ctrl+F5`）后重试。若仍失败，检查浏览器是否拦截了同源请求，并记录控制台报错。

**Q：导出非常慢，页面卡顿怎么办？**

A：导出量很大时受浏览器内存与主线程限制属正常现象。可以：

- 关闭其他占用内存的标签页；
- 保持本页面在前台，避免后台标签页被浏览器节流或挂起；
- 聊天库特别大时，**没有内建的分批/选择功能**，只能手工处理：先移走 `chats/` 中已导出的聊天目录，再次导出；或直接备份数据目录。JSONL 便于后续脚本处理，但同样会先把全部记录读入内存。

**Q：群聊导出为空？**

A：先确认「包含群聊」已勾选；其次确认该群确实存在聊天文件（新建但从未发言的群可能没有记录）。

**Q：某张角色卡导出失败？**

A：展开失败详情查看具体原因，常见为文件被其它程序占用，或文件名/路径包含非法字符。失败条目不会影响其它卡，可稍后重试。

**Q：ZIP 解压后文件名乱码？**

A：本扩展已为 ZIP 条目写入 UTF-8 标记，请使用 7-Zip 或系统自带解压工具。极老旧的解压工具可能仍显示乱码，但文件内容无损。

**Q：导出中途取消会怎样？**

A：任务停止，已生成的数据不会保存，浏览器不会产生下载文件。可调整格式或范围后重新导出。

**Q：导出的文件打不开或看不到内容？**

A：JSON 与 JSONL 是结构化文本，可用支持大文件的编辑器或 JSON 查看器打开；TXT 可直接用任意文本编辑器阅读。文件很大时普通编辑器可能加载缓慢。

**Q：为什么导出结果里没有某些聊天？**

A：本扩展只能枚举当前角色卡与群组关联的聊天。已删除角色卡遗留的孤儿聊天、`chats/` 根目录下遗留的聊天文件，纯前端无法发现；如果需要它们，请直接备份 SillyTavern 的 `data/<handle>/chats/` 目录。

**Q：为什么有的聊天被跳过，或者带 `header_only`？**

A：0 条消息且没有元数据的空聊天会被跳过（计入 `skipped_empty`）；只有首行 metadata、没有消息的聊天会保留并标记 `header_only: true`。这是正常现象，不影响其他聊天。

**Q：面板提示「当前有生成任务」？**

A：SillyTavern 正在生成回复，此刻磁盘上的聊天可能还没有最新消息，导出结果可能少一条。建议等生成结束后再导出。

**Q：角色卡很多，导出 ZIP 时浏览器卡死或提示内存不足？**

A：单 ZIP 方案需要在浏览器内存里汇总全部 PNG。角色卡达到数百张/数百 MB 时没有内建的分批功能，只能手工移走一部分角色卡后再导出，或直接备份 SillyTavern 的 `data/<handle>/characters/` 目录（详见「角色卡 ZIP 结构」的「内存与体积」）。

**Q：为什么导出按钮是灰色的？**

A：有任务正在运行。等待完成，或点击「取消」后再操作。

**Q：支持哪些 SillyTavern 版本？**

A：见下方「兼容性说明」。遇到问题请附上浏览器控制台报错。

**Q：如何卸载？**

A：删除扩展目录（`third-party/st-full-export/` 或 `data/<user-handle>/extensions/st-full-export/`），刷新页面，并在 SillyTavern 设置里关闭对应的扩展开关。

## 兼容性说明

- **主兼容目标：SillyTavern 1.15.0**（本扩展按该版本源码核对实现），同时兼容 **1.19.1**。
- 已在源码层核对的机制：
  - manifest 加载（`/scripts/extensions/<name>/manifest.json`，`js` 以 `type="module"` 注入）、`#extensions_settings2` 设置容器；
  - `getContext()` 中的 `characters`、`groups`、`extensionSettings`、`saveSettingsDebounced`、`saveChat`、`getRequestHeaders`；
  - `POST /api/characters/all`、`POST /api/characters/chats`、`POST /api/characters/get`、`POST /api/chats/get`、`POST /api/chats/group/get`、`POST /api/groups/all`；
  - 静态资源 `GET /characters/<avatar>`（原始 PNG 字节）；
  - CSRF 请求头。
- **尚未在真机 SillyTavern 上完整测试**，请以实际运行结果为准（本仓库只在源码层核对，未启动过 SillyTavern 实例）。
- 1.15.0 的 `getContext()` 不提供 `generating`，扩展会回退读取 `document.body.dataset.generating` 判断生成状态；1.19 若提供 `generating` / `isGenerating()` 也会使用。
- 对更老版本（1.12.x / 1.13.x）尽力兼容：`getContext()` 优先、端点与响应类型都做兜底；更老的聊天文件没有 header 时也能保留第一条消息。
- `manifest.json` 只使用两代版本都支持的字段（`display_name`、`js`、`css`、`author`、`version`、`loading_order`、`auto_update`，以及空的 `requires` / `optional` / `dependencies`），没有写 `minimum_client_version` 等可能影响加载的字段。
- 若在你的版本上失败，请提供浏览器控制台中的报错信息，便于定位是端点差异还是数据差异。

## 开发者说明

本扩展为原生 ES module，无构建步骤、无第三方依赖。文件结构：

```
st-full-export/
├── manifest.json         扩展清单
├── index.js              入口：注册扩展、挂载 UI
├── style.css             样式（.stfe- 前缀）
├── src/
│   ├── api.js            SillyTavern REST API 封装
│   ├── chats.js          全部对话的编排与导出
│   ├── characters.js     全部角色卡的导出
│   ├── format.js         JSON / JSONL / TXT 格式化
│   ├── zip.js            store-only ZIP 写入器（自实现，无 JSZip）
│   ├── names.js          文件名清洗与去重
│   ├── pool.js           并发控制
│   ├── util.js           通用工具
│   └── ui.js             设置面板与进度界面
└── tests/                单元测试
```

- ZIP 为自实现的 **store-only** 格式（不压缩），因此无需 JSZip 等库。
- 测试命令（项目为 `type: module`）：
  - Node 22+ / 24：`npm test`（等价于 `node --test "tests/*.test.js"`）
  - Node 18 / 20：`node --test tests/`（旧版测试运行器不支持 glob 参数，`npm test` 的 glob 写法可能找不到测试）

```bash
cd st-full-export
npm test
```

- 单元测试覆盖：ZIP 结构与 Python `zipfile` 交叉校验、三种对话格式、聊天编排（mock API）、角色卡导出（mock PNG 数据）、真实 `api.js` + 假 fetch 集成、假 DOM 的 UI 冒烟测试，以及旧聊天无 header、混合 `send_date`、空聊天跳过、`header_only` 等 1.15 兼容行为。
