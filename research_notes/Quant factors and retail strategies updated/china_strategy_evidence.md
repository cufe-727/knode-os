# Performance evidence for China-market retail trading approaches that the earlier pass could not document (as of 2026-10-31)

Research notes. They build on the Gaps sections of `research_notes/Quant factor libraries and retail strategies/china_retail_strategies.md` and do not repeat that file's findings except where a new figure confirms or contradicts one. Scope: mainland China; Hong Kong only for the A-H premium.

Method note for the report writer:
- **Data series I pulled myself.** Several figures come from public quote APIs rather than articles: Eastmoney's kline API (daily and monthly open/close/high/low for exchange repo, indices, live futures contracts, board indices and Hang Seng indices), Eastmoney's fund data files (NAV and 余额宝 7-day yields) and Jisilu's (集思录) new-CB history API. Each is cited by its URL. I read these through a fetch tool that summarises pages, then transcribed the rows. Where I computed something from them (annualized basis, excess repo yield, index returns, CB averages), the computation sits under **Inferences** and the method is stated.
- **Source-strength labels.** "(search excerpt)" marks a figure taken from the search tool's summary of a page I did not open, which is less certain. "(weaker: Q&A site)", "(weaker: blog)" and similar mark claims that rest only on forums, Q&A sites or one blog.
- **A correction to the brief.** Chen, Gao, He, Jiang & Xiong, "Daily price limits and destructive market behavior", appeared in the *Journal of Econometrics* 208(1), January 2019, pp. 249–264, not in JFE.

## 1. Treasury reverse repo (国债逆回购): GC001 (SSE 204001) and R-001 (SZSE 131810) spikes at quarter ends, year ends and before holidays, 2024–2026, and the extra yield over a money-market fund

