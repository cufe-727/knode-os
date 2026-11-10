# Quantitative strategies other than multi-factor stock selection for mainland-China individual investors: approaches, evidence, market rules, platforms and regulation (as of 2026-10-31)

Research notes. Scope: mainland China only; Hong Kong and overseas markets only through instruments mainland individuals can buy (QDII ETFs/LOFs, Stock Connect). Every rule carries its effective date and source where one was found.

Method note for the report writer: the shared web-search budget ran out partway through this assignment (the tool returned "this turn's web search budget is used up"). After that I could only open URLs already in hand. Coverage of these items is therefore thin or missing: broker quant-terminal thresholds, the T+0 ETF list, A-H premium levels, index-futures basis, ETF rotation and grid-trading evidence, and 2024–2026 repo-rate spikes. Each section's Gaps list says what is missing. A finding marked "(search excerpt)" came from the search tool's summary of a result page that I did not open myself, so it is less certain than a page I opened (unmarked).

## 1. Convertible bonds (可转债): 双低 (double-low), low-premium rotation, 下修 (conversion-price reset), 强赎 (forced redemption), 打新债 (CB IPO subscription)

### Takeaway
双低 rotation has the best-documented record among retail strategies in China. Wind's 双低 index returned about 13.7% a year from 2018 to 2024, mostly from the underlying stocks and from valuation, while bond floors and 下修 resets added little. Conditions have since turned against it. The CB universe shrank sharply in 2025, as most exits were forced redemptions. Valuations sat at the 94th–97th historical percentile by September 2026. The index fell more than 17% from its 2026 high. Defaults are now real: 搜特 in 2023, 岭南 and 广汇 in 2024, and 龙大, the first default of 2026, in July 2026. CB IPO subscription still has a positive expected value, but allotment ratios are tiny (≈0.003%).

