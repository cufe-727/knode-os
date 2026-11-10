# Global systematic strategies for individual investors: verified details on open questions (as of 2026-10-31)

*Builds on `Quant factor libraries and retail strategies/global_retail_strategies.md` and fills its Gaps sections. Method: 34 web searches plus direct fetches. Several figures are my own calculations from primary datasets downloaded on 2026-10-31: Cboe's daily index histories (cdn-api.cboe.com), Binance and Bybit public funding-rate APIs, and DefiLlama's USDe supply and sUSDe yield APIs. Those are labelled "computed". Unreachable or blocked from this network: cmegroup.com, ssrn.com, interactivebrokers.com, schwab.com, etf.com, hedgefundalpha.com, meketa.com, altshares.com, web.archive.org, and HFR's index page (404). "Search excerpt" means the figure reached me only through the search tool's summary of the linked page, not from my own reading of it.*

## 1. US pattern-day-trader (PDT) rule: FINRA's replacement with intraday margin standards

### Takeaway
The $25,000 PDT minimum is gone. The SEC granted accelerated approval to FINRA's amended Rule 4210 on 14 April 2026 (filing SR-FINRA-2025-017), and the change took effect on 4 June 2026. Brokers may keep the old day-trading regime until the phase-in deadline of 20 October 2027. The new rule removes PDT designation, day-trade counting and day-trading buying power. Instead, each margin account must meet an "intraday margin deficit" test and settle any deficit promptly, with a 90-day freeze for customers who habitually fail to. The general $2,000 margin minimum and the 25% maintenance requirement still apply.

