# China A-share factor collections, alpha libraries and research resources (beyond GTJA Alpha191 and WorldQuant 101)

Scope note (compiled 2026-10-31): mainland A-shares. Primary documents read directly: the original GTJA Alpha191 PDF, Liu–Stambaugh–Yuan working paper, MSCI CNE5 and new MSCI China model factsheets, DolphinDB module source, Qlib/RD-Agent/AKShare/RQAlpha/investment_data READMEs and configs, Tushare Pro permissions page. GitHub metadata (stars, last push, releases) was pulled with the GitHub API on 2026-10-31. The shared 200-search budget ran out partway through (shared with other agents), so some items (方正 2022–23 factor names, 光大/国信/招商 series counts, platform prices, Chinese factor books) are left in Gaps rather than guessed. Report counts below are counts of reports in the quant-wiki collection, not necessarily complete series.

## 1. Alpha191 itself: original report, intended use, errata and implementations

### Takeaway
"Alpha191" is 国泰君安 (Guotai Junan, now merged into 国泰海通) 金融工程's 《基于短周期价量特征的多因子选股体系——数量化专题之九十三》 (cover date 2017-06-15; analysts 李辰 and 刘富兵). It defines 191 daily price-volume factors for a *trading-type* (交易型) alpha model, rebalanced every T+2 days with 30–50x annual turnover. The printed formula appendix has real errors: swapped benchmark-index definitions, a LOWDAY definition copied from HIGHDAY, missing window arguments, a recursive Alpha143 and Fama–French inputs that are never supplied. Every implementation (DolphinDB, JoinQuant, GitHub) therefore makes its own interpretive choices.