### Cited Findings
**Trading and eligibility rules**
- The SSE and SZSE issued the CB rule package on 2022-06-17. On SSE, the listing day has price limits of +57.3% and −43.3%, and every later day has a 20% limit. On SZSE, the 20% limit applies from the day after listing. A "Z" prefix marks a CB's last trading day. On SZSE, orders outside the limit are treated as invalid (无效申报). — [每日经济新闻 2022-06-19](https://www.nbd.com.cn/articles/2022-06-19/2328956.html)
- The new trading rules (实施细则) took effect on **2022-08-01** — [中证网 2022-09-02 (search excerpt)](https://www.cs.com.cn/xwzx/hg/202209/t20220902_6295712.html)
- Investor suitability comes from 《关于可转换公司债券适当性管理相关事项的通知》, issued 2022-06-17 and **effective 2022-06-18**. New individual investors need two years of trading experience and 10万元 in assets ("2年交易经验+10万元资产量"). Investors who already had CB permission and kept their accounts open are grandfathered. — [每日经济新闻 2022-06-19](https://www.nbd.com.cn/articles/2022-06-19/2328956.html); [每日经济新闻 (search excerpt)](https://www.nbd.com.cn/articles/2022-06-18/2328645.html)

**双低 evidence**
- The Wind 可转债双低指数 (889047.WI) ranks bonds by price + conversion premium × 100 and rebalances on the third Friday of each month, with no rating, term or size filters. From 2018 to 2024 it returned 124% cumulatively: 13.72% a year with 11.43% annualized volatility. In 2024 it returned 15.53% with an 8.73% maximum drawdown. Over 2018–2024 the underlying stocks contributed about 54% of the return, valuation about 41%, and the bond floor and 下修 about 2% each. Valuation contributed positively every year except 2018 and 2023. The study calls 2019–2021 favourable (顺境) and 2022–2024 adverse (逆境). — [申万宏源 via 新浪财经 2025-01-09](https://finance.sina.cn/bond/zsyj/2025-01-09/detail-ineekuyn9306337.d.html)
- In 2024 the index's outperformance came mainly in June, during the credit scare, and in September, during the equity rally. The weight of bonds rated A+ or below rose noticeably from July 2024. — [same source](https://finance.sina.cn/bond/zsyj/2025-01-09/detail-ineekuyn9306337.d.html)
- Broker commentary describes a shift from classic 双低 toward a "low bond floor + low premium" variant. — (search excerpt) [格隆汇](https://m.gelonghui.com/p/4154469)

**Credit and delisting scares, 2023–2026**
- 搜特转债 (2023) was the first substantive default. The stock and the CB were both delisted with no 退市整理期 (delisting consolidation period), which broke the market's belief that CBs were principal-protected. — [21世纪经济报道 via 同花顺 2026-07-09](https://news.10jqka.com.cn/20260709/c678074991.shtml); (search excerpt) [界面](https://m.jiemian.com/article/11563937.html)
- 2024: 广汇转债 fell more than 50% within a month after closing below par on 5月23日. On 2024-08-14 岭南股份 said it could not repay 岭南转债. On 2024-06-24 岭南股份 closed at 0.84元 and 岭南转债 at 51.265元. — (search excerpts) [华尔街见闻](https://wallstreetcn.com/articles/3717955); [第一财经](https://www.yicai.com/news/102165805.html)
- Wind data show the 中证转债 (CSI Convertible Bond) index fell 10.97% from its high between 2024-05-17 and 2024-08-23. — (search excerpt) [中证网 2024-08-26](https://cs.com.cn/tzjj/jjdt/202408/t20240826_6434423.html)
- 2026: ST龙大 (002726) said its cash could not cover 龙大转债's principal and interest at maturity. This was the first CB default of 2026. The CSI CB index was down nearly 6% from 1月26日. — [同花顺 2026-07-09](https://news.10jqka.com.cn/20260709/c678074991.shtml)
- 2026-10-19: *ST岭南 triggered face-value delisting, and 岭南转债 will most likely be delisted with it. 搜于特, 鸿达兴业, 蓝盾股份 and 广汇汽车 have all had stock and CB delisted together (双退) after CB defaults. Defaulted bonds are under 2% of all CBs ever issued, but holders rarely recover full principal and interest. No CB-specific delisting rule change had been adopted; the article lists only expert proposals. — [证券时报 via 同花顺 2026-10-19](https://news.10jqka.com.cn/20261019/c680808637.shtml)

**Market state, 2025**
- On 2025-12-22 the CSI CB index was up more than 17% for the year, at its highest level since 2015. As of 2025-12-23, 413 CBs were outstanding (116 fewer than at end-2024), worth 5,577.58亿元 (down 1,759.74亿元). In 2025, 173 CBs exited (88 in 2024): 134 by forced redemption (77.46%, against 57.95% in 2024), 38 at maturity, and 1 through delisting of the underlying stock. New issues numbered 48, worth 639.83亿元. The median price was above 131元 and the median conversion premium above 32%. — [证券时报 2025-12](https://www.stcn.com/article/detail/3554514.html)
- Another source puts outstanding CBs at about 5,271亿元 at end-2025, down 1,836亿元 in the year. It gives a median price of 133.72元, a median premium of about 33%, and 37 bonds priced above 200元. CB ETF shares peaked at 48.5亿份 in early September 2025 and fell to 38亿份 by end-2025. Insurers cut Shanghai CB holdings for 11 straight months from February 2025. — [财联社 2026-01-06](https://www.cls.cn/detail/2249517). These size figures conflict with 证券时报's 5,577.58亿 (2025-12-23) and 上海证券报's 5,606亿 ([上证报 2025-12-12](https://paper.cnstock.com/html/2025-12/12/content_2157127.htm)), probably because of different coverage and dates.

**Market state, 2026**
- On 2026-01-06 the CSI CB index closed at 505.77, its first close above 500 in ten years. — [财联社 2026-01-06](https://www.cls.cn/detail/2249517)
- On 2026-10-15 the index closed at 446.05 (−1.85%), a new low for the year. From the year's high of 537.6, the maximum drawdown exceeds 17%. The index rose about 2.5% in H1 2026 and fell faster from September. At end-September, valuations by parity bucket sat at the 94%–97% percentile since 2017. Over the past month, 89 CB funds had no positive return; over one year only 10 (11.2%) were positive. 东方金诚 still favours 双低 and high-rated CBs as defensive holdings. — [财联社 2026-10-15](https://www.cls.cn/detail/2505885)

**CB IPO subscription (打新债)**
- By 2026-08-05, 39 CBs had listed in 2026. Their average first-day close was +52.56%; 27 closed at the +57.30% cap and the lowest, 宜化转债, gained 30%. The average online allotment ratio (网上中签率) was 0.0031%, ranging from 0.0002% (三江转债) to 0.0402% (曙26转债). Fifty public CBs worth 605.30亿元 were issued by that date, against 23 worth 313.97亿元 a year earlier. — [新华财经 via 南方财经 2026-08-06](https://m.sfccn.com/2026/8-6/0OMDE0MDRfMjIwMDg0OQ.html)
- In late 2025, 卓镁转债 gained 57.3% on its first day (listed 2025-11-11). 茂莱转债 reached a two-day high 78% above par. — [上证报 2025-12-12](https://paper.cnstock.com/html/2025-12/12/content_2157127.htm)

**Jisilu (集思录) as data source**
- Jisilu's CB table refreshes every 30 seconds. It flags announced forced redemptions ("!公告要强赎"). For 下修 it shows a countdown such as "[2 / 15 | 30 *]": trigger days hit in the last 30, out of the 15 required. Conversion-price notes are coloured (red = reset passed, green = rejected, black = in progress), and bonds that only qualified institutions can buy are greyed out. A pipeline view tracks new CB proposals by stage. The site links a community Q&A on the 双低 strategy and a live CB rotation (可转债轮动) diary by a user. — [集思录 CB page](https://www.jisilu.cn/data/cbnew/)

### Inferences
- Double-low's historical edge came from cheap optionality: low premiums plus a bond floor when the universe was large and prices clustered near par. In 2025 the universe shrank by about a quarter by value (1,760–1,836亿 out of roughly 7,100–7,300亿), medians rose to about 131–134元 with a 32–33% premium, and valuations reached the 94th–97th percentile. A 双低 basket therefore now holds either expensive equity-like bonds or low-priced bonds that carry real credit and delisting risk. Expect lower and more credit-sensitive returns than in 2018–2024.
- Default and delisting cases since 2023 show the "bond floor" is conditional. Under the April 2024 delisting regime (see Gaps), a stock below 1元 can drag its CB through a 双退 with no consolidation period, so low-price CB baskets need credit filters: rating, net assets against outstanding CB, stock above 1元, and maturity within a year.
- Rough EV of 打新债 for one fully subscribed account, using the 2026 figures above: 1,000 lots (100万 face) × 0.0031% ≈ 0.031 lots per issue. At about 52.6% × 1,000元 per lot, that is ≈ 16元 per issue, or roughly 600–700元 for 39 issues. The cap of 1,000 lots is a typical figure, not taken from the sources. No market-value requirement is assumed (credit subscription); confirm both. The return is small but needs almost no capital.
- 强赎 avoidance matters more as forced redemptions became 77% of exits in 2025. A holder who neither sells nor converts after a redemption notice is redeemed at about par plus interest, far below a market price usually above 130元.

### Gaps
- No year-by-year 双低 returns for 2018–2023 (charts only in the source), and no independent backtest including costs, for example Jisilu's own index or 聚宽 notebooks.
- No source for the exact 强赎 and 下修 clause conventions (typically 15 of 30 trading days at ≥130% or ≤85% of the conversion price, and a shareholder vote for a reset). These vary by indenture and were not verified.
- No source for the April 2024 "new 国九条" delisting tightening (face-value and market-cap delisting) that underlies the 2024 CB scare. The rule dates were not verified.
- The 2025 CB IPO statistics are unconfirmed: 40 listings, average first-day +38.15%, 10 at the cap, allotment ratio 0.0047% (2022–2024: 0.0049%, 0.0024%, 0.0042%). They came from a search summary attributed to 东方财富 statistics, and I could not confirm the article URL.
- No source on 弃购 (subscribe-then-not-pay) penalties for CBs, or on 抢权配售 (buying the stock before the record date to get priority CB allotment), a common retail play.

## 2. ETF strategies: momentum and rotation (二八轮动, sector, broad-index, cross-border), grid trading (网格交易), T+0-eligible ETFs, the 2023–2026 ETF boom

### Takeaway
The ETF universe that rotation and grid strategies need now exists. By end-2025 there were 1,381 ETFs worth about 6.02万亿元, including more than 1万亿 in cross-border ETFs by January 2026. The 2026 trading-rule revision changed execution: from 2026-07-06, SSE funds close by call auction, and post-close fixed-price trading covers all A-shares and ETFs. I found no reliable performance evidence for 二八轮动, ETF rotation or grid trading within the search budget.

### Cited Findings
- **Size milestones.** Domestic ETF AUM first passed 1万亿元 in October 2020, 2万亿 in August 2023, 3万亿 in September 2024, 4万亿 in April 2025, 5万亿 in August 2025 and 6万亿 at end-2025, when it stood at about 6.02万亿 (+61% y/y). At end-2025 there were 1,381 ETFs: stock ETFs 3.83万亿, cross-border ETFs 9,374亿, bond ETFs 8,281亿. Net inflow in 2025 exceeded 1.16万亿. On 2026-01-12 total AUM reached 6.24万亿, cross-border ETFs passed 1万亿, and 华夏基金 became the first manager with over 1万亿 in ETFs (10,164.24亿). — (search excerpts) [同花顺 2026-01-19 "两个'破万亿元'诞生"](https://news.10jqka.com.cn/20260119/c674104885.shtml); [每日经济新闻 2026-01-13](https://www.nbd.com.cn/articles/2026-01-13/4217433.html); [第一财经](https://www.yicai.com/news/103043325.html)
- **Closing auction, effective 2026-07-06.** Under the revised rules published 2026-04-24, SSE ETFs, LOFs and REITs use a closing call auction at 14:57–15:00, as stocks already did. Fund orders in those last three minutes are limit-only and cannot be cancelled. — [上证报 via 同花顺 2026-07-01](https://news.10jqka.com.cn/20260701/c677870245.shtml)
- **Post-close fixed-price trading (盘后固定价格交易), effective 2026-07-06.** It now covers all SSE A-shares and ETFs, previously STAR only. Orders are accepted 9:30–11:30 and 13:00–15:30 and matched by time priority at the closing price from 15:05 to 15:30. SZSE extended it from ChiNext to all A-shares and ETFs. BSE introduced it. No suitability threshold applies. — [同花顺 2026-07-01](https://news.10jqka.com.cn/20260701/c677870245.shtml)
- **LOFs in 2025.** The 407 LOFs averaged +24.06%. 国投瑞银白银期货 A returned +130.99%. — [每日经济新闻 2026-01-08](https://www.nbd.com.cn/articles/2026-01-08/4212802.html). Premium episodes are in Section 3.

### Inferences
- The closing call auction and post-close fixed-price window let a daily rotation strategy trade at or near the official close on SSE ETFs. Before 2026-07-06 SSE funds closed on continuous trading, which made close-to-close backtests harder to execute. Backtests spanning that date should model the execution change.
- A ~1万亿 cross-border ETF segment broadens rotation menus (US, Japan, HK and Korea semis), but Section 3 shows these products often trade 5–20% above NAV. A momentum signal on price can therefore chase premiums rather than underlying returns. Use IOPV or NAV-based signals and cap entry premiums.

### Gaps
- **Rotation and grid evidence:** I found no performance evidence (index data, academic work or broker backtests with costs) for 二八轮动, sector or cross-border ETF rotation, or ETF grid trading.
- **Broker tools:** I found no broker help page on 条件单 (conditional orders) or 网格单 (grid orders), covering which brokers offer them, whether orders run server-side, and their limits.
- **T+0 instrument list:** I found no official source for which instruments allow same-day round trips (当日回转). From background knowledge, unverified here: bond, gold, cross-border, money-market and commodity-futures ETFs, plus cross-border LOFs and CBs, are T+0, while equity ETFs are T+1. Verify against the SSE and SZSE trading rules (2026 revision).
- **Current data:** I found no data on ETF AUM after January 2026.

## 3. Arbitrage open to individuals: LOF/QDII premium-discount, ETF creation/redemption, 国债逆回购 (treasury reverse repo) rate spikes, index-futures basis, A-H premium via Stock Connect

### Takeaway
Premiums on QDII and commodity LOFs/ETFs recur every year (2024, 2025 and 2026). They are rarely capturable by individuals. Daily subscription caps can be as low as 100元, conversion between exchange and fund-company channels (跨系统转托管) takes T+2 or longer, and the fund manager halts trading (停牌) to crush the premium. Reverse-repo spikes at quarter-end and year-end are real and nearly costless to harvest, but recent magnitudes are unverified. Basis and A-H data could not be gathered.

### Cited Findings
**Commodity LOF premiums: the 2025–26 silver LOF case**
- 国投白银LOF's premium peaked at 68.19% on 2025-12-24. The fund then hit limit-down on 12-25 and 12-26, and the premium fell below 30%. From December 2025 it issued 18 premium warnings, daily from 2026-01-05 to 01-09. A shares were capped at 100元 a day and C shares closed to purchases, a limit attributed to futures position caps (fund size 66.4亿 at end-Q3 2025). Arbitrage (场外申购–场内卖出, buy at NAV off-exchange and sell on-exchange) settles T+2, so silver moves can erase the spread. — [第一财经 2026-01-11](https://www.yicai.com/news/102997700.html)
- **Exchange risk controls (SHFE).** From the 2026-01-09 close, AG2601–AG2604 had daily limits of 16%, hedging margin of 17% and general margin of 18% (up from 17%). From the 2026-01-08 night session, non-futures-company members and clients could open at most 7,000 lots per contract per day. This was the fourth tightening since December 2025. — [第一财经 2026-01-11](https://www.yicai.com/news/102997700.html)
- **Spillover.** Close to 20 LOFs hit limit-up on premiums in late 2025. On 2026-01-05 about 10 LOFs issued premium warnings and halted until 10:30. Many retail investors first touched LOFs through social-media arbitrage tutorials. — [每日经济新闻 2026-01-08](https://www.nbd.com.cn/articles/2026-01-08/4212802.html)
- The silver LOF still warned of premiums in May and August 2026: on 2026-08-24 it closed at 2.115元 against a NAV of 1.8780元 on 08-21. — (search excerpt) [SZSE notice 2026-08-25](https://disc.static.szse.cn/disc/disk03/finalpage/2026-08-25/082819db-ed2e-4311-970a-d47f6e15a88b.PDF)

**QDII ETF premiums**
- January 2024: 华夏野村日经225ETF (513520) had an intraday premium near 20% and closed near 10%. It halted until 10:30 on 2024-01-17 and raised its daily creation cap from 200万 to 750万 units. 易方达 MSCI 美国50ETF hit limit-up after resuming, at a premium above 21%. 工银大和日经225ETF (159866) halted until 10:30 on 2024-01-24. — (search excerpts) [第一财经](https://www.yicai.com/news/101959349.html); [澎湃](https://www.thepaper.cn/newsDetail_forward_26040348); [中证网 2024-01-24](https://cs.com.cn/tzjj/jjdt/202401/t20240124_6386823.html)
- 2026: 易方达纳指ETF (159696) closed at 2.087元 on 2026-08-17 against an IOPV of 1.8922 (≈10% premium) and halted on 08-18. 景顺纳指科技ETF (159509) repeatedly halted to 10:30 in May, July and August 2026. 华泰柏瑞中韩半导体ETF (513310) halted on 2026-07-28, 08-04 and 08-25. 华安日经225ETF (513880) warned it might seek intraday or extended halts if the premium on 2026-10-08 did not ease. — (search excerpts) [SZSE notice 2026-08-18](https://disc.static.szse.cn/disc/disk03/finalpage/2026-08-18/02c3552a-c6d2-41c6-adfc-0b9ed3271bca.PDF); [SSE 513310 notice 2026-08-25](https://www.sse.com.cn//disclosure/fund/announcement/c/new/2026-08-25/513310_20260825_4SEJ.pdf); [华安 notice 2026-10-08](https://pdf.dfcfw.com/pdf/H2_AN202610081830203477_1.pdf)
- **QDII quotas.** Cumulative approved QDII quota was 1,761.69亿美元 at end-March 2026 (+53亿 m/m). By end-August 2026 it reached 1,830.09亿美元, and securities and fund firms' quotas passed 1,000亿美元 for the first time. SAFE said in July 2026 it would issue quotas regularly, tilted toward public funds. — (search excerpts) [每日经济新闻 2026-03-28](https://www.nbd.com.cn/articles/2026-03-28/4313678.html); [同花顺 2026-09-01](https://news.10jqka.com.cn/20260901/c679463485.shtml); [同花顺 2026-07-17](https://news.10jqka.com.cn/20260717/c678245481.shtml)

**国债逆回购 (treasury reverse repo)**
- Rates rise at month-end, quarter-end and before long holidays. The 1-day SSE repo GC001 (code 204001) once hit 32% intraday in late March 2017 (close 14.955%) and 24% at end-2017. Around the 2023 year-end it fell back from near 6% to 2.625%. Since May 2017, interest accrues on the actual days funds are used, so a 1-day repo sold before a weekend or holiday earns several days' interest. A 2020 article quotes fees of 1元 per 10万元 per day, capped at 30元 per trade. — (search excerpts) [每日经济新闻 2017-03-30](https://www.nbd.com.cn/articles/2017-03-30/1090088.html); [每日经济新闻 2017-05-31](https://www.nbd.com.cn/articles/2017-05-31/1112408.html); [每日经济新闻 2018-12-25](https://www.nbd.com.cn/articles/2018-12-25/1285356.html); [杭州网 2020-06-29](https://hznews.hangzhou.com.cn/jingji/content/2020-06/29/content_7764050.htm); [第一财经](https://www.yicai.com/news/101634846.html)

**Index-futures basis**
- In January 2024, when snowball products knocked in, dealers unwound excess long hedges. IC2409 and several IM contracts briefly hit limit-down on 2024-01-22. Analysts said knock-ins "disturb the futures basis" but transmit weakly to spot. IC and IM open interest was near 6,000亿元 at the time. — [金融时报 via 华尔街见闻](https://wallstreetcn.com/articles/3707839)

### Inferences
- For individuals, LOF and QDII premium "arbitrage" is mostly a directional bet that the premium will compress. Being short the premium requires holding or borrowing units, and 融券 (short selling) is effectively shut (Section 8). Subscribing off-exchange to sell on-exchange runs into 100元-a-day caps and T+2 conversion. The realistic retail trades are rotating out of a premium-rich ETF into a sister ETF on the same index trading near NAV, and avoiding buying at high premiums.
- Reverse repo is the cleanest small edge: idle cash at quarter-end, year-end or before holidays, at fees of about 0.001% a day. Recent magnitudes are unknown (see Gaps), and ample liquidity in 2024–2026 may have damped spikes.

### Gaps
- I found no 2024–2026 GC001/R-001 spike data and no current fee schedule for reverse repos.
- **ETF creation/redemption arbitrage:** I found nothing on minimum creation units, which brokers let individuals use primary-market creation, or cash-substitution mechanics.
- **Index-futures basis:** I found no annualized IC/IM/IF/IH basis series for 2024–2026, and nothing on whether "futures-instead-of-spot" basis harvesting stayed positive after the 2024 snowball unwinding. The 50万 CFFEX account threshold applies (Section 5).
- **A-H premium:** I found no data on the Hang Seng Stock Connect China AH Premium Index for 2024–2026, no source for the southbound (港股通) eligibility threshold for individuals (commonly cited as 50万元 in assets, unverified here), and nothing on the 20% dividend withholding for individuals holding H-shares through Stock Connect.

## 4. IPO subscription (新股申购/打新)

### Takeaway
After the 2024 slowdown (100 IPOs raising 673.53亿元), issuance recovered: 116 IPOs raising 1,317.71亿元 in 2025 and about 100 by 2026-08-21. First-day returns averaged about 250–280%, with no first-day breaks below issue price (破发) since the start of 2025. For a small account the expected value is still a lottery with long dry spells, because allotment ratios average about 0.03%.

### Cited Findings
- **2025 vs 2024 (Wind).** IPOs rose from 100 to 116, and money raised from 673.53亿元 to 1,317.71亿元 (+95.64%). By board: ChiNext 33 (38 in 2024), BSE 26 (23), SSE main board 23 (17), STAR 19 (15), SZSE main board 15 (7). The largest 2025 IPO was 华电新能 (181.71亿元). 摩尔线程-U (issue price 114.28元) rose 425.46% on its first day, and 沐曦股份-U (104.66元) closed up 692.95%. — [证券市场周刊 2026-01-07](https://static.weeklyonstock.com/26/0107/wd171329.html)
- **2025 first-day returns.** Deloitte counts 104 IPOs with no breaks and an average first-day close of +257%. EY counts +253% to 2025-11-26, flat versus 2024. Thirty-two IPOs gained more than 300% on day one. One tally puts the average allotment ratio at 0.03%. — (search excerpts) [第一财经](https://www.yicai.com/news/102967170.html); [36氪](https://www.36kr.com/p/3618845063841033); [澎湃](https://www.thepaper.cn/newsDetail_forward_32056728)
- **2026 YTD.** By 2026-08-21 there had been 100 A-share IPOs (+53.85% y/y) with an average first-day gain of about 277.8% and no breaks. H1 figures were 280.17% (新华财经) and 280.26% to early August (虎嗅). More than 180 consecutive IPOs since 2025 had no first-day break. New listings later fell an average 34.23% from their first-day highs. In H1, 34 IPOs paid more than 1万元 profit per winning lot. — (search excerpts) [证券日报 via 同花顺 2026-08-24](https://stock.10jqka.com.cn/20260824/c679199792.shtml) (returned 404 when I fetched it); [新华财经 2026-06-30](https://www.cnfin.com/yw-lb/detail/20260630/4433726_1.html); [第一财经 2026-06-18 "上半年A股IPO盘点"](https://www.yicai.com/epaper/pc/202606/18/content_52283.html); [虎嗅](https://www.huxiu.com/article/4883226.html)
- **One retail account's 2025 (anecdote).** The 雪球 author won no stock or CB lot all year, with a subscription quota of 1.6万 shares in Shanghai and 1万 in Shenzhen. Winning lots paid 36.26万元 for 沐曦股份 and 24.3万元 for 摩尔线程. The BSE IPO 蘅东光 needed 918万元 of subscription money to expect one lot, worth about 3万元 in profit. — [雪球 post](https://www.xueqiu.com/1910558321/368700468)
- **Quota rules (secondary blog, partly inconsistent).** Quota is set by average market value over the 20 trading days ending T-2. Shanghai and Shenzhen holdings count separately, cash, ETFs and bonds don't count, and three unpaid allotments within 12 months bring a six-month ban. The same post's Shenzhen ratio ("1万元 = 500股") conflicts with the commonly cited "每5000元市值 = 500股", so treat its conversion ratios as unreliable. — [CSDN 2025-05-11](https://damodev.csdn.net/6a438bc210ee7a33f2850a6e.html)

### Inferences
- With first-day pops near 250–280% and zero breaks, each winning lot is worth thousands to hundreds of thousands of yuan. Quota is capped by market value, though, so the marginal return on additional market value falls fast once an account reaches the per-IPO subscription cap.
- For a small account (about 10万 per exchange), outcomes are binary: one public 雪球 tally (search excerpt, unverified) said only 40.3% of accounts won any lot in 2025. Yield as a percentage of capital depends on the market-value basis and should be presented as a distribution, not an average.
- Price discovery now happens in the first five unrestricted days. The 34% average fall from first-day highs means "sell on day one" is the standard rule; holding longer has had poor expected value.

### Gaps
- I found no official source for the full-registration (全面注册制) dates (rules commonly cited as issued 2023-02-17 and main-board registration IPOs from 2023-04-10), or for the five-day no-limit rule for main-board IPOs. The SSE English page I fetched still shows the pre-reform main-board first-day rule and the old 5% ST limit, so it is out of date ([SSE trading mechanism](https://english.sse.com.cn/start/trading/mechanism/)).
- I found no official source for STAR, ChiNext and BSE subscription eligibility (commonly 50万/24 months for STAR and BSE, 10万/24 months for ChiNext), or for official quota conversion ratios.
- The 2023 IPO count and amount (for the "2024 slowdown" comparison) and a credible per-account annual yield estimate for 2025–2026 are both missing. The 雪球 "2025年度市值打新收益全统计" (5.28%, 户均0.51签) was seen only as a search snippet with no stated basis.

## 5. Futures and options: CTA/trend following for individuals, account thresholds, 50ETF/300ETF options eligibility (投资者适当性), CTA performance evidence

### Takeaway
Ordinary commodity futures have no asset threshold. Financial futures and stock or ETF options require about 50万元 plus experience and tests, and commodity options and some special products require 10万元 (crude oil 50万元). Chinese CTA funds were the best-performing private-fund strategy in 2024 (12.18%) and again in 2026 to September (6.39%), helped by higher commodity volatility. Exchanges actively change margins and limits during squeezes, and every program trader must file a report before trading from 2025-10-09.

### Cited Findings
- **Stock/ETF options (股票期权) suitability for individuals.** Requirements are:
  - a 20-trading-day average of at least 50万元 in securities and cash at the broker, excluding margin-financed amounts;
  - at least six months of designated trading at a securities firm plus margin-trading eligibility or financial-futures experience, or at least six months at a futures firm with financial-futures experience;
  - passing an SSE-recognised knowledge test;
  - SSE-recognised simulated options trading;
  - adequate risk tolerance.
  — [深圳证监局 2024-01-18](https://www.csrc.gov.cn/shenzhen/c105614/c7461701/content.shtml). The SSE guideline was revised in 2017, and SZSE's 2019 rules match it. — (search excerpt) [每日经济新闻 2019-03-19](https://www.nbd.com.cn/articles/2019-03-19/1311835.html)
- **Index futures (股指期货) account opening, from low-quality Q&A sources.** Requirements cited are:
  - at least 50万元 available in the margin account for five consecutive trading days;
  - passing the CFFEX/CFA knowledge test at 80 points;
  - either 10 trading days and 20 trades of simulated index-futures trading, or 10 commodity-futures trades in the past three years;
  - a comprehensive assessment score of 70 or more;
  - no bad credit record.
  — (search excerpt; secondary Q&A) [理财问答](https://licai.cofool.com/ask/qa_20248.html)
- **Commodity options and special products.** Commodity options need at least 10万元 available after the previous day's settlement, a knowledge test, and simulated trading (10 days, 20 trades). — (search excerpt) [南华期货 rules doc](https://www.nanhua.net/news/2017/03/fa7f9856-3265-42bc-9a86-b9989add757a-781b3da1-33f9-4418-a880-84e5e97520f1.pdf). Individuals trading crude-oil futures or options need at least 50万元 available for five consecutive days, against 10万元 for other permissions. — (search excerpt) [中金财富期货 account-opening notice (file dated 2023-08)](https://ciccwm.com/ciccwmweb/statics/pdf/employee_info/futures/zjcfqh/qhkhlc-1.pdf)
- **CTA performance, 2024.** Third-party data to 2024-12-27 put average CTA returns at 12.18%, the best of five private strategies (equity 11.29%, bond 7.99%, multi-asset 10.86%, FoF 9.92%). Trend-following did better than cross-sectional or fundamental CTA. 2022 was an industry-wide slump and 2023 lukewarm. — [中证网 2025-01-10](https://www.cs.com.cn/tzjj/smjj/202501/t20250110_6467358.html). For January–October 2024, 425 CTA products averaged 16.54% (median 10.48%) on 排排网 data, and discretionary CTA beat quant CTA. — (search excerpt) [中证网 2024-12-05](https://cs.com.cn/zzqh2020/202412/t20241205_6458882.html)
- **CTA performance, 2026 to 09-30 (排排网).** The 1,344 CTA private funds averaged +6.39%, and 72.12% were positive. All 10,818 private securities funds averaged +2.37%, and equity strategies +1.92%. In September 2026 the CTA index (+1.01%, 好买) was the only positive sub-strategy. — [上海证券报 via 新浪 2026-10-18](https://finance.sina.cn/2026-10-18/detail-inivrkxi6734055.d.html)
- **Volatility regime.** The 南华商品综合指数's 20-day annualized volatility was 15.36% at the time of writing. Its 2025–2026 average stayed above 18%, against about 13% in 2023–2024. Commodity turnover began falling noticeably from April 2026. — (search excerpt) [财联社](https://www.cls.cn/detail/2514349)
- **Exchange risk-parameter changes.** During the silver squeeze, SHFE moved silver limits to 16% and margins to 17–18%, and capped intraday opening at 7,000 lots per contract (from 2026-01-08/09). — [第一财经 2026-01-11](https://www.yicai.com/news/102997700.html)

### Inferences
- A retail CTA (trend-following on liquid commodity futures through CTP, Section 9) is accessible with modest capital, since ordinary commodity futures have no asset threshold. The 2024 and 2026 private-fund record suggests the strategy still works in China's high-vol, trending regime. Survivorship and fee differences mean private-fund averages overstate what a retail replication would earn.
- Mid-squeeze changes to margin, limits and position caps are part of China's futures microstructure. They raise gap and liquidity risk for leveraged trend strategies, and backtests should model them.

### Gaps
- I found no official CFFEX or exchange source for index-futures and commodity-option thresholds. The figures above come from broker documents and Q&A sites.
- I found no source on the 一级/二级/三级 options permission tiers, or on CSI 300 index options (CFFEX) thresholds.
- I found no 2025 full-year CTA figure. Sources call 2024–2025 a "业绩提振期" (performance upswing) without numbers.
- I found no academic study of time-series momentum in Chinese commodity futures.

## 6. A-share short-horizon strategies popular with retail quants (micro-cap rotation, 打板/首板 limit-up chasing, 龙虎榜/游资 following, 红利低波 allocation, 底仓做T), and the 雪球 (snowball) knock-in cautionary case

### Takeaway
Micro-cap rotation had a spectacular long-run record: the Wind micro-cap index rose 508% over the ten years to June 2026. Its crashes are crowding events: about −33% on CSI 2000 from January to February 2024, about −12% in December 2024, and −23.7% in May–July 2026. Dividend low-vol (红利低波) gave strong total returns in 2023–2024 (+12.2%, +24.8%) but stalled in 2025–2026. Snowballs lost heavily when CSI 500 and CSI 1000 fell in January 2024. For limit-up chasing, 龙虎榜 following and intraday T-trading I found no rigorous evidence; the account-level research in Section 7 implies that small-account momentum trading loses on average.

### Cited Findings
**Micro-cap (微盘股)**
- From the CSI 2000's 2024-01-02 open (2402.23) to its 2024-02-05 close (1613.40) it fell 32.84%, its largest drawdown since launch. On 2024-02-02 the all-A index fell as much as 8% intraday, with about 1,000 stocks limit-down. — (search excerpt) [复旦大学金融研究中心](https://fddi.fudan.edu.cn/_t2515/2b/23/c21253a666403/page.htm)
- From 2024-12-12 to 12-27 the 万得微盘股指数 fell more than 12% (to 327,953.09). The drop was linked to a list of stocks at risk of delisting, and quant managers denied causing it. — (search excerpt) [同花顺 2024-12-29](https://stock.10jqka.com.cn/20241229/c664989705.shtml)
- From 2026-05-12 to 07-13 the 万得微盘股指数 fell 23.68% as volume rotated into large-cap tech. More than 80% of turnover moved to mid and large caps from May, quant funds reduced micro-cap holdings, and redemptions of micro-cap products amplified the fall. To end-June 2026 the index was up 508.19% over 10 years, 277.36% over 5 and 111.39% over 3. Managers set capacity caps, for example 诺安 limited subscriptions to 100万 a day from 2025-06-05 and lifted the cap on 2026-06-15. — [上海证券报 2026-07-19](https://paper.cnstock.com/html/2026-07/19/content_2246198.htm). Monthly moves were −9.16% in May 2026 and −11.88% in June. — (search excerpt) [开源证券 report](https://pdf.dfcfw.com/pdf/H3_AP202607291827456920_1.pdf)

**Dividend low-vol (红利低波)**
- The 中证红利低波动指数 (H30269) total-return index returned: 2019 +18.45%, 2020 +1.99%, 2021 +16.34%, 2022 +3.46%, 2023 +12.23%, 2024 +24.82%, 2025 +5.57%, 2026 to 08-13 −1.43%. Its worst full-year drawdown was −17.54% in 2020; others stayed within about −14%. — [雪球 analysis (individual author)](https://www.xueqiu.com/9607639944/405174700). Since launch it has returned about 6.87% a year in price terms and 11.84% in total-return terms (snapshot around August 2026). The index holds 50 high-yield, low-volatility, continuous dividend payers weighted by dividend yield. — (search excerpt) [理杏仁](https://www.lixinger.com/equity/index/detail/csi/H30269/1730269/fund-list)

**Limit-up and ST stocks**
- From **2026-07-06**, main-board risk-warning (ST/*ST) stocks have ±10% price limits instead of ±5%. The change was consulted on 2025-06-27 and published in the 2026-04-24 rules. More than 150 main-board ST stocks existed in early July 2026. — [同花顺 2026-07-01](https://news.10jqka.com.cn/20260701/c677870245.shtml); (search excerpt) [财联社 2025-06-27](https://www.cls.cn/detail/2069694)

**Snowballs (雪球), January 2024**
- In early January 2024 about 1,380亿元 of snowballs were linked to CSI 500 and 920亿 to CSI 1000. Typical knock-in levels were 70–80%, knock-out about 100%. On 2024-01-22, with CSI 500 at 4,780.97 and CSI 1000 at 5,000.83, new knock-ins were 513.2亿 on CSI 500 (25.9% of products not yet knocked in) and 288.8亿 on CSI 1000 (33.2%), per a Xinda estimate. Industry officials put the share of securities-firm snowballs knocked in at about 7%, below April 2022.
- In one case, a 200万元 CSI 500 snowball maturing on 2024-01-15 lost all principal and coupons after the index fell 26.83% over its term. On classic structures (15–20% coupons), one analyst found a 78.5% profit probability but an average absolute return of only 6–8%.
- Dealers unwinding hedges pushed IC and IM to intraday limit-down on 01-22. — [金融时报 via 华尔街见闻](https://wallstreetcn.com/articles/3707839)
- Snowballs are generally sold to professional and institutional buyers but have spread to high-net-worth individuals. One retail buyer bought a 100万元, two-year CSI 1000 snowball in early 2023 and was knocked in during January 2024. — (search excerpts) [华尔街见闻](https://wallstreetcn.com/articles/3707839); [商业周刊/Reuters case](https://www.businessweekly.com.tw/international/blog/3014598)

### Inferences
- Micro-cap is a liquidity-provision and crowding premium with recurring −20% to −35% crashes, each time a regime shifts toward large caps or tighter delisting. Retail micro-cap rotations need explicit crash rules (turnover, crowding, and the large-cap/micro-cap spread, which the 2026 article lists as signals). They also need delisting-risk exclusions: below 1元, ST, and low market cap.
- The ST limit widening (5% → 10%) on 2026-07-06 changes 打板 dynamics on ST names: fewer consecutive limit days and more intraday range. Strategies calibrated on pre-July-2026 ST data are stale.
- Snowballs are short put options with knock-out. The January 2024 episode shows the loss distribution (full principal at risk after 25–30% index falls), and the hedging flows also distorted futures basis.

### Gaps
- I found no rigorous evidence (academic or audited) on 打板/首板 returns, 龙虎榜/游资 following, or 底仓做T. The well-known academic paper on price limits and large investors' strategic limit-hitting (Chen, Gao, He, Jiang & Xiong, "Daily price limits and destructive market behavior") could not be verified: the URL I tried pointed to an unrelated NBER paper.
- I found no 2025 full-year micro-cap index return, and no 中证红利低波 price-index annual data.
- I found no official source for snowball investor thresholds (the minimum investment for over-the-counter derivatives or 收益凭证).

## 7. Evidence on individual-investor trading performance in A-shares

### Takeaway
The best account-level evidence comes from Jones, Shi, Zhang & Zhang. Their study uses complete SSE account data for 2016–2019 and was published in JFQA in February 2025. Retail flow by itself has no edge; it splits by account size. Large retail accounts predict returns, trade contrarian and use public news. Small accounts do not predict returns, chase daily momentum and show gambling preferences. Individual investors still dominate turnover, about 85% of volume in the study's data.

### Cited Findings
- **Citation.** Jones, Charles M., Donghui Shi, Xiaoyan Zhang & Xinran Zhang, "Retail Trading and Return Predictability in China," *Journal of Financial and Quantitative Analysis* 60(1), February 2025, pp. 68–104. The working paper, "Understanding Retail Investors: Evidence from China," was first posted in 2019 and revised in 2022. It splits retail into five account-size groups using comprehensive account-level data for 2016–2019. — (search excerpts) [IDEAS/RePEc](https://ideas.repec.org/a/cup/jfinqa/v60y2025i1p68-104_3.html); [ABFER working paper](https://abfer.org/media/abfer-events-2022/annual-conference/papers-investfin/AC22P3020_Understanding-Retail-Investors_Evidence-from-China.pdf)
- **Findings.** Retail investors with larger balances forecast future returns, trade against recent price moves and incorporate public news. Smaller accounts cannot forecast returns, trade on short-term daily momentum, handle public news poorly, and show overconfidence and gambling preferences. — [清华五道口 summary](https://eng.pbcsf.tsinghua.edu.cn/info/1072/2762.htm)
- **Volume share.** Retail investors contribute about 85% of daily exchange volume, institutions about 15%. — (search excerpt) [BFI seminar page](https://bfi.uchicago.edu/?p=29250); [ABFER paper](https://abfer.org/media/abfer-events-2022/annual-conference/papers-investfin/AC22P3020_Understanding-Retail-Investors_Evidence-from-China.pdf)
- **Investor counts (China Clear).** About 2.368亿 investors at end-2024, with individuals above 99.76%. About 2.507亿 at end-2025 (+5.86%), including 1,382.84万 new individual investors in 2025. — (search excerpts) [新京报](https://m.bjnews.com.cn/detail/1781349245168686.html); [财联社](https://www.cls.cn/detail/2086830)
- **Regulators on program trading.** During the April 2024 trial of abnormal-trading indicators, the triggers were mainly quant private funds and broker proprietary desks; small and medium individual investors were "basically unaffected". — [SSE 2025-04-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250403_10776805.shtml)

### Inferences
- For retail quants, the evidence argues against short-horizon momentum and lottery-stock strategies, which describe the losing small-account cohort. Slower contrarian, news-aware or structural strategies (CB rotation, ETF allocation, IPO subscription, CTA) do not rely on beating faster participants on the same signals.
- The evidence predates the 2024–2026 rule changes (program-trading reporting, the end of 转融券 short lending, the ST limit change), so its magnitudes may not carry over exactly.

### Gaps
- I could not extract the paper's yuan-denominated gain or loss estimates by group (the PDF text layer could not be decoded locally), or the cutoff for "small" accounts.
- I could not find the SSE yearbook (统计年鉴) data on individuals' share of trading and holdings for 2024–2025, or other account-level studies such as An, Lou & Shi on the 2015 bubble.

## 8. Market microstructure constraints

### Takeaway
The binding constraints for retail quants in 2026 are these:
- A-shares settle T+1, while CBs and some funds can be traded back the same day.
- Price limits are ±10% on the main board, now including ST stocks from 2026-07-06, and ±20% on STAR. ChiNext (±20%) and BSE (±30%) are background figures I could not verify in this session.
- Shorting is practically unavailable: 转融券 lending has been suspended since 2024-07-11, and the short-sale margin floor has been 100% since 2024-07-22.
- Stamp duty is 0.05%, paid by the seller, since 2023-08-28.
- Real-time northbound flow data stopped on 2024-05-13.
- The 2026 rules add closing auctions for SSE funds, post-close fixed-price trading for all A-shares and ETFs, and ChiNext market makers.

### Cited Findings
- **Stamp duty.** Securities transaction stamp duty was halved from **2023-08-28**; the previous rate was 1‰ of value, paid by the seller. — [华尔街见闻 2023-08-27](https://wallstreetcn.com/articles/3696465); (search excerpt) [新华网 2023-08-28](https://www.news.cn/2023-08/28/c_1212260850.htm). The 2026 central budget still shows the halving in force, with expected revenue of 2,025亿元 (+0.7%). — (search excerpt) [第一财经](https://www.yicai.com/news/103107427.html). In the same package, the SSE, SZSE and BSE cut trading handling fees (经手费) and many brokers cut commissions, but the rates were not given. — (search excerpt) [新华网](https://www.news.cn/2023-08/28/c_1212260850.htm)
- **Short selling.** The CSRC approved suspending 转融券 (securities refinancing for short selling) from **2024-07-11**. Existing contracts could roll but had to close by 2024-09-30. From **2024-07-22** the minimum short-sale margin ratio rose from 80% to 100%, and to 120% for private funds. By end-June 2024, 融券 and 转融券 balances had fallen 64% and 75% cumulatively. The short balance was about 0.05% of free-float cap, and short-sale turnover had fallen from 0.7% to 0.2% of A-share turnover. Earlier steps since August 2023 restricted lending of strategic-placement shares and raised margins. — [CSRC 2024-07-10](https://www.csrc.gov.cn/csrc/c100028/c7493852/content.shtml)
- **Northbound disclosure.** Real-time northbound trading data stopped on **2024-05-13**. From **2024-08-19**, Stock Connect investors' aggregate holdings in each stock are published quarterly, on the fifth Stock Connect trading day after quarter-end; the first release was on 2024-10-15. — (search excerpts) [澎湃](https://www.thepaper.cn/newsDetail_forward_27359478); [界面](https://www.jiemian.com/article/11834743.html); [新京报](https://m.bjnews.com.cn/detail/1724066324129030.html)
- **2026 trading-rule revision**, published 2026-04-24 and **effective 2026-07-06**:
  - Main-board ST limits widen from 5% to 10%.
  - SSE funds close by call auction.
  - Post-close fixed-price trading expands to all SSE and SZSE A-shares and ETFs, and BSE introduces it.
  - SZSE introduces a ChiNext market-maker system, with details to come.
  - BSE adjusts block-trade ranges for stocks without limits and adds rules for severe abnormal volatility.
  — [同花顺 2026-07-01](https://news.10jqka.com.cn/20260701/c677870245.shtml)
- **SSE order sizes and ticks.** Main-board buy orders must be in multiples of 100 shares, with odd lots sold in one order, and a maximum of 1,000,000 shares per order. STAR limit orders range from 200 to 100,000 shares, and STAR market orders from 200 to 50,000 shares and must carry a protection limit price. The tick size is 0.01元. Block trades need at least 300,000 shares or 200万元. — [SSE English, trading mechanism](https://english.sse.com.cn/start/trading/mechanism/). This page is out of date: it still shows a 5% risk-warning limit and the pre-registration main-board first-day rule.
- **CBs.** ±20% after the listing day; +57.3% and −43.3% on SSE listing days; effective 2022-08-01. — [每日经济新闻](https://www.nbd.com.cn/articles/2022-06-19/2328956.html); [中证网 (search excerpt)](https://www.cs.com.cn/xwzx/hg/202209/t20220902_6295712.html)
- **HFT costs, proposed.** The exchange's flow fee (流量费) would rise from 0.1元 to 1元 per order, and HFT accounts would pay a 5元 cancellation fee. See Section 10. — [华尔街见闻 2024-07-28](https://wallstreetcn.com/articles/3721499)

### Inferences
- With 融券 and 转融券 effectively closed, long-short and market-neutral retail strategies are infeasible in single stocks. Hedging is possible only with index futures or options (50万 thresholds), or by rotating out of exposure. This also removes the arbitrage arm that would close LOF and QDII premiums.
- T+1 on stocks means intraday strategies work only as 底仓做T against an existing position, or in T+0 instruments (CBs, cross-border, bond and gold ETFs; list unverified, see Section 2). CBs remain the main T+0 equity-linked instrument under ±20% limits.
- Costs: after 2023-08-28, a round trip costs about 0.05% in stamp duty plus commissions (typically low single basis points, unverified) plus small exchange and transfer fees. Turnover-heavy strategies are still dominated by spread and slippage rather than fees, except for HFT accounts under the proposed fee scheme.

### Gaps
- I found no source for 2026 broker commission levels (万0.85–万3, 免五 waivers), the post-2023 经手费 rate, or the 过户费 transfer fee. All are unverified here.
- I found no current source for ChiNext, STAR and BSE price limits. The 20% on STAR is in the SSE page; ChiNext 20% since 2020-08-24 and BSE 30% since 2021-11-15 are background knowledge, unverified here.
- I found no data on 2025–2026 margin-financing (融资) rules or any resumption of 转融券. The question of resumption was searched, and nothing was found to indicate it occurred.
- I found no data on other 2024 quant-specific curbs (for example the February 2024 restrictions on certain quant funds' selling, or DMA business limits).

## 9. Platforms and data: broker quant terminals (迅投 QMT/miniQMT, 恒生 PTrade, 掘金, 金字塔 and others), vn.py, 聚宽/米筐, Tushare Pro, AKShare, 集思录; which brokers let individuals trade through an API in 2026

### Takeaway
The standard retail stack in 2026:
- **Execution:** a broker-provided terminal, either 迅投 QMT/miniQMT (Python via xtquant, local client required) or 恒生 PTrade (broker-hosted).
- **Futures:** CTP-based connections through open-source vn.py.
- **Data:** Tushare Pro (points-gated) and AKShare (free scraping, academic use).
- **CBs:** 集思录 for monitoring.
Every API user must now file a 程序化交易 report through the broker before trading (Section 10). I could not verify broker thresholds or the list of API-friendly brokers because the search budget ran out.

### Cited Findings
- **XtQuant (miniQMT).** XtQuant is a Python framework derived from 迅投 MiniQMT, supporting 64-bit Python 3.6–3.12. Programs need a running MiniQMT client. `xtdata` provides historical and real-time K-line and tick data, financials, instrument information and sectors. `xttrader` handles orders, cancels, queries of assets, orders, trades and positions, and push callbacks. — [迅投知识库](https://dict.thinktrader.net/nativeApi/start_now.html)
- **vn.py (VeighNa).** The GitHub badge shows v4.5.0. It needs Python ≥3.10 (64-bit; 3.13 recommended) on Windows 11 or later, Windows Server 2022, or Ubuntu 22.04 LTS. It is MIT-licensed.
  - Futures and options gateways: CTP, CTP Mini, 飞马, 易盛, 飞鼠, 利星资管, 融航, 杰宜斯, TTS.
  - Securities and ETF-option gateways: 中泰 XTP, 华鑫奇点 TORA, 顶点 HTS, 顶点飞创, CTP证券 (SOPT).
  - Data: 迅投研 and RQData.
  - Apps: CTA strategy and backtester, spread trading, option master, portfolio strategy, algo trading, and `vnpy.alpha`, an ML multi-factor module modelled on Qlib.
  It does not list 恒生 UFT or QMT. — [vnpy/vnpy GitHub](https://github.com/vnpy/vnpy)
- **Tushare Pro.** Access is gated by points (积分): 100 at registration, 20 for completing profile details, 50 per valid referral, 100–500 for accepted code, 100–1,000 for quality articles, and 5,000 for joining the paid WeChat group. Sponsors receive points, purchases are non-refundable, and points stay valid for one year. The point thresholds per endpoint are on separate pages that I did not retrieve. — [Tushare Pro points page](https://tushare.pro/document/1?doc_id=13)
- **AKShare.** An open-source Python library that scrapes public sites (东方财富, 新浪财经, exchanges) and returns pandas DataFrames with Chinese column names. It covers stocks, futures, options, funds, bonds, FX, indices and macro data, and is intended for academic research. Interfaces break when source sites change, so users must keep it updated. — [AKShare docs](https://akshare.akfamily.xyz/introduction.html)
- **集思录.** Live CB table with 强赎 and 下修 trackers, a pipeline view, a 双低 Q&A and user strategy diaries. — [集思录](https://www.jisilu.cn/data/cbnew/)
- **Regulatory overlay.** Exchanges require "未经报告不得进行程序化交易": no program trading without a prior report. Reports cover the trading software's name, version and developer. — [华尔街见闻 2023-09-01 notices](https://wallstreetcn.com/articles/3696980)
- **Industry response.** After the 2025-07-07 rules took effect, quant institutions shifted research toward mid- and low-frequency strategies. — [同花顺 2025-07-08 (headline)](https://news.10jqka.com.cn/20250708/c669461222.shtml)

### Inferences
- Because reports must name software, version and developer, broker-sanctioned terminals (QMT, PTrade) are the path of least resistance for individuals. Self-built API stacks still need the broker's acceptance of the report.
- On the futures side, vn.py over CTP remains the open-source default. The futures rules (Section 10) make "self-developed or custom software" a reporting trigger, so individuals using vn.py must report.

### Gaps
- I found no 2026 data on which brokers offer QMT, miniQMT or PTrade to individuals, or on typical asset thresholds (commonly 10万–50万+, unverified).
- I found no information on 掘金 (MyQuant), 金字塔, 文华财经 or TB for futures.
- I found no data on whether 聚宽 (JoinQuant) and 米筐 (RiceQuant) still support live trading, or on their pricing.
- I found nothing on Tushare's per-endpoint point thresholds or call limits, or on BaoStock and other free sources.

## 10. Regulation: CSRC 《证券市场程序化交易管理规定（试行）》 (2024), the exchanges' 程序化交易管理实施细则 (2025), reporting duties for individuals, HFT thresholds, abnormal-trading monitoring and fees, futures-market rules, 2025–2026 updates

### Takeaway
The securities-market timeline:
- Reporting notices issued 2023-09-01, effective **2023-10-09**.
- CSRC 《证券市场程序化交易管理规定（试行）》, issued 2024-05-15, effective **2024-10-08**.
- Exchange 实施细则, issued 2025-04-03, effective **2025-07-07**.

Its principles are "report first, trade later", HFT defined as **≥300 orders+cancels per second or ≥20,000 per day per account**, four monitored abnormal behaviours, and differentiated HFT fees that were planned but not finalised in the sources found. The futures market followed with CSRC rules issued 2025-06-13, effective **2025-10-09**, exchange rules published 2025-08-08, and a transition deadline of **2026-04-08**. Individuals who trade programmatically are covered as broker clients. In practice the HFT and abnormal-trading machinery targets institutions.

### Cited Findings
**Securities market**
- **2023 reporting notices.** The SSE and SZSE notices were issued **2023-09-01** and took effect **2023-10-09**. Existing SSE program traders had 60 trading days to report. Clients report to their member broker, which reports to the exchange; SZSE states that unreported investors may not trade programmatically.
  - Report contents: account basics; fund size and source; leverage size, source and ratio; strategy type and main content; order execution method; maximum order rate and maximum daily orders; software name, version and developer; contacts. Material changes are due within the first five trading days of the following month.
  - Extra items for HFT (≥300 orders per second or ≥20,000 per day): server location, system test report, and contingency plan.
  - SZSE monitors the same thresholds.
  — [华尔街见闻](https://wallstreetcn.com/articles/3696980)
- **CSRC rules.** 《证券市场程序化交易管理规定（试行）》 was issued 2024-05-15 and took effect **2024-10-08**. It has 7 chapters and 32 articles and is the CSRC's first dedicated program-trading regulation. It lets exchanges charge HFT higher or differentiated fees, including cancellation fees. — (search excerpts) [同花顺 2024-05-16](https://news.10jqka.com.cn/20240516/c657883396.shtml); [华尔街见闻](https://wallstreetcn.com/articles/3716812)
- **Definition.** Program trading is "通过计算机程序自动生成或者下达交易指令" in exchange trading: orders automatically generated or submitted by computer programs. — (search excerpt) [SZSE 实施细则 consultation draft, 2024-06-07](https://docs.static.szse.cn/www/disclosure/notice/general/W020240607673406988136.pdf)
- **Exchange 实施细则.** The SSE, SZSE and BSE issued them on **2025-04-03**, effective **2025-07-07**. They cover reporting, trading behaviour, information systems, HFT, Stock Connect (northbound) and supervision.
  - HFT: "单账户每秒申报、撤单笔数合计最高达到300笔以上" or "单账户全日申报、撤单笔数合计最高达到20000笔以上" (combined orders and cancels per account, per second or per day).
  - Four abnormal behaviours: abnormal instantaneous order rate, frequent instantaneous cancels, frequent ramping or suppression across many stocks, and large trades in a short period aggregated across one institution's products. No numeric thresholds are published.
  - Sanctions: self-regulatory measures and discipline; suspending use of exchange co-location after repeated restrictions within a month; referral to CSRC bureaus or associations.
  - HFT extra reporting: server location, test reports, contingency plans.
  - Fees: differentiated HFT fees, with higher flow and cancellation fees "under study", to be issued later under CSRC guidance.
  - Indicator trial: since **2024-04**, with triggers concentrated in quant private funds and broker proprietary desks.
  — [SSE 2025-04-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250403_10776805.shtml)
- **Program-trading share.** The exchanges said program trading's share of the market was "stable with a slight decline" (稳中有降). — [同花顺 2025-04-07 (headline)](https://news.10jqka.com.cn/20250407/c667241566.shtml)
- **Northbound reporting.** A July 2025 reporting guideline (报告指引) brought Stock Connect (沪深股通) investors into program-trading reporting on equal terms with domestic investors. — (search excerpts) [澎湃](https://www.thepaper.cn/newsDetail_forward_31158971); [SSE 2025-04-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250403_10776805.shtml)
- **HFT fee consultation (2024).** Reported on 2024-07-27/28. HFT accounts' flow fee would rise from 0.1元 to 1元 per order (excluding cancels), plus a 5元 fee per cancel. The exchange would compile the figures, pass them to brokers monthly, and brokers would charge clients quarterly. A separate unconfirmed version (2024-07-12) used turnover below 4× a month and cancel rates below 40%. Status at the time: consultation only. — [华尔街见闻 2024-07-28](https://wallstreetcn.com/articles/3721499); [Bloomberg 2024-07-26](https://www.bloomberg.com/news/articles/2024-07-26/china-weighs-tenfold-fee-increase-on-high-frequency-traders)

**Futures market**
- **CSRC rules.** 《期货市场程序化交易管理规定（试行）》 was issued **2025-06-13** and took effect **2025-10-09**, with 7 chapters and 37 articles.
  - HFT means a high number or frequency of orders and cancels in a short time or within a day; the exact standards are set by the futures exchanges.
  - Exchanges may charge cancellation fees, set limits and differentiate HFT fees.
  - Non-futures-company members may not do HFT.
  - Only HFT traders report strategy type, maximum order rates, server location, tests and contingency plans.
  - Futures firms keep system-test records for at least 20 years.
  - Existing program traders must meet the reporting articles 7–12 by **2026-04-08**.
  — [君合 legal update](https://junhe.com/legal-updates/2715); (search excerpts) [CSRC](https://www.csrc.gov.cn/csrc/c100028/c7564353/content.shtml); [新华网 2025-06-16](https://www.news.cn/money/20250616/ae599ca6222242f38fb29c92d6c4038e/c.html)
- **Exchange rules.** SHFE, ZCE, DCE, CFFEX and GFEX each published 《程序化交易管理办法》 on 2025-08-08, effective 2025-10-09. Their principle is "先报告、后交易" (report first, then trade). Reports cover trader scope, account information, and trading and software information, and accounts under common control are treated as one. — [同花顺 2025-08-12](https://news.10jqka.com.cn/20250812/c670294168.shtml)
- **Reporting triggers.** Program traders must report if any of these apply:
  1. In one day, at least 10 occurrences of 10 or more orders/cancels within one second ("1日内≥10次'1秒内10笔以上报撤单'").
  2. Fully automated order decisions.
  3. Use of self-developed or custom software.
  4. Other cases the exchange designates.
  Futures firms must re-sign entrustment agreements with existing program-trading clients by 2026-04-08. — [界面](https://m.jiemian.com/article/13185947.html); [同花顺 2025-08-12](https://news.10jqka.com.cn/20250812/c670294168.shtml)

**2026 status**
- My searches found no new 2026 securities-market program-trading rule. The 2026 events found were the futures transition deadline (2026-04-08) and the 2026-07-06 trading-rule revision (Section 8), which did not concern program trading. — [同花顺 2026-07-01](https://news.10jqka.com.cn/20260701/c677870245.shtml); [界面](https://m.jiemian.com/article/13185947.html)

### Inferences
- **Individuals are in scope.** The duty applies to "会员客户" (broker clients) and to "investors" generally, so an individual running a Python strategy through QMT, PTrade, vn.py or another API must file the report with the broker before trading: account, funds and leverage, strategy type, order rates, and software and developer. The sources do not exempt small accounts.
- **Thresholds are far above retail.** An individual placing tens to hundreds of orders a day is orders of magnitude below 300 per second or 20,000 per day, so HFT fees and extra reporting will rarely apply. Abnormal-trading rules (rapid cancels, ramping) can still apply to aggressive limit-up (打板) bots that cancel and resubmit orders.
- **Futures trigger is low.** The futures "10 times a day, 10 orders within 1 second" trigger and the "fully automated" and "custom software" triggers reach most retail CTA bots, so vn.py/CTP users must report from 2025-10-09, and pre-existing ones by 2026-04-08.
- **Unclear whether conditional orders count.** Whether broker-hosted 条件单 or 网格单 count as program trading is not settled by these sources. Broker-side conditional orders are typically outside the client-reporting regime, but this is unverified (see Gaps).

### Gaps
- I found no evidence that the exchanges finalised a differentiated HFT fee schedule after the 2024 consultation and 2025-04-03 statement (amounts and effective date), or the numeric abnormal-trading thresholds.
- I did not retrieve the full article text of the 2025 实施细则 or of the 2025-07 报告指引, including the precise individual-investor report fields and whether broker conditional or grid orders are excluded.
- I did not retrieve the futures exchanges' own HFT numeric standards (per-second and per-day counts). I found only the reporting trigger above.
- My searches found no 2026 amendments beyond those noted, but the search budget was exhausted before a thorough 2026 sweep, so a 2026 change could have been missed.