### Cited Findings
- **Timeline:**
  - FINRA started a retrospective review with Regulatory Notice 24-13 (October 2024). — [FINRA Regulatory Notice 26-10, endnote 4](https://www.finra.org/sites/default/files/2026-04/Regulatory-Notice-26-10.pdf)
  - The proposal (SR-FINRA-2025-017) was noticed in Exchange Act Release No. 104572 (9 January 2026), 91 FR 1580 (14 January 2026). — [RN 26-10, endnote 3](https://www.finra.org/sites/default/files/2026-04/Regulatory-Notice-26-10.pdf)
  - FINRA's filing page dates its documents only through upload paths and file names: filing text uploaded December 2025; Federal Register notice January 2026; an SEC notice designating a longer period for action (91 FR 4750) February 2026; FINRA's response to comments dated 18 March 2026; Amendment No. 1 and the approval order April 2026. — [FINRA rule filing page](https://www.finra.org/rules-guidance/rule-filings/sr-finra-2025-017)
  - **Approval:** Exchange Act Release No. 105226 (14 April 2026), 91 FR 20731 (17 April 2026), granted accelerated approval of the proposal as modified by Amendment No. 1. — [RN 26-10, endnote 1](https://www.finra.org/sites/default/files/2026-04/Regulatory-Notice-26-10.pdf)
  - Most secondary sources give 14 April; King & Spalding gives 15 April (search excerpt). — [WilmerHale alert, 23 Apr 2026](https://wilmerhale.com/en/insights/client-alerts/20260423-sec-approves-amendments-to-finra-rule-4210-replacing-day-trading-margin-requirements-with-a-modernized-intraday-margin-standard); [King & Spalding](https://www.kslaw.com/insights/articles/finra-adopts-sweeping-changes-to-margin-requirements-for-day-trading)
  - **Effective date and phase-in:** RN 26-10 is dated 20 April 2026. The rule took effect on 4 June 2026, 45 days after publication. Members that need more time may phase in over 18 months, until 20 October 2027. — [RN 26-10](https://www.finra.org/sites/default/files/2026-04/Regulatory-Notice-26-10.pdf)
- **What was deleted:** the day-trade count test for designating a "pattern day trader", the $25,000 PDT minimum equity, and the day-trading provisions in Rule 4210 paragraphs (f)(8)(B), (b), (f)(10) and (g)(13), together with the related interpretations. — [RN 26-10](https://www.finra.org/sites/default/files/2026-04/Regulatory-Notice-26-10.pdf)
- **What the new rule requires (new Rule 4210(a)(17)–(19), (d)(2), (g)(1)(J)–(K)):**
  - **Scope:** for every customer margin account other than good-faith and portfolio-margin accounts, and for each day with an "IML-reducing transaction", the firm must determine the "intraday margin deficit". This is broadly the largest shortfall of equity against required margin after such a transaction. An IML-reducing transaction is broadly one that reduces what the customer could withdraw while still meeting maintenance margin, such as a short sale or a purchase other than a short cover.
  - **Monitoring:** real-time monitoring and blocking are allowed but not required. Firms may instead make a single end-of-day calculation, and may use the same end-of-day prices they use for maintenance margin.
  - **Computation conventions:**
    - Sweep-program bank deposits may count as a credit balance.
    - Deposits, withdrawals and closings of positions open at the start of the day may be treated as occurring at the start of the day.
    - The legs of a spread, and same-day option exercise and liquidation, may be treated as simultaneous.
    - If the firm cannot show the order of activities, it must assume the order that produces the highest deficit.
  - **Satisfaction:** a deficit must be met "as promptly as possible", by net deposits or other increases in the account's intraday margin level (IML). It stays outstanding until it is satisfied or until close of business on the 15th business day.
  - **90-day freeze:** if a customer makes a practice of failing to meet deficits and leaves one unmet by close of business on the fifth business day, the firm must stop the customer from creating or increasing short positions or debit balances for 90 calendar days, or until the deficit is met.
    - De minimis exclusion: deficits no larger than the lesser of 5% of account equity or $1,000.
    - Extraordinary-circumstances exclusion: deficits the firm reasonably judges arose under extraordinary circumstances.
  - **Portfolio margin:** accounts with less than $5 million of equity must hold intraday margin substantially similar to their end-of-day margin.
  - [RN 26-10](https://www.finra.org/sites/default/files/2026-04/Regulatory-Notice-26-10.pdf)
- **FINRA's investor explainer (20 April 2026):**
  - $2,000 is still the minimum equity to trade on margin. Below it, an investor can trade only with available cash.
  - Equity must stay at 25% or more of the market value of long margin-eligible equities throughout the trading day.
  - Firms "have the authority to impose higher requirements".
  - During the transition a firm may keep its old day-trading margin rules.
  - [FINRA, "Understanding the New Intraday Margin Requirements"](https://syndication.finra.org/node/1126)
- **Broker adoption (secondary, unverified):** Webull reportedly switched on 4 June 2026 and Schwab on 8 June; Fidelity had announced no date. — [Gotrade blog](https://www.heygotrade.com/en/blog/the-pattern-day-trader-rule-is-gone-what-it-means-for-retail-us-stock-traders/)

### Inferences
- As of October 2026, whether a given retail account is still subject to PDT-style limits depends on the broker. The new standard is legally effective, but brokers may run the old regime until 20 October 2027.
- The new regime ties the requirement to intraday exposure, not to trade counts. Small accounts can now day trade on margin above $2,000 of equity. Repeated unmet deficits lead to a 90-day freeze rather than a PDT flag.
- The rule covers margin accounts. Cash-account settlement and free-riding restrictions come from Regulation T, which FINRA's amendment does not change. I did not verify this point this session.
- The earlier notes' retail day-trading evidence (Taiwan, Brazil, 0DTE) implies that a lower entry barrier is more likely to increase aggregate retail losses than to create an edge.

### Gaps
- I did not see the exact date FINRA filed SR-FINRA-2025-017 with the SEC (the filing page shows only a December 2025 upload path), or the text of Amendment No. 1.
- I found no FINRA interpretive-guidance notice issued after RN 26-10, although the notice says one was planned, and no primary broker announcements of switch dates.

## 2. Trend following: SG Trend Index in the 2010s, and Faber's later GTAA updates

### Takeaway
- **SG Trend Index:** I could not obtain a complete 2010–2019 calendar-year series. SG distributes full history only on request, and the BarclayHedge and archive copies were unavailable. Verified points:
  - 2009–2013 −1.8% (Man Group does not say whether cumulative or annualized).
  - 2014 +19.76%.
  - 2015 flat.
  - 2017 +2.2%.
  - 2018 negative, "the most difficult year... on record" at that time.
  - 2019 +9.22%.
  - The decade averaged about 1.8% a year, against 5.7% over the full record.
  - No primary source gave a 2010s Sharpe ratio. The arithmetic suggests it was near 0.1.
- **Faber's GTAA:**
  - The February 2013 update (data to 2012) reported a 1973–2012 gross Sharpe of 0.73 against 0.44 for buy-and-hold, and a 2006–2012 out-of-sample Sharpe of 0.61 against 0.16.
  - The 2018 *Journal of Portfolio Management* revisit reportedly showed about 4.9% a year against 3.5%, with Sharpe 0.59 against 0.19, over the 11 years after 2005 (search excerpt only).
  - An independent 2006–March 2025 test found a 6.05% CAGR and a Sharpe of 0.68.

### Cited Findings
#### SG (formerly Newedge) Trend Index, 2010s data points

| Period | SG / Newedge Trend Index | Source |
|---|---|---|
| 2009–2013 | −1.8% ("From 2009 to 2013, the SG Trend index returned -1.8%"; not stated whether cumulative or annualized) | [Man Group, "Trend Following and Drawdowns: Is This Time Different?", 17 Jun 2025](https://www.man.com/insights/is-this-time-different) |
| 2011 | Exact figure not found; most constituents finished the year negative | [Man Group, "A Trend Following Deep Dive", 3 Sep 2025](https://www.man.com/insights/deep-dive-trend-following) |
| 2014 | +19.76% in the release's table, +19.75% in its text (December +2.32% in the table, +2.52% in the text). Man Group quotes +19.7% | [Newedge/SG CIB release, 21 Jan 2015](https://mondovisione.com/media-and-resources/news/ctas-end-the-year-with-five-months-of-positive-performance-positive-performanc-2015121/); [Man Group](https://www.man.com/insights/is-this-time-different) |
| 2015 | "Flat" (December −2.08%); SG CTA Index also flat | [Hedgeweek, 6 Jan 2016](https://www.hedgeweek.com/ctas-post-negative-returns-december-finish-2015-flat/) |
| 2017 | +2.2% (SG CTA Index +2.5%, Barclay BTOP50 −0.6%) | [SIGLO Timeout, Jan 2018](https://www.cambridgeassociates.com/wp-content/uploads/2025/01/siglo-timeout-nr.-81-rueck-und-ausblick-auf-ctas.pdf) |
| 2018 | Negative, exact figure not stated (December +0.94%). "2018 has been the most difficult year for the CTA Index and Trend Index on record" | [Hedgeweek, 11 Jan 2019](https://www.hedgeweek.com/ctas-see-out-challenging-2018-improvement-performance-2/) |
| 2019 | +9.22%, the best year since 2014 (SG CTA +6.24%, SG Short-Term Traders +3.62%) | [Hedgeweek, 9 Jan 2020](https://www.hedgeweek.com/ctas-close-best-year-2014-trend-followers-lead-performance-2019/) |
| 2010s average | About 1.8% a year, against 5.7% a year over the full track record | [Welton Investment Partners, 2 Jun 2023](https://www.welton.com/performance-drivers-return-for-quant-macro-and-trend-following/) |

- **Other 2010s statistics:**
  - Before 2025, the index's worst rolling 12-month return was −16.0%, ending in January 2019.
  - From that January 2019 low to May 2024 it gained +82.5%.
  - The rolling 12-month return to 30 April 2025 was −18.6%.
  - [Man Group, 17 Jun 2025](https://www.man.com/insights/is-this-time-different)
- **Different index, not to be confused:** the Newedge Trend *Indicator* (a market-based replication index) lost −17.72% in 2013. — [Hedgeweek, 17 Jan 2014](https://www.hedgeweek.com/seven-11-newedge-hedge-fund-indices-produced-positive-returns-2013/)
- **Data access:** SG's index page shows only current MTD/YTD figures and offers full daily data on request or through SG Markets. BarclayHedge's SG Trend page now shows only MTD/YTD (−0.77% and +14.92% as of 31 Oct 2026). — [SG Prime Services Indices](https://wholesale.banking.societegenerale.com/en/prime-services-indices/); [BarclayHedge](https://portal.barclayhedge.com/cgi-bin/indices/displayHfIndex.cgi?indexCat=SG-Prime-Services-Indices&indexName=SG-Trend-Index)
- **Explanation:** AQR (Babu, Levine, Ooi, Schroeder, Stamelos, JPM, March 2020) attributes the weak decade mainly to "fewer large moves across markets", not to weaker trend capture. Its page does not give the SG Trend numbers in text. — [AQR](https://www.aqr.com/Insights/Research/White-Papers/You-Cant-Always-Trend-When-You-Want)

#### Faber's 10-month SMA / GTAA updates
- **February 2013 update (data through 2012), as summarized by CXO Advisory (16 Aug 2013):**
  - Five assets (S&P 500, 10-year Treasuries, MSCI EAFE, GSCI, NAREIT), equal-weighted and rebalanced monthly; cash at 90-day T-bills; gross of costs and taxes.
  - **1973–2012:** timing 10.5% a year against 9.9% for buy-and-hold; volatility 7.0% against 10.3%; Sharpe 0.73 against 0.44; maximum drawdown −9.5% against −46.0%.
  - **S&P 500 alone, 1901–2012:** 10.2% against 9.3%; Sharpe 0.55 against 0.32; maximum drawdown −50.3% against −83.5%.
  - **13-asset version, 1973–2012:** 12.0% against 10.5%; Sharpe 0.94 against 0.73. Holding 10-year Treasuries instead of T-bills as the cash asset lifts this to 13.4% and a Sharpe of 0.98.
  - **Out of sample, 2006–2012:** timing won only three of seven years, with a Sharpe of 0.61 against 0.16. CXO's text gives the same return (10.5% against 9.9%) and drawdown (−9.5% against −46.0%) as the full sample, plus volatilities of 6.0% and 3.9%. These look like transcription errors.
  - [CXO Advisory](https://www.cxoadvisory.com/technical-trading/long-term-outperformance-from-trends-defined-by-moving-averages)
- **2018 revisit, "A Quantitative Approach to Tactical Asset Allocation Revisited 10 Years Later" (JPM special issue, 2018), search excerpts of an ETF.com/Swedroe article:**
  - Over the 11 years after 2005: about 4.9% against 3.5% a year; volatility 6.6% against 12.8%; Sharpe 0.59 against 0.19; maximum drawdown 9.5% against 46%.
  - Using long-term bonds instead of cash reportedly raised the Sharpe from 0.71 to 0.91.
  - The comparison baseline was not clearly named in the excerpt.
  - [ETF.com (Swedroe), search excerpt; page blocked](https://www.etf.com/sections/index-investor-corner/swedroe-why-financial-trends-persist)
- **Independent out-of-sample test (Concretum Group: Gabriel, Pagani, Zarattini):** the same 200-day SMA, five assets and monthly rebalancing from January 2006 to March 2025 gave a 6.05% CAGR, a Sharpe of 0.68 and an 11.7% maximum drawdown. — [Concretum Group](https://concretumgroup.com/global-tactical-asset-allocation/); [Concretum Substack](https://concretumgroup.substack.com/p/global-tactical-asset-allocation)

### Inferences
- **Approximate 2010s Sharpe:** with a 1.8% a year return and T-bill yields near zero for most of the decade, any plausible index volatility (roughly 10–15%) implies a Sharpe of about 0.1. That is consistent with the unverified Quantpedia figure of 0.05 for 2010–2018 cited in the earlier notes. This is arithmetic on cited inputs, not a sourced statistic.
- **Pattern of the decade:** roughly flat to negative over 2009–2013, one exceptional year (2014), then flat (2015), negative (2016, unverified), small positive (2017) and record-bad (2018) years, before 2019 recovered.
- **GTAA:** out-of-sample, the Sharpe advantage over buy-and-hold persisted: 0.61 against 0.16 (2006–2012) and reportedly 0.59 against 0.19 (2006–2016). The absolute Sharpe fell from about 0.73 in-sample to about 0.6–0.68 out-of-sample. Most of the advantage came from avoiding the 2008 drawdown.

### Gaps
- Calendar-year SG Trend returns for 2010, 2011, 2012, 2013 and 2018, and any primary 2010s Sharpe ratio, were not found.
- A search excerpt attributed to Hedgeweek gave 2016 as −6.19% ("the first negative year since 2012"), but I could not identify or open the article, so 2016 is unverified.
- The Meketa (Dec 2025) and Man Group PDFs that may tabulate annual returns were blocked or image-only.
- The 2018 JPM revisit itself (SSRN/PMR) and Faber's original 2013 PDF could not be opened, so the precise out-of-sample tables remain unverified.

## 3. Merger arbitrage after 2010: index and ETF returns, and 2023–2026 spreads

### Takeaway
- **Returns:** liquid merger arbitrage after 2010 earned roughly cash-like returns.
  - The passive ETFs MNA (since 2009) and MRGR (since 2012) compounded at only about 2.1–3.6% a year over 10 years or since inception.
  - The hedge-fund average (Barclay Merger Arbitrage Index) earned about 5% a year over 10 years.
  - ARB (Water Island) returned 3.87% a year over five years to May 2026, against 3.46% for 3-month T-bills.
  - MNA and its index lost money in both 2021 and 2022.
- **Spreads:**
  - They widened sharply in 2023–24 under aggressive FTC/DOJ enforcement. Average day-one spreads of pending deals passed 12% in May 2023, more than double a year earlier, and rose roughly another 10% by May 2024 in Water Island's fund.
  - In 2025, under a more permissive antitrust stance, they settled around 6–9%.
  - In 2025 MNA returned +8.60% and the Barclay index +7.38%.
- **HFRI:** I could not obtain HFRI ED: Merger Arbitrage annual returns.

### Cited Findings
#### MNA (NYLIM, formerly IQ / NYLI, Merger Arbitrage ETF)
- **Fund facts:** inception 17 Nov 2009; total expense ratio 0.78%; net assets $264.69M; 74 holdings; renamed NYLIM Merger Arbitrage ETF on 28 Aug 2026. The index holds announced global takeover targets and shorts the acquirer's stock in stock-for-stock deals. — [MNA factsheet, data to 30 Sep 2026](https://www.nylim.com/assets/documents/etf/mna-nylim-merger-arbitrage-etf-fs.pdf)
- **Calendar-year returns (%):** — [MNA factsheet](https://www.nylim.com/assets/documents/etf/mna-nylim-merger-arbitrage-etf-fs.pdf)

| Year | MNA (NAV) | NYLIM Merger Arb Index | Barclay Merger Arbitrage Index (hedge-fund average) | MSCI World (net) |
|---|---|---|---|---|
| 2016 | 4.86 | 5.63 | 6.37 | 7.51 |
| 2017 | 5.87 | 6.70 | 4.97 | 22.40 |
| 2018 | 2.10 | 2.55 | 0.33 | −8.71 |
| 2019 | 4.62 | 5.03 | 6.39 | 27.67 |
| 2020 | 2.87 | 3.45 | 9.18 | 15.90 |
| 2021 | −3.27 | −2.33 | 7.69 | 21.82 |
| 2022 | −1.49 | −0.89 | 0.95 | −18.14 |
| 2023 | 0.36 | 1.41 | 4.57 | 23.79 |
| 2024 | 4.96 | 5.78 | 4.45 | 18.67 |
| 2025 | 8.60 | 8.51 | 7.38 | 21.09 |

- **Average annual returns to 30 Sep 2026:**
  - MNA NAV: 1 year 2.39%, 3 years 5.53%, 5 years 2.50%, 10 years 2.73%, since inception 2.74%.
  - Barclay Merger Arbitrage Index: 3.58%, 5.40%, 4.07%, 5.00%, 4.83%.
  - MSCI World: 15.24%, 21.40%, 11.89%, 12.81%, 10.81%.
  - [MNA factsheet](https://www.nylim.com/assets/documents/etf/mna-nylim-merger-arbitrage-etf-fs.pdf)

#### MRGR and ARB
- **MRGR (ProShares Merger ETF, S&P Merger Arbitrage Index):**
  - Inception 11 Dec 2012; net expense ratio 0.75% (gross 2.03%, fee waiver to 30 Sep 2027); net assets $15.9M.
  - NAV returns to 30 Sep 2026: 1 year 6.94%, 3 years 7.12%, 5 years 3.95%, 10 years 3.57%, since inception 2.09%.
  - Index: 8.41%, 8.16%, 5.03%, 4.47%, 3.13%.
  - [ProShares MRGR page](https://www.proshares.com/our-etfs/strategic/mrgr)
- **ARB (AltShares Merger Arbitrage ETF, Water Island Merger Arbitrage USD Hedged Index; inception 7 May 2020):**
  - **Fiscal year to 31 May 2023:** NAV −0.95%; 2.09% a year since inception, against 3.60% for the index and 1.10% for 3-month T-bills. First Horizon/TD Bank (terminated May 2023) was the top detractor. — [AltShares N-CSR, FY2023](https://www.sec.gov/Archives/edgar/data/1779306/000110465923087624/tm2314530d1_ncsr.htm)
  - **Fiscal year to 31 May 2024:** NAV +8.25% (index +9.23% gross). — [AltShares N-CSR, FY2024](https://www.sec.gov/Archives/edgar/data/1779306/000110465924086721/tm2413616d1_ncsr.htm)
  - **Fiscal year to 31 May 2026 (filed 5 Aug 2026):**
    - NAV: 1 year 4.77%, 5 years 3.87%, since inception 4.21%.
    - Index: 5.97%, 5.20%, 5.58%.
    - ICE BofA 3-month T-bill: 3.88%, 3.46%, 2.86%.
    - S&P 500: 29.78%, 14.15%, 19.26%.
    - Costs 0.65% of a $10,000 investment; net assets $103.1M; 146 holdings; turnover 399%.
    - Top detractors: Alcon/STAAR Surgical, Permira/Bavarian Nordic, Zijin/Allied Gold.
    - [AltShares N-CSR, FY2026](https://www.sec.gov/Archives/edgar/data/1779306/000110465926090983/tm2613590d1_ncsr.htm); [EDGAR filing list](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1779306&type=N-CSR&dateb=&owner=include&count=40)

#### Spread levels 2023–2026
- **May 2023:** Water Island said volatility and rising rates had pushed deal spreads to "average levels we haven't seen since the Global Financial Crisis". The average day-one spread of pending deals at 31 May 2023 "exceeded 12% – more than double the rate just 12 months prior". — [AltShares N-CSR, FY2023](https://www.sec.gov/Archives/edgar/data/1779306/000110465923087624/tm2314530d1_ncsr.htm)
- **May 2024:**
  - At 31 May 2024 the average spread in Water Island's Arbitrage Fund had risen by nearly 10% from a year earlier.
  - The managers cite FTC/DOJ "novel theories" and court losses, including Microsoft/Activision and the FTC's challenge to Amgen/Horizon.
  - Deal flow recovered: 371 deals worth $647B in January–May 2024, against 318 worth $441B a year earlier (Dealogic).
  - [AltShares N-CSR, FY2024](https://www.sec.gov/Archives/edgar/data/1779306/000110465924086721/tm2413616d1_ncsr.htm)
- **2025 (Gabelli, 11 Nov 2025):**
  - "Deal spreads have remained relatively consistent throughout the year, averaging around 6-9%", wider for deals under regulatory scrutiny. Gabelli does not say whether the figures are annualized.
  - New FTC/DOJ leadership signalled a "business-friendly, pragmatic" stance.
  - Global M&A was $3.0T in the first nine months of 2025, up 33%.
  - Gabelli ABC Fund: 5.2% a year since 1993.
  - [Gabelli M&A Update](https://gabelli.com/research/gabelli-ma-update/)
- **Q2 2026 (Carmignac letter, 14 Jul 2026):** no spread levels given. 25 new deals worth about $138B were announced in the quarter, with no deal breaks in Carmignac's book. It expects a "more pragmatic US antitrust environment", and Chinese approval risk widened the Zijin/Allied Gold spread. — [Carmignac](https://www.carmignac.com/en/articles/carmignac-portfolio-merger-arbitrage-plus-letter-from-the-fund-managers-q2-2026-3962-13515)

### Inferences
- **ETFs barely beat cash:** over 2016–2025 the passive ETFs earned roughly T-bill-like returns: ARB 3.87% against 3.46% for T-bills over five years. The positive 2021–2022 hedge-fund average contrasts with negative passive-ETF years. Possible reasons are that the passive index holds every announced deal, including high-risk ones, takes no view on deal risk, and pays an ETF fee.
- **The Barclay index likely flatters:** its roughly 2 percentage-point annual edge over MNA (10-year 5.00% against 2.73%) is a self-reported hedge-fund average. It is likely flattered by reporting and survivorship bias (general knowledge, not verified here).
- **Spreads vs realized returns:** spreads were widest in 2023–24, but those years' realized returns were modest because deal breaks and delays (First Horizon/TD, Capri/Tapestry) consumed the wider spreads. 2025 returns were higher once antitrust risk receded and pending deals closed. This is consistent with the earlier notes' Mitchell-Pulvino view of merger arbitrage as a short-put, liquidity-premium trade.

### Gaps
- I found no HFRI ED: Merger Arbitrage annual returns: HFR's page returned 404 and press releases were not found.
- A fund letter search excerpt reported +8.2% for the HFRI index in an unclear 2025 period (likely year-to-date to Q3 2025), and a Carmignac page cited −1.84% for the HFRX Merger Arbitrage Index in an unstated year. Both are unverified.
- No independent, consistently defined annualized spread series for 2023–2026 (for example from a dealer index) was found.
- ARB calendar-year returns were not extracted; its fiscal year ends in May.

## 4. Futures for small accounts: CME micro contracts, margins, Section 1256 and non-US residents

### Takeaway
- **Contract sizes:** CME's micros are one-tenth of the full contracts:
  - Micro E-mini S&P 500 and Nasdaq-100: one-tenth of the E-mini.
  - Micro WTI: 100 barrels.
  - Micro Gold: 10 troy ounces.
  - Micro 10-Year Yield: $10 per basis point.
  - Micro Bitcoin and Micro Ether: 0.1 coin.
- **Margins:** retail overnight margins posted by AMP Futures (seen 31 Oct 2026) ranged from about $350 (Micro 10-Year Yield) to about $4,600 (MNQ). An MES contract margined at $2,881 controls about $37,900 of S&P 500 exposure (about 7.6%).
- **US taxes:** regulated futures are Section 1256 contracts. They are marked to market at year end and taxed 60% long-term / 40% short-term regardless of holding period. Individuals can elect to carry net 1256 losses back three years.
- **Non-US residents:** they are generally outside all of this. Trading exchange-traded commodities for their own account through a US broker is not a US trade or business. Their capital gains are generally foreign-source, or taxed only if they spend 183 days or more in the US. Home-country rules therefore govern.

### Cited Findings
#### Contract specifications (CME sources; cmegroup.com itself was blocked)
- **Micro E-mini equity index futures:** launched 6 May 2019 on the S&P 500, Nasdaq-100, Russell 2000 and Dow, at one-tenth of the E-mini contracts (search excerpt). By the conventional E-mini multipliers this means $5 × S&P 500 and $2 × Nasdaq-100; I did not re-fetch those multipliers. — [CME release, May 2019 (search excerpt)](https://www.prnewswire.com/news-releases/cme-group-announces-launch-of-new-micro-e-mini-equity-index-futures-300843857.html)
- **Micro WTI:** announced 17 May 2021 and launched 12 July 2021. It is one-tenth of the benchmark WTI contract, cash-settled on the NYMEX WTI daily settlement price. — [CME release](https://www.prnewswire.com/news-releases/cme-group-to-launch-micro-wti-futures-on-july-12-301292355.html)
- **Micro Treasury Yield (2-, 5-, 10- and 30-year):** announced 9 June 2021 and launched 16 August 2021. "$10 per basis point of yield", cash-settled to BrokerTec Treasury benchmarks, on CBOT. — [CME release](https://www.prnewswire.com/news-releases/cme-group-to-launch-micro-treasury-yield-futures-301308721.html)
- **Micro Bitcoin:** launched 3 May 2021 at one-tenth of a bitcoin, cash-settled to the CME CF Bitcoin Reference Rate (search excerpt). — [CME release](https://www.prnewswire.com/news-releases/cme-group-announces-launch-of-micro-bitcoin-futures-301281660.html)
- **Micro Ether:** launched 6 December 2021 at one-tenth of one ether, which is 1/500 of the 50-ether contract. Cash-settled to the CME CF Ether-Dollar Reference Rate (search excerpts). — [CME release](https://www.prnewswire.com/news-releases/cme-group-announces-launch-of-micro-ether-futures-301437548.html); [TradeStation release](https://www.prnewswire.com/news-releases/tradestation-securities-supports-trading-of-micro-ether-futures-from-cme-group-starting-on-day-one-301437981.html)
- **Micro Gold (MGC, launched 2010 as "E-micro Gold"):** "ten (10) Troy Ounces", one-tenth of the 100-ounce GC contract (search excerpt of the 2010 CFTC self-certification). — [CFTC filing](https://cftc.gov/stellent/groups/public/@rulesandproducts/documents/ifdocs/rul092410xcomex001.pdf)
- **Adoption:** by August 2021 more than 1 billion micro contracts had traded, 87% of them equity micros. CME called Micro E-mini "the most-successful product launch in CME Group's history". — [CME release, 30 Aug 2021](https://www.prnewswire.com/news-releases/cme-group-micro-futures-and-options-surpass-1-billion-contracts-traded-301365253.html)

#### Typical margins (broker-posted; check before trading)
- **AMP Futures table, accessed 31 Oct 2026, no as-of date shown.** The overnight column is headed "*Maintenance". Its footnote says the CFTC, CME and NFA classify all retail traders as a "Heightened Risk Profile", mandating exchange margin 10% above the rates CME publishes. Listed overnight margin and AMP day-trade margin:
  - MES: $2,881 overnight, $40 day-trade.
  - MNQ: $4,638 overnight, $100 day-trade.
  - Micro WTI (MCL): $1,120, $280.
  - Micro Gold (MGC): $2,320, $580.
  - Micro 10-Year Yield (10Y): $352, $88.
  - For comparison, 1-Ounce Gold is $232 and the 10-Year T-Note (ZN) $2,062.
  - [AMP Futures margins](https://www.ampfutures.com/trading-info/margins)
- **Micro Bitcoin:** Schwab reportedly put initial margin at about $2,800 for MBT against about $140,000 for the full BTC contract as of 24 Mar 2026, and $3,267 against $163,581 in April 2025 (search excerpts; page blocked). — [Schwab](https://www.schwab.com/learn/story/micro-bitcoin-and-ether-futures-offer-small-bites-crypto)
- **Contract values at current prices (computed):**
  - S&P 500 closed at 7,580.07 on 30 Oct 2026, so one MES contract is about $37,900. — [Cboe SPX history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/SPX_History.csv)
  - Binance BTC and ETH mark prices on 31 Oct 2026 at 08:00 UTC were $77,316 and $2,242.54, so one MBT is about $7,730 and one MET about $224. — [Binance API](https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT)

#### US Section 1256 treatment
- **Mark-to-market and 60/40:** a 1256 contract held at year end is treated as sold at fair market value. Gain or loss is "short-term capital gain or loss, to the extent of 40 percent" and "long-term... to the extent of 60 percent". — [26 U.S.C. §1256(a)](https://www.law.cornell.edu/uscode/text/26/1256)
- **Definition:** 1256 contracts are regulated futures contracts, foreign currency contracts, nonequity options, dealer equity options and dealer securities futures contracts. A "regulated futures contract" is one that is marked to market and "traded on or subject to the rules of a qualified board or exchange". — [26 U.S.C. §1256(b), (g)(1)](https://www.law.cornell.edu/uscode/text/26/1256)
- **Exclusions:** securities futures contracts and options on them (unless dealer securities futures), and swaps of all kinds. — [26 U.S.C. §1256(b)(2)](https://www.law.cornell.edu/uscode/text/26/1256)
- **Other provisions:**
  - The wash-sale rule (§1091) "shall not apply" to losses recognized under the year-end mark-to-market rule.
  - There is a hedging exception, a mixed-straddle election and capital-gain treatment for traders.
  - [26 U.S.C. §1256(e), (d), (f)(3), (f)(5)](https://www.law.cornell.edu/uscode/text/26/1256)
- **Loss carryback:** a non-corporate taxpayer can elect to carry a net 1256 loss back three years, against prior 1256 gains, again treated as 40% short-term and 60% long-term. — [26 U.S.C. §1212(c)](https://www.law.cornell.edu/uscode/text/26/1212)
- Gains are reported on Form 6781. — [IRS](https://www.irs.gov/forms-pubs/about-form-6781)

#### Non-US residents (IRS Publication 519, for 2025 returns)
- **Trading safe harbor:** if a nonresident alien's only US business activity is trading stocks, securities or commodities through a US broker, they are "not engaged in a trade or business in the United States". For commodities this covers those usually traded on an organized commodity exchange. The safe harbor applies even when trading for one's own account while present in the US, but not to dealers or to anyone with a US office through which they trade. — [IRS Pub. 519](https://www.irs.gov/pub/irs-pdf/p519.pdf)
- **Source rule:** gain on the sale of personal property is generally US-source only for someone with a US tax home; otherwise it is "from sources outside the United States". — [IRS Pub. 519](https://www.irs.gov/pub/irs-pdf/p519.pdf)
- **183-day rule:** a nonresident in the US for 183 days or more is taxed at 30% (or a lower treaty rate) on net US-source capital gains. Pub. 519 also says "Specific tax treatment that applies to U.S. citizens or residents generally does not apply to you." — [IRS Pub. 519](https://www.irs.gov/pub/irs-pdf/p519.pdf)

### Inferences
- **Contract granularity:**
  - At about $350–$4,600 overnight margin per contract, a small account can hold one each of equity, rate, energy, metal and crypto micros with well under $15,000 of margin.
  - The binding issue is position granularity, not margin. One MES contract is about $38,000 of exposure, so precise volatility targeting is hard below roughly $50,000–$100,000. This is consistent with Carver's guidance cited in the earlier notes.
- **Tax value of 60/40:**
  - At 2025 top US federal rates of 20% (long-term) and 37% (short-term), the blended maximum rate is about 26.8% before the 3.8% net investment income tax, regardless of holding period. Short-term ETF trading would face up to 37%.
  - Futures-based ETFs are funds, so their shareholders do not get 1256 treatment directly.
  - These points are inference; the rates were not re-verified this session.
- **Micro crypto futures:** CME's crypto micros are exchange-traded, marked-to-market regulated futures, so they appear to fall under §1256, unlike spot crypto or offshore perpetuals. I found no IRS statement specific to them.
- **Non-US investors:** the US 60/40 rule is generally irrelevant to them; their home-country rules decide whether futures gains are capital or income. The US safe harbor and source rules usually mean no US tax and no US filing for pure exchange trading, but estate-tax and treaty issues were not examined.

### Gaps
- CME's official margin schedule and contract-spec pages were blocked, so margins are broker-posted (AMP) and may differ from CME's published maintenance levels.
- No current margin was found for Micro Ether, and no primary current figure for Micro Bitcoin.
- Specific non-US countries' rules (for example UK spread betting, Germany's derivative-loss cap and its 2024 reform, Australia) were not researched.

## 5. Crypto carry: funding and CME basis 2024–2026, spot-ETF demand, Ethena/USDe, and 10 October 2025

### Takeaway
- **Funding (computed from Binance's own data):** realized BTC perpetual funding was about 11.9% annualized in 2024 (22% in the first quarter), 5.1% in 2025 and 3.1% in 2026 to 31 October. ETH followed the same path: 13.0%, 4.9% and 2.1%.
- **A ceiling since December 2024:** no Binance BTC or ETH funding print has exceeded 0.01% per 8 hours (about 10.95% a year) since 9 Dec 2024. Bybit is nearly identical.
- **CME basis:** it was about 50% annualized around the January 2024 spot-ETF approval and near 25% in February 2024. It fell to about 1–6% in late 2025 and about 5% in April 2026, roughly the T-bill rate. CME open interest fell to its lowest since February 2024.
- **Ethena:** sUSDe's yield fell from about 17.5% (2024 average) to 6.5% (2025) and 4.2% (2026). USDe supply peaked at $14.8B on 4 Oct 2025 and fell about 70% to $4.5B after the 10 October crash.
- **10 October 2025:** liquidations exceeded $19B. Hyperliquid force-closed about $2.1B of winners' positions by auto-deleveraging within 12 minutes. Binance paid $283M after USDe and staked-token collateral depegged on its venue alone.

### Cited Findings
#### Perpetual funding, realized, from exchange data (computed)
- **Method:** I summed every Binance USDT-margined funding print from 1 Jan 2024 to 31 Oct 2026 (3,104 prints per symbol) and annualized the totals. — [Binance API, BTCUSDT](https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=1704067200000&limit=1000); [Binance API, ETHUSDT](https://fapi.binance.com/fapi/v1/fundingRate?symbol=ETHUSDT&startTime=1704067200000&limit=1000)

| Period | BTCUSDT annualized | ETHUSDT annualized | BTC share of negative prints | ETH share of negative prints |
|---|---|---|---|---|
| 2024 | 11.92% | 12.96% | 8.4% | 4.2% |
| 2025 | 5.13% | 4.93% | 12.9% | 16.2% |
| 2026 to 31 Oct | 3.11% | 2.08% | 25.0% | 29.1% |

- **BTC by quarter (computed):**
  - 2024: Q1 22.33%, Q2 9.34%, Q3 3.46%, Q4 12.65%.
  - 2025: Q1 5.25%, Q2 3.54%, Q3 7.02%, Q4 4.68%.
  - 2026: Q1 1.22%, Q2 1.03%, Q3 6.49%, October 4.70%.
  - [Binance API](https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=1704067200000&limit=1000)
- **Ceiling (computed):**
  - The 2024 maximum print was 0.088% per 8 hours for BTC and 0.102% for ETH.
  - In 2025–2026, none of the 2,006 prints for each of BTC and ETH exceeded 0.0100%. The last print above it, for both, was on 9 Dec 2024 at 16:00 UTC.
  - Around the crash, BTC funding stayed tiny and mixed-sign (for example −0.0109% on 12 Oct 16:00 UTC).
  - [Binance API](https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=1704067200000&limit=1000)
- **Bybit cross-check (computed):** BTCUSDT realized 5.12% annualized in 2025 (only 3 prints above 0.01%, maximum 0.0514%; 18.2% negative). 2026 to date: 2.66%, with none above 0.01% and 28.1% negative. — [Bybit API](https://api.bybit.com/v5/market/funding/history?category=linear&symbol=BTCUSDT&limit=200)
- **Context (search excerpts):**
  - Binance's annualized BTC funding passed 100% in February 2024. — [FXStreet](https://www.fxstreet.com/amp/cryptocurrencies/news/bitcoin-funding-rates-jump-to-100-sparking-opportunity-for-savvy-traders-202402270607)
  - K33 reported daily average funding in September 2024 at the lowest since March 2023. — [The Block/K33](https://www.theblock.co/post/314382/bitcoin-perpetual-futures-funding-rates-pessimism)
  - BitMEX describes a default base rate of 0.01% per 8 hours when the premium is small. Its Q3 2025 report, "The Anchor and the Ceiling", returned 404 when fetched. — [BitMEX](https://www.bitmex.com/blog/2025q3-derivatives-report)

#### CME basis and spot-ETF demand
- **Around the ETF approval:**
  - K33 reported CME premiums at about 50% annualized. — [The Block/K33 (search excerpt)](https://www.theblock.co/post/269993/bitcoin-spot-etf-sell-the-news)
  - Cointelegraph reported a $1,600 premium, about 53% annualized intraday, on 2 Jan 2024. — [Cointelegraph (search excerpt)](https://cointelegraph.com/markets/cme-bitcoin-futures-held-1-6k-premium-as-spot-btc-price-traded-above-45k-why)
- **CF Benchmarks (index administrator; 16 Oct 2025):**
  - The CME basis "approached 25% in February 2024", "exceeded 20% in November 2024", "briefly dipped below zero" in March 2025, fell "below 10%" in April 2025 and was "near 10%" in May 2025.
  - CME open interest rose from about 30,000 contracts (January 2024) to a record near 45,000 (late November 2024), up as much as 83% after the ETF launches. It fell to about 32,000 by May 2025.
  - Leveraged funds increased their net shorts after the ETF launch (no figures in text).
  - [CF Benchmarks](https://www.cfbenchmarks.com/blog/revisiting-the-bitcoin-basis-how-momentum-sentiment-impact-the-structural-drivers-of-basis-activity)
- **June 2024 (CF Benchmarks via The Block):**
  - Spot ETFs had contributed to an 80% year-to-date rise in CME open interest.
  - CME short contracts were just under 18,000, about $6.3B notional.
  - The analyst said the basis-trade share of ETF holdings is "hard to say with certainty" but "within the ball park" of the roughly $6B CME short notional.
  - [The Block, 20 Jun 2024](https://www.theblock.co/post/301041/spot-etf-basis-trades-driving-80-surge-in-cme-bitcoin-futures-open-interest-analyst-says)
- **October–November 2025 (Kaiko / Amberdata, vendor analysis with some internal inconsistencies):**
  - The 30-day annualized basis fell from 6.63% to 4.46% over 87 days, with a low of 1.17% on 21 Nov 2025. It was below a 5% breakeven on 93% of the last 30 days.
  - Spot ETF gross outflows were $1.74B (Grayscale 53%) against $3.15B of inflows over 1 Oct–26 Nov.
  - The piece calls the unwind "mechanical".
  - [Kaiko](https://www.kaiko.com/resources/the-etf-exodus-decoded-basis-arbitrage-not-capitulation)
- **April 2026 (The Block, 9 Apr 2026):**
  - Annualized basis was about 5% against a risk-free rate of about 4.5%, "essentially zero incentive".
  - CME bitcoin futures open interest was $7.2B, the lowest since February 2024, and March 2026 volume was down nearly 50% from its January 2025 peak.
  - Binance overtook CME as the largest bitcoin futures venue, for the first time since November 2023.
  - [The Block](https://www.theblock.co/post/396722/cme-bitcoin-futures-activity-slumps-to-14-month-low-as-basis-trade-unwind-drains-institutional-demand)
- **Pre-ETF benchmark:** the BIS's "Crypto carry" (Schmeling, Schrimpf, Todorov) found carry "averaging above 10% annually", with peaks up to 60%. — [BIS WP 1087](https://www.bis.org/publ/work1087.htm)

#### Ethena / USDe as a funding trade at scale (computed from DefiLlama)
- **USDe circulating supply:**
  - $0.09B on 1 Jan 2024; $5.88B at end-2024.
  - Peak $14.82B on 4 Oct 2025; $14.66B on 10 Oct; $12.70B on 12 Oct; $9.56B on 31 Oct; $6.30B at end-2025.
  - Low $3.75B on 28 Apr 2026; $4.53B on 30 Oct 2026.
  - [DefiLlama stablecoin API (USDe, id 146)](https://stablecoins.llama.fi/stablecoincharts/all?stablecoin=146)
- **sUSDe yield (DefiLlama pool for Ethereum sUSDe):**
  - 2024 (from 16 Feb): mean 17.47%, median 14.19%, maximum 55.87%. Quarterly means: Q1 32.4%, Q2 19.8%, Q3 8.2%, Q4 17.1%.
  - 2025: mean 6.52%.
  - 2026 to 31 Oct: mean 4.20%; 5.05% on 31 Oct 2026.
  - sUSDe TVL was $5.86B on 1 Oct 2025 and $1.17B on 31 Oct 2026.
  - [DefiLlama yields API](https://yields.llama.fi/chart/66985a81-9c51-46ca-9977-42b4fe7bc6df)
- **Redemptions around 10 October (search excerpts):**
  - About $1.9B of USDe redemptions were processed between 10 and 11 October, citing an Ethena governance-forum post, and the price on Curve stayed near $1. — [The Defiant](https://thedefiant.io/news/tokens/ethena-usde-market-cap-drops-40-percent-since-black-friday-10-10)
  - Blockworks measured a median backing ratio of about 1.005 on 10–11 October, against about 1.011 normally. — [Blockworks](https://blockworks.com/insights/ethena-cooldown-analysis)
  - 10x Research estimated about $8.3B of net outflows after 10 October. — [ForkLog](https://forklog.com/en/news/usde-capitalisation-by-ethena-plummets-by-8-3-billion-since-october)

#### 10 October 2025 liquidation and auto-deleveraging (ADL)
- **Scale (carried over from the earlier notes):** more than $19B liquidated across about 1.6M accounts after the announcement of 100% tariffs on China. — [CoinGecko](https://www.coingecko.com/learn/october-10-crypto-crash-explained); [Cointelegraph](https://cointelegraph.com/news/19b-crypto-market-crash-leverage-china-tariffs)
- **Hyperliquid ADL (Chitra, "Autodeleveraging: Impossibilities and Optimization", arXiv 2512.01112, v3 16 Feb 2026):**
  - About $2.1B of positions were closed by ADL within 12 minutes.
  - Hyperliquid's production ADL overshot the minimum haircut: profitable traders lost an estimated $45.0–51.7M too much, on about $653.6M of positions.
  - The paper suggests Binance used ADL much more heavily than Hyperliquid.
  - [arXiv](https://arxiv.org/abs/2512.01112)
  - A search excerpt describes this as Hyperliquid's first cross-margin ADL in more than two years. — [WuBlock](https://wublock.substack.com/p/hyperliquid-activates-cross-margin)
- **Binance:**
  - Paid about $283M to users liquidated while holding USDe, BNSOL or wBETH as collateral between 21:36 and 22:16 UTC on 10 October.
  - USDe briefly fell below $0.66 on Binance alone. Prices bottomed at 21:20–21:21 UTC, before the depegs.
  - Binance said it would add redemption prices to the index weights and put a soft floor on the USDe reference price.
  - [The Block, 12 Oct 2025](https://www.theblock.co/post/374295/binance-pays-283-million-in-compensation-following-fridays-depegs-covering-user-losses)

### Inferences
- **The premium has gone:** for a retail cash-and-carry or funding trade, the attractive premium of 2021–2024 has largely disappeared. Realized 2026 funding (2–3%) and CME basis (about 5%) are at or below T-bills: 3.88% over the year to May 2026 on the ICE BofA 3-month T-bill index, per [AltShares' FY2026 report](https://www.sec.gov/Archives/edgar/data/1779306/000110465926090983/tm2613590d1_ncsr.htm). Venue, margin and ADL risks remain.
- **Why funding hits a ceiling:** a Binance print of exactly 0.0100% normally means the premium component was too small to move funding off its default interest component. Funding has stayed pinned at or below that level since December 2024. This is consistent with large delta-neutral capital (Ethena and other funding arbitrageurs) shorting perpetuals whenever a premium appears, while CME basis funds did the same on the futures curve. This interpretation is not verified.
- **Effect of US spot ETFs:** they raised carry first (record CME open interest, 20–25% basis in 2024), then helped compress it. ETFs made the long-spot leg cheap and institutional, and hedge funds' short CME legs competed the basis down. When basis fell below funding costs, the unwind showed up as ETF outflows and falling CME open interest (late 2025 to April 2026).
- **sUSDe yields:** they track funding (2024 17.5% against Binance BTC 11.9%; 2025 6.5% against 5.1%). The yield is higher than funding because only staked USDe receives it. USDe's roughly 70% contraction after 10 October shows the capacity of the trade shrinking with funding. It survived the stress on-chain, but the Binance depeg was a venue/oracle failure that liquidated people using USDe as collateral.
- **ADL is the key tail risk for a hedged trader:** ADL can close the profitable short hedge leg while the spot or collateral leg stays exposed, turning a "delta-neutral" position directional at the worst moment.

### Gaps
- I did not compute CME basis from raw futures prices. CME data were blocked, so basis levels come from CF Benchmarks, Kaiko, K33 and The Block. The late-2025 −2.35% CME backwardation figure was a search excerpt only.
- Exact ADL totals on Binance, Bybit and OKX on 10 October were not found.
- Ethena's own yield-attribution data (funding, staking, T-bill/USDtb) was not fetched. DefiLlama's sUSDe "apy" is a trailing measure whose exact construction I did not check.
- I found no 13F-based estimate of the share of ETF holdings in basis trades.

## 6. Options benchmarks: Cboe BXM, BXMD and PUT

### Takeaway
- **Long-run record (computed from Cboe's own daily index files):**
  - BXMD: 10.6% a year since June 1986.
  - PUT: 9.3% since March 1991.
  - BXM: 6.2% since March 2002 (the start of Cboe's daily file).
  - Over 2007–Oct 2026: PUT 7.2%, BXM 6.0%, BXMD 8.4%, against 8.8% for the S&P 500 *price* index (dividends excluded).
- **Risk:** monthly volatility of about 10.6–12.9% against 15.4%. Maximum drawdowns, on month-end closes, of −32.7% for PUT, −35.8% for BXM and −42.7% for BXMD, all in 2008–09.
- **2020–2026:** the indexes cushioned 2022 (PUT −7.7%, BXM −11.4% against SPX price −19.4%). BXM lagged badly in the 2020 V-shaped rebound (−2.8% against +16.3%). All gained 9–24% in 2023–2025.

### Cited Findings
- **Data:** Cboe's daily histories run to 30 Oct 2026. BXM starts 22 Mar 2002, BXMD 20 Jun 1986, and PUT 4 Mar 1991 (sparse until 2007, daily from January 2007). SPX is a price index from 1975; Cboe's total-return S&P series was not accessible (403). — [BXM](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv); [BXMD](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/BXMD_History.csv); [PUT](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/PUT_History.csv); [SPX](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/SPX_History.csv)
- **Long-run statistics (computed):**

| Index (window) | CAGR | Volatility (monthly / daily) | Max drawdown (daily closes) | Max drawdown (month-end) |
|---|---|---|---|---|
| BXMD (Jun 1986–Oct 2026) | 10.61% | 12.85% / 15.94% | −47.01% (12 Oct 2007–9 Mar 2009) | −42.73% |
| PUT (Mar 1991–Oct 2026, point to point) | 9.32% | n/a (sparse before 2007) | n/a | n/a |
| BXM (Mar 2002–Oct 2026) | 6.16% | 10.64% / 13.75% | −40.14% (26 Dec 2007–9 Mar 2009) | −35.81% (May 2008–Feb 2009) |
| PUT (Jan 2007–Oct 2026) | 7.23% | 10.72% / 13.84% | −37.09% (19 May 2008–9 Mar 2009) | −32.66% |
| BXM (Jan 2007–Oct 2026) | 6.01% | 10.95% / 14.31% | −40.14% | −35.81% |
| BXMD (Jan 2007–Oct 2026) | 8.41% | 12.94% / 16.83% | −47.01% | −42.73% |
| SPX price only (Jan 2007–Oct 2026) | 8.83% | 15.41% / 19.66% | −56.78% (9 Oct 2007–9 Mar 2009) | not computed |

  Source: computed from [Cboe daily histories](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv)
- **SPX price CAGR over matching windows (computed):** 8.85% from June 1986, 8.84% from March 1991, 7.97% from March 2002. — [Cboe SPX history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/SPX_History.csv)
- **Sub-periods (computed):**
  - **2010–2019:** BXM 7.05%, BXMD 9.82%, PUT 7.33%, SPX price 11.23%.
  - **Jan 2020–Oct 2026:** BXM 7.91%, BXMD 10.77%, PUT 9.55%, SPX price 13.30%.
  - **COVID drawdowns (Feb–Mar 2020):** BXM −30.3%, BXMD −32.3%, PUT −28.9%, SPX −33.9%.
- **Calendar-year returns 2020–2026 (computed, %):**

| Year | BXM | BXMD | PUT | SPX (price) |
|---|---|---|---|---|
| 2020 | −2.75 | 6.18 | 2.13 | 16.26 |
| 2021 | 20.47 | 22.18 | 21.79 | 26.89 |
| 2022 | −11.37 | −16.14 | −7.66 | −19.44 |
| 2023 | 11.82 | 19.78 | 14.32 | 24.23 |
| 2024 | 20.12 | 23.79 | 17.84 | 23.31 |
| 2025 | 8.91 | 12.14 | 9.19 | 16.39 |
| 2026 to 30 Oct | 10.72 | 11.21 | 10.36 | 10.73 |

  Source: computed from [Cboe daily histories](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/PUT_History.csv)
- **Cboe's own published statements:**
  - **2019 post (17 Jan 2019), over 32.5 years:** PUT, CMBO, BXMD and BXM all had higher Sharpe and Sortino ratios than the S&P 500, MSCI EAFE, S&P GSCI and the PPUT protective-put index. BXMD's cumulative return since mid-1986 was 2,265%, 13% more than the S&P 500. 2018 aggregate premiums were 16.6% for PUT and 35.6% for weekly WPUT. Cboe attributes the outperformance to the implied-volatility risk premium. — [Cboe](https://www.cboe.com/insights/posts/key-cboe-benchmark-indexes-using-spx-options-offer-strong-risk-adjusted-returns/)
  - **2021 post (Matt Moran, 20 Jul 2021), over about 35 years:**
    - All four option-writing indexes had lower volatility and shallower drawdowns than the comparison indexes, and betas of 0.57–0.82 to the S&P 500.
    - Their annualized returns were below the S&P 500's.
    - Only BXMD, PUT and CMBO, not BXM, still had higher Sharpe and Sortino ratios than the five comparison indexes.
    - Since May 2006 BXM has collected an average gross premium of 1.7% a month (2% out-of-the-money BXY: 0.9%).
    - [Cboe](https://www.cboe.com/insights/posts/benchmark-indices-series-income-generation-and-smoother-returns-with-cboes-bxm-bxmd-put-and-cmbo-indices)
- **Corroboration of the earlier notes' unverified excerpt:** that excerpt gave BXM since June 1986 at about 8.5% against 11.1% for the S&P 500 total return, volatility 10.7% against 15.2%, and maximum drawdown −35.8% against −50.9%. My month-end drawdown for BXM (since 2002) reproduces −35.8% exactly, and my monthly volatility (10.6%) is close to 10.7%, which suggests Cboe computes those statistics on month-end data. — computed from [Cboe BXM history](https://cdn-api.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv)

### Inferences
- **Return gap vs the S&P 500:** BXM and PUT are total-return indexes (dividends and T-bill interest included). Against the S&P 500 *total* return, their shortfall since 2007 is roughly the dividend yield wider than the 1.6–2.8 points a year shown against the price index. Over 2010–2019 and 2020–2026 the gap against the price index alone widened to about 3.7–5.4 points a year for BXM and PUT (1.4–2.5 for BXMD), because option writing caps upside in strong bull markets.
- **What option writing delivers:** an equity substitute with about 70% of the volatility and drawdowns about 10–20 points shallower, not a free premium. BXMD, which sells out-of-the-money 30-delta calls, has captured the most return. The at-the-money BXM has been weakest since 2002 and lost its Sharpe edge by 2021 on Cboe's own measure.
- **Payoff shape in 2020–2026:** the pattern matches a short-put payoff. The indexes lost less in grinding bear markets (2022) and lagged in V-shaped recoveries (2020), which matters for retail investors switching into covered-call ETFs after selloffs.

### Gaps
- Cboe's monthly BXM and PUT series from 1986 (pre-2002 BXM and pre-2007 PUT), an official S&P 500 total-return comparison on the same data, and T-bill series for proper Sharpe ratios were not obtained.
- Cboe's chart-based tables in its posts and the Wilshire, Callan and Ibbotson studies were not read.

## 7. Overfitting and ML: the Quantopian R², and critiques of Kelly, Malamud & Zhou's "Virtue of Complexity"

### Takeaway
- **Quantopian study:** Wiecki, Campbell, Lent & Stauth ("All That Glitters Is Not Gold", March 2016) studied 888 strategies.
  - Backtest Sharpe ratios explained only about 1–2% of out-of-sample Sharpe variation (R² 0.01–0.02; abstract: R² < 0.025).
  - Volatility (R² 0.67) and maximum drawdown (R² 0.34) were far more persistent.
  - A nonlinear ML model on many backtest features reached R² = 0.17.
- **Kelly-Malamud-Zhou (KMZ):** their market-timing result has drawn several critiques.
  - **Nagel (NBER w34104, Aug 2025):** with P ≫ T and 12-month windows, the random-feature forecast mechanically becomes a volatility-timed momentum rule rather than learning a signal.
  - **Buncic:** the result depends on a zero-intercept restriction and an unusual performance-aggregation scheme.
  - **Guo, Huang, Li & Yu (arXiv, Aug 2026):** neither ridgeless nor ridge models beat the historical mean.
  - **Kılıç (Fed FEDS, June 2026):** in FX, Sharpe ratios near 0.40 collapse once an intercept is added.
  - **Response:** Kelly & Malamud (AQR, July 2025) say these challenges have "little bearing" on KMZ.

### Cited Findings
#### Wiecki et al., Quantopian
- **CXO Advisory summary (2 Jun 2016) of the March 2016 paper:**
  - Sample: 888 strategies after screening. In-sample from 2010 to deployment between January and June 2015; out-of-sample June 2015–February 2016 (at least six months).
  - **Sharpe:** in-sample to out-of-sample R² of 0.01–0.02. Sharpe and Sortino were the most predictable return-based metrics but still very weak, and the last in-sample year predicted better than the full in-sample period.
  - **Other metrics:** average returns had a slightly negative correlation. Information ratio, alpha and Calmar had no predictability. Annual volatility had R² 0.67 and maximum drawdown R² 0.34.
  - **Nonlinear ML on many in-sample features:** out-of-sample Sharpe R² 0.17.
  - **Overfitting:** more backtest days produced larger in-sample/out-of-sample gaps.
  - **Portfolios:** the top 10 ML-picked strategies had an out-of-sample Sharpe of 1.8, beating about 99% of random 10-strategy portfolios and the 10 highest in-sample-Sharpe strategies (0.7).
  - **CXO's caveats:** a short, low-volatility test period and costly daily rebalancing.
  - [CXO Advisory](https://www.cxoadvisory.com/big-ideas/in-sample-vs-out-of-sample-performance-of-888-trading-strategies)
- **Quantpedia summary (4 May 2016), quoting the abstract:**
  - Sharpe and similar metrics "offer little value in predicting out of sample performance (R² < 0.025)".
  - Volatility and maximum drawdown have "significant predictive value".
  - ML on hold-out data reached R² = 0.17.
  - More backtesting correlated with a larger gap.
  - It quotes an ML portfolio Sharpe of 1.2, which conflicts with CXO's 1.8 (possibly a different portfolio construction).
  - [Quantpedia](https://quantpedia.com/quantopians-academic-paper-about-in-vs-out-of-sample-performance-of-trading-alg/)
- The initial sample was 7,152 algorithms (search excerpt of the abstract). — [paper copy](https://c.mql5.com/forextsd/forum/208/All%20that%20Glitters%20Is%20Not%20Gold%20-%20Comparing%20Backtest%20and%20Out-of-Sample%20Performance%20on%20a%20Large%20Cohort%20o.pdf)

#### KMZ and its critiques
- **Original claim:** KMZ, *Journal of Finance* 79(1), 459–503 (2024), report that out-of-sample R² and portfolio Sharpe ratios generally rise with model parameterization, even with minimal regularization (search excerpt). — [SFI](https://www.sfi.ch/en/publications/the-virtue-of-complexity-in-return-prediction); [NBER w30217](https://www.nber.org/papers/w30217)
- **Nagel, "Seemingly Virtuous Complexity in Return Prediction" (NBER w34104 and BFI WP 2025-104, August 2025):**
  - **Setup examined:** KMZ's headline uses P = 12,000 random Fourier features built from K = 15 Welch-Goyal predictors plus lagged returns, with T = 12-month rolling windows and ridgeless regression.
  - **Mechanism:** when P ≫ K, random-feature dot products converge to Gaussian kernels. The forecast therefore becomes a similarity-weighted average of the 12 training returns. Because predictors are persistent, recent months get the most weight (momentum). Because similarity falls when predictor volatility rises, the result is "a volatility-timed momentum strategy".
  - **Benchmark test:** a simple linearly declining 12-month momentum rule scaled by inverse predictor volatility reproduces the positions and "captures most of the abnormal returns". It de-risks before recessions only because predictor volatility rises.
  - **Placebo:** on artificial data with return reversals (an added MA(2) component), the method still builds the same momentum strategy, which then performs poorly. Conclusion: the strong record "stems not from its ability to extract predictive signals" but from momentum having worked historically.
  - [NBER](https://www.nber.org/papers/w34104); [BFI working paper PDF](https://bfi.uchicago.edu/wp-content/uploads/2025/08/BFI_WP_2025-104.pdf)
- **Buncic, "Simplified: A Closer Look at the Virtue of Complexity in Return Prediction" (May 2025 revision; presented at the European Finance Association):**
  - Uses KMZ's own data, models and evaluation methods. — [CXO Advisory, 12 Jun 2025](https://www.cxoadvisory.com/investing-expertise/complexity-or-simplicity/)
  - In his own post (search excerpt), Buncic says KMZ's empirical results hold only under "a zero-intercept restriction" and "an unconventional performance aggregation scheme". He adds that linear models are "grossly misrepresented" and "perform better when evaluated fairly". — [Buncic, LinkedIn (search excerpt)](https://se.linkedin.com/in/daniel-buncic)
- **Guo, Huang, Li & Yu, "(Mis)Understanding Benign Overfitting in Equity Return Prediction" (arXiv 2608.23761, 24 Aug 2026):** ridgeless prediction risk shows double descent, and optimal ridge beats ridgeless only negligibly at high parameter-to-observation ratios. "Neither model beats a simple historical average benchmark". Standard equity predictors appear to lack true forecasting power, so both models converge to the historical mean. — [arXiv](https://arxiv.org/abs/2608.23761)
- **Kılıç, "Virtue or Mirage? Complexity in Exchange Rate Prediction" (Fed FEDS 2025-089r1, June 2026):**
  - Ridge with random Fourier features beats OLS at short windows but beats the random walk for only a few currencies.
  - Taylor-rule timing Sharpe ratios near 0.40 "collapse once an intercept is included, exposing drift capture".
  - The cross-currency mean out-of-sample R² is "bounded above by zero everywhere".
  - [Federal Reserve FEDS](https://www.federalreserve.gov/econres/feds/files/2025089r1pap.pdf)
- **Response, Kelly & Malamud, "Understanding the Virtue of Complexity" (AQR working paper, 10 Jul 2025):** recent challenges "have little bearing" on KMZ's theory or evidence. The paper discusses learning in small samples, nominal versus effective complexity, implicit regularization and limits to learning, and introduces a "virtue of ensemble complexity". It names no critics on its landing page, and the authors have a commercial interest. It predates Nagel's NBER posting (August 2025; a June 2025 conference draft existed, per a search excerpt), Guo et al. and Kılıç, so it cannot address those papers' final versions. — [AQR](https://www.aqr.com/insights/research/working-paper/understanding-the-virtue-of-complexity)

### Inferences
- **Quantopian lesson:** select on risk (volatility and drawdown persist) and on robustness features, not on backtest Sharpe, which is mostly noise. Haircut any reported Sharpe heavily. This reinforces the earlier notes' 50–75% haircut rule.
- **Two convergent critiques of KMZ:**
  - Mechanical: Nagel shows the kernel collapses to volatility-timed momentum.
  - Specification: Buncic and Kılıç show that intercept and aggregation choices drive the results.
  - Guo et al. add an independent null result. Individuals should not read "complexity" papers as support for fitting large ML models to a few hundred monthly observations. Any edge found should be benchmarked against simple momentum and volatility-timing rules with an intercept.

### Gaps
- Buncic's paper itself (SSRN) could not be opened, so his arguments rest on his own summary.
- Kelly and Malamud's detailed rebuttal of Nagel specifically was not read.
- Wiecki et al.'s full paper text (the source of the 1.2 vs 1.8 discrepancy) and its journal publication details were not verified.