### Takeaway
Period-end spikes were large in 2024 and the first half of 2025 but have nearly vanished since. GC001's intraday peaks were 5.40% on 2024-03-28, 7.77% on 2025-01-17 and 5.50% on 2025-06-27. In 2026 the highest print to 2026-10-30 is 2.02% (2026-06-29), and the 2026-09-30 quarter-end and pre-holiday day peaked at only 1.41%. Measured against 余额宝's (Yu'ebao, the largest money-market fund) 7-day yield, one placement of 10万元 per window at the closing rate would have earned about 42元 extra in 2024, 88元 in 2025 and 15元 in 2026 to date. That is 0.04%, 0.09% and 0.02% of the balance a year, after a 1元 fee. Pre-holiday windows with 8–11 interest days carry most of that. For a small balance the gain is trivial and shrinking.

### Cited Findings
**Daily GC001 and R-001 rates (Eastmoney daily klines; rates in % a year; "close" is the last trade, not the weighted average)**

| Date | Window | GC001 close / high | R-001 close / high | Days to next trading day |
|---|---|---|---|---|
| 2024-02-08 | Last day before Spring Festival | 1.975 / 2.700 | n/a | 11 (to 02-19) |
| 2024-03-28 | Day before Q1-end | 4.720 / 5.400 | 4.815 / 5.460 | 1 |
| 2024-03-29 | Q1-end (Fri) | 2.340 / 4.345 | 2.330 / 4.440 | 3 |
| 2024-06-28 | Q2-end (Fri) | 2.505 / 2.800 | 2.480 / 2.925 | 3 |
| 2024-09-30 | Q3-end and last day before National Day | 2.760 / 3.800 | 2.550 / 3.880 | 8 (to 10-08) |
| 2024-10-08 | First day after the holiday | 2.625 / 4.350 | 2.575 / 4.185 | 1 |
| 2024-12-30 / 12-31 | Year-end | 2.580 / 2.920; 1.790 / 2.600 | 2.540 / 2.880; 1.725 / 2.500 | 1; 2 |
| 2025-01-17 | Mid-January squeeze (Fri) | 3.955 / 7.770 | 3.840 / 7.200 | 3 |
| 2025-01-27 | Last day before Spring Festival | 2.815 / 3.585 | 2.540 / 3.360 | 9 (to 02-05) |
| 2025-03-28 | Q1-end (Fri) | 3.595 / 5.100 | 3.425 / 4.890 | 3 |
| 2025-06-27 | Q2-end (Fri) | 3.890 / 5.500 | 3.675 / 5.880 | 3 |
| 2025-09-30 | Q3-end and last day before National Day | 1.500 / 1.790 | 1.465 / 1.800 | 9 (to 10-09) |
| 2025-12-30 / 12-31 | Year-end | 2.035 / 2.600; 1.860 / 2.340 | 1.945 / 2.475; 1.810 / 2.225 | 1; 5 (to 2026-01-05) |
| 2026-02-13 | Last day before Spring Festival | 1.465 / 1.750 | 1.440 / 1.680 | 11 (to 02-24) |
| 2026-03-31 | Q1-end | 1.305 / 1.595 | 1.260 / 1.570 | 1 |
| 2026-06-29 / 06-30 | Q2-end | 1.835 / 2.020; 1.460 / 1.905 | 1.810 / 2.015; 1.415 / 1.800 | 1; 1 |
| 2026-09-30 | Q3-end and last day before National Day | 1.125 / 1.410 | 1.070 / 1.420 | 8 (to 10-08) |

— GC001: [Eastmoney 204001, 2024](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20240101&end=20241231), [2025](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20250101&end=20251231), [2026](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20260101&end=20261031), [holiday windows](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20240201&end=20261015). R-001: [Eastmoney 131810, 2024–2025](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.131810&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20240101&end=20251231), [2026](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.131810&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20260101&end=20261031). The "days" column is the gap to the next row (next trading day) in the same data.

**Annual pattern (same data)**
- **2024 (241 trading days).** GC001's highest close was 4.72% (2024-03-28) and its lowest 1.45% (2024-10-31 and 2024-11-21). Twenty-nine days had an intraday high of 2.5% or more. Closes often collapse after a morning spike: on 2024-09-27 the low was 0.01%. — [Eastmoney 2024](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20240101&end=20241231)
- **2025 (243 days).** The highest close was 3.955% (2025-01-17) and the lowest 0.91% (2025-08-21). Spikes cluster in January–March and late June. From July 2025 no day reached 2.2% intraday until the 2025-12-30 high of 2.60%. — [Eastmoney 2025](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20250101&end=20251231)
- **2026 to 10-30 (198 days).** The highest close was 1.835% (2026-06-29) and the lowest 0.67% (2026-04-29). Only seven days had an intraday high of 1.8% or more. The last row, 2026-10-30, closed at 1.105%. R-001's 2026 highest close was 1.81% (06-29). — [Eastmoney 2026](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.204001&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20260101&end=20261031); [R-001 2026](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.131810&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20260101&end=20261031)

**Money-market fund comparison**
- **余额宝 (天弘余额宝, 000198) 7-day annualized yield.** 2024-01-02: 2.431%. 2024-02-08: 2.039%. 2024-03-29: 1.794%. 2024-06-28: 1.489%. 2024-09-30: 1.424%. 2024-12-31: 1.254%. 2025-01-27: 1.543%. 2025-03-31: 1.35%. 2025-06-30: 1.212%. 2025-09-30: 1.088%. 2025-12-31: 1.046%. 2026-02-13: 1.14%. 2026-03-31: 1.00%. 2026-06-30: 0.872%. 2026-09-30: 0.844%. 2026-10-30: 0.805%. Its trailing one-year return to 2026-10-31 was 0.93%. — [Eastmoney fund data file 000198](https://fund.eastmoney.com/pingzhongdata/000198.js) (the 7-day series is the array that ends just before `Data_assetAllocationCurrency`)
- **Market average.** On 2026-05-02 the average MMF 7-day yield was 1.0473% (Wind, 351 funds), 9.66bp below the start of 2026, and 107 funds were below 1%. 余额宝 fell below 1% that day. — [财联社 via 同花顺 2026-05-03](https://news.10jqka.com.cn/20260503/c676446408.shtml). By late June 2026 the average had fallen to about 1.1%, from above 1.5% earlier. About a quarter of funds were below 1% on 2026-06-26. — (search excerpt) [中国基金报](https://www.chnfund.com/article/AR20260627095957810)

**The 2026 mid-year quarter-end**
- On 2026-06-30 GC001 fell 37.5bp to 1.46% and GC007 to 1.47%. Interbank DR001 was 1.3626% and DR007 1.4587%. The PBoC ran overnight reverse repos on June 29 and 30, and funding "整体平稳跨季" (crossed quarter-end smoothly). — [财联社 2026-07-01](https://www.cls.cn/detail/2413657)

**Mechanics and costs**
- Since May 2017, repo interest accrues on the days funds are actually used, so a 1-day repo placed before a weekend or holiday earns several days' interest. — (search excerpt, carried from the earlier notes) [每日经济新闻 2017-05-31](https://www.nbd.com.cn/articles/2017-05-31/1112408.html)
- The commission for a 1-day repo is 0.001% of principal (1元 per 10万元), with 2-day at 0.002%, 3-day at 0.003% and so on. Claims about a minimum fee conflict: one says 0.1元 per trade under a 2025 rule, another says 5元. — (weaker: Q&A site) [叩富问财](https://licai.cofool.com/ask/qa_5724382.html)
- **Broker tooling.** In July 2026, 金融街证券 launched a 通用回购 (general repo) conditional order: the investor sets a target annualized rate and the account lends automatically when it is reached. — [财联社 2026-07-26](https://www.cls.cn/detail/2437221)

### Inferences
- **Extra yield from period-end placement (my calculation).** Extra = (repo rate − 余额宝 7-day yield on that date) × interest days ÷ 365 × 100,000 − 1元 fee, in yuan per 10万元. The "at close" column assumes an order fills near the closing rate. The "at high" column is an unattainable upper bound.

| Date | At close | At high |
|---|---|---|
| 2024-02-08 (pre-Spring Festival, 11 days) | −2.9 | 18.9 |
| 2024-03-28 (1 day) | 7.0 | 8.9 |
| 2024-06-28 (3 days) | 7.4 | 9.8 |
| 2024-09-30 (pre-National Day, 8 days) | 28.3 | 51.1 |
| 2024-12-30 (1 day) | 2.6 | 3.6 |
| 2025-01-17 (squeeze, 3 days) | 20.9 | 52.2 |
| 2025-01-27 (pre-Spring Festival, 9 days) | 30.4 | 49.4 |
| 2025-03-28 (3 days) | 17.4 | 29.8 |
| 2025-06-27 (3 days) | 21.0 | 34.3 |
| 2025-09-30 (pre-National Day, 9 days) | 9.2 | 16.3 |
| 2025-12-31 (New Year, 5 days) | 10.2 | 16.7 |
| 2026-02-13 (pre-Spring Festival, 11 days) | 8.8 | 17.4 |
| 2026-03-31 (1 day) | −0.2 | 0.6 |
| 2026-06-29 (1 day) | 1.7 | 2.2 |
| 2026-09-30 (pre-National Day, 8 days) | 5.2 | 11.4 |

- **Annual totals.** Taking one placement per window (the best-closing day of each), the extra is about 42元 per 10万 in 2024 (5 windows), 88元 in 2025 (5 windows) and 15元 in 2026 to date (4 windows). That is roughly 0.04%, 0.09% and 0.02% of the balance a year. Scale it linearly for a small balance: 1万元 earns under 10元 a year. A fixed minimum fee, if one applies, could wipe that out.
- **Why spikes faded.** MMF yields and repo rates fell together, and the 2026 quarter-ends saw active PBoC liquidity supply, including overnight reverse repos. The extra yield now comes almost entirely from holiday day-counts, not from rate spikes.
- **Timing.** Spikes are intraday and morning-heavy, and closes often collapse to near zero (lows of 0.01% on 2024-09-27, 2026-09-30 and others). The close is a fair estimate of what a mid-day order gets.
- **Switching cost.** Moving cash from an MMF to repo can lose MMF accrual during redemption (T+1 for most off-exchange MMFs), which shrinks the small edge further. The comparison is more favourable if the alternative is idle broker cash rather than an MMF.

### Gaps
- **No weighted-average rates.** I found no SSE or SZSE weighted-average (加权平均) series for 204001 or 131810. The Eastmoney data give open, close, high and low only, and I did not retrieve exchange pages with daily weighted averages.
- **No official fee schedule.** The fee figures come only from Q&A sites; I found no exchange or broker fee schedule, and the minimum-fee rule is unresolved.
- **Proxy limits.** 余额宝 stands in for "an MMF". The market-average MMF yield was available for only one date (2026-05-02), and broker cash-sweep yields are unknown.
- **Missing windows.** No data for May Day, Dragon Boat or Mid-Autumn windows. Those windows are short, and the 2026 levels suggest little extra.

## 2. Limit-up chasing (打板), following 龙虎榜 trading-seat disclosures, and price-limit effects

### Takeaway
Account-level studies find that the money around limit-up days is made by large accounts. They buy heavily at or near the limit and sell into the next morning's gap, for gross gains of about 1.2–2% per round trip in 2000s–2010s samples, before costs and failed attempts. Small accounts trade the other way, and prices reverse over the following weeks. Following 龙虎榜 (Dragon-Tiger list, the exchanges' daily list of abnormal movers and their top five buying and selling broker seats) after the close means buying from those sellers. Evidence on ChiNext's 2020 move to ±20% conflicts on whether a "magnet effect" exists. There is no systematic evidence yet on the 2026-07-06 widening of ST limits to ±10%. I found no rigorous study of 游资 (hot-money) seat-following returns.

### Cited Findings
**Chen, Gao, He, Jiang & Xiong (Journal of Econometrics 2019)**
- **Citation.** "Daily price limits and destructive market behavior," *Journal of Econometrics* 208(1): 249–264 (January 2019), DOI 10.1016/j.jeconom.2018.09.014; earlier NBER w24014 (2017). The data are account-level records from the Shenzhen Stock Exchange. — [IDEAS](https://ideas.repec.org/a/eee/econom/v208y2019i1p249-264.html)
- **Sample.** All SZSE A-shares, 2012–2015, with investors grouped into institutions and five individual groups by average balance (under 10万 to over 1,000万元). — [CUHK Business School 2019-07-18](https://cbk.bschool.cuhk.edu.hk/do-daily-price-limits-stabilize-the-markets/)
- **Large accounts.** On the day a stock closes at its +10% limit, investors with over 1,000万元 net-bought 0.69% of float and net-sold 0.51% the next day; for scale, regular stocks average 3.1% daily turnover. Groups under 500万 did the reverse: they sold on day 0 and bought on day 1. Institutions bought on both days. — [VoxChina summary](https://voxchina.org/show-3-49.html)
- **Exit and reversal.** 83.6% of large investors who bought on day 0 sold on day 1. Prices kept rising for two more days, to a peak cumulative return of 2.59% on day 2, and then reversed. The more large investors bought on the limit day, the lower returns were from day 1 through day 120. — [CUHK 2019-07-18](https://cbk.bschool.cuhk.edu.hk/do-daily-price-limits-stabilize-the-markets/). Most of the next-day rise came at the open. — [VoxChina](https://voxchina.org/show-3-49.html)
- **Lower limits and ST stocks.** Nothing comparable happens on lower-limit days, which the authors attribute to short-sale constraints. ST stocks, with 5% limits then, show the pattern only after receiving ST status; this comparison is the paper's causal test. — [VoxChina](https://voxchina.org/show-3-49.html)

**龙虎榜 and "fund-dominant" accounts: 刘莉亚, 金正轩, 陈瑞华 (财经研究 2020)**
- **Citation.** 《资金优势账户可以利用投资者注意力获利吗？——基于"龙虎榜"上榜股票的券商营业部账户成交数据》 (Can fund-dominant accounts profit from investor attention? Evidence from broker-branch account trades in 龙虎榜 stocks), 刘莉亚, 金正轩, 陈瑞华, 《财经研究》 (Journal of Finance and Economics) 46(6): 94–109, 2020, DOI 10.16538/j.cnki.jfe.2020.06.007. — [SUFE journal page](https://qks.shufe.edu.cn/J/ArticleQuery/A44c2c628-9dee-45e0-b8ab-0f112001e2d9)
- **Data.** Every branch-level individual account at one large broker, covering stocks listed on 龙虎榜 only for a "涨幅偏离值达到7%" (price deviation of at least 7%) between January 2015 and July 2019. Nearly 95% of such listed stocks closed at limit-up. One branch's top buyer typically took a median 2.87% of the stock's whole-market turnover that day. The authors identified 20 habitual fund-dominant (资金优势) accounts. — [full text PDF](https://qks.shufe.edu.cn/j/PDFFull/A44c2c628-9dee-45e0-b8ab-0f112001e2d9.pdf)
- **Exit returns.** In events where these accounts sold more than half the next day (414 listed events, 1,786 limit-up-but-not-listed controls), they sold about 99% of the prior day's purchase. Prices were close to the open:

  | Measure | Listed | Control |
  |---|---|---|
  | Next open vs average buy price | +1.56% | +2.45% |
  | Sell price vs open | +0.13% | −0.31% |
  | Sell price vs buy price | +1.67% | +2.05% |

  All figures are gross of costs. The authors conclude that the listing itself "似乎没能为资金优势账户在卖出股票时带来更高的收益率" (did not seem to raise their exit returns). The disclosure does flag accounts with a strong "一日游" (one-day trip) habit. — [full text PDF](https://qks.shufe.edu.cn/j/PDFFull/A44c2c628-9dee-45e0-b8ab-0f112001e2d9.pdf)
- **Earlier work, as cited in the same paper.** Seasholes & Wu (2007) found accounts that place large buy orders minutes after a first limit hit and sell on day t+1 earn 1.16% on average. 冯旭南 (2016, 经济学季刊) found that when a listed stock rises while branches net-buy, investors follow-buy in the short term. — [刘莉亚 et al. PDF](https://qks.shufe.edu.cn/j/PDFFull/A44c2c628-9dee-45e0-b8ab-0f112001e2d9.pdf)
- Zhai, Hou & Li (2020, *Journal of Business Economics and Management*) build an attention measure from 龙虎榜 and find that attention predicts lower returns when a stock's listing-day cumulative return is negative. — (search excerpt) [JBEM](https://journals.vilniustech.lt/index.php/JBEM/article/view/11836)
- **Newer work.** A 2025 study with 2014–2022 main-board and ChiNext data plus retail account data finds that limit events produce abnormal returns followed by "obvious reversal effects", with asymmetric retail responses. Only a seminar abstract is available: speaker Xiong Xiong (Tianjin University), Shandong University, 2025-12-10, with no magnitudes. — [Shandong University seminar page](https://soe.sdu.edu.cn/info/1009/1971.htm)

**Who is on 龙虎榜 in 2026**
- To 2026-09-30, 7,749 broker branches made 5.97万 appearances with 3.55万亿元 of 龙虎榜 turnover. The top 100 branches took 75.77% of it. The largest seats are institutional or foreign: 国泰海通总部 3,212.72亿, 高盛（中国）上海浦东世纪大道 2,582.25亿, 中信证券上海分公司 2,138.98亿, 瑞银上海花园石桥路 1,774.05亿, 摩根大通（中国）上海银城中路 1,154.96亿 and 中金上海分公司 1,139.79亿. The only ordinary branch office of a domestic broker in the top seven is 开源证券西安太华路 (1,167.37亿); the article does not say who trades through it. — [中国证券报 via 南方财经 2026-10-03, Wind data](https://www.sfccn.com/2026/10-3/wNMDE1MjBfMjI1OTAwNQ.html)
- **No seat-following evidence.** A 2025-08-03 blog post titled as quantifying 游资 returns contains no data, sample or results. — (weaker: blog) [CSDN 云策量化](https://adg.csdn.net/6972eec2437a6b40336b430d.html)

**A board index of the previous day's limit-up stocks**
- Eastmoney's "昨日涨停" (yesterday's limit-up) board index, BK0815, rose from 1.07 (open of its first monthly bar, April 2025) to 256.46 on 2026-10-30. That is about 240× in roughly 19 months, or about 1.45% a day compounded. Eastmoney does not document its construction in the retrieved data. — [Eastmoney BK0815 monthly](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK0815&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=103&fqt=0&beg=20150101&end=20261031)

**Magnet effect and ChiNext's 2020-08-24 move to ±20%**
- **Evidence for a magnet effect.** Shanghai transaction data show prices approaching limits faster, with higher trading intensity, when a hit is imminent (Wong, Liu & Zeng 2009, *China Economic Review*). Shanghai high-frequency data show downward magnet effects and volatility spillovers (Hou, Li & Zhong 2020, *Emerging Markets Finance and Trade*). — (search excerpts) [UWE repository](https://uwe-repository.worktribe.com/output/998540); [IDEAS](https://ideas.repec.org/a/mes/emfitr/v56y2020i7p1447-1461.html)
- **Qi (2023, PLoS ONE 18(6): e0287548).** The sample is ChiNext before (2020-02-01 to 07-31: 1,537 upper and 1,042 lower limit hits) and after the reform (2020-10-01 to 2021-03-31: 942 and 329 moves beyond ±10%).
  - **Magnet effect: none found.** The share of moves in the 9–9.99% band fell from 19.96% to 6.96% upward and from 17.42% to 4.70% downward.
  - **Day-1 abnormal returns after up-moves:** +0.24% before the reform (continuation), −0.76% after (overreaction then correction).
  - **Day-1 abnormal returns after down-moves:** −3.37% before, −0.68% after. The author reads this as delayed price discovery under the 10% limit, worse on the downside.

  — [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10289463/)
- **Contradicting Qi.** Zhang, Li, Hao & Li (2023, *Finance Research Letters* 53) find that the wider 20% limit increased the magnet effect, with investor attention strengthening it. — [IDEAS](https://ideas.repec.org/a/eee/finlet/v53y2023ics154461232200753x.html)
- **Wan & Zhang (2022, *Economics Letters* 215, event study).** Returns were positive when the limit widened. Liquidity improved and volatility rose, with no significant change in price efficiency. — [IDEAS](https://ideas.repec.org/a/eee/ecolet/v215y2022ics0165176522001318.html)
- **Tang (2023, *International Review of Financial Analysis* 89).**
  - Liquidity and volatility rose, more in the short term than the long term.
  - 10% hits rose at first, then declined.
  - Institutions bought first and retail followed; over the long run institutions added while retail sold.
  - The wider limits "encourage short-term price manipulation, overreactions, and long-term reversals" while improving long-run efficiency.

  — [IDEAS](https://ideas.repec.org/a/eee/finana/v89y2023ics1057521923002636.html)
- **Crash risk.** ChiNext firms' crash risk fell after the relaxation (Liang et al.). — (search excerpt) [University of Nottingham Ningbo](https://research.nottingham.edu.cn/en/publications/unleashing-stock-volatility-and-its-implications-for-stock-crash-/)

**ST stocks moved to ±10% on 2026-07-06 (first-day evidence only)**
- **Scope.** On 2026-07-06, 211 A-shares carried risk warnings, of which 150 main-board ST stocks were affected (69 SSE, 81 SZSE). An ST sector index fell 1.31% that day after gaining more than 5% over the previous five trading days. By that date, 62 ST stocks had had warnings lifted in 2026, more than in all of 2025. Participants expect the change to end multi-day one-way 一字 limit runs and improve pricing efficiency. — [上海证券报 via 同花顺 2026-07-07](https://stock.10jqka.com.cn/20260707/c677990380.shtml)
- **Day-one closes.** Ten ST stocks closed at the new ±10% limits, six up (including ST星农, ST海王, *ST瑞茂, *ST东智, ST洲际, ST龙大) and four down (*ST高科, *ST准油, *ST联翔, *ST美芝). Another 34 moved beyond the old ±5%, so 44 in all. The headline's "10股触及新'天花板'" refers to closes, not intraday touches. — [金融投资报 via 同花顺 2026-07-06](https://news.10jqka.com.cn/20260706/c677988335.shtml)

### Inferences
- **What 打板 offers an individual.** The documented gains (≈1.2–2.0% gross per trade) accrue to accounts big enough to drive and seal the limit, a median 2.87% of the day's whole-market turnover in 刘莉亚 et al. An individual's limit-price order joins the queue behind them and tends to fill when the seal weakens, an adverse-selection problem these studies do not measure. Costs eat part of the edge: 0.05% stamp duty on the sale, commissions, and days when the stock fails to seal. On these numbers a retail 打板 strategy has no demonstrated positive expected value.
- **Following 龙虎榜 seats.** 龙虎榜 is published after the close, so a follower's earliest entry is the next open. That is exactly when fund-dominant accounts exit (their average sell price is within ±0.3% of the open) and when the CUHK sample's day-1/day-2 drift is mostly already in the price. The long-run reversal (to day 120) then works against the follower. In 2026 the largest seats are institutional, foreign and quant desks, so the "名游资席位" (famous hot-money seat) signal is diluted.
- **The 昨日涨停 index cannot be earned.** An index that compounds about 1.45% a day can only be read as an untradeable gross average. It presumably includes limit-up stocks no one could buy (一字板 opens at the limit; sealed queues) and ignores costs. Treat any backtest that buys all limit-ups at the close as having the same bias.
- **ST strategies need recalibration.** After ChiNext widened to 20%, the 9–10% band of moves collapsed (Qi 2023), so strategies tuned to 10%-limit behaviour stopped transferring. The ST change on 2026-07-06 is the same kind of break: models tuned on 5%-limit ST data (multi-day 一字 runs) are obsolete. The ChiNext studies suggest more single-day overreaction and reversal, with fewer consecutive limit days. This is an inference; no post-July ST study exists.

### Gaps
- I found no peer-reviewed or audited study of the returns from following named 游资 seats, with or without costs.
- I found no account-level study of 打板 returns after 2019 on the main board, after 2020 on ChiNext, or after the 2023 main-board registration reform. That reform's five-day no-limit rule for new listings is unverified background.
- I found no systematic data on ST behaviour after 2026-07-06 beyond day one: limit-hit counts, turnover or volatility in July–October 2026.
- Two pre-change figures appeared only in search summaries that I could not tie to a specific article, so I left them out of the findings: main-board ST turnover averaging about 1.2% a day over the prior three years, and 53 ST stocks hitting limit-up together on 2026-07-03.
- I took Seasholes & Wu (2007) and 冯旭南 (2016) from 刘莉亚 et al. and did not open them. The Hou–Li–Zhong, Wong–Liu–Zeng and Liang et al. findings are from search summaries only.

## 3. ETF rotation and grid trading: cost-inclusive evidence, live records, and broker tools

### Takeaway
No independent, cost-inclusive, out-of-sample evidence shows ETF rotation beating buy-and-hold for individuals in China.
- **Broker evidence is self-reported or in-sample.** 国盛's rotation tracking shows 5–9% a year of excess return over 2023–2025, with costs and out-of-sample status not stated. 国信's AI-developed rotation backtest shows 12–21% a year but was grid-searched over more than 1,000 rules.
- **Live records are poor.** The four 2021–2022 equity-ETF FOF-LOFs lost 14–24% from launch to 2026-10-30, and three of the four trailed the CSI 300 and CSI All Share price indices.
- **Grid trading has no rigorous China evidence.** The SZSE's own investor guide says it fails in trending markets.
- **Broker tools expanded in July 2026.** Grid and conditional-order tools now include fill-driven grids, but the sources give no usage or performance data.

### Cited Findings
**Broker research**
- **国盛金融工程, rotation model built on 景气度 (industry prosperity), trend and crowding signals (2025-09-10).** Reported excess returns:
  - Rotation model vs Wind All A: 2023 +7.3%, 2024 +5.7%, 2025 to August +3.1%. Backtest: 22.0% a year long-only, 14.0% excess, IR 1.52.
  - ETF portfolio vs CSI 800: 2023 +6.0%, 2024 +5.3%, 2025 to end-August +9.3%. Backtest excess 15.7% a year, IR 1.8, maximum excess drawdown 10.8%.
  - The September 2025 allocation was electronics 20%, communications 17%, media 16%, banking 13% and others.
  - The article does not say whether costs are included or which years are out of sample.

  — [国盛量化 via 新浪财经 2025-09-10](https://finance.sina.cn/2025-09-10/detail-infpyyfe7729701.d.html)
- **国信证券 资产配置专题 "AI赋能资产配置(三十八)：Agent赋能开发行业轮动策略" (2026-06-16, 陈凯畅).** The analyst used Codex to build a rotation strategy targeting Sharpe above 1.
  - **Baseline.** 60% in six 申万 level-1 industries chosen by 500-day risk-adjusted return and risk-parity weighted, 40% in a 10-year government bond ETF. From 2019-02-11 to 2026-06-01, net of 0.035% one-way costs: 12.29% a year, volatility 11.85%, Sharpe 1.04, maximum drawdown −11.92%, turnover about 3× a year.
  - **Final strategy.** An RRG (relative rotation graph) model chosen after a grid search over more than 1,000 risk-control rules. It returned 20.64% a year from 2019-01-02 (Sharpe 1.339, maximum drawdown −18.86%) and 14.70% from 2017-01-03 (Sharpe 1.068, maximum drawdown −20.13%).
  - **Discarded variants** included 4.63% a year with Sharpe 0.33 and a −36.84% drawdown, and 12.06% a year with Sharpe 0.87 and a −34.01% drawdown.
  - **The report's own warnings:** overfitting risk; costs only 0.05% one-way, excluding impact, creation/redemption costs and capacity limits.

  — [国信证券 PDF](https://pdf.dfcfw.com/pdf/H3_AP202606161823592020_1.pdf)

**Live product records: the first equity-ETF FOF-LOFs (2021–2022)**
- **The products.** 国泰行业轮动股票, 华夏优选配置股票, 华夏行业配置股票, 富国智鑫行业精选股票 and 工银睿智进取股票 (all FOF-LOF) must hold at least 80% in equity ETFs. Their size was "普遍不足两亿元" (generally under 2亿元) as of May 2025. Q1 2025 top holdings of 工银睿智进取 were thematic ETFs: HK internet, STAR chips, robotics, Nasdaq, gold, innovative drugs. ETF-FOFs avoid ordinary FOFs' "双重收费" (double fee layer); no rates were given. New 2025 entrants included 中欧积极多元配置 (on sale from 2025-05-13) and 汇添富行业轮动90天持有 (launching 2025-06-03). — [中国证券报 via 同花顺 2025-05-23](https://news.10jqka.com.cn/20250523/c668374044.shtml)
- **NAVs (Eastmoney fund data; no distributions, since cumulative NAV equals unit NAV where shown):**

  | Fund | First NAV date | NAV on 2026-10-30 | Recent returns |
  |---|---|---|---|
  | 工银睿智进取股票(FOF-LOF)C | 2021-11-24 | 0.7601 | 1 year −26.4% |
  | 华夏优选配置股票(FOF-LOF)A | 2021-12-30 | 0.8464 | 1 year −0.6% |
  | 华夏行业配置股票(FOF-LOF)C | 2022-04-08 | 0.859 | 1 year −13.12% |
  | 国泰行业轮动股票(FOF-LOF)C | 2022-07-19 | 0.7978 | 1 year −39.02%; 6 months −41.71% (peer average −16.97%) |

  — [Eastmoney FOF-LOF list](https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=FOF-LOF); [013933](https://fund.eastmoney.com/pingzhongdata/013933.js); [160326](https://fund.eastmoney.com/pingzhongdata/160326.js); [014079](https://fund.eastmoney.com/pingzhongdata/014079.js); [014197](https://fund.eastmoney.com/pingzhongdata/014197.js)
- **Benchmark levels on the same dates (Eastmoney, price indices).**
  - CSI 300 (000300): 4,916.66 (2021-11-24), 4,921.51 (2021-12-30), 4,230.77 (2022-04-08), 4,269.34 (2022-07-19), 3,985.50 (2026-10-30).
  - CSI All Share (000985): 5,911.98, 5,935.27, 5,078.00, 5,214.09 on the same dates, and 4,952.50 on 2026-10-30.

  — [CSI 300 history](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&beg=20211122&end=20220722); [CSI All Share history](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000985&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&beg=20211122&end=20220722); [CSI All Share 2026-10](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000985&fields1=f1,f2,f3&fields2=f51,f53&klt=101&fqt=0&beg=20261028&end=20261031); [CSI 300 2026-10](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031)
- **FOF market context.**
  - 2026 issuance: by 2026-03-11, 34 public FOFs had been issued in 2026 with 480亿 shares, over half of 2025's 710.96亿. Five ETF-FOFs were announced by 2026-03-12. — [上海证券报 2026-03-16](https://paper.cnstock.com/html/2026-03/16/content_2188761.htm)
  - Returns: the average public FOF returned 14.75% over the year to 2026-03-11. — [same](https://paper.cnstock.com/html/2026-03/16/content_2188761.htm)
  - 基金投顾 (fund-advisory) portfolios in 2025: 26 global-allocation portfolios were all positive over January–October, averaging +18.45%. Of 16 mid- to high-risk domestic portfolios, 14 were under water early in the year and two were still slightly negative at end-October. — (search excerpt) [每日经济新闻 2025-11-06](https://www.nbd.com.cn/articles/2025-11-06/4132990.html)

**Rotation by active funds (fund-level evidence)**
- Securities Times analysed 2,700+ active equity funds from 2021 to 2026-08-28 using quarterly holdings. The correlation between rotation intensity and annualized return was 0.0265. By rotation quintile, annualized average returns were 1.23% for the fastest, 1.74%, 3.12% (middle), 2.78% and 0.46% for the slowest. The seven funds with hit rates above 80% averaged negative returns, four of them about −5%. — [证券时报 via 同花顺 2026-09-01](https://stock.10jqka.com.cn/20260901/c679483818.shtml)

**Grid trading (网格交易)**
- **The SZSE's guide.** 《深交所ETF投资问答》 (2024 edition, by the SZSE fund management department) describes the method: a base position plus N equal grids, buying on each step down and selling on each step up. It says the method "并不适合趋势行情" (does not suit trending markets) and may fail in a large one-way rise or fall. It gives no backtests or cost analysis. — [中国证券报 金牛投资者教育基地 2025-07-03](https://cs.com.cn/tj/07/202507/t20250703_6499510.html)
- **No backtests found.** My searches found no peer-reviewed or broker backtest of ETF grid trading in China. Retail-facing pages make only qualitative claims: grids work in 震荡市 (range-bound markets) and fail in one-way moves; an ETF commission of about 万三 (0.03%) is typical. — (weaker: Q&A sites) [叩富问财 qa_6567711](https://licai.cofool.com/ask/qa_6567711.html); [叩富问财 qa_5087876](https://licai.cofool.com/ask/qa_5087876.html)

**Broker tools (条件单 conditional orders, 网格 grid orders)**
- **New tools in July 2026.** These include multi-trigger grids and 场内定投 (on-exchange periodic buying), "成交驱动型网格" (fill-driven grids with pre-placed orders), margin-account conditional orders, conditional IPO subscription and repo conditional orders:
  - 东方证券: "开板卖出" (sell when a limit-up board opens), in three modes.
  - 东海证券: multi-trigger grids, with spacing by price or percentage, price and holding ranges, and monitoring windows; also 场内定投.
  - 西部证券: fill-driven grids, plus 16 smart conditional-order types.
  - 华宝证券 and 国新证券: margin-account conditional orders; 国新 also offers "预约打新" (scheduled IPO subscription).
  - 江海证券: conditional IPO subscription.
  - 金融街证券: repo conditional orders.

  The article says a trigger does not guarantee a fill (price-time priority) and that ex-dividend price jumps can cancel orders. It gives no fees, validity periods or usage numbers. — [财联社 2026-07-26](https://www.cls.cn/detail/2437221)
- **Retail-facing claims.**
  - Mainstream brokers monitor conditional orders in the cloud, so they trigger with the app closed.
  - Validity is said to reach up to 365 days, and grid strategies "最长一年" (up to a year).
  - 国信证券 once sold conditional orders as a membership at 200元 a month or 1,800元 a year, with grids charged separately.

  — (weaker: Q&A sites and a product blog) [叩富问财 qa_7325285](https://licai.cofool.com/ask/qa_7325285.html); [qa_7225617](https://licai.cofool.com/ask/qa_7225617.html); [qa_7302813](https://licai.cofool.com/ask/qa_7302813.html); [人人都是产品经理](https://www.woshipm.com/?p=5814582)

### Inferences
- **Live vs backtest (my calculation from the NAVs and price indices above).**

  | Fund | Since launch | CSI 300 | CSI All Share |
  |---|---|---|---|
  | 工银睿智进取 C | −24.0% | −18.9% | −16.2% |
  | 华夏优选配置 A | −15.4% | −19.0% | −16.6% |
  | 华夏行业配置 C | −14.1% | −5.8% | −2.5% |
  | 国泰行业轮动 C | −20.2% | −6.6% | −5.0% |

  The indices are price-only, so against total-return benchmarks, which add roughly 2–3% a year of dividends, the gaps would widen by about 10 points over four to five years. Three of four ETF-rotation or allocation FOFs lagged a passive index after all fees. That contrasts sharply with broker backtests of 12–21% a year.
- **What the record says.** The live record (tiny AUM, thematic holdings, a −39% year for the "industry rotation" fund) and the active-fund evidence (rotation intensity uncorrelated with returns) both suggest that an individual's ETF rotation is more likely to add turnover and theme-chasing than alpha. A rotation rule needs out-of-sample tracking, with costs, from a source that has no stake in it before it is relied on.
- **Grid trading economics.** A grid is a short-volatility, mean-reversion bet: it earns the spread in ranges and loses in trends by selling winners early or averaging down. Recent markets were strongly trending: CSI 1000 rose from 4,629 (2024-08-30) to 8,810 (2026-06-30) and then fell 30.1% to 6,161 (2026-10-30). A fixed grid would have run out of inventory in the rally and out of cash in the fall. Fees are small for ETFs: no stamp duty is assumed, which I did not verify, and commissions are about 0.03% in Q&A sources. Path dependence dominates.
- **Program-trading status unresolved.** Whether broker-hosted conditional or grid orders count as 程序化交易 (program trading) for the reporting duty is still unresolved (see earlier notes). The 2026-07-26 article does not address it.

### Gaps
- I found no CSI or SSE strategy index for ETF rotation and no independent out-of-sample study of 二八轮动 (large/small-cap switching), sector or cross-border ETF rotation.
- I found no live records for 基金投顾 portfolios that are explicitly ETF-rotation, beyond the aggregate snippets above, and no records for the 2025-launched ETF-FOFs (中欧积极多元, 汇添富行业轮动 and others).
- I found no ETF grid-trading backtest with costs for China, and no broker usage statistics for 条件单 or 网格.
- I did not retrieve the A-share classes of the FOF-LOFs, which carry no sales service fee, or their benchmarks' total-return series.

## 4. The A-H premium: level and range of the Hang Seng Stock Connect China AH Premium Index (HSAHP) in 2024–2026, A-H switching evidence, and the 2025–2026 A+H listing wave

### Takeaway
HSAHP (above 100 means A-shares trade at a premium to the same companies' H-shares) averaged about 147 at month-ends in 2024, 128 in 2025 and 122 in 2026.
- **The decline.** From an intramonth high of 161.36 in February 2024, the index fell to 113.56 in February 2026, near an eight-year low.
- **The rebound.** It widened again to 132.49 by 2026-10-30.
- **The listing wave behind it.** Nineteen A+H listings came in 2025 and 38 in Q1–Q3 2026, the latter raising about HK$261bn. Some new H-shares traded above their A-shares, CATL's by more than 44% in April 2026.
- **Switching did not pay over the long run.** Over 2014-03 to 2026-10, the Hang Seng AH Smart Index (cheaper share class) returned +96% against +122% for the A-share leg and +43% for the H-share leg, all price indices. It won only during the 2024–2025 convergence.

### Cited Findings
**HSAHP levels (Eastmoney monthly bars, code HSAHP)**
- **2024.** Monthly closes ranged from 140.32 (May) to 155.48 (January). The intramonth high was 161.36 in February. The intramonth low was 128.49 in October. My inference is that this came during the mainland National Day closure (2024-10-01 to 10-07), when H-shares traded and A-shares did not. The index ended 2024 at 143.00.
- **2025.** The index fell steadily from 141.31 (January) to 117.21 (September), with an intramonth low of 115.44 in October. It ended 2025 at 123.46.
- **2026.** Month-end closes were 118.56 (January), 118.17 (February; intramonth low 113.56), 121.29, 120.55, 119.08, 122.86, 123.16, 123.53, 124.53 (September) and 132.49 (2026-10-30; October high 134.26).

— [Eastmoney HSAHP monthly](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=100.HSAHP&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=103&fqt=0&beg=20231201&end=20261031)

**Press confirmation**
- In 2026 to mid-April most days closed below 120, and the February low was a near-eight-year low. — [证券时报 via 同花顺 2026-04-17](https://stock.10jqka.com.cn/20260417/c676057082.shtml)
- The index was about 123 on 2026-09-09 (Wind). — [界面新闻 (about 2026-09-14)](https://m.jiemian.com/article/15092425.html)
- The index fell from "near 158" in February 2024 to 123.48 at the start of 2026 and 118.94 in mid-April 2026. The 158 figure is probably a daily close; Eastmoney's February 2024 intramonth high is 161.36. — (search excerpt; the summary did not say which of these two pages it drew on) [老虎证券 news](https://www.itiger.com/news/2626128031); [蓝鲸财经](https://www.lanjinger.com/d/1775802053606341910). The Securities Times data desk put it "回落至117点附近" (back to around 117) in April 2026. — [证券时报数据宝 via 同花顺 2026-04-22](https://stock.10jqka.com.cn/20260422/c676180888.shtml)

**H-shares trading above A-shares (2026)**
- **CATL (宁德时代, HK3750).** Its H-share closed at a record HK$714.5 on 2026-04-16. Its H-share premium over the A-share peaked above 48% and stayed above 44% at the article date. In 2026 to that date the H-share was up more than 47% and the A-share less than 22%. CATL's H float is under 5% of share capital. — [证券时报数据宝 via 同花顺 2026-04-22](https://stock.10jqka.com.cn/20260422/c676180888.shtml)
- **Others at the 2026-04-21 close.** 澜起科技 and 兆易创新 H-shares were more than 14% above their A-shares; 药明康德 and 恒瑞医药 were more than 5% above. — [same](https://stock.10jqka.com.cn/20260422/c676180888.shtml)
- **Base rates.** After a year-end in which the H-share traded at a premium, H outperformed A the next year about 34% of the time since 2005 and about 47% since 2015. — [same](https://stock.10jqka.com.cn/20260422/c676180888.shtml)
- **Pharma pairs (Wind, 2026-09-09).** Of 23 pharma A+H pairs, 22 had the A-share at a premium, nine above 100% (复旦张江 255.37%, 康希诺 177.88%). 药明康德's A-share was at a 7.23% discount. The article stresses that A and H shares are not fungible, so the gap is not riskless arbitrage. — [界面新闻](https://m.jiemian.com/article/15092425.html)

**The A+H listing wave**
- **2025.** By 2025-12-28, 19 A-share companies had issued H-shares (3 in 2024), raising about HK$1,400亿, close to half of HKEX's 2025 IPO proceeds. The HK market had 117 listings raising HK$2,856.9亿, first globally. CATL (HK$410.06亿) was the largest IPO, and six of the top ten were A-share companies. — [格隆汇 (year-end 2025)](https://m.gelonghui.com/p/3473010). By mid-November, 16 A+H listings had been completed and more than 80 A-share companies had filed in Hong Kong. — (search excerpt) [上海证券报 2025-11-13](https://paper.cnstock.com/html/2025-11/13/content_2145090.htm)
- **Q1 2026.** Hong Kong led global IPO fundraising with HK$1,099.26亿. Fifteen A+H companies listed, supplying over half the proceeds; examples are 牧原股份, 东鹏饮料 and 澜起科技. — [证券时报 via 同花顺 2026-04-17](https://stock.10jqka.com.cn/20260417/c676057082.shtml)
- **Q1–Q3 2026 (Deloitte data via LiveReport).**
  - Market totals: 114 HK IPOs (+72.7% y/y) raised about HK$3,880亿 (+106.1%).
  - A+H share: 38 A+H listings raised about HK$2,612亿, 67.3% of proceeds. The largest were 中际旭创 (HK$614.22亿), 立讯精密 (250.60亿) and 胜宏科技 (231.35亿).
  - After-market: in Q3, 14 of 30 new listings broke issue on day one, and "几乎所有9月份A+H股都在暗盘或首日破发" (almost every September A+H listing broke issue in grey-market or first-day trading). Cumulatively, 58 of 115 listings were below issue price.
  - Pipeline: 615 applications were queued, and more than ten A-share companies had dropped HK plans in the past year.

  — [LiveReport via 华盛通 2026-10-02](https://www.hstong.com/news/detail/10261002208270423)

**Switching-strategy indices and their returns**
- **Methodology.** The Hang Seng CSI Shanghai-Hong Kong AH Smart Index launched on 2014-11-17 with 50 dual-listed Stock Connect stocks. It holds "the share class that has a lower relative price" and was designed around expected AH convergence after Stock Connect. The broader Hang Seng China AH Smart Index launched in 2013. — [Structured Retail Products 2014-11-11](https://www.structuredretailproducts.com/news/19810/hang-seng-and-csi-partner-to-launch-thematic-stock-connect-benchmark)
- **Current status.** The CSI-HSI Shanghai-HK Connect AH Smart Index (中证恒生沪港通AH股精明指数) still has 50 constituents after its 2026-06-30 review, with share classes reset monthly ("每月的股份类别转换调整"). — [证券时报 via 同花顺 2026-08-01](https://stock.10jqka.com.cn/20260801/c678603541.shtml)
- **Quarterly closes (Eastmoney, price indices).**

  | Index | 2014-03-31 | 2019-12-31 | 2023-12-29 | 2025-12-31 | 2026-10-30 |
  |---|---|---|---|---|---|
  | 恒生AH股精明指数 (HSCAHSI, Smart) | 3,133.31 | 5,247.10 | 4,025.96 | 6,901.29 | 6,153.34 |
  | 恒生AH股A指数 (AHXA, A leg) | 1,396.98 | 2,786.96 | 2,338.09 | 3,421.71 | 3,108.01 |
  | 恒生AH股H指数 (AHXH, H leg) | 1,736.94 | 2,185.86 | 1,625.37 | 2,754.40 | 2,476.24 |

  — [HSCAHSI](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=124.HSCAHSI&fields1=f1,f2,f3&fields2=f51,f53&klt=104&fqt=0&beg=20140101&end=20261031); [AHXA](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=124.AHXA&fields1=f1,f2,f3&fields2=f51,f53&klt=104&fqt=0&beg=20140101&end=20261031); [AHXH](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=124.AHXH&fields1=f1,f2,f3&fields2=f51,f53&klt=104&fqt=0&beg=20140101&end=20261031)

**Academic evidence on the premium**
- Tang & Liu (ANU), "A-H Premium and the Shanghai-Hong Kong Stock Connect," arXiv:2602.14754 (2026-02-16; v3 2026-05-16). Using 67 Shanghai A+H firms, monthly data for 2011-01 to 2019-05 and system GMM, they find Stock Connect's implementation "is associated with an average 18.4% increase in the A-H premium". The effect is stronger where trading frictions are higher, and there was no response at announcement. — [arXiv](https://arxiv.org/abs/2602.14754v1)
- A PBoC-hosted working paper (2020) covering 2007–2019 finds USD-index shocks explain about 50–70% of HSAHP changes. HSAHP jumped from 115.8 to 126.4 after the November 2014 Stock Connect launch, with lower variance. The authors suggest a pilot that lets investors arbitrage the premium within a range. — [PBoC research page](https://camlmac.pbc.gov.cn/en/3935690/3689029/3982923/2025080817534179994/index.html)

### Inferences
- **What the HSAHP moves imply (my calculation).** HSAHP is roughly a weighted A/H price ratio. Its fall from 148.36 (2024-09-30) to 117.21 (2025-09-30) means the H legs beat the A legs by about 26.6% in that year. Its rise from 118.17 (2026-02-27) to 132.49 (2026-10-30) means A beat H by about 12.1% in eight months. In October 2026 alone the H-leg index fell 8.1% and the A-leg index 3.2%, from the September-end values 2,695.84 and 3,210.96.
- **Switching index vs single legs (my calculation from the Eastmoney indices).**

  | Period | Smart | A leg | H leg |
  |---|---|---|---|
  | 2014-03-31 to 2026-10-30 (12.6 years) | +96.4% (5.5% a year) | +122.5% (6.6% a year) | +42.6% (2.9% a year) |
  | 2014-03 to 2019-12 | +67.5% | +99.5% | +25.8% |
  | 2020 to 2023 | −23.3% | −16.1% | −25.6% |
  | 2024 to 2025 | +71.4% | +46.3% | +69.5% |
  | 2026 to 10-30 | −10.8% | −9.2% | −10.1% |

  Holding the cheaper class beat holding A-shares only in the 2024–2025 convergence. Over the full period it lagged, because the cheaper class (usually H) stayed cheap or got cheaper. Caveats: these are price indices, and H-shares' higher dividend yields would narrow the gap on a total-return basis. Currency denominations were not confirmed, and the HKD–CNY moves since 2014 could shift the comparison by about 10–15 points.
- **Practical frictions.** For a mainland individual, an A-to-H switch needs 港股通 (southbound Stock Connect) access, with an asset threshold commonly cited at 50万元 and unverified. It also involves dividend withholding on H-shares, FX conversion and different trading hours and limits (HK has none). The premium can widen for months, as in October 2026. The "convergence trade" is a slow, unhedged relative-value bet, not arbitrage.
- **New A+H issues.** The 2025–1H 2026 pattern of H-shares listing at or above A prices made buying new H issues attractive. The September 2026 wave of issue breaks shows that this has reversed with supply: 38 deals in nine months and 615 applications queued.

### Gaps
- I did not verify the AH Smart index's exact rule (relative-price threshold, monthly versus semi-annual switching), its currency or a total-return version. I also found no factsheet with official performance.
- I found no broker or academic backtest of an A/H switching rule with costs, taxes and FX.
- I did not verify 港股通 eligibility thresholds or the dividend-tax rate for individuals in 2026.
- I did not pull daily HSAHP data, so the daily extremes are intramonth monthly-bar values.

## 5. Index-futures basis (IF, IH, IC, IM), 2024–2026: levels, drivers, hedging cost and long-futures replacement

### Takeaway
Futures traded at a discount almost all the time. Outside crises the raw annualized basis was typically −8% to −15% for IM and IC, −2% to −7% for IF and 0% to −5% for IH, deeper in the May–August dividend season.
- **Crisis spikes.** On 2024-02-05 IM2403 traded at an annualized −52.8% and IC2403 at −35.8%. On 2026-03-12 IM, IC and IF were near −30%.
- **Brief premiums.** All four went to a premium on 2024-07-31, and the IF main contract did again on 2025-08-25.
- **Latest.** On 2026-10-30 the December contracts were at −9.4% to −11.2% annualized, unusually deep for IF and IH, during a sharp sell-off.
- **Drivers.** Market-neutral hedging, dealers' snowball hedge flows, short-sale curbs that disable reverse arbitrage, and dividends.
- **Implications.** A hedger pays roughly the discount, around 8–12% a year on small caps. A long-futures holder earns it as extra carry, but a contract is about 0.8–1.25 million yuan of notional, the account threshold is 50万, and margin calls apply.

### Cited Findings
**Snapshots (annualized basis = (futures − spot)/spot × 365/days to expiry; raw unless stated)**
- **2024-02-05 (crisis).** 华金期货 (Huajin Futures) data, with 40 days to the 2024-03-15 expiry:

  | Contract | Futures | Spot | Raw discount |
  |---|---|---|---|
  | IM2403 | 4,044.6 | 4,293.07 | 248.47 points, 5.79% |
  | IC2403 | 4,285.2 | 4,460.26 | 3.92% |
  | IF2403 | 3,131.2 | 3,200.42 | 2.16% |
  | IH2403 | 2,221.8 | 2,255.28 | 1.48% |

  The IM discount narrowed below 150 points the next day. The report blames snowball knock-ins, margin liquidations and fund redemptions, with CSI 1000 down nearly 30% year to date. It notes that from 2024-03-18 borrowed securities could not be sold in real time (T+1), which hobbles reverse arbitrage (反向套利: buy futures, short the ETF). — [华金期货 专题报告 2024-02-06](https://www.huajinqh.com/UserFiles/upload/file/20240207/节前恐慌情绪冲击，股指套利机会频现.pdf)
- **2024-07-31.** The August contracts of IF, IH, IC and IM all traded above spot, a premium. — (search excerpt) [北京商报 2024-08-01](https://www.bbtnews.com.cn/2024/0801/524165.shtml)
- **2025-03-02.** IH and IF basis drifted weaker at low volatility. IC and IM basis was strongly negatively correlated with the market because of large dealer "cash gamma" exposure. "由于敲出与到期影响，场外对冲交易对基差影响整体偏空" (because of knock-outs and maturities, OTC hedge flows weighed on basis overall), so the IC/IM discount was expected to persist. The 6× leveraged calendar-spread backtests returned 3.9–8.3% a year since 2024. The annualized-basis-factor version returned 19.1% (2019), 26.6% (2020), 7.6–8.4% (2021–2023), 5.4% (2024) and −0.9% (2025 to date), at 0.005% one-way costs. — [东证衍生品研究院 金工策略周报 2025-03-02](https://notice.10jqka.com.cn/api/original/380e267f173e1ec7.pdf)
- **2025-07-15 (dividend season).** Next-month contracts were at IM −14.56%, IC −12.07%, IF −6.7% and IH −4.64% annualized, at the 15th, 10th, 19th and 24th percentiles of three years. Across IC contracts the range was −9.6% (IC2512) to −12.1% (IC2508). The firm says the discount was back at an extreme and long-futures replacement (多头替代) offered excess return. — [招商期货 金融期货早班车 2025-07-16](https://notice.10jqka.com.cn/api/original/b823543ee1ac2218.pdf)
- **2025-08-25.** The IF main contract's discount went from more than 56 points in early July to about 25 points in August, then to a small premium. IF rose 2.29% that day and IM 1.27%. — [第一财经 2025-08-25](https://www.yicai.com/news/102792299.html)
- **Week to 2025-09-12.** Annualized discounts across contracts were 11–18% for IM, 8–18% for IC and 1.5–5% for IF; IH was within 2%. — [光大期货 股指期货策略周报 2025-09-14](https://notice.10jqka.com.cn/api/original/f2a2014d0d0ad21c.pdf)
- **2026-03-12 and 2026-05-14.** On 2026-03-12 IM, IC and IF briefly had annualized discounts of about −30%. By 2026-05-14 all four were within 0 to −10%. Turnover was above 3万亿元 a day in May, including 3.57万亿 on 2026-05-11, and short hedgers cut positions. Market-neutral funds returned an average 11.28% over the year to 2026-05-08, with 8.24% volatility and a 5.85% maximum drawdown. — [私募排排网 via 新浪 2026-05-19](https://cj.sina.com.cn/articles/view/1667856794/6369799a00101bhh2)
- **2026-04-24.** Dividend-adjusted annualized basis for current-quarter contracts was IC −5.33%, IF −3.25%, IH −0.14% and IM −8.26%. Hedged IC and IM strategies lost 0.06% and 0.45% that week as the discount narrowed. — [东吴金工 via 网易 2026-04-25](https://m.163.com/dy/article/KRCNR07D05568W0A.html)
- **2026-05-15 (dividend season, raw).** Next-month contracts were at IM −11.08%, IC −9.86%, IF −7.04% and IH −4.1%, at three-year percentiles of 40%, 24%, 19% and 24%. — [招商期货 2026-05-18](https://notice.10jqka.com.cn/api/original/696af8c43b35339b.pdf)
- **2026-10-28 to 10-30 (closes).**

  | Contract | Futures 10-28 / 10-29 / 10-30 | Index 10-28 / 10-29 / 10-30 |
  |---|---|---|
  | IM2612 | 6,502.0 / 6,304.4 / 6,081.0 | CSI 1000: 6,578.10 / 6,378.78 / 6,161.23 |
  | IC2612 | 6,564.0 / 6,374.6 / 6,187.2 | CSI 500: 6,640.89 / 6,453.72 / 6,266.19 |
  | IF2612 | 4,027.2 / 3,980.4 / 3,928.0 | CSI 300: 4,083.87 / 4,041.84 / 3,985.50 |
  | IH2612 | 2,713.4 / 2,714.0 / 2,700.8 | SSE 50: 2,753.01 / 2,762.79 / 2,742.11 |

  — [IM2612](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=220.IM2612&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261026&end=20261031); [IC2612](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=220.IC2612&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031); [IF2612](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=220.IF2612&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031); [IH2612](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=220.IH2612&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031); [CSI 1000](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000852&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261026&end=20261031); [CSI 500](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000905&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031); [CSI 300](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000300&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031); [SSE 50](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000016&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55&klt=101&fqt=0&beg=20261028&end=20261031)

**Drivers**
- **Snowballs (雪球).** Most outstanding snowballs knocked in during the January 2024 slide. Many knocked out in September–November 2024 (the "924 rally"). Products maturing in February–April 2025 totalled about 200–300亿元 (恒泰证券 estimate). Hedge selling at maturity widened the discount somewhat in early 2025, far less than the early-2024 knock-in spike. AMAC's 《私募证券投资基金运作指引》 (effective August 2024) raised the minimum for individuals buying snowballs to 1,000万元 (previously 100万), cooling issuance. — [界面新闻 (about late March 2025)](https://m.jiemian.com/article/12528362.html)
- **Short-sale constraints and hedging demand.** Futures sit at a long-run discount because of spot short-selling constraints and investors' short hedging demand. Basis converges faster near expiry, so long positions suit near contracts and short hedges suit far ones. — [中信建投期货 半年报 2026-07-01](https://finance.sina.cn/futuremarket/qsyw/2026-07-01/detail-inifhmie3085918.d.html). An academic treatment models futures pricing deviations under short-sale constraints and disagreement about constituents' excess returns: 陈蓉, 刘非亚, 郑振龙, 《股指期货定价偏差与成分股超额收益分歧》, 《经济学（季刊）》 2024年第5期, online appendix with 2016–2020 data. — [北京大学国家发展研究院 PDF appendix](https://www.nsd.pku.edu.cn/docs/20241030093235612524.pdf)
- **Dividends.** Constituents' dividends pull down the basis of contracts whose life spans the payment, which is why dividend-adjusted figures (东吴) are much shallower for IH and IF than raw ones in April–August. — [东吴金工 via 网易 2026-04-25](https://m.163.com/dy/article/KRCNR07D05568W0A.html)
- **Contract terms.** IF and IH multipliers are 300元 per point and IC is 200元 per point. — [招商期货 table note 2025-07-16](https://notice.10jqka.com.cn/api/original/b823543ee1ac2218.pdf)

### Inferences
- **Annualized basis on 2026-10-28 / 10-29 / 10-30 (my calculation; 51, 50 and 49 days to the 2026-12-18 expiry).**

  | Contract | 10-28 | 10-29 | 10-30 |
  |---|---|---|---|
  | IM2612 | −8.3% | −8.5% | −9.7% |
  | IC2612 | −8.3% | −8.9% | −9.4% |
  | IF2612 | −9.9% | −11.1% | −10.7% |
  | IH2612 | −10.3% | −12.9% | −11.2% |

  IF and IH discounts this deep outside dividend season are unusual compared with the 2025–2026 snapshots. They coincide with a sharp sell-off: CSI 1000 fell 6.3% in two days and 30.1% from its 2026-06-30 level of 8,809.79. A three-day snapshot does not establish a regime.
- **Typical ranges in 2024–2026 (synthesis of the snapshots).** IM −8% to −15% and IC −8% to −12% a year in normal conditions. IF −2% to −7% and IH 0% to −5%, deeper in the dividend months. Crisis spikes reach −30% to −53% (2024-02, 2026-03). Premiums are rare and brief (2024-07-31, 2025-08-25), coinciding with sharp rallies and short-covering.
- **Hedging cost.** For a market-neutral or hedged holder the cost is roughly the discount if held to convergence: about 8–12% a year on IM or IC in normal times, 3–7% on IF. Much of a neutral fund's gross alpha goes to the basis, and timing entries for shallow-discount periods matters (私募排排网).
- **Long-futures replacement (多头替代).** Futures plus cash beats a total-return ETF by roughly |raw discount| + cash yield − index dividend yield, which is about the dividend-adjusted discount plus the cash yield. At April 2026 adjusted levels that is about 8.3% + 1% ≈ 9% a year for IM. At 2026-10-30 raw levels it is about 9–11% before dividends and roll costs. The broker spread backtests (东证: −0.9% to 26.6% a year by year) show the carry is real but volatile.
- **Barriers for individuals.**
  - **Account access:** the 50万元 CFFEX account threshold and tests (earlier notes; Q&A-sourced).
  - **Contract size:** notional at 2026-10-30 closes is about 123.7万元 for IC, 117.8万元 for IF, 81.0万元 for IH and about 121.6万元 for IM, assuming IM's multiplier is also 200 (not confirmed in the sources).
  - **Margin and rolls:** daily marking to market (a −30% fall like June–October 2026 needs cash to cover margin calls), roll costs four times a year, and gap risk. For accounts below about 1–2 million yuan, an ETF (or ETF plus a small futures overlay) is the only practical choice.

### Gaps
- I found no complete daily or annual-average basis series for 2024–2026. Eastmoney no longer serves expired contracts (it returned null for IM2403), and CFFEX's data pages refused connections. The ranges above are pieced together from dated snapshots.
- I found no 2024-09/10 annualized figures beyond "premium on 2024-07-31", and no snapshot for 2025-12 or 2026-07 to 09.
- I found no quantified 2025–2026 snowball stock (only the early-2025 maturity estimate) or neutral-product AUM series, so the drivers are qualitative.
- I did not confirm the IM contract multiplier, the 50万 threshold or the 2026 margin rates from CFFEX.

## 6. Convertible bonds (可转债): full-year 2025 CB IPO statistics, the market after mid-October 2026, and 下修 (conversion-price reset) plays

### Takeaway
- **2025 CB IPOs.** Jisilu's data show 40 public CBs listed in 2025, with an average first-day return of +38.15% (median +37.25%). Ten closed at the +57.3% cap and none broke par. The mean online allotment ratio was 0.00475% (median 0.00265%). A full subscription at the typical 1,000手 cap would have earned an expected 540元 for the year. H2 2025 was far richer than H1 (+47.2% vs +23.0%).
- **The market since mid-October 2026.** The CSI CB index fell to 443.12 on 2026-10-30, a new 2026 closing low 17.6% below the year's high. I found no new default after mid-October, though 东时转债's April 2026 non-payment at maturity predates 龙大's July default.
- **下修 plays.** Reset announcements now move prices only about 1–2% and fade within days. Screening for issuers likely to reset gives about 70% hit rates in one broker's backtest; returns were not reported.

### Cited Findings
**2025 CB IPO statistics**
- **Jisilu's record of 2025 listings.** Forty public CBs had listing dates in 2025, from 华医转债 (2025-01-09) to 鼎捷转债 and 天准转债 (2025-12-31). The `list_price` field is the first-day price: 157.300 marks the +57.3% cap, and 电化转债 at 157.000 shows it is a close, not the cap. The `lucky_draw_rt` field is the online allotment ratio in percent. Examples: 普联转债 (2025-12-22) 0.0006% / 157.300; 广核转债 (2025-07-25) 0.0186% / 129.800; 亿纬转债 (2025-04-11) 0.0397% / 114.900; 太能转债 (2025-04-16) 0.0135% / 109.450. — [集思录 new-CB history API](https://www.jisilu.cn/webapi/cb/pre/?history=Y) (2025 records sit in the first 200,000 characters of the response)
- **Securities Times (Wind, by listing date).** By 2025-12-25 "逾30只" (more than 30) public CBs had listed in 2025, averaging about +37% on day one, +43.0% in the first week and +45.5% in the first month. None closed below par on day one.
  - First-day averages in prior years: 2018 2.4%, 2019 9.5%, 2020 19.1%, 2021 19.4%, 2022 29.7%, 2023 33.7%, 2024 24.1%.
  - Average online allotment ratio: 2025 about 0.0048%; 2022 0.0049%; 2023 0.0087%; 2024 0.0052%.

  The headline says the yield per winning lot hit a near-eight-year high. — [证券时报 2025-12-25 (胡华雄)](https://stcn.com/article/detail/3558303.html)
- **2026 to 2026-08-05 (earlier notes).** Thirty-nine listings averaged +52.56% on day one, with an average allotment of 0.0031%. — [新华财经 via 南方财经 2026-08-06](https://m.sfccn.com/2026/8-6/0OMDE0MDRfMjIwMDg0OQ.html)

**The CB market after mid-October 2026**
- **CSI CB index (中证转债, 000832) closes.** 465.49 (10-09), 446.05 (10-15), 451.66 (10-19), 456.87 (10-23), 457.79 (10-28), 452.63 (10-29) and 443.12 (2026-10-30), the last a new 2026 closing low. — [Eastmoney 000832 daily](https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000832&fields1=f1,f2,f3&fields2=f51,f53,f54,f55&klt=101&fqt=0&beg=20261009&end=20261031). The 2026 high was 537.6. — [财联社 2026-10-15 (earlier notes)](https://www.cls.cn/detail/2505885)
- **Normal maturity, not a default.** 华海转债 (110076) matured on 2026-11-01 and is redeemed at 110元 per bond. Its last trading day was 2026-10-27 and it is delisted from 2026-11-02. — [华海药业 announcement 临2026-103](https://static.cninfo.com.cn/finalpage/2026-09-24/1225579212.PDF)
- **东时转债 (ST东时) could not be repaid at its 2026-04-08 maturity.** The company said "公司现有货币资金无法兑付'东时转债'本息" (its existing cash cannot repay principal and interest). The bond stayed listed after maturity. The rating was cut to CC (negative outlook) from 2026-03-19, and the company was in court-supervised pre-restructuring (预重整). — [上海证券报 2026-04-01 announcement](https://paper.cnstock.com/html/2026-04/01/content_2195257.htm). The amount due was 108元 per bond. — (search excerpt) [上海证券报 2026-03-07](https://paper.cnstock.com/html/2026-03/07/content_2186489.htm). This conflicts with press calling 龙大转债 (July 2026) "年内首个违约可转债" (the year's first CB default). — [同花顺 2026-07-09](https://news.10jqka.com.cn/20260709/c678074991.shtml)
- **No new default found.** My searches found no CB default announced between 2026-10-15 and 2026-10-31. *ST岭南's face-value delisting trigger (2026-10-19, earlier notes) means 岭南转债 is likely to be delisted with the stock.

**下修 (conversion-price reset) evidence**
- **华安证券 转债周记 (2025-07-15; 颜子琦, 胡倩倩).**
  - **Reset rates.** In H1 2025 (to 07-03), 36 resets occurred, 10.03% of bonds whose reset clause had triggered (2024 12.72%, 2023 10.34%, 2022 13.64%).
  - **Resets to the floor (下修到底, as far as rules allow).** 33.33% in H1 2025 (12 of 36), against 56.94% in 2024 (41/72), 18.52% in 2023 and 38.46% in 2022.
  - **Price path around the announcement.** Average price 112.98 at T−10 and 114.49 at T (+1.34%; the 2022–2024 pre-announcement run-up was about 1.8%). The peak was 115.91 at T+1/T+2, +1.24% over T, and the price was still 0.71% above T at T+10.
  - **Share of bonds up after the announcement.** 41.67% at T+1, 47.22% at T+5 and 66.67% at T+10, against about 75% at T+10 in 2022–2024. The peak came at T+2 in 2025, against T+7 in 2024.
  - **Screening backtest.** On 1,292 bonds (2022-08 to 2025-06-27; 451 reset), five conditions were tested: current ratio below 1, EBITDA/liabilities below 0.05, finance cost/revenue above 10%, major-holder stake above 30% and remaining term under a year. Meeting three or more gave a 70.00% hit rate on whether a reset followed, and four or more 73.68% (14/19). No return figures were reported.
  - **Conclusion.** Pricing efficiency has improved and the persistence of gains has fallen.

  — [华安证券 via 新浪财经 2025-07-16](https://finance.sina.cn/2025-07-16/detail-inffrzsm4573579.d.html)
- **申万宏源 statistics since 2017.** CBs gained about 3% on average after a reset proposal and about 6% after a successful reset, with almost no effect if no reset occurred. Q1 2025 resets averaged more than 30% in size (2024 monthly average 26%). By 2025-04-03 there were 30 resets in 2025, about half the year-earlier pace, and 11 of the Q1 cases came during put periods. — [上海证券报 via 同花顺 2025-04-07](https://news.10jqka.com.cn/20250407/c667241474.shtml)
- **2026 reset counts.** Completed resets were 3 (April), 5 (May), 9 (June), 12 (July), 11 (August) and 6 (September to 09-22): 29 in H2 2026 to that date. A 浙商证券 report (August 2026) counts 512 reset proposals since 2018, 485 of them passed by shareholders, which implies 27 not passed. ST龙大's reset was voted down by minority holders in May 2026. — [证券时报 via 同花顺 2026-09-22](https://news.10jqka.com.cn/20260922/c680142318.shtml). That vote had 62.97% of votes against. — (search excerpt) [每日经济新闻 2026-05-22](https://www.nbd.com.cn/articles/2026-05-22/4405663.html)
- **Partial resets.** Resets that stop short of the floor (下修不到底) rose from about 31.3% of cases in 2018–2022 to 60.87% in H1 2023 (安信证券). — (search excerpt) [中证网 2023-10-18](https://www.cs.com.cn/ssgs/gsxw/202310/t20231018_6371135.html)

### Inferences
- **2025 CB IPO computation (my calculation from the 40 Jisilu records).** Mean first-day return +38.15%, median +37.25%, range +8.67% (华医转债) to +57.30%. Ten closed at the cap (twelve within 0.5 of it). Mean allotment 0.00475%, median 0.00265%. By half: H1 had 15 listings at +23.0% and 0.0070% allotment; H2 had 25 at +47.2% and 0.0034%. Restricting to listings by 2025-12-25 gives 37 bonds, +36.96% and 0.00488%, matching Securities Times. These figures confirm the earlier notes' unconfirmed numbers (40, +38.15%, 10 at cap, ≈0.0047%) and supersede its 2023–2024 allotment figures (0.0024% and 0.0042%), which Securities Times contradicts (0.0087% and 0.0052%).
- **Expected value of 打新债 (CB IPO subscription).** For one account subscribing the typical maximum of 1,000手 (100万元 face; the cap is common practice, not confirmed in these sources): expected profit per issue = 1,000 × allotment ratio × (first-day price − 100) × 10. The 2025 average is about 13.6元 per issue and about 540元 for the year. At 2026 rates (+52.6%, 0.0031%) it is about 16元 per issue. The return on capital is high because no cash is frozen (credit subscription), but the yuan amount is small.
- **Market after mid-October.** The index's slide to 443 continues the September–October de-rating noted earlier (valuations at the 94th–97th percentile in September). Together with two 2026 payment failures (东时 in April, 龙大 in July), it argues for credit filters on 双低 baskets rather than relying on bond floors.
- **下修 as a retail play.** The announcement edge has shrunk to about 1–2% and peaks within two days, so buying on announcement captures little. The documented edge lies in anticipating resets: the five-condition screen gives about 70% hit rates on whether a reset happens. With no return figures and with shareholder rejections possible (ST龙大), this is a probabilistic tilt for a CB portfolio, not a stand-alone strategy.

### Gaps
- Jisilu's `list_price` definition (first-day close vs another price) is inferred from the values, not documented. I did not cross-check every 2025 record against exchange data.
- I found no full-year 2025 figure on 弃购 (unpaid allotments) or on the 抢权配售 (buying the stock before the record date for priority allotment) play.
- I found no source for CB index valuation (median price or premium) after 2026-10-15, and no figure for total CB market size at end-October 2026.
- I found no return backtest for a 下修-anticipation strategy (as opposed to hit rates), and no 2026 study of announcement returns.
- I did not confirm whether 东时转债's non-payment is classed as a "default" in the press tallies that call 龙大 the first default of 2026.
