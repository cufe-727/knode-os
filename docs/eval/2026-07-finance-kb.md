# 金融知识库构建与评测报告（2026-07）

用 rookie-trade 爬虫归档（雪球 / 微博 / 知识星球 / 淘股吧 / 红圈 / 分船，2026-04 ~ 2026-07，投资相关内容）构建 knode-os 知识库，并对构建性能、召回质量、端到端问答、抽取后端做了全套评测。所有原始报告在数据目录 `eval/reports/` 下（本次为 `~/knode-finance`）。

## 环境与配置

| 项 | 值 |
| --- | --- |
| chat 模型 | `doubao-seed-1.8-251228`（LLM Router，OpenAI 兼容 `/v1`） |
| embedding | `doubao-embedding`，4096 维，batch 32（>64 会触发 429，客户端已带指数退避） |
| 抽取并发 | tier-1 concurrency 8，日 token 预算 5000 万 |
| 存储 | PGlite + pgvector，`vector(4096)` 无索引 brute-force |

注意：Router 会按 api key 自动追加渠道后缀，模型名必须写成 `doubao-embedding` 而不是 `doubao-embedding___sre-data`。

## 语料

当时用 `knode-os import archive --since 2026-04 --until 2026-07 --relevant-only` 把归档按月拼成分卷（该命令已于 2026-09-29 移除，归档转 markdown 改由 rookie-trade 的 `crawler/archive-markdown.mjs` 负责）：

- 89 个 NDJSON 文件 → 6228 条帖子（过滤掉 905 条 investment_relevant=false），0 解析失败
- 产出 641 个 markdown 分卷（约 9000 字符/卷，与 tier-1 的 12000 字符截断上限对齐），共 8.9 MB
- 平台分布：xueqiu 2264 / zsxq 2073 / weibo 1166 / tgb 463 / redring 162 / fenchuan 100

## 构建性能（bench build，一次全量冷构建）

总耗时 **3h26m**，全程无人工干预，tier-1 队列清空。

| 阶段 | 耗时 | 产出 | 吞吐 |
| --- | --- | --- | --- |
| tier-0 ingest（分块+embedding+概念图） | 17m | 641 docs / 7177 chunks | 37.7 docs/min，422 chunks/min |
| tier-1 LLM 抽取 | 171m | 616 docs（1 失败），9089 实体 / 9571 关系 | 3.6 docs/min，~399 万 tokens |
| wiki generate（热点源摘要+实体桩页） | 14m | 50 页 | — |
| wiki refine（tier-2 社区聚类） | 3m | 5 个概念聚类页，542 条 claim 审计建议 | — |

构建后图谱规模：641 documents / 7177 chunks / 5677 entities / 61472 relations / 5480 claims。

瓶颈分析：tier-1 单文档 p50 约 116s（doubao-seed-1.8 是 reasoning 模型，思考 token 开销大），是总时长的主导项。换非 thinking 模型或加大并发可以线性压缩；embedding 阶段受 Router 限流（batch>64 429）约束。

## 召回质量（bench retrieval，100 条 LLM 生成 QA，ground truth = 出题 chunk）

| mode | chunk R@5 | chunk R@10 | doc R@5 | doc R@10 | chunk MRR | NDCG@10 | p50/p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| vector（4096 维） | 0.34 | 0.42 | 0.39 | 0.47 | 0.252 | 0.292 | 251/470ms |
| keyword | 0.51 | 0.55 | 0.54 | 0.58 | 0.418 | 0.450 | 467/527ms |
| **hybrid（RRF）** | **0.53** | **0.61** | 0.53 | **0.64** | 0.371 | 0.428 | 629/714ms |
| graph | 0.05 | 0.10 | 0.09 | 0.14 | 0.041 | 0.055 | 283/398ms |

关键发现与修复：

- 初版 keyword/graph 召回对中文问题几乎为零（R@10=0.02）——原按空格分词，中文自然语言问题整句无法匹配。修复为 CJK bigram 分词 + 问句停用词过滤（`queryTerms`，src/search/search.ts）后 keyword R@10 0.02 → 0.55，hybrid 0.43 → 0.61。
- 7177 chunks 规模下 4096 维 brute-force 向量检索 p50 251ms，可用；无需降维。
- graph 模式单独召回弱是预期行为（它面向实体导航，不是 chunk 召回），但作为 hybrid 的信号仍有贡献。
- 分平台 hybrid doc R@10：zsxq 0.82 / weibo 0.82 / xueqiu 0.52 / tgb 0.33——评论楼层类内容（雪球/淘股吧）碎片化重复多，是召回短板。

