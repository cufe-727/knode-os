# Systematic trading and investing approaches for individual investors beyond cross-sectional stock selection: global evidence (as of 2026-10-31)

*Scope: US/European equities and ETFs, futures, options and crypto; China-specific material is covered elsewhere. Method note: the shared web-search budget for this run ran out partway through (after about 55 searches by this researcher), so later facts come from direct fetches of known primary pages (arXiv, NBER, AQR, issuer pages, GitHub API, PyPI) rather than new searches. Several hosts (cboe.com, cepr.org, cmegroup.com, ssrn.com, alphaarchitect.com) were unreachable or blocked from this network; figures that reached me only as search-result excerpts from those hosts are flagged. "Search excerpt" means the figure came from the search tool's summary of the listed page, not from my own reading of the page.*

*Corrections to the brief, detailed in the sections below: (1) "Adaptive Asset Allocation" is generally credited to ReSolve Asset Management (Butler, Philbrick and Gordillo), not to Keller; Keller's family is FAA/EAA/PAA/VAA/DAA/BAA/HAA. I could not re-verify the ReSolve credit this session. (2) pysystemtrade now lives at `pst-group/pysystemtrade` and PyPortfolioOpt at `PyPortfolio/PyPortfolioOpt`. (3) Polygon.io's Python client now redirects to Massive (`massive-com/client-python`). (4) ib_insync is archived; ib_async is the maintained IBKR wrapper. (5) Backtrader has had no commits since April 2023. (6) The pandas-ta GitHub repository returns 404. (7) The PDT $25k rule no longer appears on FINRA's investor day-trading page, which now describes intraday margin with a $2,000 minimum.*

## 1. Trend following / time-series momentum (TSMOM) and managed-futures (CTA) style strategies

### Takeaway
Trend following has the longest and most consistent evidence base of anything here. It made money in every decade back to 1880 in AQR's simulation, with a "smile" payoff in extreme equity years. Realized industry returns are far more modest. The SG Trend Index has compounded at about 5.3–5.75% a year since 2000 with a 20.6% maximum drawdown. It had a weak 2010s, a record +27.4% in 2022, a −20.4% drawdown from May 2024 to May 2025, roughly +2.4% in each of 2024 and 2025, and a strong 2026 (+14.9% YTD estimate to 31 Oct). Academic critiques argue that much of TSMOM's apparent alpha comes from volatility scaling rather than from statistically robust return predictability. Individuals can get exposure through managed-futures ETFs at any account size (about 0.75–0.95% fees), or trade it themselves in futures. For a diversified DIY futures system, Carver suggests at least $100k.

