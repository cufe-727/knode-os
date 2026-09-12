# Obsidian Vault 原生兼容设计

> 调研与实现基线：2026-07-18。

## 1. 目标

每个由 knode-os 创建的知识 bundle 都可以直接作为 Obsidian Vault 打开，
同时继续满足 OKF v0.2，并保持 knode-os 的摄入、检索和知识图谱语义。

Obsidian 的存储模型非常适合这一目标：Vault 就是包含子目录的本地文件夹，笔记
是普通 Markdown，Vault 根的 `.obsidian/` 保存该 Vault 的设置。Obsidian 会监测
外部文件变化，因此 knode-os 和 Obsidian 可以在同一批 Markdown 上协作，而不需要
专有数据库或同步转换层。

## 2. Vault 边界

```text
<data>/                         不是 Vault：运行时和原始数据容器
├── raw/
├── cooked/
├── .knode/
└── wiki/                      唯一的原生知识 Vault
    ├── .obsidian/
    │   ├── app.json
    │   └── .gitignore
    ├── attachments/
    ├── index.md
    ├── entities/
    ├── concepts/
    ├── sources/
    └── dreams/
```

用户应在 Obsidian 中选择“Open folder as vault”，打开 `<data>/wiki`，而不是
`<data>`。这样不会把原始文档、cooked 副本、sidecar 和数据库暴露为重复笔记，
也避免 Obsidian 官方不建议的 Vault-in-Vault 结构。

通过 `okf import` 创建的 `raw/docs/okf/<name>/` 和 `okf export` 创建的目标目录
也是各自独立的 Vault；它们不位于原生 `wiki/` Vault 内。

## 3. 默认 Vault 设置

新 Vault 的 `.obsidian/app.json` 使用以下保守设置：

```json
{
  "alwaysUpdateLinks": true,
  "newFileLocation": "folder",
  "newFileFolderPath": "concepts",
  "attachmentFolderPath": "attachments",
  "useMarkdownLinks": true,
  "showUnsupportedFiles": true
}
```

- 新笔记默认进入 `concepts/`；
- 新附件统一进入 `attachments/`；
- 重命名笔记时自动维护内部链接；
- 新链接优先写标准 Markdown，既被 Obsidian 支持，也满足 OKF 的跨工具契约；
- 已有 `[[Wikilink]]` 继续正常渲染和解析。

初始化严格非破坏：如果 `.obsidian/app.json` 已存在，knode-os 不会合并、重排或
覆盖用户设置。`.obsidian/.gitignore` 默认忽略高频变化的 `workspace*.json` 和
cache；Obsidian 官方也建议 Git Vault 忽略 workspace 布局状态。

## 4. 支持的 Obsidian 格式

### Properties

OKF frontmatter 同时就是 Obsidian Properties。`type`、`title`、`description`、
`resource`、`tags`、`aliases` 以及生产者扩展字段均可保留。生成器使用现代复数
字段 `tags`、`aliases`，不使用 Obsidian 已弃用的 `tag`、`alias`、`cssclass`。

Obsidian 不在可视化 Properties 编辑器中完整支持嵌套属性。OKF v0.2 的
`generated: { by, at }`、`verified`、`sources` 都是嵌套结构，因此生成器统一写成
单行 flow mapping：文件仍然有效，在 Properties 面板中折叠显示，可在 Source mode
直接编辑，knode-os 不会压平它。

### 内部链接

图谱层同时识别：

- `[[Note]]`
- `[[folder/Note]]`
- `[[Note#Heading|Label]]`
- `[[Note#^block-id]]`
- `![[Note]]` 和附件嵌入
- `[Label](folder/Note.md)`
- Properties 中用引号包裹的 `"[[Note]]"`

路径式 Wikilink 按 Vault 根解析；无路径短链接优先同目录，然后在 Vault 中按唯一
文件名解析。解析到真实笔记后，关系连接到该笔记 frontmatter 的 `title`，并写为
`links_to`；尚不存在或存在歧义的链接仍以宽容的 `mentions` 保留。

### 附件

附件保存在 `attachments/`。OKF 导入/导出复制所有非隐藏笔记和附件，但不复制
源 Vault 的 `.obsidian`、`.git`、workspace 或插件状态；目标端生成一套安全的
默认 Vault 配置。这样图片/PDF/音视频引用不会在交换后丢失，也不会把机器相关或
可能执行代码的插件配置带到另一个环境。

## 5. 生命周期

```bash
# 新建知识库：wiki/ 已经是 Vault
knode-os init --data ~/knode-data

# 检查并直接用 Obsidian 打开输出路径
knode-os obsidian status --data ~/knode-data

# 为已有任意目录补齐 Vault 结构；已有设置不覆盖
knode-os obsidian init ./existing-knowledge

# 外部 OKF/Obsidian bundle 导入后仍是独立 Vault
knode-os okf import ./team-vault --name team --data ~/knode-data

# 导出结果包含笔记、附件和新的安全 Vault 配置
knode-os okf export ./portable-vault --data ~/knode-data
```

## 6. OKF 与 Obsidian 的关系

两者在 Markdown + YAML 上天然重合，但职责不同：

| 维度 | OKF | Obsidian |
| --- | --- | --- |
| 目标 | Agent/系统间知识交换 | 本地知识创作与浏览 |
| 必填元数据 | `type` | 无 |
| 标准内部链接 | Markdown links | Wikilink 与 Markdown 都支持 |
| Reserved 文件 | `index.md`、`log.md` | 无 |
| Vault 设置 | 无 | `.obsidian/` |
| 附件 | v0.1 未专门建模 | 一等支持 |

因此 knode-os 以 OKF 作为可验证的最小交换合同，以 Obsidian 作为可直接使用的
编辑体验。标准 Markdown 链接是二者的最大公约数；Wikilink 和 embeds 是被保留
并理解的增强，而不是导出 bundle 唯一依赖的链接形式。

## 7. 一手资料

- [Obsidian：How Obsidian stores data](https://obsidian.md/help/Files%2Band%2Bfolders/How%2BObsidian%2Bstores%2Bdata)
- [Obsidian：Manage vaults](https://obsidian.md/help/Files%2Band%2Bfolders/Manage%2Bvaults)
- [Obsidian：Properties](https://obsidian.md/help/Editing%2Band%2Bformatting/Properties)
- [Obsidian：Internal links](https://obsidian.md/help/Linking%2Bnotes%2Band%2Bfiles/Internal%2Blinks)