## 端到端问答（bench answer，20 题，LLM judge 0-2 分）

- 平均正确性 **1.6 / 2**（16 题满分、0 题 1 分、4 题 0 分）
- 金标文档引用率 **75%**，平均每答 2 条引用
- 延迟 p50 14.4s / p95 49.3s（含检索 + doubao 推理）

0 分案例主要是「知识库确实检索不到该 chunk 时模型如实说无法回答」，与召回短板一致。

## 抽取后端对比（bench extract-compare，12 个相同文档）

| backend | 成功率 | 延迟 p50/p95 | 实体/关系/claims 均值 | coverage | precision |
| --- | --- | --- | --- | --- | --- |
| doubao-seed-1.8（Router） | 12/12 | 116s/190s | 14.3 / 14.9 / 9.2 | 2.8 | 3.4 |
| codex-cli（gpt-5.6-sol） | 12/12 | 45s/187s | 14.3 / 13.8 / 9.8 | 2.8 | 3.6 |
| claude-cli | 0/12 | — | — | — | — |

- codex-cli 单文档反而比 doubao 快（doubao thinking 开销大），质量相当、precision 略高；但 CLI 只能串行、无并发，批量构建吞吐仍是 Router 占优（8 并发 = 等效 ~15s/doc）。
- claude-cli 全部失败：本机 `claude -p` 返回 `401 Invalid authentication credentials`，需要重新 `claude login` 后重跑（`knode-os bench extract-compare --backends claude-cli`）。
- coverage 偏低（2.8/5）是分卷含多篇帖子而抽取上限 15 实体所致，属提示词/上限调参空间。

## MCP 接入验证

- `knode-os connect codex` / `connect claude` 均注册成功。
- 直连 JSON-RPC 验证 MCP server：9 个工具正常，`knode_search` 0.7s 返回。
- `codex exec` 实测：能发现并调用 `knode-os/knode_search` 拿到结果。注意本机 codex 的 PermissionRequest 钩子会在非交互模式下取消 MCP 调用，需交互式确认或 bypass 审批；交互式 codex / claude 会正常弹权限确认。
- claude CLI 侧因上述 401 未能端到端验证（MCP 注册已完成）。

## 成本

- tier-1 抽取 ~399 万 tokens + wiki 生成/精炼 + QA 生成/裁判 ≈ 全程 500 万 tokens 量级（doubao 定价下成本很低）；embedding 约 8.9MB 文本 ≈ 500 万 tokens。
- 抽取结果持久化在每个文档的 `.knode.json` sidecar，重建 DB（删 `.knode/` 重新 ingest）零 LLM 成本回放。

## 复现步骤

当时导入语料用的 `import archive` 已移除。改用 rookie-trade 渲染的 markdown 时，文件是按月整份而不是约 9000 字符的分卷，上面的数字不会原样复现。

```bash
pnpm install && pnpm build
node dist/cli.js init --data ~/knode-finance          # 然后写入 Router 配置（见上表）
# 语料：把 rookie-trade crawler/archive-markdown.mjs 渲染的 markdown 放进 ~/knode-finance/raw/docs/finance/
node dist/cli.js --data ~/knode-finance bench build   # 全量构建 + 性能报告
node dist/cli.js --data ~/knode-finance bench qa-gen --n 100
node dist/cli.js --data ~/knode-finance bench retrieval --k 5,10
node dist/cli.js --data ~/knode-finance bench answer --n 20
node dist/cli.js --data ~/knode-finance bench extract-compare --n 12
node dist/cli.js --data ~/knode-finance connect codex   # / connect claude
```

## 后续改进建议

1. tier-1 换非 thinking 模型（如 doubao-1.6-flash）做首轮抽取，thinking 模型只精炼热点文档，构建时长可从 3.4h 压到 <1h。
2. 雪球/淘股吧评论楼层碎片召回差：渲染 markdown 时可按「主帖+评论」聚合为语义单元而非按大小分卷，或对评论卷做去重。
3. graph 信号在 hybrid 中权重（0.6）可用 QA 集网格搜索调优。
4. `bench retrieval` 已固定 QA 集（eval/qa.jsonl），后续改动检索管线时直接重跑即可回归对比。