### Cited Findings
#### Rules (canonical academic version)
- AQR's "Century" strategy is an equal-weighted mix of 1-, 3- and 12-month TSMOM signals across 67 markets (equity-index, bond, currency and commodity futures/forwards). Each market is long if its past excess return is positive and short otherwise. Positions are sized to equal volatility, the combined portfolio is scaled to a 10% annualized ex-ante volatility target, and it is rebalanced monthly. The backtest subtracts estimated transaction costs (assumed 2× higher in 1993–2002 and 6× higher in 1880–1992) and a 2% management / 20% performance fee with a high-water mark. — [Hurst, Ooi & Pedersen, JPM Fall 2017 (PDF copy)](https://fairmodel.econ.yale.edu/ec439/hurst.pdf); [AQR summary page](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)
- Moskowitz, Ooi & Pedersen (JFE, May 2012) studied 58 liquid equity-index, currency, commodity and bond futures from 1985 to 2009. 12-month TSMOM was profitable for every one of the 58 contracts. Returns persist for 1–12 months and partially reverse over longer horizons. — [SSRN abstract](https://papers.ssrn.com/abstract=2089463); [CXO Advisory summary](https://cxoadvisory.com/momentum-investing/intrinsic-time-series-momentum-everywhere)
- Levine & Pedersen (2016) show that TSMOM in its general form captures moving-average crossovers and all other linear trend filters (as cited in the Century paper). — [Hurst, Ooi & Pedersen 2017](https://fairmodel.econ.yale.edu/ec439/hurst.pdf)

#### Key evidence
- Century paper (1880–2016):
  - Performance was "surprisingly consistent" across the Great Depression, wars, stagflation and the GFC, and each lookback (1, 3, 12 months) was positive in every decade.
  - Lagging the signal by one month degrades returns, especially for short lookbacks.
  - The average per-market gross Sharpe is about 0.4, and returns are positive in every market.
  - The strategy was positive in 8 of the 10 largest 60/40 drawdowns. Those drawdowns lasted about 15 months on average, which gave trend followers time to position.
  - It may fail in abrupt crashes such as 1987.
  - Its own drawdowns reached up to 25% over extended periods.
  - Returns were weaker when cross-market correlations were high.
  - Moving 20% of a 60/40 portfolio into the strategy lowered maximum drawdown and volatility and raised return.
  - [Hurst, Ooi & Pedersen 2017](https://fairmodel.econ.yale.edu/ec439/hurst.pdf)
- Headline portfolio figures: the Exhibit 1 table is an image in the PDF and could not be extracted. A search excerpt of AQR's page reported a net-of-fee Sharpe of 0.77 for January 1880 to December 2013 (earlier version); treat this as unverified. — [AQR page (search excerpt)](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)
- MOP 2012: CXO reports a gross monthly alpha versus equities of about 1.26% (1985–2009) and notes the returns are apparently gross. Quantpedia's Sharpe of 1.31 is its own estimate derived from a t-statistic, not a figure quoted in the paper. — [CXO Advisory](https://cxoadvisory.com/momentum-investing/intrinsic-time-series-momentum-everywhere); [Quantpedia](https://quantpedia.com/strategies/time-series-momentum-effect/)

#### Critiques and decay
- Huang, Li, Wang & Zhou ("Time series momentum: Is it there?", JFE 135(3), 2020):
  - Asset-by-asset predictive regressions show little power in or out of sample.
  - The large pooled t-statistic does not survive bootstrap critical values.
  - A TSM strategy performs about the same as one built on the historical sample mean.
  - [IDEAS/RePEc](https://ideas.repec.org/a/eee/jfinec/v135y2020i3p774-794.html); [WUSTL profile](https://profiles.wustl.edu/en/publications/time-series-momentum-is-it-there/)
- Kim, Tse & Wald (J. Financial Markets 30, 2016):
  - On MOP's 1985–2009 sample, alpha falls from 1.27% to 0.41% a month without volatility scaling.
  - Unscaled TSMOM performs similarly to buy-and-hold.
  - The superior performance vanishes in 2009–2013 and is concentrated before 2001.
  - These figures are from secondary summaries; the paper itself is paywalled.
  - [Quantpedia](https://quantpedia.com/deconstructing-the-time-series-momentum-strategy/); [Alpha Architect](https://alphaarchitect.com/2016/12/time-series-momentum-volatility-scaling-and-crisis-alpha/)
- AQR, "You Can't Always Trend When You Want" (Babu, Hoffman, Levine, Ooi, Schroeder, Stamelos, 2019): the weak 2010s reflect fewer large market moves, not a loss of the ability to profit from trends or of diversification. The authors see the weakness as cyclical rather than structural. — [AQR](https://www.aqr.com/Insights/Research/White-Papers/You-Cant-Always-Trend-When-You-Want)
- One secondary summary puts the SG Trend Index Sharpe at about 0.05 for 2010–2018 versus 0.28 since 2000. I could not verify this. — [Quantpedia write-up (search excerpt)](https://quantpedia.com/?p=5604)

#### Post-2020 behaviour (index data)
- **2008 and 2022:**
  - SG Trend returned +20.9% in 2008 (MSCI ACWI −42.2%) and +27.4% in 2022 (ACWI −18.4%). — [Cambridge Associates, Aug 2025](https://www.cambridgeassociates.com/en-eu/insight/does-trend-followings-recent-struggle-signal-that-the-strategy-is-structurally-broken/)
  - 2022 (+27.35%) was the index's best year since its January 2000 launch. — [The Full FX](https://thefullfx.com/year-end-drop-fails-to-dampen-stellar-2022-for-trend-followers/)
- **2023:** SG Trend −4.16%, BTOP50 −1.70%. — [TTU Dec 2023 report](https://www.toptradersunplugged.com/?p=14211)
- **2024:** SG Trend +2.42%, BTOP50 +4.44%. — [TTU Dec 2024 report](https://www.toptradersunplugged.com/trend-following-performance-report-december-2024/)
- **May 2024 to May 2025 drawdown:**
  - SG Trend fell −20.4%, its second-largest drawdown since 2000, while MSCI ACWI rose +18.3%.
  - The index has had 16 drawdowns larger than 10% since 2000, roughly one every 18–24 months.
  - Cambridge Associates blames abrupt reversals and range-bound markets (for example the April 2025 "Liberation Day" tariff whipsaw) and concludes the strategy is cyclical, not structurally broken.
  - [Cambridge Associates](https://www.cambridgeassociates.com/en-eu/insight/does-trend-followings-recent-struggle-signal-that-the-strategy-is-structurally-broken/)
- **2025:**
  - SG Trend was −9.33% YTD after April and −7.56% YTD in August (search excerpts of TTU reports). — [TTU Apr 2025](https://www.toptradersunplugged.com/trend-following-performance-report-april-2025/); [TTU Aug 2025](https://www.toptradersunplugged.com/trend-following-performance-report-august-2025/)
  - It finished 2025 at +2.39% (December +1.92%), with a since-inception CAGR of 5.33% and a maximum drawdown of 20.61%. — [TTU Dec 2025 report](https://www.toptradersunplugged.com/trend-following-performance-report-december-2025/)
  - An SG note says the range of 2025 returns across individual trend followers was about 30 percentage points (excerpt truncated). — [SG CTA industry update 2025](https://content.sgmarkets.com/CTA_UPDATE_KEEPING_UP_WITH_THE_TRENDFOLLOWERS_2025)
- **2026:**
  - September: SG Trend +4.26%, YTD +15.80%, trailing 12 months +21.33%. BTOP50 YTD +14.81%; S&P 500 TR YTD +12.75%.
  - Since 2000: SG Trend CAGR 5.75% with a 20.61% max drawdown; BTOP50 4.51% / 15.94%; S&P 500 TR 8.23% / 50.95%.
  - [TTU Sep 2026 report](https://www.toptradersunplugged.com/trend-following-performance-report-september-2026/)
  - BarclayHedge's estimate as of 31 Oct 2026 is YTD +14.92% (October MTD −0.77%). — [BarclayHedge SG Trend page](https://portal.barclayhedge.com/cgi-bin/indices/displayHfIndex.cgi?indexCat=SG-Prime-Services-Indices&indexName=SG-Trend-Index)

#### Implementation for individuals (capital, instruments, data, execution)
- **Minimum capital:** Carver recommends at least $100,000 for trading futures, and says UK readers can use less capital by replicating futures with CFDs and spread bets. — [Harriman House interview on *Advanced Futures Trading Strategies*](https://www.harriman-house.com/advancedfuturestradingstrat)
- **Small accounts:** a podcast summary says Carver moved from static instrument selection to "dynamic optimisation", which accounts for costs and contract size, ideally with at least four contracts per instrument. This is a secondary paraphrase. — [Algorithmic Advantage podcast notes](https://thealgorithmicadvantage.substack.com/p/033-rob-carver-the-comprehensive)
- **What AFTS covers:** capital needed per instrument, trading-cost calculation and instrument selection. Strategies include trend, breakouts, calendar spreads and fast mean reversion. — [Pan Macmillan listing](https://www.panmacmillan.com/authors/robert-carver/advanced-futures-trading-strategies/9780857199683)
- **Open-source implementation:** Carver's system is now at `pst-group/pysystemtrade`. Release 1.8.3 came out 2026-09-30, with commits in October 2026. — [GitHub](https://github.com/pst-group/pysystemtrade)
- **ETF route, KMLM:**
  - KMLM (KraneShares, KFA MLM Index) holds 22 futures (11 commodities, 6 currencies, 5 bond markets, no equities), weighted by sector volatility. Expense ratio 0.90%; inception 1 Dec 2020.
  - NAV returns: 2026 YTD +19.23% (to 30 Sep 2026); 3-year annualized +0.41%; 5-year +5.94%; since inception +8.23%.
  - [KraneShares KMLM page](https://kraneshares.com/kmlm/)
- **ETF route, DBMF and CTA:**
  - DBMF (iMGP DBi) replicates the pre-fee SG CTA Index with a regression on liquid futures across four buckets; its expense ratio is about 0.85%.
  - CTA (Simplify) charges about 0.75% and adds other models to trend. Secondary sources disagree on its exact fee and method.
  - [Picture Perfect Portfolios comparison](https://pictureperfectportfolios.com/whats-the-best-managed-futures-etf-dbmf-vs-kmlm-vs-cta/); [Flourishing Path comparison](https://www.flourishingpathfinancial.com/post/managed-futures-part-2-which-fund-is-right-for-your-portfolio)

#### Best learning sources
- **Robert Carver:**
  - Books: *Systematic Trading*, *Smart Portfolios*, *Leveraged Trading*, *Advanced Futures Trading Strategies* and *The Art and Science of Trading*.
  - Background: former AHL portfolio manager who ran AHL's multi-billion-dollar fixed-income portfolio. — [Harriman House author page](https://harriman-house.com/authors/profile/robertcarver/17482)
  - Blog: on 4 September 2026 he posted about his fifth book, and he now also trades Bitcoin and Ethereum futures. — [qoppac blog](https://qoppac.blogspot.com/)
- **AQR research:**
  - "A Century of Evidence on Trend-Following Investing". — [AQR](https://www.aqr.com/Insights/Research/Journal-Article/A-Century-of-Evidence-on-Trend-Following-Investing)
  - "You Can't Always Trend When You Want". — [AQR](https://www.aqr.com/Insights/Research/White-Papers/You-Cant-Always-Trend-When-You-Want)
- **Monthly index tracking:** Top Traders Unplugged's monthly performance reports. — [TTU](https://www.toptradersunplugged.com/trend-following-performance-report-september-2026/)

### Inferences
- Behaviour after 2020 is consistent with design, not decay. Trend paid off in the slow, persistent 2022 inflation and rates shock. It lost in the V-shaped, policy-driven reversals of 2024–25. It recovered in 2026. Nothing in the 2020–2026 data shows a structural break, but 26 years of index data show modest returns (about 5–6% CAGR) with frequent 10–20% drawdowns.
- The Kim-Tse-Wald and Huang et al. critiques mean individuals should not pay for "trend alpha" that a cheaper volatility-scaled diversified allocation already delivers. The case for trend rests on crisis convexity and diversification, not on a large standalone Sharpe ratio.
- Individuals have real advantages here:
  - A small account has no capacity problem in liquid futures.
  - Signals are slow (monthly in AQR's version), so turnover and costs are low.
  - Futures provide cheap, exchange-margined leverage.
- The binding constraint is capital granularity. Below roughly $100k a DIY futures portfolio is under-diversified, so ETFs (any size, about 0.75–0.95% a year) or Carver-style dynamic optimisation over micro contracts are the practical routes.
- KMLM's +0.41% 3-year annualized return against +19.23% for 2026 YTD shows how path-dependent and lumpy single-vendor trend ETFs are. Diversifying across replication methods (DBMF's index replication versus KMLM's rules-based index) reduces model risk.

### Gaps
- The Century paper's Exhibit 1 numbers (gross and net returns, Sharpe ratios, correlations by decade) could not be extracted because they are an image.
- I could not verify calendar-year SG Trend returns for 2010–2019, the SG CTA Index for 2023–2025, or DBMF and CTA calendar-year returns, including 2022.
- I found no source this session for micro-futures contract specifications (CME pages unreachable) or for Clenow's *Following the Trend* details and evidence. Clenow's books remain standard practitioner references, but their contents and dates were not re-verified.
- US tax treatment of futures (Section 1256 60/40) versus managed-futures ETFs was not verified. The IRS page fetched confirms only that Form 6781 reports Section 1256 mark-to-market gains. — [IRS Form 6781 page](https://www.irs.gov/forms-pubs/about-form-6781)

## 2. Tactical asset allocation (TAA) and ETF rotation

### Takeaway
Published TAA rules work mainly as drawdown insurance. Out of sample they have usually earned less than buy-and-hold equities, and often less than a static 60/40, with risk-adjusted performance well below the in-sample claims:

| Strategy | In-sample | Out of sample |
|---|---|---|
| Faber 5-asset GTAA | 1972–2005: 11.7% CAGR, Sharpe 0.81 | 2006–Mar 2025: 6.05% CAGR, Sharpe 0.68 |
| Antonacci's GEM | Beat the S&P 500 by about 5 points a year pre-publication | Trailed SPY by about 5 points a year since the 2014 book |
| Adaptive Asset Allocation | 1996–2014: Sharpe 1.33 | 2015–2023: Sharpe 0.57 |

Keller's highly parameterized PAA/VAA/DAA/BAA family has little independent out-of-sample evidence.

### Cited Findings
#### Faber's 10-month moving average / GTAA
- **Rules:** hold each of five asset classes only when it is above its roughly 10-month (200-day) moving average; otherwise hold cash. Checked at month-end. The usual description of the five is US stocks, foreign stocks, US bonds, REITs and commodities, but I did not re-verify the asset list this session. An independent update used the same 200-day SMA, the same five assets and month-end rebalancing. — [Concretum Research, Jun 2026](https://concretumgroup.substack.com/p/global-tactical-asset-allocation)
- **History of the paper:**
  - The 2007 paper tested data through 2005, and a 2009 version extended the out-of-sample period through 2008 (search excerpts). — [Swedroe/ETF.com](https://www.etf.com/sections/index-investor-corner/swedroe-why-financial-trends-persist); [Capital Spectator](https://capitalspectator.com/?p=7974)
  - Faber later published a "10 years later" revisit. — [Meb Faber podcast ep. 86](https://mebfaber.libsyn.com/ep86-meb-faber)
- **Out-of-sample result:** 2006 to March 2025 delivered a 6.05% CAGR, Sharpe 0.68 and an 11.7% maximum drawdown. The original 1972–2005 backtest showed 11.7% CAGR, Sharpe 0.81 and a 9.5% maximum drawdown. The author says it held up through the GFC, COVID and 2022 (cost assumptions are behind a paywall). — [Concretum Research](https://concretumgroup.substack.com/p/global-tactical-asset-allocation)
- Capital Spectator argued the original backtest may have overstated what to expect going forward. — [Capital Spectator](https://capitalspectator.com/?p=7974)

#### Antonacci's dual momentum / Global Equities Momentum (GEM)
- **Rules:** monthly, using 12-month returns. If US stocks (SPY) beat T-bills (BIL), hold whichever of SPY or ex-US stocks (VEU) has the stronger 12-month return; otherwise hold aggregate bonds (AGG). — [Quant for Free reimplementation, 2026-07-31](https://quant4free.com/analysis/dual-momentum/)
- **Out-of-sample results (blog reimplementation):**
  - 2014–2026: GEM 8.4% CAGR, Sharpe 0.70, maximum drawdown −20%; SPY 13.6%, 0.94, −24%; static 60/40 9.1%, 0.95, −20%.
  - 2008–2026: GEM 9.1%, 0.74, −20% versus SPY 11.6%, 0.77, −42%.
  - About 30 switches in 18 years, with US equities held roughly two-thirds of the time.
  - Verdict: "Not broken — just beaten by boring". This is a blog reimplementation, not peer-reviewed.
  - [Quant for Free](https://quant4free.com/analysis/dual-momentum/)
- **Other independent replications (secondary, from search excerpts):**
  - One replication covering December 2011 to September 2026 found GEM returned 4.32% a year versus 6.19% for the paper's no-momentum benchmark, with a −28.62% maximum drawdown versus −24.89%. — [GitHub dual-momentum-oos](https://github.com/FranciscoAC-burst/dual-momentum-oos)
  - Another found GEM beat the S&P 500 by 5.1 points a year pre-publication (1997–2013) and trailed it by 5.4 points a year post-publication (2014–2026). It offered no protection in fast crashes (2020, 2025). — [GitHub AlgoStrategyLab](https://github.com/AlgoStrategyLab/dual-momentum)
- **Whipsaw:** short-lived signals cost transaction costs and missed rallies. GEM underperformed S&P 500 buy-and-hold from 2014 to 2022. — [Reblnc](https://reblnc.com/insights/dual-momentum)

#### Keller-family strategies (VAA, DAA, BAA)
- VAA ("Breadth Momentum and Vigilant Asset Allocation", 2017) replaces asset-level trend filters with universe-level "breadth momentum" and a fast momentum filter.
- DAA ("Breadth Momentum and the Canary Universe", 2018) uses a separate canary universe to decide crash protection. It holds less than half of VAA's average cash. It beat VAA on CAGR in three of four universes but had worse maximum drawdowns in all four.
- [CXO Advisory](https://www.cxoadvisory.com/strategic-allocation/multi-class-momentum-portfolio-with-canary-crash-protection/)
- BAA (Keller, SSRN 4166845, July 2022) combines slow relative momentum with fast absolute momentum and crash protection. In the PAA-G12 example the breadth parameter B is 6. — [BAA paper copy](https://thechartist.com.au/wp-content/uploads/2024/12/5369/SSRN-id4166845.pdf)

#### Adaptive Asset Allocation (AAA)
- **Rules:** take the top 5 asset classes by roughly 6-month momentum, weight them by minimum variance, and rebalance monthly.
- **Replication (Feb 1996–Dec 2014):** annualized return 13.7%, volatility 10.3%, Sharpe 1.33, worst drawdown −10.2%.
- **Out of sample (2015–2023):** 5.4%, 9.4%, Sharpe 0.57, −19.0%. Over 2015–2021 alone: 8.6%, Sharpe 1.03, −8.0%.
- [FOSS Trading / R-bloggers, Jan 2024](https://www.r-bloggers.com/2024/01/adaptive-asset-allocation-extended/amp/)

#### Aggregate post-publication evidence
- An Allocate Smartly guest post (April 2017) found TAA had trailed the 60/40 benchmark by 4.3% a year since the 2009 bottom, while doing "a respectable job" during and after the GFC. — [Alpha Architect guest post](https://alphaarchitect.com/tactical-asset-allocation-us-6040-benchmark/)
- 19 of 39 tracked TAA strategies beat 60/40 in 2017 (search excerpt). — [Seeking Alpha](https://seekingalpha.com/article/4135873-tactical-asset-allocation-performance-in-2017)
- **General decay (stock anomalies, but the closest systematic evidence):**
  - Sharpe ratios decay by about half after publication.
  - The decay for newly published factors grows by 5 percentage points with each later publication year.
  - Publication year alone explains about 30% of the variance in decay; signal complexity and sensitivity to outliers add about 15%.
  - [Falck, Rej & Thesmar, arXiv 2105.01380](https://arxiv.org/abs/2105.01380)
  - Portfolio returns are 26% lower out of sample and 58% lower after publication (97 predictors). — [McLean & Pontiff, JF 2016](https://www.gwern.net/doc/economics/2016-mclean.pdf)

### Inferences
- TAA is trend following on 2–13 ETFs instead of 60+ futures. It has less diversification and more single-asset whipsaw, but it needs no leverage, no futures account and almost no capital.
- Its realistic job is to cut drawdowns, so investors stay invested, at the price of lower bull-market returns. It is not a source of alpha.
- The 2014–2026 evidence is dominated by a US mega-cap bull market with fast crashes (2020, 2025). That is the worst environment for slow 10–12-month filters, so some of the post-publication shortfall is regime-driven.
- The in-sample-versus-OOS pattern (GTAA, GEM, AAA) still matches the general rule of roughly a 50% Sharpe haircut.
- Monthly switching realizes capital gains. For taxable investors this argues for running TAA in tax-advantaged accounts. This is an inference; I did not verify specific tax rules.
- Keller-style strategies with many tuned parameters (breadth B, canary sets, 13612W weights) should be treated as high overfitting risk. Falck et al. find complexity predicts decay.

### Gaps
- I could not obtain the numbers from Faber's 2018 JPM revisit, Allocate Smartly's own live-versus-backtest tracking (pages not fetched), or independent OOS studies of PAA/VAA/DAA/BAA/HAA.
- I found no rigorous OOS evidence on sector-ETF rotation.
- The credit for Adaptive Asset Allocation to ReSolve (Butler, Philbrick, Gordillo) could not be re-verified (ReSolve URL returned 404).

## 3. Risk-based allocation: risk parity / All Weather, volatility targeting, volatility-managed portfolios, rebalancing premium, leveraged ETFs

### Takeaway
Volatility targeting is a robust risk-control tool. It lowers tail risk across asset classes and improves Sharpe for equities and credit, but not for bonds, FX or commodities. The stronger "volatility-managed alpha" claim (Moreira & Muir) mostly fails out of sample (Cederburg et al.: worse for 72 of 103 strategies) and after transaction costs (Barroso & Detzel). Risk parity, which relies on leveraged bonds, had its worst year in 2022: All Weather lost 22% and the RPAR ETF fell 32% peak to trough. The rebalancing or diversification return is real in theory but conditional. Daily-reset leveraged ETFs are path-dependent and can suffer drawdowns of around 80%.

### Cited Findings
#### Volatility-managed portfolios (Moreira & Muir 2017)
- **Rule:** scale exposure to a factor or the market inversely to its recent realized variance.
- **Claims:** large utility gains (working-paper figures range from about 50–90%, with 65% and 75% cited for lifetime utility), and survival after transaction costs for the market and most international indices. Published in the Journal of Finance 72(4), 1611–1644. — [NBER w22208](https://www.nber.org/papers/22208); [NBER conference paper](https://conference.nber.org/conf_papers/f88104/f88104.pdf)
- **Out-of-sample test (Cederburg, O'Doherty, Wang & Yan, JFE 138, 2020; 103 equity strategies):**
  - Volatility-managed versions had higher gross Sharpe ratios for only 53 of 103 strategies, and only 8 of those were significant.
  - Spanning-regression alphas looked positive for 77 of 103, but this needs full-sample foresight.
  - Real-time mean-variance implementations were worse for 72 of 103.
  - [Paper PDF](https://www.lehigh.edu/~xuy219/research/COWY.pdf); [CXO Advisory summary](https://www.cxoadvisory.com/volatility-effects/does-volatility-management-work-for-equity-factor-portfolios/)
- **Transaction costs (Barroso & Detzel):** costs erode the gains for every factor except the market, and gains appear concentrated in high-sentiment periods. These are secondary summaries; exact scope and year were not verified. — [Hedge Fund Alpha summary](https://hedgefundalpha.com/strategies/volatility-managed-portfolios/)

#### Volatility targeting (Harvey, Hoyle, Korgaonkar, Rattray, Sargaison & Van Hemert, JPM 2018)
- Sample: more than 60 assets, daily data from 1926 to 2017.
- Volatility targeting raises Sharpe ratios for "risk assets" (equities, credit) through the leverage effect, has negligible Sharpe impact for bonds, FX and commodities, and reduces extreme returns everywhere. It also cuts maximum drawdowns for balanced and risk-parity portfolios.
- US equity volatility-of-volatility falls from 4.6% to 1.8%.
- [Alpha Architect](https://alphaarchitect.com/volatility-targeting-improves-risk-adjusted-returns/); [Quantpedia](https://quantpedia.com/the-impact-of-volatility-targeting-on-equities-bonds-commodities-and-currencies)

#### Risk parity in 2022
- Bridgewater's All Weather (10% volatility version) lost 22% in 2022, lagging most peers. — [Fortune, Apr 2024](https://fortune.com/2024/04/23/lackluster-returns-ray-dalio-investing-strategy-investors-pull-billions/)
- CAIA notes the 2022 loss was 2 points larger than All Weather's −20% in 2008, as correlations "trended upwards". The Permanent Portfolio lost only −5.5% thanks to equity and gold allocations. — [CAIA](https://caia.org/node/7312)
- The RPAR Risk Parity ETF fell more than 32% from its November 2021 high, a record drawdown as of late September 2022. — [Bloomberg](https://www.bloomberg.com/news/articles/2022-09-28/-perfect-storm-for-risk-parity-has-etf-posting-record-32-drop)

#### Rebalancing premium (diversification return)
- Willenbrock (FAJ 2011) argues that rebalancing, by selling relative winners and buying relative losers, is the source of diversification return. Variance reduction is necessary but not sufficient. A rebalanced commodity-futures index's excess return can be largely explained by diversification return. — [arXiv 1109.1256](https://arxiv.org/abs/1109.1256); [CFA Institute page](https://rpc.cfainstitute.org/research/financial-analysts-journal/2011/diversification-return-portfolio-rebalancing-and-the-commodity-return-puzzle)

#### Leveraged ETFs and volatility decay
- Daily-reset leveraged ETFs lose to volatility drag. In a +10% / −10% two-day example, a 2× fund loses 4% while the index loses 1%, so the fund ends 2 points below twice the index's two-day return.
- Leveraged ETFs beat their simple multiple in low-volatility trends and lag in choppy, high-volatility markets.
- TQQQ's 2022 maximum drawdown was −81% versus −35% for a 1× Nasdaq-100 fund.
- [Nasdaq](https://www.nasdaq.com/articles/should-investors-use-leveraged-etfs-or-avoid-them-altogether); [Ryan O'Connell](https://ryanoconnellfinance.com/leveraged-etfs/)
- A leveraged 60/40-style fund "fell into the same trap" when stocks and bonds moved together in 2022. — [Morningstar](https://global.morningstar.com/en-ca/etfs/can-leveraged-etfs-benefit-your-portfolio-clone)

### Inferences
- For individuals, volatility targeting is cheap (monthly ETF rebalancing) and its value is risk control: fewer extreme months and smaller drawdowns. Do not expect it to add alpha.
- Risk parity requires leverage, which is affordable through futures and portfolio margin. 2022 showed its hidden assumption: negative stock-bond correlation and falling rates. Leveraged bond-heavy portfolios such as UPRO/TMF ("HFEA") face the same regime risk plus daily-reset decay.
- Daily-reset leveraged ETFs are a poor way to get long-horizon leverage in volatile assets. Futures or modest margin give linear leverage without the reset drag.

### Gaps
- I could not access HFEA's realized 2022 drawdown, Cheng & Madhavan (2009) on leveraged-ETF dynamics, Gayed & Bilello's "Leverage for the Long Run" (moving-average-filtered leverage), or risk-parity performance in 2023–2026.
- Barroso & Detzel's exact results and Moreira & Muir's published-version utility numbers were not verified from the papers.

## 4. Statistical arbitrage individuals can run: pairs trading, cointegration/ETF pairs, short-term reversal, mean-reversion rules

### Takeaway
Classic distance-method pairs trading earned up to about 11% a year for top pairs (1962–2002, essentially gross), but profitability declined steadily. After commissions, market impact and short-selling fees it is "much more modest" (Do & Faff, 1963–2009), and the profits are concentrated in turbulent periods such as 2007–09. Short-horizon contrarian equity returns collapsed as capital crowded in (Khandani & Lo: a simulated contrarian strategy's average daily return fell to 0.13% by 2006) and then crashed in August 2007. Retail ETF mean-reversion rules such as Connors' RSI(2) have only thin, practitioner-level evidence. A 2016–2026 test shows positive but tiny returns against buy-and-hold.

### Cited Findings
#### Pairs trading
- **Gatev, Goetzmann & Rouwenhorst (RFS 2006):** pair stocks by minimum distance between normalized prices in a formation period, open when the spread diverges by two standard deviations, and close on convergence. Self-financing top-pairs portfolios earned average annualized excess returns of up to about 11% over 1962–2002 (up to 12% in the NBER 1962–1997 version). These returns typically exceed conservative transaction-cost estimates. — [NBER w7032](https://nber.org/papers/w7032); [paper copy](https://c.mql5.com/forextsd/forum/208/Pairs%20Trading%20-%20Performance%20of%20a%20Relative%20Value%20Arbitrage%20Rule.pdf); [Alpha Architect](https://alphaarchitect.com/2013/06/pairs-trading-kicks-butt/)
- A later replication reported a 6.2% compounded annual excess return after costs for its best strategy, in a different sample (search excerpt). — [Harbourfront Quant](https://harbourfrontquant.substack.com/p/further-on-the-profitability-of-pairs)
- **Do & Faff (FAJ 2010):** pairs-trading profitability continued to decline, but the strategy performs strongly in prolonged turbulence, including 2007–09. Refined pair selection adds about 22 bp a month for bank stocks. — [IDEAS/RePEc](https://ideas.repec.org/a/taf/ufajxx/v66y2010i4p83-95.html); [CFA Institute](https://rpc.cfainstitute.org/research/financial-analysts-journal/2010/does-simple-pairs-trading-still-work)
- **Do & Faff (2012, US 1963–2009):** after commissions, market impact and short-selling fees, pairs trading "remains profitable, albeit at much more modest levels". — [Strathprints](https://strathprints.strath.ac.uk/41722/)

#### Short-term reversal and crowding
- **Khandani & Lo, "What Happened to the Quants in August 2007?":**
  - A simple contrarian long/short strategy's average daily return fell to a low of 0.13% in 2006 as assets in long/short and market-neutral funds grew. Secondary sources cite about 1.38% a day in 1995 (unverified).
  - The leverage needed to keep returns constant rose about 4.5× from 1998 to 2007.
  - In the week of 6 August 2007 the unleveraged model lost about 12 daily standard deviations before rebounding.
  - [NBER w14465](https://nber.org/system/files/working_papers/w14465/w14465.pdf); [MIT summary](https://web.mit.edu/~alo/www/Papers/august07.html); [CXO Advisory](https://www.cxoadvisory.com/?p=1434); [Harvard blog](https://archive.blogs.harvard.edu/cqtwo/2007/10/25/what-happened-to-the-quants-in-august-2007/)
- **Lou, Polk & Skouras (JFE 2019, "A Tug of War"):** for many strategies, profits accrue entirely overnight or entirely intraday, often with opposite signs, reflecting competing clienteles. The authors note that trading costs make exploiting these patterns much less attractive. — [LSE PDF](https://personal.lse.ac.uk/polk/research/TugOfWar.pdf)

#### Connors RSI(2)
- **Rules (Connors & Alvarez 2008):** buy when 2-period RSI is below 10 and price is above its 200-day average; exit when RSI(2) rises above 65.
- **2016–2026 S&P 500 CFD test (stricter RSI < 5 entry):**
  - Positive but small: +18.1% cumulative, profit factor 1.43, 71% winners.
  - About 1.7% a year versus 13.5% a year for buy-and-hold.
  - 2018 was the worst year (−9.8%).
  - [Backtest Substack](https://backtest.substack.com/p/the-2-period-rsi-a-simple-system)
- Other public tests are vendor or community backtests without clear methodology. — [ProRealCode](https://www.prorealcode.com/prorealtime-trading-strategies/rsi-2p-larry-connors/); [Backtrex](https://backtrex.com/en/backtests/connors-rsi-2-sp-500)

### Inferences
- Individuals face structural headwinds in short-horizon equity stat arb:
  - They pay retail borrow fees and can be refused hard-to-borrow names.
  - They pay spreads on every round trip.
  - The edge is crowded by institutional capital, as Khandani & Lo show.
  - Profits cluster in crises, exactly when retail margin and borrow availability are most fragile.
- More realistic retail variants:
  - Long-only "buy-the-dip" overlays on index ETFs. These need no shorting, but expect small returns and long cash periods.
  - Liquid ETF pairs with cheap borrow.
  - Futures calendar or relative-value spreads with exchange margin offsets, as covered in Carver's AFTS.

### Gaps
- I found no rigorous post-2010 out-of-sample study of cointegration-based ETF pairs or of RSI(2) on SPY with costs, and no data on retail short-borrow fees.
- Standard books (Vidyamurthy, *Pairs Trading*; Chan, *Algorithmic Trading* and *Quantitative Trading*; Connors) were not re-verified this session.

## 5. Calendar and event effects: turn of the month, overnight vs intraday, pre-FOMC drift, PEAD, index inclusion, merger arbitrage

### Takeaway
Most famous effects have weakened sharply or disappeared after publication or market-structure change:
- The pre-FOMC drift essentially vanished after 2015.
- Large-cap PEAD has been gone since about 2006. Its survival is disputed and mostly confined to microcaps.
- The S&P 500 inclusion premium shrank from about 7.5% in the 1990s to under 1% in the 2010s.
- A live "overnight-only" ETF closed in 2023 after −6.9% versus +22% for the S&P 500.
- Turn-of-the-month was powerful in 1926–2005, but a 2025 paper is titled "The disappearing turn-of-month effect".

Merger arbitrage still looks like a genuine liquidity or insurance premium: about 4% a year after costs in 1963–1998, with a short-put-like crash profile.

### Cited Findings
- **Pre-FOMC drift:**
  - Lucca & Moench found US stock returns on FOMC announcement days were more than 30× larger than on other days. The excess return in the 24 hours before scheduled announcements accounted for more than 80% of the equity premium over about 17 years (sample September 1994 to March 2011). No risk explanation fits. — [NY Fed SR 512 abstract](https://econpapers.repec.org/RePEc:fip:fednsr:512)
  - Kurov, Wolfe & Gilbert (Finance Research Letters 40, 2021) extended the sample to December 2019. They found the drift "essentially disappeared" after 2015, both with and without press conferences, and attribute this to reduced uncertainty. Ben Dor & Rosa (2019) dissent. — [IDEAS/RePEc](https://ideas.repec.org/a/eee/finlet/v40y2021ics1544612320315956.html)
- **Post-earnings-announcement drift (PEAD):**
  - Martineau ("Rest in Peace Post-Earnings Announcement Drift", Critical Finance Review 11(3–4), 2022) argues prices fully reflect earnings surprises on the announcement date. PEAD has been nonexistent in large stocks since 2006 and disappeared later in microcaps. — [CFR PDF](https://cfr.ivo-welch.info/published/papers/martineau2021rest.pdf); [IDEAS](https://ideas.repec.org/a/now/jnlcfr/104.00000122.html)
  - **The 2025 counter-evidence and rebuttal:**
    - Dickerson, Julliard & Mueller (JFE, in press) treat earnings drift as a major priced factor.
    - Hirshleifer, Peng & Wang (RFS 38(3), 2025) report drift with t ≈ 14.
    - Subrahmanyam (2025 WP) attributes the disagreement to research design, mainly including microcaps (the bottom 20% of NYSE market cap, about 3% of market value). In his February 2001 to December 2024 replication the drift factor has t = 2.18 with all stocks and only 1.43 excluding microcaps.
    - [UCLA Anderson Review, 21 Jan 2026](https://anderson-review.ucla.edu/is-post-earnings-announcement-drift-a-thing-again/)
- **Index inclusion (Greenwood & Sammon, "The Disappearing Index Effect", JF 80(2), 2025):**
  - Abnormal returns for S&P 500 additions were about 3.4% in the 1980s, 7.4–7.6% in the 1990s and under 1% (0.8%) in the last decade.
  - Deletions went from −4.6% (1980s) to about −16% (1990s), about −12% (2000s) and −0.6% (2010–2020).
  - Main reason: "migrations" from the S&P 400, which net out demand shocks, rose from about half to more than 70% of additions. Other contributors are greater predictability and liquidity. Similar declines appear in other index families.
  - [NBER w30748](https://www.nber.org/system/files/working_papers/w30748/w30748.pdf); [SSRN](https://papers.ssrn.com/abstract=4294297); [IDEAS (JF)](https://ideas.repec.org/a/bla/jfinan/v80y2025i2p657-698.html); [Alpha Architect](https://alphaarchitect.com/disappearing-index-effect/)
- **Overnight versus intraday (live test):**
  - The NightShares 500 ETF (NSPY) and NightShares 2000 ETF (NIWM) used futures and swaps to capture close-to-open returns. They stopped trading at end-July 2023 and liquidated on 10 August 2023.
  - NSPY had only $3.7M in assets. It returned −6.9% since inception versus +22% for the S&P 500, and −1.7% in 2023 YTD versus +19.9%.
  - Morningstar noted trading costs eat into the strategy when implemented.
  - [WealthManagement.com](https://www.wealthmanagement.com/etfs/night-effect-etfs-shut-down-overnight-stock-returns-elusive); [ETF.com](https://www.etf.com/sections/news/2-nightshares-etfs-close-after-struggling-gain-traction)
- **Turn of the month:**
  - McConnell & Xu (FAJ 64(2), 2008, 1926–2005): investors "received no reward for bearing market risk except at turns of the month". The effect exists in 34 of 38 countries and is not explained by volume or fund flows. — [IDEAS](https://ideas.repec.org/a/taf/ufajxx/v64y2008i2p49-64.html); [CFA Institute](https://rpc.cfainstitute.org/research/financial-analysts-journal/2008/equity-returns-at-the-turn-of-the-month)
  - Chen, Shin & Sun report that a turn-of-the-month timing strategy with international ETFs is profitable after costs. — [Financial Services Review article](https://openjournals.libs.uga.edu/fsr/article/download/3338/2971)
  - A 2025 Finance Research Letters paper by Han, Han & Tian is titled "The disappearing turn-of-month effect". I saw only the title and could not read the results (search excerpt). — [CXO Advisory TOM page (context)](https://www.cxoadvisory.com/calendar-effects/the-turn-of-the-month-effect/)
- **Merger arbitrage (Mitchell & Pulvino, JF 56(6), 2001):**
  - 4,750 mergers, 1963–1998.
  - After transaction costs, excess returns are about 4% a year; ignoring costs, about 10.3%.
  - Returns are uncorrelated with the market in flat or rising markets but correlated in downturns, resembling uncovered index put writing. The authors interpret this as a liquidity premium.
  - [JF paper copy](https://www.johnhcochrane.com/s/mitchell-pulvino-characteristics-of-risk-and-return-JF.pdf); [AQR](https://www.aqr.com/Insights/Research/Journal-Article/Characteristics-of-Risk-and-Return-in-Risk-Arbitrage)

### Inferences
- What survives tends to be compensation for bearing risk or providing liquidity (merger arbitrage, and perhaps residual turn-of-the-month), not informational inefficiencies. Those decay with HFT, decimalization and predictability (PEAD, index effect, pre-FOMC).
- Calendar trades need frequent entries and exits, which in taxable accounts turn gains short-term. The overnight trade needs two round trips a day. For individuals, these frictions are larger than the remaining edges. NightShares is a live negative example.
- Merger arbitrage is hard to do well with small accounts. Diversification needs many deals, and deal-break risk is lumpy. Fund wrappers are the practical route, but I did not evaluate their returns.

### Gaps
- I found no post-2010 merger-arbitrage index returns (HFRI Merger Arbitrage, ETF records), no post-2005 TOM cost-adjusted study results, and no Halloween / Sell-in-May evidence (not searched due to budget).

## 6. Options-based systematic strategies: covered calls, put-writing, volatility risk premium, short-vol blowups, 0DTE, tail hedging

### Takeaway
Systematic SPX option writing (Cboe BXM buy-write, PUT put-write) has historically delivered lower-than-equity returns with much lower volatility and smaller drawdowns: since 1986, BXM returned about 8.5% versus about 11.1–11.2% for the S&P 500, with volatility of about 10.7% versus 15.2% and maximum drawdown of −35.8% versus −50.9%. It harvests the volatility risk premium. Covered calls also embed an uncompensated equity-reversal timing bet. Protective puts are expensive drag, and a static cash position does as well. Leveraged short-volatility ETPs can be wiped out in a day (XIV, February 2018). 0DTE options are now about 59% of SPX volume (2025), roughly half of it retail, and retail traders lost money there and in options generally, paying very wide spreads.

### Cited Findings
#### Cboe benchmark indexes (figures from search excerpts; cboe.com unreachable here, attribution not independently checked)
- **BXM since June 1986:** about 8.5% annualized versus 11.1–11.2% for the S&P 500 TR; volatility about 10.7% versus 15.2%; maximum drawdown −35.8% versus −50.9%.
- **PUT since 2007:** 7.0% versus 11.0%.
- **Calendar years:** 2023 BXM 11.8%, PUT 14.3%, S&P 500 26.3%; 2024 BXM 20.1%, PUT 17.8%, S&P 500 25.0%.
- [Cboe Benchmark Indices Series post](https://www.cboe.com/insights/posts/benchmark-indices-series-income-generation-and-smoother-returns-with-cboes-bxm-bxmd-put-and-cmbo-indices); [Cboe insights](https://www.cboe.com/insights/posts/key-cboe-benchmark-indexes-using-spx-options-offer-strong-risk-adjusted-returns/)
- **Earlier long-run studies:** over mid-1986 to 2011, PUT grew 1,153% versus 830% for BXM and 807% for the S&P 500. A Hewitt EnnisKnupp review found BXM produced a similar return to the S&P 500 with lower volatility from June 1986 to January 2012. A Wilshire study covered 1986–2016. — [Mondo Visione (Cboe study release)](https://mondovisione.com/media-and-resources/news/new-study-compares-25-year-performance-of-options-strategy-benchmarks-to-traditi-2012214/); [Mondo Visione (2012 study)](https://mondovisione.com/media-and-resources/news/cboe-new-study-evaluates-bxm-and-other-indexes-returns-standard-deviations-an-2012320/); [Hedgeweek](https://www.hedgeweek.com/options-indices-offered-noteworthy-returns-over-30-years-says-study/)

#### Volatility risk premium mechanics
- **Israelov & Nielsen, "Covered Calls Uncovered" (FAJ 71(6), 2015):**
  - Covered-call returns decompose into equity exposure (most of the risk and return), short volatility, and a short "equity reversal" timing exposure.
  - The short-volatility component has a Sharpe near 1.0 but is under 10% of risk. The reversal component is about a quarter of risk and adds little return.
  - Hedging the reversal exposure improves Sharpe.
  - The authors manage covered-call portfolios at AQR, a commercial interest flagged by the journal.
  - [AQR](https://www.aqr.com/Insights/Research/Journal-Article/Covered-Calls-Uncovered); [CFA Institute](https://rpc.cfainstitute.org/research/financial-analysts-journal/2015/covered-calls-uncovered); [Quantpedia](https://quantpedia.com/covered-calls-uncovered/)
- **Israelov, "Pathetic Protection: The Elusive Benefits of Protective Puts" (J. Alternative Investments, Winter 2019):**
  - Puts reduce drawdowns only if options carry no volatility risk premium and drawdowns coincide with the holding period. With the usual premium, puts can worsen drawdowns.
  - A portfolio of 36.5% S&P 500 and 63.5% cash matched the 2.5% compound annualized excess return of the CBOE S&P 500 5% Put Protection Index.
  - [AQR](https://www.aqr.com/Insights/Research/White-Papers/Pathetic-Protection-The-Elusive-Benefits-of-Protective-Puts); [Alpha Architect](https://alphaarchitect.com/pathetic-protection/)

#### Short-vol blowup (5 February 2018, "Volmageddon")
- The VIX jumped about 20 points in a day, a record, and roughly doubled. — [BIS Quarterly Review, Mar 2018](https://www.bis.org/publ/qtrpdf/r_qt1803t.htm); [Bloomberg](https://www.bloomberg.com/news/articles/2019-02-06/the-day-the-vix-doubled-tales-of-volmageddon)
- XIV's loss is reported at 84–97% depending on measure. Credit Suisse triggered an acceleration event because XIV's intraday indicative value fell to 20% or less of the prior close (the prospectus threshold was an 80% loss), and the last trading day was 20 February 2018. — [BIS](https://www.bis.org/publ/qtrpdf/r_qt1803t.htm); [SLCG](https://www.slcg.com/resources/blog/686)
- A New York appeals court let claims that Credit Suisse engineered the collapse proceed; Credit Suisse denies wrongdoing. — [CGTN](https://news.cgtn.com/news/77516a4e796b7a6333566d54/index.html)
- Academic post-mortem: Augustin, Cheng & Van den Bergen, "Volmageddon and the Failure of Short Volatility Products" (FAJ 2021). — [CFA Institute](https://rpc.cfainstitute.org/research/financial-analysts-journal/2021/volmageddon-failure-short-volatility-products)

#### 0DTE boom and retail options outcomes
- **Market share:**
  - SPX 0DTE averaged 2.3M contracts a day, 59% of SPX volume, in 2025. — [Cboe, State of the Options Industry 2025](https://www.cboe.com/insights/posts/the-state-of-the-options-industry-2025)
  - The record month was August 2025 at 62.4%, with retail an estimated 53% of 0DTE volume. — [Cboe](https://www.cboe.com/insights/posts/spx-0-dte-options-jump-to-record-62-share-in-august)
  - Retail made up about 54% of SPX 0DTE volume in May 2025. — [Benzinga](https://www.benzinga.com/partner/options/25/08/47354766/whats-behind-the-growing-popularity-of-0dte-options)
- **Retail 0DTE losses (Beckmeyer, Branger & Gayda, "Retail Traders Love 0DTE Options... But Should They?", SSRN 2023):**
  - Sample January 2021 to February 2023. About 75% of retail S&P 500 option trades are 0DTE.
  - Average daily retail losses were about $184k, rising to about $358k after daily expirations began on 16 May 2022.
  - Transaction costs and put buying are major sources of the losses. The authors call it "a cautionary tale".
  - [WealthManagement.com](https://www.wealthmanagement.com/equities/retail-investors-are-in-love-with-same-day-options); [Bloomberg](https://www.bloomberg.com/news/articles/2023-04-21/day-traders-lose-358-000-per-day-gambling-on-zero-day-options); [CXO Advisory](https://cxoadvisory.com/individual-investing/retail-0dte-option-trader-performance)
- **Retail options generally (Bryzgalova, Pavlova & Sikorskaya, JF 78(6), 2023):**
  - Retail recently exceeded 60% of total US options volume, driven by payment for order flow. Nearly 90% of that PFOF comes from three wholesalers.
  - Retail favours cheap weekly options, whose average bid-ask spread is 12.6%, and retail investors lose money on average.
  - [LBS Research Online](https://lbsresearch.london.edu/id/eprint/2827/)

#### Tail hedging debate
- Universa reported a 3,612% return during the 2020 crash (headline figure; period and capital base not verified). Spitznagel's letter argues a 96.7% S&P 500 / 3.3% Universa mix beat the S&P 500 since March 2008. AQR-side research favours trend following as a cheaper crisis diversifier than puts. — [BNN Bloomberg](https://www.bnnbloomberg.ca/why-one-firm-s-3-612-return-is-drawing-the-ire-of-hedge-funds-1.1903852); [Advisor Perspectives (search excerpt)](https://www.advisorperspectives.com/articles/2020/05/06/an-aqr-warning-and-a-3-612-return-fire-up-the-black-swan-debate)
- CalPERS ended its tail-hedge program shortly before the 2020 crash, prompting public disputes over the missed payoff. — [Institutional Investor](https://www.institutionalinvestor.com/article/b1lft49hkwdjpv/CalPERS-CIO-Called-Out-By-Ex-Head-of-Tail-Risk-Program)

### Inferences
- Put-writing and covered calls on broad indices are viable low-turnover individual strategies, best thought of as an equity substitute with a different payoff shape. Individuals can run them with SPX options, ETF options or wrapper ETFs.
- The main failure modes:
  - Selling too much volatility relative to capital, short-vol ETPs being the extreme case.
  - Crash exposure that arrives with equity drawdowns.
  - Paying wide spreads in short-dated contracts.
- 0DTE and short-dated speculation is where retail order flow is the liquidity taker against wholesalers and market makers, the "market making against professionals" problem in reverse. The documented outcomes are losses.
- Buying puts systematically is rarely efficient for individuals. Smaller equity exposure, trend overlays or managed futures are cheaper ways to cut crash risk, and Universa-style convex hedges require institutional-grade execution and sizing discipline.

### Gaps
- I could not verify Cboe's own current index performance tables (2025 calendar returns, PUT since 1986 statistics) or the 2025–2026 performance of covered-call ETFs (e.g., JEPI/QYLD-style).
- Short-vol behaviour on 5 August 2024 and in April 2025, the Universa letter itself, and books (Sinclair, *Volatility Trading* and *Positional Option Trading*; Natenberg, *Option Volatility and Pricing*) were not re-verified this session.

## 7. Carry and basis: FX carry, futures carry, crypto funding-rate and basis arbitrage, grid and DCA bots

### Takeaway
Carry is one of the broadest documented premia. Koijen, Moskowitz, Pedersen & Vrugt report a Sharpe of about 0.7 within asset classes and about 1.1 for a diversified carry portfolio (1.4 in an earlier draft). Carry strategies lose together in global recessions and liquidity crunches (2008; the August 2024 yen carry unwind). Crypto cash-and-carry and funding-rate arbitrage has offered very high carry, up to about 60% a year, with a Sharpe of about 1.8 even at retail costs (BTC perpetuals). The returns are compensation for venue, margin, liquidation and auto-deleveraging (ADL) risk, as FTX (2022) and the 10 October 2025 crash showed, and the deviations are shrinking. Grid and DCA bots add operational and API-key risk (3Commas, 2022), and I found no evidence of edge for them.

### Cited Findings
- **Koijen, Moskowitz, Pedersen & Vrugt, "Carry" (JFE 127(2), 2018):**
  - A security's expected return decomposes into carry and expected price appreciation, and carry predicts returns in both the cross section and time series across asset classes.
  - Sharpe about 0.7 within asset classes and about 1.1 for a diversified portfolio (August 2013 version); an earlier draft reported 1.4.
  - Carry strategies across asset classes do badly at the same times, which coincide with global recessions.
  - [NBER w19325](https://www.nber.org/papers/w19325); [CEPR DP9771](https://repec.cepr.org/repec/cpr/ceprdp/DP9771.pdf); [BI abstract](https://www.bi.no/link/af8ef92ed3ee4896bc0cea7fc855b1ba.aspx)
  - CXO notes the three largest global-carry drawdowns (Aug 1972–Sep 1975, Mar 1980–Jun 1982, Aug 2008–Feb 2009), and that weighting asset classes by full-sample inverse volatility introduces look-ahead bias. — [CXO Advisory](https://www.cxoadvisory.com/big-ideas/unified-carry-trade-theory/)
- **FX carry crash, August 2024:**
  - JPMorgan estimated the yen-carry unwind was only 50–60% complete among speculators on 6 August 2024, and about three-quarters complete days later. The selloff erased the year's carry gains. — [Bloomberg](https://www.bloomberg.com/news/articles/2024-08-06/jpmorgan-says-carry-trade-unwind-is-only-half-complete); [Fortune](https://www.fortune.com/2024/08/08/75-carry-trade-blamed-recent-stock-meltdown-unwound-jpmorgan/)
  - The BIS notes leveraged carry positions had grown rapidly but are hard to size. — [BIS Bulletin 90](https://www.bis.org/publ/bisbull90.pdf)
- **Crypto basis carry (Schmeling, Schrimpf & Todorov, BIS WP 1087, April 2023, revised October 2025):**
  - BTC and ETH futures carry (long spot, short futures) can reach about 60% a year and varies strongly.
  - It is driven by convenience yield from leveraged retail demand in booms and scarce arbitrage capital. Margin spikes and liquidations make the trade risky.
  - High carry predicts future crashes.
  - [BIS](https://www.bis.org/publ/work1087.htm)
- **Perpetual futures (He, Manela, Ross & von Wachter, "Fundamentals of Perpetual Futures", arXiv v6, Aug 2024):**
  - Funding is typically paid every 8 hours and approximates the average futures-spot spread.
  - Funding-rate arbitrage is risky even ignoring margins and costs.
  - For BTC perpetuals it earns a Sharpe of about 1.8 at retail-level costs and up to 3.5 for fee-free market makers.
  - Deviations are larger than in FX, comove across coins and "diminish over time".
  - [arXiv 2212.06888](https://arxiv.org/abs/2212.06888v6)
- **Counterparty risk, FTX (November 2022):**
  - FTX filed for bankruptcy on 11 November 2022, nine days after Alameda's balance sheet leaked. — [Wikipedia: Bankruptcy of FTX](https://en.wikipedia.org/wiki/Bankruptcy_of_FTX)
  - Futures basis fell to historic lows and briefly turned negative. — [Crypto Finance house view, Dec 2022](https://www.crypto-finance.com/house-view-december-2022/?lang=de)
  - CME basis hit an all-time low, and funds, lenders, market makers and retail with balances on FTX took large losses. — [K33 Research](https://k33.com/research/articles/crooks-contagion-distortion-and-march-12-flashbacks)
- **ADL and liquidation risk, 10 October 2025:**
  - More than $19B was liquidated across about 1.6M accounts after a 100% China-tariff announcement.
  - USDe traded at about $0.65 on Binance while on-chain pools held near $1. Binance cited thin liquidity and an internal oracle issue.
  - Auto-deleveraging closes profitable positions on the winning side when other safeguards fail.
  - [CoinGecko](https://www.coingecko.com/learn/october-10-crypto-crash-explained); [Cointelegraph](https://cointelegraph.com/news/19b-crypto-market-crash-leverage-china-tariffs); [CoinShares](https://coinshares.com/at/insights/knowledge/billions-in-liquidations-what-happened/); [The Defiant](https://thedefiant.io/newsletter/defi-daily/the-ultimate-10-10-crash-autopsy)
- **Bot/API risk (3Commas, Dec 2022):**
  - The CEO confirmed leaked API keys were genuine after Binance's CZ urged users to disable them. Attackers traded victims' accounts through the keys.
  - HAPI counted 24 victims and about $14.9M lost in November alone; other reports put total losses at about $20–22M.
  - [Cointelegraph](https://cointelegraph.com/news/3commas-ceo-confirms-api-key-leak-following-warning-from-cz); [ForkLog/HAPI](https://forklog.com/en/news/api-key-leaks-and-exchange-inaction-a-hapi-analysis-of-the-3commas-incident); [Unchained](https://unchainedcrypto.com/3commas-users-plan-class-action-lawsuit-after-losing-14m/)

### Inferences
- **Futures carry:** for individuals, carry is best used as one signal inside a diversified futures system, as Carver does, rather than as a concentrated FX carry book, because carry crashes coincide with recessions.
- **Crypto funding arbitrage:**
  - It is one of the few places where a small, patient trader can earn a sizeable spread with modest capital.
  - The risk is not market beta but venue default, frozen withdrawals, ADL of the hedge leg, oracle or stablecoin depegs, and margin calls on the short leg during spikes.
  - Splitting collateral across venues, preferring regulated venues such as CME, and sizing to survive a gap are essential. Even so, documented deviations are shrinking.
- **Grid and DCA bots:** a grid harvests range-bound volatility and loses in trends (it is short volatility in disguise), and DCA is a deployment schedule, not an edge. Neither is supported by evidence I found. Their documented incremental risk is API-key compromise, so keys should be trade-only with withdrawals disabled.

### Gaps
- I found no peer-reviewed evidence on grid or DCA bot performance.
- I did not quantify losses of delta-neutral basis traders at FTX or of funding arbitrageurs during the 10 October 2025 ADL event.
- I have no post-2023 data on crypto funding levels (e.g., Ethena's yield history) or on FX carry index returns in 2025–2026.

## 8. Machine learning, LLMs and alternative data for individuals

### Takeaway
The strongest ML evidence is either cross-sectional (out of scope here) or institutional-scale market-timing research. Kelly, Malamud & Zhou argue "complex" models with more parameters than observations improve market-return prediction. LLM news-sentiment signals have predicted returns, but the profits decline as LLM adoption grows, and backtests are contaminated by look-ahead and "distraction" bias. Overfitting rises with complexity. For individuals, ML is more realistically a tool for risk models, data cleaning and execution than a standalone alpha source.

### Cited Findings
- **LLM headline sentiment (Lopez-Lira & Tang, "Can ChatGPT Forecast Stock Price Movements?", v6 Oct 2025):**
  - Using headlines after the models' knowledge cutoffs, GPT-4 captures the initial market reaction (about 90% portfolio-day hit rate for the non-tradable initial reaction). It also predicts subsequent drift, especially for small stocks and negative news.
  - Ability rises with model size.
  - Strategy returns decline as LLM adoption rises, consistent with improved price efficiency.
  - [arXiv 2304.07619](https://arxiv.org/abs/2304.07619)
- **Look-ahead and distraction bias (Glasserman & Lin, Sept 2023):**
  - LLM backtests suffer look-ahead bias (the model may know what happened) and a "distraction effect" (general firm knowledge distorts sentiment).
  - In sample, anonymized headlines outperformed the originals: "the distraction effect has a greater impact than look-ahead bias". The advantage is strongest for large firms.
  - The authors propose anonymization for de-biased backtests.
  - [arXiv 2309.17322](https://arxiv.org/abs/2309.17322)
- **Complexity (Kelly, Malamud & Zhou, "The Virtue of Complexity in Return Prediction", JF 79(1), 2024):** simple models "severely understate return predictability" compared with complex ones. They document this empirically for US equity-market return prediction and argue it justifies ML. — [NBER w30217](https://www.nber.org/papers/w30217)
- **Complexity predicts decay:** the number of operations needed to compute a signal predicts out-of-sample Sharpe decay. — [Falck, Rej & Thesmar](https://arxiv.org/abs/2105.01380)
- **Live versus backtest:** the most complex alternative-beta products deteriorated about 30% more from backtest to live than the simplest. — [Alpha Architect on Suhonen et al.](https://alphaarchitect.com/beware-of-backtest-overfitting/)
- **Platform-scale evidence (888 Quantopian algorithms):** selecting algorithms by hold-out ML prediction worked significantly better out of sample than picking those with the highest backtest Sharpe ratios. — [Wiecki et al., "All that Glitters Is Not Gold" (SSRN 2745220 copy)](https://c.mql5.com/forextsd/forum/208/All%20that%20Glitters%20Is%20Not%20Gold%20-%20Comparing%20Backtest%20and%20Out-of-Sample%20Performance%20on%20a%20Large%20Cohort%20o.pdf)
- **Open-source ML quant platforms are actively maintained as of October 2026:**
  - Microsoft Qlib: v0.9.8, 2026-10-08, now paired with RD-Agent for automated R&D. — [GitHub](https://github.com/microsoft/qlib)
  - FinRL: v0.3.8, March 2026, commits in October 2026. — [GitHub](https://github.com/AI4Finance-Foundation/FinRL)

### Inferences
- **Where ML fits for an individual:**
  - With daily data and a few dozen assets, the number of independent observations is small, so the virtue-of-complexity regime is hard to exploit without overfitting.
  - The realistic uses are volatility and correlation forecasting for position sizing, regime classification layered on simple rules, NLP for screening, and execution.
- **LLM sentiment strategies:**
  - Any LLM sentiment backtest that covers the model's training window is suspect; use post-cutoff data or anonymization.
  - The small-cap and negative-news concentration of the edge points to illiquid names with high costs and borrow constraints.
- **Alternative data:** the expensive, high-capacity datasets are priced for institutions. Individuals realistically have only free or cheap data (web traffic, app ranks, social media), which is crowded and noisy. This is an inference; I found no source quantifying it.

### Gaps
- I did not access critiques of Kelly-Malamud-Zhou (e.g., any "seemingly virtuous complexity" rebuttals).
- I have no peer-reviewed evidence on retail use of alternative data, and no quantitative results for reinforcement-learning trading (FinRL) out of sample.

## 9. Evidence on retail active and systematic traders, and the backtest-overfitting / data-mining literature

### Takeaway
Large administrative datasets agree that active retail trading destroys value:
- US households that trade most earned 11.4% a year versus 17.9% for the market (1991–96).
- Fewer than 1% of Taiwanese day traders are predictably profitable net of fees.
- Of Brazilian mini-index day traders who persisted for more than 300 sessions, only 1.1% earned more than the minimum wage.
- Retail options traders lose money, paying spreads of about 12.6%.

The methodology literature implies that a backtest Sharpe ratio should be haircut by roughly 50–75% before being trusted: a t > 3 hurdle, a 73% live-versus-backtest Sharpe decline for bank alternative-beta products, and returns 58% lower after publication.

### Cited Findings
#### Retail trading outcomes
- **Barber & Odean, "Trading Is Hazardous to Your Wealth" (JF 55(2), 2000):** 66,465 households at a large discount broker, 1991–1996. The most active traders earned 11.4% a year versus 17.9% for the market. The average household earned 16.4% and turned over 75% of its portfolio a year; the most active quintile turned over more than 250% a year. Overconfidence explains the high trading. — [Paper PDF](https://faculty.haas.berkeley.edu/odean/papers%20current%20versions/individual_investor_performance_final.pdf)
- **Barber, Lee, Liu & Odean, "The Cross-Section of Speculator Skill" (J. Financial Markets 18, 2014; Taiwan 1992–2006):**
  - Fewer than 1% of day traders predictably and reliably earn positive abnormal returns net of fees.
  - The prior year's top-ranked traders go on to earn 61.3 bp a day before fees and 37.9 bp after.
  - Critics note the data are old and Taiwanese costs were high.
  - [IDEAS](https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html); [working paper](https://faculty.haas.berkeley.edu/odean/papers/day%20traders/Day%20Trading%20Skill%20110523.pdf); [Morningstar commentary](https://global.morningstar.com/en-gb/stocks/no-casino-gambling-isn-t-more-lucrative-than-day-trading)
- **Chague, De-Losso & Giovannetti, "Day Trading for a Living?" (FGV WP, 2019/2020):**
  - All 19,646 individuals who started day trading mini-Ibovespa futures in 2013–2015. Only 1,551 (7.9%) persisted for more than 300 sessions.
  - Of those, only 17 (1.1%) earned more than the Brazilian minimum wage and 0.5% more than a bank teller's starting salary.
  - There is no evidence of learning, and the authors conclude it is "virtually impossible" to day trade for a living.
  - CXO reports that only 3.0% achieved positive net daily returns, the source of the popular "97% lose" figure.
  - [EconPapers](https://econpapers.repec.org/RePEc:fgv:eesptd:525); [FGV repository](https://repositorio.fgv.br/items/e87d04fc-4b4c-4a56-ab5a-1c84c1afde1b/full); [CXO Advisory](https://www.cxoadvisory.com/investing-expertise/day-trading-a-bust/)
- **Retail options:** see section 6. Bryzgalova, Pavlova & Sikorskaya document retail losses and 12.6% average spreads. — [LBS](https://lbsresearch.london.edu/id/eprint/2827/) Beckmeyer, Branger & Gayda document about $358k of daily retail 0DTE losses after May 2022. — [WealthManagement.com](https://www.wealthmanagement.com/equities/retail-investors-are-in-love-with-same-day-options)
- **Day-trading rules (US):** FINRA's current investor page on day trading describes intraday margin requirements, a $2,000 minimum equity to trade on margin, and possible 90-day margin restrictions after unmet intraday deficits. It does not mention the former $25,000 pattern-day-trader minimum (fetched 2026-10-31). — [FINRA](https://www.finra.org/investors/investing/investment-products/stocks/day-trading)

#### Overfitting and data mining
- **Harvey, Liu & Zhu ("...and the Cross-Section of Expected Returns", NBER w20592 / RFS 2016):** hundreds of factors have been tried, so a new factor should clear a t-ratio above 3.0, and many published findings are likely false. — [NBER](https://www.nber.org/papers/w20592)
- **McLean & Pontiff (JF 71(1), 2016):** across 97 predictors, returns are 26% lower out of sample and 58% lower after publication. They estimate a 32% decline from publication-informed trading, with bigger declines for predictors with higher in-sample returns. — [JF PDF](https://www.gwern.net/doc/economics/2016-mclean.pdf)
- **Suhonen, Lennkh & Perez ("Quantifying Backtest Overfitting in Alternative Beta Strategies", JPM 2017):**
  - 215 bank alternative-beta products. The median Sharpe ratio fell from 1.20 in backtests to 0.31 live, a 73% decline.
  - Only 18 of 215 products did as well live as in backtest; 65 had negative live Sharpe ratios.
  - The most complex strategies deteriorated about 30% more.
  - [Alpha Architect](https://alphaarchitect.com/beware-of-backtest-overfitting/); [CXO Advisory](https://www.cxoadvisory.com/big-ideas/live-performance-of-alternative-beta-products/)
- **Bailey, Borwein, López de Prado & Zhu ("The Probability of Backtest Overfitting", J. Computational Finance):**
  - Standard hold-out validation is unreliable for investment backtests. They propose combinatorially symmetric cross-validation (CSCV) to estimate the probability of backtest overfitting (PBO). Sources date the paper 2015 or 2017.
  - The deflated Sharpe ratio (Bailey & López de Prado) corrects for selection bias across many trials.
  - An R package (`pbo`) implements CSCV.
  - [SSRN](https://papers.ssrn.com/abstract=2326253); [CRAN pbo README](https://archive.linux.duke.edu/cran/web/packages/pbo/readme/README.html); [LuxAlgo explainer](https://www.luxalgo.com/library/concept/probability-of-backtest-overfitting/)
- **Wiecki et al. (888 Quantopian algorithms):** see section 8. Backtest Sharpe ratios were a poor basis for selection compared with hold-out ML prediction. — [paper copy](https://c.mql5.com/forextsd/forum/208/All%20that%20Glitters%20Is%20Not%20Gold%20-%20Comparing%20Backtest%20and%20Out-of-Sample%20Performance%20on%20a%20Large%20Cohort%20o.pdf)

### Inferences
- The retail evidence concerns discretionary and high-frequency activity (day trading, short-dated options). It says less about slow, rules-based allocation. The common thread is that costs, turnover and overconfidence dominate, which favours low-turnover systematic approaches with pre-committed rules.
- A practical protocol for an individual:
  - Count every variant tried.
  - Require t > 3, or deflate the Sharpe ratio.
  - Prefer rules with few parameters that work across many markets.
  - Haircut the backtest Sharpe by at least half.
  - Paper-trade or run small size for a year before scaling.
- If FINRA has indeed replaced the pattern-day-trader regime with intraday margin rules, the $25k barrier to US retail day trading has fallen. The evidence above suggests that is more likely to increase retail losses than to create an edge.

### Gaps
- I could not verify Wiecki et al.'s exact R² between backtest and out-of-sample Sharpe (SSRN blocked), Harvey & Liu's "Backtesting" (JPM 2015) haircut tables, or the effective date of FINRA's Rule 4210 changes.
- Kogan, Makarov, Niessner & Schoar on retail crypto trading, and Barber et al. "Just How Much Do Individual Investors Lose by Trading?" (RFS 2009), were not fetched.

## 10. Strategy compendia and tooling for individuals: backtesters, portfolio libraries, data and broker APIs (maintenance status as of 2026-10-31)

### Takeaway
The open-source stack is healthy, but the old defaults have changed:
- **Backtrader:** no commits since April 2023; last PyPI release 1.9.78.123.
- **Original Quantopian zipline and pyfolio:** dead.
- **ib_insync:** archived after its author's death; use ib_async.
- **pandas-ta:** GitHub repo returns 404.
- **Moved repositories:** pysystemtrade is now under pst-group, PyPortfolioOpt under the PyPortfolio org, and Polygon's client under Massive.

Actively maintained in October 2026: LEAN and lean-cli, NautilusTrader, zipline-reloaded, vectorbt (open source v1.2.0; PRO is paid), bt, pysystemtrade, PyPortfolioOpt, Riskfolio-Lib, backtesting.py, quantstats, pyfolio-reloaded, alphalens-reloaded, freqtrade, hummingbot, ccxt, jesse and lumibot. Alpaca's official SDK (alpaca-py) is active. Community SDKs are active for IBKR (ib_async) and tastytrade, while Schwab's (schwab-py) has had no commits since August 2025.

### Cited Findings
#### Backtesting and research frameworks (GitHub API, checked 2026-10-31)
- **QuantConnect LEAN:** Python/C# engine, Apache-2.0, about 22.3k stars, last commit 2026-10-30. lean-cli 1.0.233 released 2026-10-27. — [LEAN](https://github.com/QuantConnect/Lean); [lean-cli](https://github.com/QuantConnect/lean-cli)
- **NautilusTrader:** "Production-grade Rust-native trading engine", LGPL-3.0, about 31k stars, v1.231.0 (2026-08-02), commits on 2026-10-31. — [GitHub](https://github.com/nautechsystems/nautilus_trader); [PyPI](https://pypi.org/project/nautilus_trader/)
- **zipline-reloaded:** release 3.2.1 on 2026-10-25, Apache-2.0. The original quantopian/zipline's last commit was 2020-10-14 (release 1.4.1). — [zipline-reloaded](https://github.com/stefan-jansen/zipline-reloaded); [quantopian/zipline](https://github.com/quantopian/zipline)
- **vectorbt:** open-source v1.2.0 (2026-10-19), licensed "Apache 2.0 with Commons Clause" (no right to sell). The README links the separate paid VectorBT PRO. — [GitHub](https://github.com/polakowo/vectorbt); [VectorBT PRO](https://vectorbt.pro/)
- **Backtrader:** GPL-3.0, about 23.6k stars, last commit 2023-04-19; last PyPI release 1.9.78.123 (2023-04-19). Effectively unmaintained. — [GitHub](https://github.com/mementum/backtrader); [PyPI](https://pypi.org/project/backtrader/)
- **bt:** v1.4.1 (2026-10-10), MIT. — [GitHub](https://github.com/pmorissette/bt)
- **backtesting.py:** AGPL-3.0, last commit 2026-08-05. — [GitHub](https://github.com/kernc/backtesting.py)
- **pysystemtrade:** "Systematic Trading in python", GPL-3.0, now at pst-group, release 1.8.3 (2026-09-30). — [GitHub](https://github.com/pst-group/pysystemtrade)
- **qstrader:** last commit 2024-06-24 (v0.3.0). Slow or dormant. — [GitHub](https://github.com/mhallsmoore/qstrader)
- **Crypto-native frameworks:**
  - freqtrade: release 2026.10 (2026-10-30). — [GitHub](https://github.com/freqtrade/freqtrade)
  - hummingbot: v2.17.0 (2026-09-22); "high-frequency crypto trading bots". — [GitHub](https://github.com/hummingbot/hummingbot)
  - jesse: active October 2026. — [GitHub](https://github.com/jesse-ai/jesse)
  - ccxt: v4.5.91 (2026-10-29). — [GitHub](https://github.com/ccxt/ccxt)
- **lumibot:** v4.6.32 (2026-10-28). — [GitHub](https://github.com/Lumiwealth/lumibot)

#### Portfolio construction and analytics
- **PyPortfolioOpt:** now at PyPortfolio/PyPortfolioOpt; efficient frontier, Black-Litterman, hierarchical risk parity; v1.6.0 (2026-02-26); last commit 2026-07-07. — [GitHub](https://github.com/PyPortfolio/PyPortfolioOpt)
- **Riskfolio-Lib:** BSD-3, commits 2026-10-30. — [GitHub](https://github.com/dcajasn/Riskfolio-Lib)
- **cvxportfolio:** 1.5.1 (2025-07), last commit 2026-04. — [GitHub](https://github.com/cvxgrp/cvxportfolio)
- **quantstats:** v0.0.86 (2026-09-27). — [GitHub](https://github.com/ranaroussi/quantstats)
- **pyfolio-reloaded:** 0.10.1 (2026-10-25). The original quantopian/pyfolio's last release was 0.9.2 (2019). — [pyfolio-reloaded](https://github.com/stefan-jansen/pyfolio-reloaded); [quantopian/pyfolio](https://github.com/quantopian/pyfolio)
- **alphalens-reloaded:** active October 2026. — [GitHub](https://github.com/stefan-jansen/alphalens-reloaded)
- **pandas-ta:** GitHub `twopirllc/pandas-ta` returned 404 on 2026-10-31. Last PyPI release 0.4.71b0 (2025-09-14). — [PyPI](https://pypi.org/project/pandas-ta/)

#### Broker APIs and SDKs
- **Alpaca:** alpaca-py ("The Official Python SDK for Alpaca API") v0.44.0 (2026-08-11), commits October 2026. The legacy alpaca-trade-api-python is archived. — [alpaca-py](https://github.com/alpacahq/alpaca-py); [legacy SDK](https://github.com/alpacahq/alpaca-trade-api-python)
- **Interactive Brokers:**
  - ib_insync is archived; its README notes that the author, Ewald de Wit, died in March 2024. — [ib_insync](https://github.com/erdewit/ib_insync)
  - ib_async (ib-api-reloaded) is the maintained Python interface to TWS / IB Gateway via the IBKR API. v2.0.1 (2025-06-22); repository pushed 2026-10-29. — [ib_async](https://github.com/ib-api-reloaded/ib_async)
- **Schwab:** schwab-py ("Unofficial API wrapper for the Schwab HTTP API") v1.5.0 (2025-06-30), last commit 2025-08-04. — [GitHub](https://github.com/alexgolec/schwab-py)
- **tastytrade:** unofficial typed async SDK v13.2.3 (2026-08-07). — [GitHub](https://github.com/tastyware/tastytrade)

#### Data
- **Norgate Data** specializes in survivorship-bias-free data for US, Australian and Canadian stocks, plus selected world futures and FX. — [Norgate](https://norgatedata.com/)
- **Databento:** official Python client v0.89.0 (2026-10-28). — [GitHub](https://github.com/databento/databento-python)
- **Massive (formerly Polygon.io):** `polygon-io/client-python` now redirects to `massive-com/client-python`, "The official Python client library for the Massive.com REST and WebSocket API", v2.9.1 (2026-10-26). — [GitHub](https://github.com/massive-com/client-python)
- **yfinance:** unofficial "Download market data from Yahoo! Finance's API", v1.7.0 (2026-08-26). — [GitHub](https://github.com/ranaroussi/yfinance)

#### Strategy compendia
- Quantpedia, Quantocracy, Robot Wealth, Allocate Smartly, CXO Advisory and Carver's blog all responded HTTP 200 on 2026-10-31. Alpha Architect returned 403 to scripted requests but is widely cited above. — [Quantpedia](https://quantpedia.com/); [Quantocracy](https://quantocracy.com/); [Robot Wealth](https://robotwealth.com/); [Allocate Smartly](https://allocatesmartly.com/); [CXO Advisory](https://www.cxoadvisory.com/); [qoppac](https://qoppac.blogspot.com/)
- Quantpedia's database pages summarize each anomaly with source papers and indicative statistics (e.g., time-series momentum, pairs trading, turn of the month). — [Quantpedia TSMOM](https://quantpedia.com/strategies/time-series-momentum-effect/); [Quantpedia pairs](https://quantpedia.com/strategies/pairs-trading-with-stocks); [Quantpedia TOM](https://quantpedia.com/strategies/turn-of-the-month-in-equity-indexes)

### Inferences
- **A sensible 2026 stack for an individual:**
  - Futures trend or carry: pysystemtrade (IBKR via ib_async) or LEAN.
  - ETF/TAA research: bt, vectorbt or zipline-reloaded, with pyfolio-reloaded or quantstats for analytics.
  - Allocation: Riskfolio-Lib or PyPortfolioOpt.
  - Crypto: ccxt or freqtrade.
  - Event-driven live trading: NautilusTrader or LEAN.
- **Data quality is the main hidden risk:**
  - yfinance is unofficial and unsuitable for survivorship-sensitive equity backtests.
  - Norgate (equities, with delisted names) or Databento and Massive (paid, official APIs) are the robust choices.
  - Continuous futures need back-adjusted or roll-aware series.
- **Avoid building on dormant projects** (Backtrader, qstrader, the original zipline and pyfolio, pandas-ta) for new work. Licences differ: AGPL for backtesting.py, LGPL for Nautilus, and the Commons Clause on vectorbt matters if you plan to sell a service.

### Gaps
- I did not verify IBKR's own API products (TWS API versus Web API) beyond ib_async's documentation links, Alpaca or IBKR fees, QuantConnect pricing, Norgate pricing, Tiingo/EODHD/FRED status (Tiingo and Kenneth French's library were unreachable from this network), or European broker APIs (Saxo, IG).

## 11. Comparative judgement: which approaches suit individuals, and which do not

### Takeaway
Individuals' durable edges are structural, not informational:
- No capacity limits.
- No benchmark or career risk.
- The ability to sit through multi-year flat periods.
- Access to tax-advantaged accounts.
- Exchange-traded leverage through futures.

These favour low-turnover, diversified, risk-premium-style systems: trend following or managed futures, simple trend or volatility-targeted allocation, index option writing sized conservatively, and carry inside a diversified futures book. They work against anything that depends on speed, order-flow position, cheap shorting or information that professionals already arbitrage: HFT and market making, short-horizon equity stat arb, 0DTE speculation, faded event anomalies, short-vol ETPs, opaque bots and complex ML or LLM alpha.

### Cited Findings
| Approach | Evidence quality / post-publication status | Turnover & cost sensitivity | Leverage / capital | Main failure modes | Verdict for individuals |
|---|---|---|---|---|---|
| Diversified trend following (futures; managed-futures ETFs) | 1880–2016 positive every decade, crisis "smile" ([Hurst et al.](https://fairmodel.econ.yale.edu/ec439/hurst.pdf)); SG Trend 5.75% CAGR since 2000, −20.6% max DD, 2022 +27%, 2024–25 −20.4% DD, 2026 YTD +15.8% ([TTU](https://www.toptradersunplugged.com/trend-following-performance-report-september-2026/); [Cambridge Associates](https://www.cambridgeassociates.com/en-eu/insight/does-trend-followings-recent-struggle-signal-that-the-strategy-is-structurally-broken/)) | Low (monthly signals in canonical version) | DIY ≥ ~$100k ([Carver](https://www.harriman-house.com/advancedfuturestradingstrat)); ETFs any size at 0.75–0.95% ([KraneShares](https://kraneshares.com/kmlm/)) | Long flat/whipsaw periods, V-shaped reversals, vol-scaling critique ([Kim-Tse-Wald](https://quantpedia.com/deconstructing-the-time-series-momentum-strategy/)) | **Suitable** as a diversifier; small sleeves via ETFs |
| TAA / ETF trend filters (GTAA, GEM, AAA, Keller family) | OOS Sharpe roughly halves vs in-sample (GTAA 0.81→0.68 [Concretum](https://concretumgroup.substack.com/p/global-tactical-asset-allocation); AAA 1.33→0.57 [FOSS Trading](https://www.r-bloggers.com/2024/01/adaptive-asset-allocation-extended/amp/)); GEM lagged SPY ~5 pts/yr since 2014 ([Quant for Free](https://quant4free.com/analysis/dual-momentum/)) | Low (~30 switches/18 yrs for GEM) | No leverage needed; tiny capital | Whipsaw, fast crashes, parameter overfitting | **Suitable for risk control**, not for beating equities; prefer tax-advantaged accounts |
| Volatility targeting / risk parity | Vol targeting lowers tails, raises Sharpe for equities/credit only ([Harvey et al.](https://alphaarchitect.com/volatility-targeting-improves-risk-adjusted-returns/)); vol-managed alpha fails OOS for 72/103 ([Cederburg et al.](https://www.lehigh.edu/~xuy219/research/COWY.pdf)); All Weather −22% in 2022 ([Fortune](https://fortune.com/2024/04/23/lackluster-returns-ray-dalio-investing-strategy-investors-pull-billions/)) | Low–moderate | Risk parity needs leverage (futures) | Rate shocks, positive stock-bond correlation, leveraged-ETF decay ([Nasdaq](https://www.nasdaq.com/articles/should-investors-use-leveraged-etfs-or-avoid-them-altogether)) | **Suitable** (vol targeting); risk parity only with understood rate risk |
| Index option writing (put-write, covered call) | BXM ~8.5% vs ~11.1% S&P since 1986 with lower vol and −35.8% vs −50.9% max DD (Cboe, search excerpts) ([Cboe](https://www.cboe.com/insights/posts/benchmark-indices-series-income-generation-and-smoother-returns-with-cboes-bxm-bxmd-put-and-cmbo-indices)); VRP real but small share of risk ([Israelov & Nielsen](https://www.aqr.com/Insights/Research/Journal-Article/Covered-Calls-Uncovered)) | Moderate (monthly rolls) | Cash-secured, modest | Crash losses, over-sizing, short-vol ETP blowups ([BIS](https://www.bis.org/publ/qtrpdf/r_qt1803t.htm)) | **Suitable if sized as equity substitute**; avoid levered short-vol ETPs |
| 0DTE / short-dated option speculation | Retail ~half of 0DTE flow ([Cboe](https://www.cboe.com/insights/posts/spx-0-dte-options-jump-to-record-62-share-in-august)); retail lost ~$358k/day ([WealthManagement](https://www.wealthmanagement.com/equities/retail-investors-are-in-love-with-same-day-options)); 12.6% avg spreads on retail-favoured options ([Bryzgalova et al.](https://lbsresearch.london.edu/id/eprint/2827/)) | Extreme | Small capital, high churn | Spreads, adverse selection, gambling dynamics | **Unsuitable** |
| Carry (futures/FX) | Sharpe ~0.7 per asset class, ~1.1 diversified; crashes in recessions ([KMPV](https://www.nber.org/papers/w19325)); Aug 2024 yen unwind ([Bloomberg](https://www.bloomberg.com/news/articles/2024-08-06/jpmorgan-says-carry-trade-unwind-is-only-half-complete)) | Low | Futures margin | Correlated crashes | **Suitable as a component** of a diversified futures system |
| Crypto basis / funding arbitrage | Carry up to ~60% p.a. ([BIS](https://www.bis.org/publ/work1087.htm)); BTC perp funding arb Sharpe ~1.8 at retail costs, deviations shrinking ([He et al.](https://arxiv.org/abs/2212.06888v6)) | Moderate | Low capital; collateral on venues | Venue default (FTX), ADL and depegs (10 Oct 2025) ([CoinGecko](https://www.coingecko.com/learn/october-10-crypto-crash-explained)) | **Conditionally suitable** with strict venue/counterparty limits |
| Pairs / short-term reversal stat arb | Gross ~11% (1962–2002) decaying, modest after costs and short fees ([Do & Faff 2012](https://strathprints.strath.ac.uk/41722/)); crowding crash Aug 2007 ([Khandani & Lo](https://nber.org/system/files/working_papers/w14465/w14465.pdf)) | High | Needs shorting | Borrow fees, crowding, crisis margin | **Mostly unsuitable** in equities; futures spreads / long-only dip-buying more feasible |
| Calendar / event anomalies (pre-FOMC, PEAD, index inclusion, overnight, TOM) | Pre-FOMC gone post-2015 ([Kurov et al.](https://ideas.repec.org/a/eee/finlet/v40y2021ics1544612320315956.html)); large-cap PEAD gone since 2006 ([Martineau](https://cfr.ivo-welch.info/published/papers/martineau2021rest.pdf)); index effect <1% ([Greenwood & Sammon](https://papers.ssrn.com/abstract=4294297)); overnight ETF closed ([WealthManagement](https://www.wealthmanagement.com/etfs/night-effect-etfs-shut-down-overnight-stock-returns-elusive)) | High | Small | Edge decayed; costs exceed remnant | **Unsuitable** as standalone; merger arb only via diversified funds |
| HFT / latency arbitrage / market making vs professionals | Retail is the liquidity taker; PFOF concentrated in three wholesalers ([Bryzgalova et al.](https://lbsresearch.london.edu/id/eprint/2827/)); <1% of day traders persistently profitable ([Barber et al.](https://ideas.repec.org/a/eee/finmar/v18y2014icp1-24.html)); 1.1% earn > minimum wage ([Chague et al.](https://econpapers.repec.org/RePEc:fgv:eesptd:525)) | Extreme | Co-location, data feeds | Adverse selection, latency | **Unsuitable** |
| Grid / DCA bots, ML/LLM alpha | No evidence of edge for bots; API-key losses ~$15–22M at 3Commas ([ForkLog/HAPI](https://forklog.com/en/news/api-key-leaks-and-exchange-inaction-a-hapi-analysis-of-the-3commas-incident)); LLM returns fall with adoption ([Lopez-Lira & Tang](https://arxiv.org/abs/2304.07619)); complexity predicts decay ([Falck et al.](https://arxiv.org/abs/2105.01380)) | Varies | Low | Overfitting, look-ahead bias, operational risk | **Unsuitable as alpha source**; ML acceptable for risk/execution tooling |

- **Base-rate haircuts to apply to any backtest:**
  - Published-strategy returns fall 58% after publication. — [McLean & Pontiff](https://www.gwern.net/doc/economics/2016-mclean.pdf)
  - Bank alternative-beta Sharpe ratios fell 73% from backtest to live. — [Suhonen et al. via Alpha Architect](https://alphaarchitect.com/beware-of-backtest-overfitting/)
  - Significance hurdle: t > 3. — [Harvey, Liu & Zhu](https://www.nber.org/papers/w20592)

### Inferences
- **Why the "suitable" group suits individuals:**
  - **Capacity:** a small account can trade every market in a trend or carry system without moving prices, while large CTAs face capacity and correlation constraints.
  - **Low turnover:** monthly or slower signals keep costs and short-term tax drag small, the opposite of the retail-trading datasets in section 9.
  - **Taxes:** low turnover defers gains, and TAA and option-writing turnover can sit in tax-advantaged accounts. Futures may get favourable US treatment, but the Section 1256 60/40 split was not verified this session.
  - **Leverage:** futures and portfolio margin give individuals institution-like, linear leverage for risk parity and trend. Daily-reset leveraged ETFs are an inferior substitute in volatile assets.
  - **Patience:** the biggest documented failure for trend and TAA is behavioural (multi-year underperformance versus equities, as in 2010–2019 and 2023–2025). An individual with no clients can, in principle, hold through it.
- **Why the "unsuitable" group does not:**
  - Its edges come from speed, order-flow position, cheap shorting or information already arbitraged by professionals.
  - Several have disappeared since publication (pre-FOMC, large-cap PEAD, index inclusion) or failed live (overnight ETFs, XIV).
  - The administrative evidence on retail day traders and options buyers is uniformly negative.
- **Additions not named in the brief:**
  - Managed-futures replication ETFs (DBMF index replication versus KMLM rules-based trend) as the low-capital route to trend.
  - Futures calendar spreads and fast mean reversion (Carver AFTS).
  - Merger arbitrage as a liquidity premium.
  - Crypto perpetual funding arbitrage as a distinct carry trade with its own venue and ADL risks.
  - Overnight-return ETFs as a live failure case.
- **Changed after 2020:**
  - 2022 vindicated trend and broke risk parity's bond leg.
  - The 0DTE share of SPX volume rose to about 60%.
  - Crypto carry boomed and then compressed, with FTX and ADL events.
  - PEAD and pre-FOMC evidence weakened further, though the PEAD debate is live.
  - Trend had its second-worst drawdown (2024–25) before recovering in 2026.

### Gaps
- This judgement is qualitative. I did not compute comparable net-of-cost, after-tax Sharpe ratios across approaches.
- Country-specific taxes (US Section 1256, UK spread-betting treatment, EU ETF rules) and broker leverage rules outside the US were not verified.
- Long-run, net-of-fee evidence on individuals running systematic futures accounts (as opposed to day traders) appears not to exist in the academic literature I could reach.