### Cited Findings
- **Identity.** Title 《基于短周期价量特征的多因子选股体系》 ("A multi-factor stock-selection system based on short-horizon price-volume features"), subtitle "数量化专题之九十三" (Quantitative special report No. 93), 国泰君安证券研究 金融工程. Cover date 2017.06.15. Analysts 李辰 (Li Chen, SAC S0880516050003) and 刘富兵 (Liu Fubing, S0880511010017); the team page also lists 陈奥林, 孟繁雪 and research assistants. The JoinQuant-hosted file is named "…2017-06-16.pdf". Its 相关报告 (related reports) box lists an earlier report with the same title dated 2017.06.01 — [GTJA report PDF (JoinQuant mirror)](https://file.joinquant.com/198f09d54939dbcd27819bb96f67ac15/%E5%9B%BD%E6%B3%B0%E5%90%9B%E5%AE%89-%E6%95%B0%E9%87%8F%E5%8C%96%E4%B8%93%E9%A2%98%E4%B9%8B%E4%B9%9D%E5%8D%81%E4%B8%89%EF%BC%9A%E5%9F%BA%E4%BA%8E%E7%9F%AD%E5%91%A8%E6%9C%9F%E4%BB%B7%E9%87%8F%E7%89%B9%E5%BE%81%E7%9A%84%E5%A4%9A%E5%9B%A0%E5%AD%90%E9%80%89%E8%82%A1%E4%BD%93%E7%B3%BB-2017-06-16.pdf)
- **Contents.** "我们总共构建了 191个基于价格和成交量数据的短周期阿尔法因子" (191 short-horizon alphas from price and volume data). Inputs are OPEN/HIGH/LOW/CLOSE/VWAP/VOLUME/AMOUNT plus a benchmark index and, for Alpha30, Fama–French factors. The abstract says "近200个" (nearly 200) factors — [GTJA PDF](https://file.joinquant.com/198f09d54939dbcd27819bb96f67ac15/%E5%9B%BD%E6%B3%B0%E5%90%9B%E5%AE%89-%E6%95%B0%E9%87%8F%E5%8C%96%E4%B8%93%E9%A2%98%E4%B9%8B%E4%B9%9D%E5%8D%81%E4%B8%89%EF%BC%9A%E5%9F%BA%E4%BA%8E%E7%9F%AD%E5%91%A8%E6%9C%9F%E4%BB%B7%E9%87%8F%E7%89%B9%E5%BE%81%E7%9A%84%E5%A4%9A%E5%9B%A0%E5%AD%90%E9%80%89%E8%82%A1%E4%BD%93%E7%B3%BB-2017-06-16.pdf)
- **Intended use (short-horizon, high-turnover).** The report positions these as "交易型阿尔法" (trading alpha) that complements fundamental multi-factor models:
  - effective horizon "一般都在1周以内" (generally within one week);
  - style-neutral strategy rebalanced at "T+2日频率", holding about 50–60 stocks;
  - annual two-sided turnover about 30–50x, versus about 10x for traditional models;
  - factor tests run 2010-01 to 2017-04.
  - Claimed result for 2012-01 to 2017-04, net of all costs versus CSI 500: 50.2% annualized excess return, 5.9% max drawdown, IR 4.67, and a break-even two-sided cost near 1%.

  — [GTJA PDF](https://file.joinquant.com/198f09d54939dbcd27819bb96f67ac15/%E5%9B%BD%E6%B3%B0%E5%90%9B%E5%AE%89-%E6%95%B0%E9%87%8F%E5%8C%96%E4%B8%93%E9%A2%98%E4%B9%8B%E4%B9%9D%E5%8D%81%E4%B8%89%EF%BC%9A%E5%9F%BA%E4%BA%8E%E7%9F%AD%E5%91%A8%E6%9C%9F%E4%BB%B7%E9%87%8F%E7%89%B9%E5%BE%81%E7%9A%84%E5%A4%9A%E5%9B%A0%E5%AD%90%E9%80%89%E8%82%A1%E4%BD%93%E7%B3%BB-2017-06-16.pdf)
- **Errata and ambiguities in the printed text** (read from the PDF's text layer) — [GTJA PDF](https://file.joinquant.com/198f09d54939dbcd27819bb96f67ac15/%E5%9B%BD%E6%B3%B0%E5%90%9B%E5%AE%89-%E6%95%B0%E9%87%8F%E5%8C%96%E4%B8%93%E9%A2%98%E4%B9%8B%E4%B9%9D%E5%8D%81%E4%B8%89%EF%BC%9A%E5%9F%BA%E4%BA%8E%E7%9F%AD%E5%91%A8%E6%9C%9F%E4%BB%B7%E9%87%8F%E7%89%B9%E5%BE%81%E7%9A%84%E5%A4%9A%E5%9B%A0%E5%AD%90%E9%80%89%E8%82%A1%E4%BD%93%E7%B3%BB-2017-06-16.pdf):
  - **Benchmark fields swapped and misspelled.** Appendix 2 defines "BANCHMARKINDEXCLOSE 基准指数的开盘价" (= benchmark *open*) and "BANCHMARKINDEXOPEN 基准指数的收盘价" (= benchmark *close*). These are used in Alpha75, 149, 181 and 182, and "BENCHMARK" is misspelled throughout.
  - **LOWDAY copied from HIGHDAY.** "LOWDAY(A, n) 计算A前n期时间序列中最大值距离当前时点的间隔" uses *最大值* (maximum), the same wording as HIGHDAY.
  - **Fama–French inputs not supplied.** Alpha30 = `WMA((REGRESI(CLOSE/DELAY(CLOSE)-1,MKT,SMB,HML，60))^2,20)` needs FF3 factor returns, which the report never provides. The appendix also labels them "HML SMB MKE" (typo for MKT), and `DELAY(CLOSE)` has no lag.
  - **SUMAC used without its window.** SUMAC(A, n) is defined with n but called without it in Alpha165 and Alpha183. Both are also printed without grouping parentheses: `MAX(SUMAC(CLOSE-MEAN(CLOSE,48)))-MIN(SUMAC(...))/STD(CLOSE,48)`.
  - **Typos in individual formulas.**
    - Alpha23 contains `STD(CLOSE:20)`.
    - Alpha28's second term uses `MAX(HIGH,9)-TSMAX(LOW,9)`, which does not match its first term `TSMAX(HIGH,9)-TSMIN(LOW,9)`.
    - Alpha181's final `SUM(...^3)` has no window.
    - Alpha190 uses `DELAY(CLOSE)` with no lag.
    - Alpha166 contains a full-width "（20-1）" and a missing operator, `(20-2)(SUM(`.
  - **Alpha143 is recursive.** `CLOSE>DELAY(CLOSE,1)?(CLOSE-DELAY(CLOSE,1))/DELAY(CLOSE,1)*SELF:SELF`, where SELF is "t-1 日的 Alpha143 因子计算结果" (the previous day's value). No initial value is given.
  - **Operator conventions differ from WorldQuant's.**
    - RANK(A) is defined as "向量A升序排序" (an ascending ordinal sort, not a percentile rank).
    - WMA uses weights 0.9^i (exponential, not linear).
    - DECAYLINEAR uses weights d, d−1, …, 1, normalized.
    - SMA(A,n,m) is the recursive 通达信-style average Y_i = (A_i·m + Y_{i−1}·(n−m))/n, i.e. an EMA with α = m/n.
- **DolphinDB `gtja191Alpha` module.**
  - Implements all 191 factors as `gtjaAlpha1…gtjaAlpha191`, taking matrix inputs.
  - Standard fields: tradetime, securityid, open, close, high, low, vol, vwap, index_open, index_close.
  - Compatible with DolphinDB 2.00.9 and 1.30.21+.
  - RANK/TSRANK return percentiles by default, and SUMAC(A,n) is computed as SUM(A,n) "since the original definition was unclear".
  - The same code runs in batch and streaming via `streamEngineParser`; the helper `gtja191Prepare.dos` maps column names.

  — [DolphinDB docs](https://docs.dolphindb.cn/zh/modules/gtja191Alpha/191alpha.html); tutorial copy on [Juejin](https://juejin.cn/post/7169781549129596964)
- **DolphinDB's interpretive choices** (read from the module source):
  - SMA is implemented as `ewmMean` with α = m/n, e.g. `alpha=2\7` for SMA(…,7,2), consistent with the report.
  - `gtjaAlpha30(close,index_close, MKT, SMB, HML)` requires user-supplied FF factors.
  - Alpha143 is a cumulative product starting at 1 that multiplies by the *raw* return on up days.
  - Alpha144 substitutes vol×vwap for AMOUNT.
  - Alpha165/183 follow the printed precedence literally and implement single-argument MAX/MIN as *cross-sectional* `rowMax/rowMin` of 48-/24-day rolling sums.

  — [gtja191Alpha.dos](https://github.com/dolphindb/DolphinDBModules/blob/master/gtja191Alpha/1.0.0/src/gtja191Alpha.dos)
- **DolphinDBModules repo.** Also contains `wq101alpha`, `alphalens`, `mytt`, `ta` and `EasyTushare` modules; last pushed 2026-10-12 (GitHub API) — [DolphinDBModules](https://github.com/dolphindb/DolphinDBModules)
- **JoinQuant (聚宽).** A third-party index of JoinQuant's docs says to use `data/Alpha101.md` and `data/Alpha191.md` for alpha factors and `jqlib.technical_analysis` for technical indicators. It also notes that local `jqdatasdk` differs in API from the in-platform `jqdata` and cannot be used inside JoinQuant's backtest or research environment — [third-party JoinQuant docs index](https://skillselion.com/skills/lzwme/finance-quant-skills/joinquant-docs) (secondary)
- **Other implementations:**
  - `shrektan/techfactor`: R/C++ framework for "GTJA 191 Alphas"; 28 stars, last push 2024-09-11 — [GitHub](https://github.com/shrektan/techfactor)
  - `yupoet/aurumq-rl`: RL stock selection for A-shares with a bundled polars-native factor library (Alpha101 plus GTJA191); 56 stars, pushed 2026-07-24 — [GitHub](https://github.com/yupoet/aurumq-rl)
  - `MurphyHoops/alphas`: alpha101/alpha191 with alphalens and backtrader notebooks; dormant since 2023-04 — [GitHub](https://github.com/MurphyHoops/alphas)
  - JoinQuant-style `GTJA_Alpha191.py` gist — [gist](https://gist.github.com/kangchihlun/7850f07c11bdea022b2d49f1d4ed9802)
  - `py-alpha-lib-private` on PyPI, reporting 190 of 191 factors computed — [PyPI](https://pypi.org/project/py-alpha-lib-private/)
  - an "Alpha191" dataset on [IEEE DataPort](https://ieee-dataport.org/documents/alpha191)
- **Cross-market reuse.** A January 2026 arXiv paper tests GTJA-style short-term factors on US stocks with double-selection LASSO. A paper in the same search results (attribution per search snippet) dropped 23 of the 191 for missing values or unstable rolling computations and kept 168 — [arXiv 2601.06499](https://arxiv.org/pdf/2601.06499)
- **Originator is now 国泰海通证券.** Research previously branded 海通 (e.g. the weekly 高频选股因子周报) is now issued as "[国泰海通证券]", e.g. the weeks of 2025-12-15 and 2026-03-02 — [fxbaogao 20251215-19](https://www.fxbaogao.com/detail/5196356); [fxbaogao 20260302-06](https://www.fxbaogao.com/detail/5288808)

### Inferences
- Because of the swapped benchmark definitions, the missing windows and the under-specified Alpha30, 143, 165, 166, 181, 183 and 190, roughly 10–15 Alpha191 factors are implementation-defined. Backtests from DolphinDB, JoinQuant and GitHub code are not directly comparable without reconciling these.
- Taken literally, Alpha143 multiplies the running value by a small return on every up day, so it collapses toward zero. The intended formula was almost certainly (1+return)·SELF, which makes DolphinDB's literal implementation of doubtful economic meaning.
- The 50.2% annualized excess return is an in-sample figure from the pre-crowding 2012–2017 window, earned with 30–50x turnover. It should be read as historical context, not a benchmark: later microstructure crowding (Section 7) and the 2025 high-frequency rules raise costs and reduce capacity for exactly this style.
- Correction to the brief: the report is 数量化专题之九十三 dated 2017-06-15 by 李辰 and 刘富兵. The "2017-06-16" date comes from the JoinQuant file name.

### Gaps
- No official GTJA erratum was found. JoinQuant's own Alpha191 documentation page could not be retrieved, so whether `jqlib.alpha191` is maintained in 2026 and which conventions it uses (percentile or ordinal RANK, SMA α) is unverified.
- What the 2017-06-01 report of the same title was (a preview or roadshow version) is unknown.

## 2. Broker 金融工程 factor-research series treated as canonical

### Takeaway
The deepest sell-side corpus is in high-frequency/microstructure, order-flow and analyst-expectation factors.
- **Mature series:** 海通 选股因子系列研究 (numbered to at least #88, with Level-2 work from 2016), 华泰 多因子系列 (a 13-report single-factor-test canon) plus 华泰人工智能系列 (at least 63 reports), 东方 因子选股系列 (#113 by April 2025), 广发 多因子 (to #51) plus 高频 and 深度学习 sub-series, 长江 基础因子研究/高频因子 (2019–2021), 中信建投 因子深度研究 (14 reports) and 国盛 多因子 (17 reports).
- **Factor-family originators:** 开源 市场微观结构研究系列 (聪明钱 smart money, 大小单 order-size flows, 2020–2026), 东吴 CPV, 招商 高频寻踪, 兴业 高频研究, 天风 市场微观结构探析, and 方正's 2017 and 2020 microstructure series.
- **Continuity risk:** several flagship authors (东方's 朱剑涛, 华泰's 林晓明 and 何康, 中信建投's 丁鲁明) left for the buy side in 2024–2026.

### Cited Findings
**Series catalogue** (counts are PDFs in the quant-wiki collection, not necessarily complete series):

| Broker / series (gloss) | Span and count evidence | Representative factor families (report no., date) | Source |
|---|---|---|---|
| 海通 选股因子系列研究 (stock-selection factor research) | 83 PDFs, numbered to at least #88 | #1 reversal ("弱者终有逆袭日，强势几无持续时"); #5 net turnover; #11 Level-2 factors (2016-06-06); #19 HF return-distribution/skew (2017-05-05); #21 consensus expectations; #22 analyst coverage; #25 realized-vol decomposition / downside-vol share (2017-09-09); #37 idiosyncratic momentum; #42–44 factor crowding; #57 active buying; #59 tick-trade factors (2020-02-23); #61 HF long-leg failure (2020-03-22); #69 "高频因子的现实与幻想" (2020-07-30); #71 large tick orders; #76 deep-learning HF factors (2021-12-28); #87–88 multi-granularity deep learning | [quant-wiki 海通 list](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/海通-选股因子系列/index.md); [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/) |
| 海通→国泰海通 高频选股因子周报 (weekly HF factor tracker) | weekly through at least 2026-03 | tracks 高频偏度, 下行波动占比, 开盘后买入意愿, 大单净买入, 改进反转, 尾盘成交占比, 平均单笔流出金额占比, 大单推动涨幅, GRU/attention-LSTM and 多颗粒度 deep-learning factors, plus CSI500/CSI1000 AI-enhanced portfolios | [Sina copy 2024-02-19](https://finance.sina.cn/2024-02-19/detail-inaiprfr2828837.d.html?vt=4); [fxbaogao](https://www.fxbaogao.com/detail/5288808) |
| 华泰 多因子系列 (multi-factor) | 13 PDFs | single-factor tests by family: valuation, growth, momentum, turnover, volatility, **money flow (资金流向, #7)**, financial quality, **consensus expectations (一致预期, #9)**, factor synthesis (#10), "海量技术因子" (#11), structured risk model (#12), historical-percentile factors (#13) | [quant-wiki 华泰多因子](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/华泰-多因子系列/index.md) |
| 华泰 人工智能系列 (AI) | 63 PDFs (#1–#63) | GLM/SVM/RF/Boosting/NN/RNN (#2–9); GP factor mining 遗传规划 (#21, #23); AlphaNet (#32, #34, #46); BERT sentiment 舆情 (#37) and analyst-report sentiment (#41); Qlib (#40, #42, #53); GNN (#42, #55); text PEAD/FADT (#51, #57, #63); GP mining of consensus factors (#54); analyst co-coverage (#58, #61) | [quant-wiki 华泰AI](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/华泰-人工智能系列/index.md) |
| 东方证券 因子选股系列 (factor stock selection) | ≈100 reports led by 朱剑涛; #107 DFQ-XGB (2024-08-15); DFQ-FactorVAE-pro (2025-02); #113 时点风险模型 (point-in-time risk model; 2025-04-20, 杨怡玲) | ML alpha models (XGB, FactorVAE), risk models | [fxbaogao #113](https://www.fxbaogao.com/detail/4781436); [Sina 2026-06-29](https://finance.sina.cn/2026-06-29/detail-inieznpi0346179.d.html) |
| 广发 多因子系列 + 高频数据因子 + 深度学习 | 46 PDFs (to #51); HF 7 PDFs (#1–9); DL 6 PDFs (#3–8) | consensus indicators (#22, #39); "海量技术指标" (#21, #42); money flow and style (#37); geographic linkage (#43–44); SemiBeta (#45, #47); price jumps (#46); fund attributes (#49); deep-learning HF factor mining (#51); intraday HF, herding and information asymmetry (HF #1–9) | [quant-wiki 广发多因子](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/广发-多因子系列/index.md); [广发高频](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/广发-高频因子系列/index.md); [广发深度学习](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/广发-深度学习系列/index.md) |
| 长江 基础因子研究 / 高频因子 (basic factor research / HF factors) | 高频因子(二) (2019-06-01) to (十二) (2021-06-06); 金工高频识途 (2017) | structured reversal; HF research framework; idiosyncratic vol; high-price-volume matching; reversal microstructure; intraday vs overnight; estimated active-trade share; buy-behaviour sentiment (2017-03-10) | [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/) |
| 中信建投 因子深度研究系列 (factor deep-dive; quant-wiki labels it "中信") | 14 PDFs | idiosyncratic-vol pure factor; Barra versus the 中信建投 system (#3); size timing; consensus system (#6); revision momentum (#7); earnings surprise (#8); HF order-book liquidity (#10); order imbalance and spread (#11); multi-level imbalance and slope (#12); 金股 (broker top-pick) portfolios (#14) | [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/中信-多因子系列/index.md) |
| 国盛 多因子系列 + 因子择时 (factor timing) | 17 numbered + 3 others | Lasso return prediction; short-leg optimization; value redesign; growth decomposition; inter-day price-volume; intangibles; fund heavy holdings; report quality; post-revision drift (#15); factor timing via factor momentum, dispersion and crowding | [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/国盛-多因子系列/index.md) |
| 渤海 多因子模型研究系列 | 14 PDFs | single-factor tests; bandit / Thompson sampling; **Barra CNE6 single-factor tests (#8) and pure factors (#9)**; Alpha101 re-mining (#14) | [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/渤海-多因子系列/index.md) |
| 星火多因子专题报告 (quant-wiki label "方正财通") | 14 PDFs | Barra model introduction, advanced and pure factors (#1–3); idiosyncratic momentum (#5); HF idiosyncratic skew (#9); robust Beta (#10); surprise plus reversal (#11); quality growth (#12); analyst upgrades (#13) | [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/方正财通-星火系列/index.md) |
| 逐鹿Alpha专题报告 (quant-wiki label "财通中信") | 18 numbered + 1 review | consensus mining (#1); q-factor in A-shares (#2); "聪明的资金流向" (#3); southbound flows (#4); **northbound institutional holdings (#6, #8)**; limit-order book (#11); AutoML-Zero (#12); OpenFE (#13); Qlib Alpha360 + TFT (#9); TiDE (#17); Model Zoo (#18) | [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/财通中信-逐鹿系列/index.md) |

**Microstructure and alternative-data originators** (dates from the quant-wiki HF index unless noted) — [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/):
- **开源证券 (魏建榕 team).** 市场微观结构研究系列 (market microstructure series): (15) intraday per-trade amount and main-force behaviour, 2022-06-12; (18) 大小单资金流 alpha 2.0 (order-size money flow), 2022-12-18. 开源量化评论: (11) northbound high-frequency data, 2020-11-14; (13) "高频股东数据的隐含信息量" (high-frequency shareholder-count data), 2020-12-31; (36) 2021-09-24.
- **东吴证券.** "技术分析拥抱选股因子"(一) 高频价量相关性 (CPV), 2020-02-23; "波动率选股因子"(二) 信息分布均匀度, 2020-09-01; a CPV futures version, 2020-06-18.
- **招商证券.** "高频寻踪" (HF tracing): 交易指令流中的Alpha (alpha in order flow), 2020-06-20; 之二, 2021-01-07. "琢璞" literature series: informed trading in HF data, 2019-10-29 and 2020-06-30.
- **兴业证券.** 高频研究系列: return-distribution factors, 2022-01-23 and 2022-05-04; 市场微观结构剖析, 2022-11-09.
- **天风证券.** 买卖压力失衡 (buy-sell pressure imbalance), 2017-08-01; 市场微观结构探析系列之四, 2020-05-14.
- **方正证券.** "聆听高频世界的声音"(六), on Benford's law and institutional traces in minute volume, 2017-08-13; 市场微观结构剖析系列6, 2020-02-27. 华安证券 published 市场微观结构剖析之七 on 2020-06-10.
- **Others.** 国联 机构主动资金流 (Level-2 institutional active flow), 2022-07-19; 国金 Alpha掘金系列之二 (snapshot price-volume divergence), 2022-11-18; 信达 minute-bar factors, 2022-04-28; 东兴 snapshot behaviour tracking, 2021-10-15; 中泰 追踪"聪明资金" (fund-holding tracking), 2021–2022.

**开源's 聪明钱 (smart-money) factor over time** — [Sina copy of 开源金工 report, 2026-08-29](https://finance.sina.cn/2026-08-29/detail-inipyfhv5524506.d.html)
- 2.0 (2020; 魏建榕, 傅开波, 高鹏): a minute-level "smartness" score S_t; the factor is the VWAP of the high-S_t bars (top 20% of cumulative volume) divided by overall VWAP. For 2021-07 to 2026-04 it shows RankIC −6.4%, long-short 16.82% and IR 2.09.
- 3.0 (2026-08-28): extends to tick trades, tick orders and snapshots. The composite shows RankIC −7.21%, long-short 27.59% annualized and IR 3.21. Correlations with Barra styles are mostly below 20%, except liquidity and residual volatility.
- The same team's 市场微观结构研究系列(20) (August 2023) uses genetic algorithms to mine trading-behaviour factors — [fxbaogao](https://fxbaogao.com/detail/3829955)
- 魏建榕 is 开源证券研究所 deputy director and chief quant analyst; representative series are 《开源量化评论》, 《市场微观结构》 and 《开源基金研究》 — [PKU Econ lecture page](https://econ.pku.edu.cn/xkzy/jrxx/xkdt2/xkdtzs/376726.htm)

**Crowding research.**
- 海通 "高频赛道拥挤了吗？——从2021年四季度量化私募的回撤说开去" ("Is the HF lane crowded? On quant private funds' Q4 2021 drawdown"), 2022-04-19 — [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/)
- 海通 因子拥挤度 (factor crowding) #42–44 — [quant-wiki 海通](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/海通-选股因子系列/index.md)

**Barra style tracking.** 山西证券 publishes a weekly 金工因子周报 tracking Barra styles (volatility, momentum, Beta, value, liquidity, earnings, growth, non-linear size) — [fxbaogao](https://www.fxbaogao.com/detail/5544894)

**People and continuity:**
- 朱剑涛: led ≈100 东方 因子选股 reports; joined 光大保德信基金 in 2024 as head of quant investment — [Sina 2026-06-29](https://finance.sina.cn/2026-06-29/detail-inieznpi0346179.d.html)
- 林晓明 (华泰 chief quant for about ten years) joined 海南思瑞私募 as chief economist on June 3 (article dated 2026-10-09). 何康, who led 华泰人工智能系列 and co-initiated 《中国量化投资白皮书》 (China Quant Investment White Paper), joined 上海波克私募 as CIO. 丁鲁明 (中信建投 chief quant) left in July 2025 to found 上海睿成私募 — [Sina 2026-10-09](https://finance.sina.cn/2026-10-09/detail-iniuqywq1106497.d.html)
- The 国泰海通 HF weekly continues under analysts including 余浩淼 and 郑雅斌 (per search-result summary). Recent titles report "高频因子表现持续回撤，多粒度因子多头继续回撤" (HF factors keep drawing down; multi-granularity long legs keep drawing down) — [fxbaogao 5574002](https://www.fxbaogao.com/detail/5574002); [fxbaogao 5531269](https://www.fxbaogao.com/detail/5531269) (pages now 404 or undated)

### Inferences
- Which series introduced which families:
  - **Intraday/HF and Level-2:** 海通 (2016–2022), 长江 (2019–2021), 方正/华安 (2017–2020), 招商, 兴业 and 天风.
  - **Order flow/资金流:** 华泰多因子#7, 开源 (2020–2022), 国联, 中信建投 #10–12 and 逐鹿 #3.
  - **Analyst consensus/一致预期:** 华泰多因子#9, 海通 #21/#22/#28, 广发 #22/#39, 中信建投 #6–8/#13–14, 逐鹿 #1 and 华泰AI #54/#58/#61.
  - **Northbound flows:** 逐鹿 #6/#8 and 开源量化评论(11).
  - **Shareholder counts/股东户数:** 开源量化评论(13).
  - **Text and sentiment:** 华泰AI #37/#41/#51/#56/#57/#63 and 长江 2017.
  - **Crowding:** 海通 #42–44 and 国盛 因子择时.
- The sell side documented decay early. 海通 #61 (2020-03) and #69 (2020-07) address HF factors' long-leg failure, and the 2022-04 crowding report followed the Q4 2021 drawdown. That matches the crowding story in Section 7.
- Microstructure-series numbering runs 方正 #6 (2020-02) then 华安 #7 (2020-06), which suggests the 方正 microstructure team moved to 华安 in 2020. The quant-wiki labels "方正财通" and "财通中信" likewise suggest the 星火 and 逐鹿 series moved brokers with their authors. This is an inference, not verified.
- Given the 2024–2026 departures, check authorship and date before treating any series' latest instalment as the "house view".

### Gaps
- **方正金工 2022–2023 factors.** Not verified because the search budget ran out. Practitioner lore names the 多因子选股系列 factors 适度冒险, 勇攀高峰 and 云开雾散; these names are recalled, not sourced.
- **Series not covered.** No series-level data for 光大, 国信, 招商 or 兴业 beyond HF, or for 天风 beyond microstructure.
- **筹码分布 and 调研 factors.** No originating series identified for chip-distribution or company-visit (调研) event factors.
- **东方 "DFQ" risk model.** Could not be confirmed. Only DFQ-prefixed ML models (DFQ-XGB, DFQ-FactorVAE-pro) and the 2025 时点风险模型 were found, so "DFQ risk model" in the brief may conflate these.
- **聪明钱 1.0.** Origin date and broker unverified; believed to be 2016, possibly at 东吴, by 魏建榕.
- **Factor counts per series.** Mostly unavailable; I could count reports, not factors. 华泰人工智能系列's last number and its LLM-era reports beyond #63 are not covered.
- **Licensing.** quant-wiki redistributes broker PDFs and books; licensing is unclear (see Section 6).

## 3. Academic China factor models and anomaly studies

### Takeaway
Three bodies of evidence define the academic China factor zoo:
- **CH-3/CH-4** (Liu, Stambaugh & Yuan): size net of the shell-contaminated bottom 30%, E/P value, and a turnover-based sentiment factor (PMO).
- **Large replications** (Li, Liu, Liu & Wei 2024: 469 anomalies, about 83–87% insignificant once microcaps are de-weighted; Jansen, Swinkels & Zhou 2021: 32 anomalies) show that value, risk/volatility, trading/turnover and reversal effects survive while momentum, quality and investment are weak.
- **Machine learning** (Leippold, Wang & Zhou 2022): liquidity is the top predictor, and retail-driven short-horizon predictability is concentrated in small stocks.

### Cited Findings
- **Liu, Stambaugh & Yuan, "Size and Value in China"** (Journal of Financial Economics, 2019) — [working paper PDF](https://faculty.wharton.upenn.edu/wp-content/uploads/2018/03/Size-and-Value-in-China.pdf); publication venue per [Alpha Architect](https://alphaarchitect.com/size-and-value-in-china/) (search summary):
  - **Shell value.** The size factor excludes the smallest 30% of firms because they are "valued significantly as potential shells in reverse mergers that circumvent tight IPO constraints". 83% of Chinese reverse mergers use shells from the smallest 30%, and for a typical bottom-30% stock about 40% of market value reflects shell value.
  - **Value.** Measured by the earnings-price ratio, which "subsumes the book-to-market ratio".
  - **Sample.** 2000-01-01 to 2016-12-31.
  - **Against FF-3.** A plain FF-3 replication "leaves a 17% annual alpha on the earnings-price factor". Of 10 anomalies unexplained by the CAPM, CH-3 explains 8 and FF-3 explains 3. Average absolute alpha is 4.80% for CH-3 versus 10% for FF-3.
  - **CH-4.** Adds a turnover factor capturing sentiment (individuals own 88% of free float; more than 101 million accounts) and "explains the turnover and reversal anomalies… handling all of China's reported anomalies".
  - **Other factors.** Investment has no significant CAPM alpha in China, and profitability is fully explained by CH-3.
- **CH-4 turnover factor (PMO).** Labelled pessimistic-minus-optimistic and built on abnormal turnover, defined as 20-day average daily turnover divided by 250-day average — [appendix PDF](https://finance.wharton.upenn.edu/~stambaug/size_value_china_appendix_2_rev.pdf) (per search summary)
- **CH-3/CH-4 data.** Stambaugh's page links "CH-3 factors, monthly, updated" hosted externally at Mingshi, plus CH-3 daily and CH-4 monthly/daily CSVs "through 2021", file-stamped 20211231. An online appendix gives Wind data mappings — [Stambaugh profile page](https://fnce.wharton.upenn.edu/profile/stambaug); [Mingshi database](https://en.mingshiim.com/database); [CH-4 monthly CSV](https://faculty.wharton.upenn.edu/wp-content/uploads/2016/11/CH_4_fac_update_20211231.csv)
- **Li, Liu, Liu & Wei, "Replicating and Digesting Anomalies in the Chinese A-Share Market"** (Management Science 70(8):5066–5090, 2024):
  - replicates 469 Hou–Xue–Zhang-style anomaly variables;
  - 83.37% show no significant high-minus-low quintile raw spread, rising to 84.22% on CAPM alphas and 86.99% on FF3 alphas;
  - uses mainboard breakpoints and value-weighting, arguing that all-A-share equal-weighted sorts overweight microcaps with "very limited investment capacity";
  - CH-3, CH-4 and the q-factor model fit best over the full sample, and the q-factor model fits best post-2007 (after split-share reform and IFRS-converged accounting).

  — [IDEAS/RePEc](https://ideas.repec.org/a/inm/ormnsc/v70y2024i8p5066-5090.html); [PolyU PDF](https://ira.lib.polyu.edu.hk/bitstream/10397/115240/1/Li_Replicating_Digesting_Anomalies.pdf)
- **Jansen, Swinkels & Zhou, "Anomalies in the China A-share market"** (Pacific-Basin Finance Journal 68, 101607, 2021):
  - tests 32 anomalies over 2000–2019;
  - value, risk and trading anomalies carry over; size, quality and past-return anomalies are much weaker, except a strong residual momentum and reversal effect;
  - first China tests of residual reversal and return seasonalities (strong out-of-sample) and connected-firm momentum (not significant);
  - results are not driven by industry, short-sale limits, SOEs or reforms;
  - data released under CC-BY-4.0 (DOI 10.25397/eur.19771261.v1).

  — [Erasmus pure](https://pure.eur.nl/en/publications/anomalies-in-the-china-a-share-market/); [dataset record](https://b2find.eudat.eu/dataset/03f8f667-9f94-594b-9d4c-882d53408023)
- **Leippold, Wang & Zhou, "Machine learning in the Chinese stock market"** (JFE 145:64–82, 2022; also titled "Machine-Learning in the Chinese Factor Zoo"):
  - liquidity is the most important predictor, unlike in the US, which leads to a close look at transaction costs;
  - retail dominance raises short-term predictability, especially in small stocks;
  - fundamentals matter more and price-trend signals less than in the US;
  - out-of-sample profits remain economically significant after costs.

  — [Swiss Finance Institute](https://www.sfi.ch/en/publications/machine-learning-in-the-chinese-stock-market); [ZJU summary](https://zibs.zju.edu.cn/enzibs/2024/0729/c82471a2972355/page.htm)
- **Critique of CH-4.** A trend-factor model by Zhou and coauthors reports that the value-weighted turnover factor "fails to produce significant alpha" in their four-factor model and explains anomalies that LSY-3/4 leave unexplained — [AEA 2021 presentation](https://topcat.aeaweb.org/conference/2021/preliminary/powerpoint/3T4YbyH4) (from a search-result summary; not opened)
- **Further China anomaly papers** (titles only; not read):
  - "Chinese stock anomalies and investor sentiment" (Pacific-Basin Finance Journal 73, 2022) — [IDEAS](https://ideas.repec.org/a/eee/pacfin/v73y2022ics0927538x22000348.html)
  - "Fundamental anomalies and the size puzzle in China: A data mining approach" (Finance Research Letters 42, 2021) — [IDEAS](https://ideas.repec.org/a/eee/finlet/v42y2021ics1544612320317219.html)
  - "Market ambiguity, investor sentiment and market anomalies – Evidence from the Chinese A-share market" (Research in International Business and Finance 75, 2025) — [IDEAS](https://ideas.repec.org/a/eee/riibaf/v75y2025ics0275531924005142.html)
- **Open factor datasets.** Ke Zhang (2024), "Common factors in China A share market" (Value, Quality, Growth and Tech factors; last updated December 2024) — [TIB](https://service.tib.eu/ldmservice/dataset/1d527ff9-5adf-42f9-91d7-7ea94d0f9a01)
- **Sell-side bridge to academia.**
  - 逐鹿Alpha #2 tests the q-factor model in A-shares — [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/财通中信-逐鹿系列/index.md)
  - 华安 "学海拾珠" and 招商 "琢璞" translate and replicate academic papers (e.g. informed-trading indicators, 2019–2020) — [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/)

### Inferences
- **Durable A-share effects** across academic and sell-side work:
  - small size, once shell value is netted out;
  - E/P value;
  - turnover, illiquidity and abnormal-turnover sentiment;
  - short-term reversal (海通 #1 is literally titled on reversal);
  - volatility and lottery-type effects;
  - residual or idiosyncratic momentum (海通 #37, 星火 #5).
- **Weak or absent:** raw momentum, investment, and quality/profitability once CH-3 is in the model.
- **Method matters.** Equal-weighted, all-board results overstate tradable alpha; Li et al.'s mainboard value-weighted design is the stricter benchmark.
- **Data timeliness.** The official CH-3/CH-4 CSVs stop at 2021-12-31, so studies after 2021 must rely on the externally hosted monthly CH-3 series or rebuild the factors.

### Gaps
- No China replication by "Hou, Qiao & Zhang" was found. The brief may conflate it with Hou–Xue–Zhang (US), which Li et al. replicated in China.
- Not verified this session (search budget): Carpenter–Lu–Whitelaw (2021), Lee–Qu–Shen on reverse-merger shell value, Hu–Chen–Shao–Wang (2019), and the JKP global factor database's China coverage.
- CNKI-indexed Chinese-language studies (e.g. 中国工业经济 ML papers) were not accessed. The relationship between Mingshi and the LSY authors is not established here.

## 4. Risk models and commercial factor libraries/platforms (what an individual can get)

### Takeaway
MSCI's Barra line runs from CHE2 to CNE5 (10 styles, 32 GICS industries, daily/short/long horizons), then CNE6 (used in broker work), then a new-generation MSCI China model (22 styles, 31 local-classification industries, SOE, crowding and ML factors; factsheet saved 2025-01). It is institutional and unpriced publicly. For individuals the practical routes are platforms with factor libraries and trials: JoinQuant (hundreds of factors, Barra-style returns via jqdatasdk), RiceQuant (RQData trial; RQAlpha non-commercial), 优矿 (still online, 400+ factors), BigQuant (AI platform, competitions) and 果仁 (no-code screening). Prices were not publicly visible on the pages I could read.

### Cited Findings
- **MSCI Barra China Equity Model (CNE5):**
  - 10 style factors and 32 GICS-based industry factors; "2,200+ assets covered, including all China A Shares"; daily history back to February 1999;
  - Daily, Short and Long horizon versions;
  - new versus CHE2: Residual Volatility and Beta replace Volatility, Non-linear Size is added, and Value is split into Book-to-Price and Earnings Yield;
  - delivered through Barra Portfolio Manager, Aegis and Models Direct.

  — [MSCI CNE5 factsheet](https://www.msci.com/documents/10199/2935796a-0a80-4050-934a-12966d1e2518)
- **CNE5 style factors and descriptors.**
  - The 10 style factors are Beta, Momentum, Size, Earnings Yield, Residual Volatility, Growth, Book-to-Price, Leverage, Liquidity and Non-linear Size — [CNE5 descriptor reproduction](https://zhiqiang.org/media/images/notes/202106/ea021009818156021bdc3e00d100b151.pdf) (secondary, via search summary)
  - Earnings Yield = 0.68·analyst-predicted E/P + 0.11·trailing E/P + 0.21·cash E/P.
  - Residual Volatility blends DASTD, CMRA and HSIGMA, orthogonalized to Beta (252-day window, 63-day half-life).
  - Non-linear Size is cubed Size orthogonalized to Size.

  — [CNE5 descriptor reproduction](https://zhiqiang.org/media/images/notes/202106/ea021009818156021bdc3e00d100b151.pdf)
- **New-generation MSCI China model** ("新一代 Barra 中国股票(本地行业分类)因子模型"):
  - 22 style factors, 31 industry factors on a Chinese local classification, and 5,000+ stocks (8,000+ including Stock Connect Hong Kong names);
  - style families: volatility, dividend yield, quality, momentum, value, size, sentiment, macro, growth, liquidity, non-linear;
  - new features: point-in-time fundamentals, an SOE-ownership factor, adaptive factor covariance, a stock-crowding factor, a machine-learning factor for non-linear exposure-return links, and peer-similarity scores;
  - value now merges B/P and E/P into one factor;
  - long-term and trading model variants;
  - access via Snowflake, BarraOne, Barra Aegis, Barra PortfolioManager, Models Direct or third-party vendors;
  - the attribution example covers 2019-11 to 2024-11, and the PDF was last modified 2025-01-15.

  — [MSCI China factor model factsheet](https://www.msci.com/documents/1296102/44119643/MSCI+China+Factor+Model+Factsheet+-cfs-ch.pdf)
- **CNE6 in broker research.** 渤海 多因子模型研究系列 #8 runs Barra CNE6 single-factor tests and #9 builds pure factors and composites — [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/渤海-多因子系列/index.md)
- **Other vendor models.** FactSet publishes a Chinese-language China equity model summary brochure — [FactSet PDF](https://go.factset.com/hubfs/Website/Resources%20Section/Brochures/china-equity-model-summary-brochure-chinese.pdf) (not opened)
- **Broker risk-model work:**
  - 华泰多因子系列12 结构化多因子风险模型 (structured multi-factor risk model) — [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/华泰-多因子系列/index.md)
  - 星火 #1–3 (Barra model introduction, risk forecasting, pure factors) and #8 (covariance estimation) — [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/方正财通-星火系列/index.md)
  - 中信建投 因子深度研究 #3 (Barra versus 中信建投's system) — [quant-wiki](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/中信-多因子系列/index.md)
  - 东方 #113 时点风险模型 (2025-04-20) — [fxbaogao](https://www.fxbaogao.com/detail/4781436)
- **JoinQuant (聚宽) factor library:**
  - `jqdatasdk.get_factor_values` returns named factors (e.g. VOL5, 5-day average turnover); the library holds "数百个" (hundreds of) factors across quality, sentiment, risk and other families; trial accounts are available — [jqfactor_analyzer on PyPI](https://pypi.org/project/jqfactor-analyzer)
  - `get_factor_style_returns` and `get_factor_specific_returns` supply style, industry and country factor returns and specific returns for Barra-style attribution in the open-source `jqfactor_analyzer` (711 stars, last push 2025-02-20) — [GitHub README](https://github.com/JoinQuant/jqfactor_analyzer)
- **RiceQuant (米筐):**
  - RQAlpha, the open-source backtester, is "仅限非商业使用" (non-commercial use only); 6.8k stars, last push 2026-10-28.
  - The same README promotes RQData (Python, Matlab and Excel APIs) with a free trial and private deployment for professional investors.

  — [RQAlpha README](https://github.com/ricequant/rqalpha)
  - RiceQuant shifted to B2B (banks, asset managers, brokers) in 2017 — [Dealroom](https://app.dealroom.co/companies/ricequant) (via search summary)
- **优矿 Uqer (通联数据 DataYes).** The homepage is still online ("优矿 - 大数据时代的量化投资 - 通联量化实验室", footer "优矿 Beta"). It advertises a 400+ factor library, "量化因子库全新升级 & 全新增加187个数据选股指标", a professional-edition application and free trial requests. No closure notice and no dates appear — [uqer.datayes.com](https://uqer.datayes.com/)
- **BigQuant (宽邦科技, Chengdu):**
  - an AI quant platform offering ML/DL frameworks, an AI factor library and cloud compute (2019 profile) — [36Kr](https://www.36kr.com/p/1724787245057)
  - ran factor competitions including 2025 high-frequency-factor contests — [BigQuant competitions](https://fund.bigquant.com/square/competition)
  - founder 梁举 spoke on AI-native research infrastructure in July 2026 — [CLS](https://www.cls.cn/detail/2437249)
- **果仁网 (Guorn):**
  - a no-code wizard strategy builder with "海量因子指标" (a large factor library), screening, ranking and custom formulas;
  - claims full-market 10-year backtests in seconds that avoid look-ahead and survivorship bias;
  - offers a strategy marketplace and live automated trading;
  - homepage promotions include a 30-day premium membership and coupons, but no list prices.

  — [guorn.com](https://guorn.com/)
- **WorldQuant BRAIN.** The consultant page offers "100,000+ data fields from 8+ regions" — [BRAIN consultant program](https://platform.worldquantbrain.com/consultant-program). A student report shows alphas run with Region CHN (Top3000 universe, delay 0, sector neutralization) — [Scribd report](https://www.scribd.com/document/733973604/Worldquant-Report) (weak source). Official CHN-universe documentation was not accessible.

### Inferences
- MSCI's 2025 model and broker crowding research converge: crowding, SOE ownership and non-linear (ML) effects are now treated as risk factors, not only alphas.
- For an individual in 2026, CNE5/CNE6-style exposures are most cheaply approximated through JoinQuant's style-return API or self-built Barra replications, following the 渤海, 星火 and 华泰 recipes.
- Paid institutional data remains the moat: Wind, 聚源, 朝阳永续 consensus forecasts and Level-2 tick data. The microstructure factors in Section 2 mostly need Level-2 or tick data.

### Gaps
- No prices found for JQData, RQData, Uqer professional, 掘金量化 (its homepage rendered only a title), 同花顺 iFinD/SuperMind, Wind, 聚源 or Barra.
- Not verified: 朝阳永续 (Go-Goal/Suntime) consensus database coverage and history; the official name and launch date of MSCI's new China model (whether it is marketed as a CNE6 successor); CNE6's factor list; the Axioma China model.
- Not verified: BRAIN's CHN universe definitions and whether China data is open to non-consultant individuals.
- RiceQuant's and JoinQuant's homepages are JavaScript-only, so 2026 service changes could not be checked.

## 5. Open-source A-share tooling with factor sets: maintenance status and data caveats (as of 2026-10-31)

### Takeaway
The open stack is alive and actively maintained:
- Qlib (v0.9.8, 2026-10-08; about 50k stars) with Alpha158/Alpha360 and a CSI300/CSI500 model zoo; its official China dataset is still "disabled temporarily", and community data (chenditc/investment_data, daily releases) substitutes.
- RD-Agent (v1.0.0, 2026-09-23) adds LLM-driven factor and model loops (RD-Agent(Q), NeurIPS 2025).
- DolphinDB ships WQ101 and GTJA191 modules.
- AKShare (several releases a day) is free but "for academic research".
- Tushare's legacy GitHub repo is dormant (2024-03); Tushare Pro is a points-gated hosted API.

Qlib's benchmark backtest ends in August 2020, and its CSI500 table contains copy errors.

### Cited Findings
- **Qlib maintenance and data.** 49,849 stars; last push 2026-10-30; releases v0.9.8 (2026-10-08) and v0.9.7 (2025-08-15) (GitHub API) — [microsoft/qlib](https://github.com/microsoft/qlib). The README says:
  - "Due to more restrict data security policy. The official dataset is disabled temporarily. You can try this data source contributed by the community" (chenditc/investment_data);
  - data "collected from Yahoo Finance… might not be perfect";
  - offline data cannot be incrementally updated, so users must re-collect via the Yahoo collector;
  - a `check_data_health.py` script is provided.

  — [Qlib README](https://github.com/microsoft/qlib)
- **Alpha360 and Alpha158 definitions.** Alpha360 is the last 60 days of six raw fields (close, open, high, low, vwap, volume), normalized by the latest close or volume. Alpha158 is hand-engineered k-bar, price, volume and rolling-operator features over windows 5/10/20/30/60 — [Qlib loader.py](https://github.com/microsoft/qlib/blob/main/qlib/contrib/data/loader.py); [benchmarks README](https://github.com/microsoft/qlib/blob/main/examples/benchmarks/README.md)
- **Benchmark design.** CSI300 against SH000300; train 2008–2014, validation 2015–2016, test 2017-01-01 to 2020-08-01; topk 50, n_drop 5; open cost 5 bp, close cost 15 bp; limit threshold 9.5% — [LightGBM Alpha158 config](https://github.com/microsoft/qlib/blob/main/examples/benchmarks/LightGBM/workflow_config_lightgbm_Alpha158.yaml)
- **Benchmark results** (mean of 20 seeds) — [benchmarks README](https://github.com/microsoft/qlib/blob/main/examples/benchmarks/README.md):
  - CSI300, Alpha158: DoubleEnsemble IC 0.052, annualized excess 11.58%, IR 1.34; LightGBM 9.01% / 1.02; XGBoost 7.80%; Linear 6.92% / 0.92.
  - CSI300, Alpha360: HIST 9.87% / IR 1.37; IGMTF 9.46%; TRA 9.20%; Transformer −2.70% and TabNet −3.69%.
  - CSI500, Alpha158: LightGBM 12.84% / IR 1.57.
  - Copy error: the CSI500 DoubleEnsemble rows repeat the Linear row's portfolio metrics (0.0382 / 0.1723 / −0.4876).
- **Broker adoption of Qlib.** 华泰AI #40 (Qlib trial), #42 (GNN with Qlib) and #53 (Microsoft AI quant research) — [quant-wiki 华泰AI](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/华泰-人工智能系列/index.md); 逐鹿 #9 (Qlib Alpha360 + TFT) — [quant-wiki 逐鹿](https://github.com/LLMQuant/quant-wiki/blob/master/docs/advanced/研报精选/财通中信-逐鹿系列/index.md)
- **RD-Agent:**
  - 15,151 stars; v1.0.0 released 2026-09-23 (v0.8.0 on 2025-11-03);
  - RD-Agent(Q) is described as "the first data-centric, multi-agent framework" for factor–model co-optimization and was accepted at NeurIPS 2025;
  - it claims that "at a cost under $10… approximately 2× higher ARR than benchmark factor libraries while using over 70% fewer factors";
  - CLI entry points: `rdagent fin_factor`, `fin_model`, `fin_quant`, and `fin_factor_report`, which extracts factors from financial reports.

  — [RD-Agent README](https://github.com/microsoft/RD-Agent); [arXiv 2505.15155](https://arxiv.org/abs/2505.15155)
- **chenditc/investment_data** (community Qlib data):
  - 1,550 stars, with daily releases (latest 2026-10-31);
  - merges Wind and Caihui ("high quality static data source. Only available till 2019"), Tushare, AKShare, Yahoo and Baostock;
  - rescales adjustment factors across sources, back-fills delisted companies, and publishes limit-price tables;
  - needs a Tushare token, and its CI needs a VPS with 30 GB+ RAM;
  - the README documents a 2026 publication-pipeline incident ("Do not re-enable publication until validator-backed digest pinning… are restored"; "repair-2026-07-20").

  — [investment_data README](https://github.com/chenditc/investment_data)
- **AKShare.** 23,143 stars; v1.20.18 published 2026-10-30, the second release that day. Disclaimer: "All data provided by AKShare is just for academic research purpose" — [akfamily/akshare](https://github.com/akfamily/akshare)
- **Tushare:**
  - The legacy open-source `waditu/tushare` repo was last pushed 2024-03-13 (15.5k stars) — [GitHub](https://github.com/waditu/tushare)
  - Tushare Pro's permissions page sets points thresholds: 120 (daily bars), 2000 (most stock, fund, futures, bond and FX interfaces including `daily_basic` and financial statements), 3000 (`share_float`), 4000 (`index_dailybasic`) and 5000 (`fund_portfolio`, `opt_daily`). Points are access thresholds, not consumed, and higher tiers get higher call frequency — [Tushare Pro doc 108](https://tushare.pro/document/1?doc_id=108)
  - New users hitting "没有接口访问权限" (no interface permission) errors is a common issue — [GitHub issue #1844](https://github.com/waditu/tushare/issues/1844)
  - Third-party tutorials say minute data requires a separate donation (¥1,000 cited), with 2000 points for financials and 300 for weekly/monthly bars in older articles — [aliyun article](https://developer.aliyun.com/article/1750997) (secondary; may be outdated)
- **Factor-analysis and trading frameworks** (GitHub API):
  - `alphalens-reloaded` (Stefan Jansen's maintained alphalens fork): 681 stars, pushed 2026-10-26 — [GitHub](https://github.com/stefan-jansen/alphalens-reloaded)
  - vn.py: 46k stars, pushed 2026-10-27 — [GitHub](https://github.com/vnpy/vnpy)
  - QUANTAXIS: 11.3k stars, pushed 2026-09-18 — [GitHub](https://github.com/yutiansut/QUANTAXIS)
- **DolphinDB.** Modules include `wq101alpha` and `gtja191Alpha`, with batch and streaming support; repo pushed 2026-10-12 — [DolphinDBModules](https://github.com/dolphindb/DolphinDBModules); [DolphinDB 191 docs](https://docs.dolphindb.cn/zh/modules/gtja191Alpha/191alpha.html)

### Inferences
- **Qlib's results are stale.** The bundled benchmark (test window to 2020-08, CSI300) predates the 2021–2026 regime changes: the micro-cap boom and bust, 2024 short-sale and northbound changes, and the 2025 HFT rules. It should not be quoted as current performance; rebuild with point-in-time data and current costs.
- **Data quality for free sources.** The key A-share-specific caveats are survivorship (delisted names), limit-up/limit-down tradability, suspensions, ST status and adjustment-factor consistency across sources. investment_data's cross-source adjustment and limit tables address some of these. Yahoo-based Qlib data addresses none explicitly.
- **AKShare's "academic research" disclaimer.** It and its scraping-based design imply no SLA on schema stability; frequent releases are both maintenance and churn.

### Gaps
- baostock's 2026 maintenance status could not be checked: its site and PyPI were blocked to the fetch tool, though it remains a listed source for investment_data.
- No independent empirical audit of AKShare, Tushare or Baostock data accuracy was found.
- Whether JoinQuant's `jqlib` Alpha101/191 modules are publicly sourced is unknown.

## 6. Books and communities

### Takeaway
Verified anchors are 丁鹏《量化投资：策略与技术》 (2012) and the community-maintained quant-wiki 中文量化百科, which indexes broker report series and hosts PDFs, with licensing unclear. Platform communities (BigQuant competitions; RiceQuant and JoinQuant forums) and university lecture series featuring broker chief quants also serve this role. Other expected canon items (石川 et al., 川总写量化, Chinese translations of Grinold–Kahn and others) could not be verified before the search budget ran out.

### Cited Findings
- **丁鹏《量化投资：策略与技术》** (Quantitative investment: strategies and techniques), 电子工业出版社, 2012. It covers 60+ cases across quant stock selection, timing, index-futures and commodity arbitrage, stat arb, options arbitrage, algorithmic trading and asset allocation, with AI, data-mining, wavelet, SVM and fractal tools — [quant-wiki book list](https://github.com/LLMQuant/quant-wiki/blob/master/docs/library/book/beginner.md)
- **quant-wiki 中文量化百科** (LLMQuant):
  - 4,387 stars, last push 2026-04-16 (GitHub API) — [LLMQuant/quant-wiki](https://github.com/LLMQuant/quant-wiki)
  - indexes broker series (华泰 AI and 多因子, 海通 选股因子, 广发, 中信建投, 国盛, 渤海, 星火, 逐鹿) and an "A股高频研报" page with 81 PDFs from 21 brokers — [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/)
  - its book library lists "101 Formulaic Alphas" as "因子投资入门经典" (a factor-investing classic for beginners) — [quant-wiki book list](https://github.com/LLMQuant/quant-wiki/blob/master/docs/library/book/beginner.md)
- **Chinese translation of Berkin & Swedroe.** *Your Complete Guide to Factor-Based Investing* appears as 《因子投資》 (大雁文化, translator 李玮; Taiwanese edition) — [eslite listing](https://www.eslite.com/product/10012117772683129507001)
- **University lecture series.** PKU School of Economics / 北京大学金融工程实验室 runs a "金工首席谈" (chief quant analysts talk) series with sell-side chief quants as speakers; its 16th session was held 2023-03-16. 华泰's 林晓明 appears among the lecturers, described as 华泰证券研究所金融工程首席分析师 — [PKU Econ](https://econ.pku.edu.cn/xkzy/jrxx/xkdt2/xkdtzs/369088.htm); [PKU Econ](https://econ.pku.edu.cn/xkzy/jrxx/xkdt2/xkdtzs/360475.htm)
- **Platform communities:**
  - BigQuant runs factor-mining competitions, including 2025 HF-factor contests — [BigQuant](https://fund.bigquant.com/square/competition)
  - RQAlpha's README still describes Ricequant as an open community with free backtesting, paper trading and competitions (wording may predate the B2B pivot) — [RQAlpha README](https://github.com/ricequant/rqalpha)
  - JoinQuant open-sources `jqfactor_analyzer` for single-factor and attribution analysis — [GitHub](https://github.com/JoinQuant/jqfactor_analyzer)

### Inferences
- Practitioners appear to learn A-share factor work mainly from broker series, collected via quant-wiki, 慧博, 萝卜投研 and fxbaogao, plus platform notebooks, rather than from textbooks. The book canon is thin and dated (2012), which raises the importance of the academic papers in Section 3.
- quant-wiki redistributes broker PDFs and full books (e.g. a folder named "algorithmic-and-high-frequency-trading-pdf-free"). Users should treat it as an index and obtain originals from brokers or licensed platforms.

### Gaps
- Not verified because the search budget ran out: 石川, 刘洋溢, 连祥斌《因子投资：方法与实践》 (recalled as 电子工业出版社, 2020); 石川's 川总写量化 公众号/知乎 column; 量化投资与机器学习 and similar 公众号.
- Also not verified: Chinese editions of Grinold & Kahn (《主动投资组合管理》), Tulchinsky et al. *Finding Alphas*, Narang *Inside the Black Box*, and López de Prado *Advances in Financial Machine Learning*.
- 聚宽 and 米筐 forum activity in 2026 was not checked.

## 7. How A-share factor performance has shifted (dated account, 2016 → October 2026)

### Takeaway
- **Pre-2017:** the small-cap premium was inflated by shell value.
- **2016-09 to 2017:** the M&A crackdown and faster IPOs destroyed shell value.
- **2017–2020:** price-volume and high-frequency factors were mined intensively; by 2020 brokers already documented long-leg decay.
- **Q4 2021:** a crowding drawdown.
- **2021–2023:** micro-cap exposure fed quant excess returns.
- **January–February 2024:** a micro-cap liquidity crash with weekly excess drawdowns above 10%.
- **2024–2025:** regulation removed or reshaped inputs and strategies: the end of real-time and daily northbound data, the suspension of 转融券, programmatic-trading rules and HFT thresholds.
- **2025:** a banner year (average index-enhancement excess about 17%).
- **2026:** excess returns collapsed in May–June as narrow tech leadership broke reversal and small-cap factors, then a July drawdown hit crowded momentum and tech-growth factors.

### Cited Findings
- **≤2016: shell value distorts size.** 83% of reverse mergers use bottom-30% shells, and about 40% of a typical bottom-30% stock's value is shell value (2000–2016 sample) — [LSY working paper](https://faculty.wharton.upenn.edu/wp-content/uploads/2018/03/Size-and-Value-in-China.pdf)
- **2016-09: the crackdown begins.** The CSRC revised 《上市公司重大资产重组管理办法》 (major asset-restructuring rules), dubbed the strictest ever. By 2017-12-14 only 6 backdoor listings had been initiated in 2017, about 70% fewer than the 20 in 2015 — [CS.com.cn 2017-12-15](https://cs.com.cn/ssgs/gsxw/201712/t20171215_5625024.html)
- **2017-05: shell market reverses.** With IPOs accelerating, shells went from "一壳难买" to "一壳难卖" (hard to buy → hard to sell), backdoor-listing costs fell 30–40%, and the IPO-versus-backdoor time gap shrank to 6–12 months — [NBD 2017-05-08](https://www.nbd.com.cn/articles/2017-05-08/1102722.html)
- **2018-05: retrospective.** The "炒壳" (shell speculation) era is described as basically over; 2017 had 14 backdoor cases, with only 3 completed — [NBD 2018-05-13](https://www.nbd.com.cn/articles/2018-05-13/1216495.html)
- **2017-06: Alpha191 published.** It claims 50.2% annualized net excess over CSI 500 from 2012 to 2017-04 using factors with horizons under a week — [GTJA PDF](https://file.joinquant.com/198f09d54939dbcd27819bb96f67ac15/%E5%9B%BD%E6%B3%B0%E5%90%9B%E5%AE%89-%E6%95%B0%E9%87%8F%E5%8C%96%E4%B8%93%E9%A2%98%E4%B9%8B%E4%B9%9D%E5%8D%81%E4%B8%89%EF%BC%9A%E5%9F%BA%E4%BA%8E%E7%9F%AD%E5%91%A8%E6%9C%9F%E4%BB%B7%E9%87%8F%E7%89%B9%E5%BE%81%E7%9A%84%E5%A4%9A%E5%9B%A0%E5%AD%90%E9%80%89%E8%82%A1%E4%BD%93%E7%B3%BB-2017-06-16.pdf)
- **2016–2022: high-frequency factor proliferation and decay.** Level-2 work starts in 2016-06 (海通 #11). By 2020-03 海通 #61 addresses "高频因子多头失效" (HF factors' long-leg failure), and 2020-07 #69 is titled "高频因子的现实与幻想" (the reality and illusion of HF factors). In 2022-04 海通 asks whether the HF lane is crowded after the Q4 2021 quant drawdown — [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/)
- **End-2021 drawdown.** Quant private funds suffered large excess drawdowns at end-2021, used as the comparison for 2024 — [中国证券报 via 10jqka, 2024-02-22](https://news.10jqka.com.cn/20240222/c655213468.shtml)
- **January–February 2024: micro-cap and quant crash:**
  - In the week before the Spring Festival, some managers' products lost more than 20% of excess return; 启林 500-enhanced fell more than 12% and 幻方 500-enhanced more than 11%; several 百亿 (≥¥10bn) managers' 500- and 1000-enhanced products lost more than 10% of excess.
  - Causes cited: over-exposure to micro-caps and concentrated withdrawal of money; heavy buying of broad ETFs; widening futures basis forcing market-neutral funds to cut positions; snowball (雪球) product knock-ins; and DMA leverage exits.
  - 幻方 admitted poor adaptation to extreme short-term markets and tightened risk control against micro-cap liquidity shocks.

  — [中国证券报 via 10jqka, 2024-02-22](https://news.10jqka.com.cn/20240222/c655213468.shtml)
- **January–February 2024: index level.** The Wind micro-cap index was down 27.49% year-to-date by February 8, and quant private funds averaged −3.42% in February through February 20 — [Yicai](https://www.yicai.com/news/101999404.html) (figures via search summary)
- **2024-02-19: 灵均 sell-off.** Accounts managed by 灵均 sold ¥2.567bn within the first minute after the open — [The Paper](https://www.thepaper.cn/newsDetail_forward_26461328) (via search summary; exact source among February 2024 reports not confirmed)
- **February 2024: deep-learning factors.** 海通's deep-learning factors saw large long-short and long-only drawdowns in the week of February 5–8, 2024 — [海通金工 weekly via Sina](https://finance.sina.cn/2024-02-19/detail-inaiprfr2828837.d.html?vt=4)
- **2024-05-13: real-time northbound disclosure ends.** — [The Paper](https://www.thepaper.cn/newsDetail_forward_27359478); [BNN Bloomberg](https://www.bnnbloomberg.ca/china-to-end-live-feed-on-gauge-of-foreign-flows-into-stocks-1.2058961)
- **2024-05-15: CSRC programmatic-trading provisions.** 《证券市场程序化交易管理规定（试行）》 (Provisions on Programmatic Trading in Securities Markets, trial) issued, effective 2024-10-08 — [Hankun Law](https://hankunlaw.com/en/portal/article/index/cid/8/id/14223.html); [Hankun Law](https://hankunlaw.com/en/portal/article/index/cid/8/id/14117.html)
- **2024-07-11: 转融券 suspended.** The CSRC suspended securities refinancing (转融券). Existing contracts had to be closed by September 30, and 融券 (short-selling) margin rose from 80% to 100%, or from 100% to 120% for private funds, effective 2024-07-22. By end-June 2024, 融券 and 转融券 balances were down 64% and 75% — [CSRC](https://www.csrc.gov.cn/csrc/c100028/c7493852/content.shtml)
- **2024-08-19: daily northbound holdings end.** Daily northbound-holding disclosure stopped; holdings are published quarterly on the 5th Connect trading day after quarter-end, with the first quarterly release on October 15 — [Jiemian](https://www.jiemian.com/article/11834743.html)
- **2025-07-07: exchange HFT rules take effect.**
  - The exchanges' 《程序化交易管理实施细则》 (programmatic-trading implementation rules) took effect. An account is high-frequency if it reaches ≥300 orders plus cancels per second or ≥20,000 per day. Abnormal-trading categories include order-rate spikes, frequent instant cancels, repeated price pushing or pressing, and large short-window trades — [10jqka 2025-07-08](https://news.10jqka.com.cn/20250708/c669461222.shtml); [Xinhua 2025-04-07](https://www.news.cn/money/20250407/3142c6f5fd1d4b1ebd9eb91910befc5e/c.html)
  - Industry view: the impact is limited except for HF alpha or arbitrage strategies above about 200x annual turnover, and R&D is shifting toward mid/low frequency — [10jqka 2025-07-08](https://news.10jqka.com.cn/20250708/c669461222.shtml)
- **2025: banner year** (私募排排网 data via 10jqka) — [10jqka 2026-01-21](https://news.10jqka.com.cn/20260121/c674173909.shtml):
  - nearly 1,000 index-enhanced products averaged a 45.08% return and 16.75% excess, with nearly 90% positive;
  - CSI1000-enhanced: 172 products averaged 49.78% return and 17.49% excess (95.93% positive); 向日葵's tracking puts CSI1000 excess at 29.48%;
  - CSI300-enhanced: 10.22% excess (向日葵);
  - 百亿-plus managers: 239 products averaged 20.26% excess;
  - drivers: high turnover and turnover value, strong beta and small-cap factors; AI moved from "可选项" (optional) to "必选项" (mandatory).
- **2025 H1 dispersion.** The best and worst popular CSI500-enhanced private products were more than 20 percentage points apart — [10jqka 2025-07-10](https://news.10jqka.com.cn/20250710/c669524668.shtml) (via search summary)
- **May–June 2026: excess collapses** — [Yicai 2026-06-17](https://www.yicai.com/news/103235171.html):
  - in May 2026, 1,251 index-enhanced funds averaged −0.98% excess, and only 44.6% were positive;
  - the Wind micro-cap index (868008.WI) peaked in mid-May and fell more than 17% over about a month;
  - reversal strategies "自然会阶段性失效" (naturally fail for a period) when strong stocks keep rising;
  - rising trading crowding amplified drawdowns;
  - a tech-led market where "一成股票涨、九成股票跌" (10% of stocks rise, 90% fall) handicaps quant books holding 800–1,300 names.
- **End-May 2026 snapshot.** CSI1000-enhanced (231 products) had median excess of 4.28% year-to-date, 10.75% over one year and 55.06% over three years; CSI500-enhanced had 2.72%, 5.39% and 39.43% — [Tencent News](https://news.qq.com/rain/a/20260622A08S2T00) (via search summary; not opened)
- **July 13–17, 2026: crowding unwind:**
  - CSI500, CSI1000 and CSI2000 all fell by double digits in the week; drawdowns above 10% were widespread, some 幻方 products fell more than 15%, and some products' July excess was below −20%;
  - an industry source blames crowding in tech-growth and price-volume-momentum strategies: factors that had earned excess "成为回撤来源" (became sources of drawdown).

  — [第一财经 via 10jqka, 2026-07-22](https://news.10jqka.com.cn/20260722/c678363462.shtml)
  - Per 每经 (NBD), 2024's damage was a micro-cap liquidity problem, while 2026's was mean reversion after extreme style concentration in tech and the 双创 (STAR/ChiNext) boards — [NBD 2026-07-20](https://www.nbd.com.cn/articles/2026-07-20/4484032.html)
  - Search summaries of late-July coverage also cite an average quant long-only drawdown of 10.06% that week, and H1 2026 average index-enhancement excess of 3.11% (1,236 products) versus 14.17% a year earlier — [CLS](https://www.cls.cn/detail/2433366) (not opened; treat as indicative)
- **2026-08-28: microstructure factors still work.** 开源's 聪明钱 2.0 still shows RankIC −6.4% and IR 2.09 over 2021-07 to 2026-04; 3.0 shows RankIC −7.21% and IR 3.21 — [Sina 2026-08-29](https://finance.sina.cn/2026-08-29/detail-inipyfhv5524506.d.html)
- **2026-08-28: broker system-access rules.** "Administrative Rules for Securities Companies' Trading Information System Access (Trial)" were issued, replacing the 2015 external-system-access framework; they govern how investor trading systems connect to brokers and are relevant to DMA and quant connectivity. The Chinese title was not retrieved — [Simmons & Simmons](https://www.simmons-simmons.com/en/publications/cmtjro1bu001uu3z81e67x2yk/china-opens-a-regulated-dma-pathway-for-qfis-and-private-fund-managers) (via search summary; details unverified)

### Inferences
- **Worked, by period:**
  - small/micro size through 2016, with a large shell-option component, and again in 2021–2023 and 2025 as a beta tailwind for quant books;
  - short-term reversal, turnover and illiquidity throughout (academic consensus), with failures in narrow, momentum-led tapes such as May–June 2026;
  - HF and Level-2 microstructure factors from 2016 to about 2020, then decaying long legs and crowding, though curated versions such as 聪明钱 still show strong RankICs through 2026;
  - analyst-expectation and text factors as diversifiers.
- **Broke down, by date:**
  - size/shell from 2017;
  - the HF long leg in 2020;
  - crowding unwinds in Q4 2021, January–February 2024 (micro-cap liquidity, DMA, snowballs) and July 2026 (tech and momentum concentration);
  - northbound-holding factors from August 2024 (daily data discontinued);
  - short-leg implementation of factor portfolios from July 2024 (转融券 suspended).
- **Regulatory direction.** Rules from 2024 to 2026 push factor research toward mid/low frequency, long-only index-enhancement and risk-model crowding controls. That is consistent with MSCI's 2025 addition of crowding and SOE factors and with the sell-side shift to ML and composite models.

### Gaps
- Not quantified with sources: 2017 size-factor returns (e.g. CSI1000 versus SSE50 spreads); the 2018–2020 "core assets" growth versus value episode; the 2022–2024 dividend and low-volatility rally; the factor impact of the 2024-09-24 stimulus rally and of the April 2024 新国九条 delisting rules on micro-caps.
- Not verified: the reported February 2024 DMA "no new scale" restrictions and the 灵均 trading suspension; the January 2024 限售股出借 (lending of restricted shares) ban.
- Developments from August to October 2026 beyond the 聪明钱 3.0 report and the August system-access rules were not covered, because the search budget ran out before late-2026 performance data could be retrieved.
