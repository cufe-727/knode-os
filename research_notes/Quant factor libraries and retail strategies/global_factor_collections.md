# Global factor collections, anomaly libraries, alpha libraries and core references (status as of 2026-10-31)

Scope: global, US and developed-market resources for a researcher who already knows *101 Formulaic Alphas*, Alpha191 and *151 Trading Strategies*. China-only collections and Qlib's Alpha158/Alpha360 are covered by other researchers. The session's web-search budget ran out before every item could be checked, so anything not confirmed in a source this session is listed under **Gaps** rather than stated as fact. Nothing was downloaded.

---

## 1. Academic anomaly collections and open replication datasets

### Takeaway
Open replication has settled on three free libraries that are still being updated. Chen–Zimmermann's **Open Source Asset Pricing** covers the US with 200+ predictors; its v2.1.0 release (October 2026) moved to CRSP CIZ and ships through Hugging Face. **JKP Global Factor Data** has 153 factors in 93 countries and 13 themes, with data through December 2025. Hou–Xue–Zhang's **global-q** library has the q and q5 factors plus anomaly testing portfolios, also through December 2025. The Kenneth French and AQR libraries (updated monthly) remain the benchmark factor sources. Green–Hand–Zhang (94 characteristics), Gu–Kelly–Xiu (920 covariates), McLean–Pontiff (97 predictors) and Harvey–Liu–Zhu (316 factors) are now mostly fixed reference sets.

### Cited Findings

#### Hou, Xue & Zhang, "Replicating Anomalies" (RFS 2020) and the global-q data library
- Publication: *Review of Financial Studies* 33(5), 2020, pp. 2019–2133. — [IDEAS/RePEc](https://ideas.repec.org/a/oup/rfinst/v33y2020i5p2019-2133..html)
- The library holds **452 anomalies** (447 in earlier drafts). Microcaps were controlled with NYSE breakpoints and value-weighted returns. On that basis **65% cannot clear the single-test hurdle**, including 96% of the trading-frictions category. A multiple-test hurdle of 2.78 raises the failure rate to **82%**, and even the anomalies that replicate have much smaller magnitudes than first reported. — [RFS abstract](https://academic.oup.com/rfs/article-abstract/33/5/2019/5236964); [CXO summary](https://www.cxoadvisory.com/big-ideas/most-stock-anomalies-fake-news/)
- Latest update: on 7/30/2026 global-q.org says "We have updated our factors and testing portfolios through December 2025". The site says it has released "most of our data from Hou, Xue, and Zhang (2020)". It also claims the q-factor model "fully subsumes the Fama-French (2018) 6-factor model in head-to-head factor spanning tests" (the authors' own claim). — [global-q.org](https://global-q.org/index.html)
- Factors page:
  - The q5 set is R_F, R_MKT, R_ME, R_IA, R_ROE and R_EG (expected growth).
  - Frequencies are daily, weekly (Friday–Friday), weekly (Wednesday–Wednesday), monthly, quarterly and annual.
  - The data cover the "1967-2025 sample". The original q-factors started in January 1972 and were extended back to January 1967 in "Which factors?" (2019).
  - Benchmark portfolios are 18 (2×3×3 on size, I/A and ROE) and 6 (2×3 on size and expected growth).
  - The technical document is dated July 2026.
  — [global-q factors](https://global-q.org/factors.html)
- Testing portfolios include expected-growth deciles and 3×5 size × expected-growth portfolios. — [global-q.org](https://global-q.org/index.html)
- The third-party `getfactormodels` package downloads q, q5, global-q portfolio sorts and individual anomaly portfolios (e.g., `abr_1`, `sue_6`). — [getfactormodels README](https://github.com/x512/getfactormodels)

#### Chen & Zimmermann, Open Source Asset Pricing (OSAP)
- Paper: "Open Source Cross-Sectional Asset Pricing," *Critical Finance Review* 11(2), 2022, pp. 207–264; also Fed FEDS working paper 2021-037. — [CFR/Emerald](https://www.emerald.com/cfr/article/11/2/207/1324917/Open-Source-Cross-Sectional-Asset-Pricing); [Federal Reserve](https://www.federalreserve.gov/econres/feds/open-source-cross-sectional-asset-pricing.htm)
- Results: the authors start from **319 characteristics** in earlier meta-studies. For the **161 "clear predictors"**, 98% of their reproduced long-short portfolios have t > 1.96. The remaining 114 were insignificant in the original papers or are modifications created by HXZ. — [CFR paper PDF](https://cfr.ivo-welch.info/published/papers/chen2021open.pdf)
- Regressing reproduced t-stats on the original t-stats gives a slope of 0.90 and an R² of 83%. — [Data.gov catalog](https://catalog.data.gov/dataset/open-source-cross-sectional-asset-pricing)
- Size: "over 200 cross-sectional predictors"; the exact count depends on the release (see Gaps). — [OpenSourceAP.DownloadR manual](https://opensourceap.r-universe.dev/OpenSourceAP.DownloadR/OpenSourceAP.DownloadR.pdf)
- Release history (the website dates are explicit; some GitHub years were inferred):

  | Release | Date | Main change |
  |---|---|---|
  | v1.0.0 | Mar 2022 | Modularisation |
  | v1.1.0 | Apr 2022 | Daily portfolio returns |
  | v1.2.0 | Mar 2023 | 2 new predictors, FF1993 2×3 implementations |
  | v1.3.0 | Aug 2023 | 5 new predictors |
  | v1.4.0 | 2024-08-22 | Portfolios through end-2023 |
  | v1.4.1 | Oct 2024 | Fixed look-ahead bias in AnnouncementReturn |
  | v2.0.0 | 2025-10-22 | Signals rewritten from Stata to Python |
  | v2.1.0 | 2026-10-27/28 | CRSP v2 (CIZ) migration; parquet on Hugging Face; SIC codes differ from legacy CRSP; fixes to PayoutYield, High52, IntanBM |

  — [GitHub releases](https://github.com/OpenSourceAP/CrossSection/releases); [openassetpricing.com](https://www.openassetpricing.com/)
- Access: Hugging Face dataset `OpenSourceAP/CrossSection` (parquet, licence tag CC-BY-4.0), with release branches such as `Data-Release-2026.10`. Also the Python package `openassetpricing` and the R package `OpenSourceAP.DownloadR`. — [Hugging Face](https://huggingface.co/datasets/OpenSourceAP/CrossSection); [FAQ](https://www.openassetpricing.com/faq/); [README](https://github.com/OpenSourceAP/CrossSection)
- Rebuilding from code:
  - Needs WRDS credentials (CRSP v2/CIZ, OptionMetrics, 13F) and a FRED API key.
  - Seven OptionMetrics signals come from a 2023 Google Drive release.
  - A full portfolio build took about 3.6 hours on a Mac with 3 workers.
  — [README](https://github.com/OpenSourceAP/CrossSection)
- Contents:
  - Signals are dated at month-end `yyyymm`.
  - "Baseline" portfolios follow each original paper's split; standardized quantiles and FF1993-style 2×3 portfolios are also provided.
  - Signals fall into eight categories: 13F, Accounting, Analyst, Event, Options, Other, Price, Trading.
  — [FAQ](https://www.openassetpricing.com/faq/)

#### Jensen, Kelly & Pedersen (JKP), "Is There a Replication Crisis in Finance?" and the JKP Global Factor Data
- Paper: *Journal of Finance* 78(5), 2023; NBER WP 28432 (Feb 2021). — [ReplicationCrisis repo](https://github.com/bkelly-lab/ReplicationCrisis); [NBER WP](https://nber.org/system/files/working_papers/w28432/w28432.pdf)
- Coverage: **153 factors, 93 countries, 13 themes**. The paper concludes that most factors replicate, survive joint modelling of all factors and hold up out of sample. — [NBER WP](https://nber.org/system/files/working_papers/w28432/w28432.pdf); [jkpfactors.com](https://jkpfactors.com/)
- Replication rate was above 75% in 10 of the 13 themes; seasonality, leverage and size were the exceptions. The authors use HXZ's 35% replication rate as the comparison baseline. — [Alpha Architect](https://alphaarchitect.com/is-there-a-replication-crisis-in-finance/)
- Secondary sources disagree on the headline replication rate: figures of 82.4% (global), 55.6% (a US main sample) and 84.9% all appear. — [Alpha Architect](https://alphaarchitect.com/factors-are-global-respectable-and-repeatable/); [CXO](https://www.cxoadvisory.com/big-ideas/re-examining-equity-factor-research-replicability/) (check the published paper before quoting one number)
- Data status on jkpfactors.com:
  - Apr 2026: "Data Updated Through December 2025" (factor returns and theme clusters), plus new download types beyond long-short factor returns.
  - Oct 2026: every Common Task Framework (CTF) leaderboard model now has its own page.
  - Data are licensed CC BY-NC 4.0; code is MIT.
  — [jkpfactors.com](https://jkpfactors.com/)
- Code: the SAS/R repo `ReplicationCrisis` says "THIS REPO IS NO LONGER MAINTAINED"; the Python successor is `bkelly-lab/jkp-data`. Stock-level returns and characteristics are on WRDS "Global Factor Data". Factor returns with portfolios, market and industry returns are on Dropbox and jkpfactors.com. — [ReplicationCrisis](https://github.com/bkelly-lab/ReplicationCrisis)
- `jkp-data`:
  - Requires a valid WRDS subscription and ships no CRSP, Compustat or IBES data.
  - Default end date 2025-12-31; outputs Parquet or CSV.
  - The authors' run used 450 GB RAM and 128 cores and took about 6 hours.
  — [jkp-data](https://github.com/bkelly-lab/jkp-data)
- Wrappers: the R `tidyfinance::download_data_jkp` (153 factors, 13 themes) and the PyPI package `globalfactordata` (93 countries). — [tidyfinance doc](https://rdrr.io/cran/tidyfinance/man/download_data_jkp.html); [PyPI globalfactordata](https://pypi.org/project/globalfactordata/)
- Common Task Framework: Hoberg, Jensen, Kelly & Pedersen (2025) propose a CTF for financial economics, meaning a shared dataset, a fixed metric and a public leaderboard for evaluating asset-pricing models and pricing kernels. A community package, `eapctf`, reproduces the leaderboard Sharpe ratio to within 0.5% using a 10% volatility target. — [Pedersen research page](https://www.lhpedersen.com/research); [PyPI eapctf](https://pypi.org/project/eapctf/)

#### Green, Hand & Zhang (RFS 2017)
- Paper: "The Characteristics that Provide Independent Information about Average U.S. Monthly Stock Returns," *RFS* 30(12), pp. 4389–4436.
- Method: 94 characteristics tested jointly in Fama–MacBeth regressions, without overweighting microcaps.
- Results: about 12 characteristics are independent predictors for non-microcaps over 1980–2014, but only 2 after 2003, when non-microcap hedge returns became statistically zero.
— [IDEAS](https://ideas.repec.org/a/oup/rfinst/v30y2017i12p4389-4436..html); [SUFE summary](https://academicnewsletter.sufe.edu.cn/info/353335)

#### Gu, Kelly & Xiu, "Empirical Asset Pricing via Machine Learning" (RFS 2020)
- Publication: *RFS* 33(5), pp. 2223–2273. — [SSRN](https://papers.ssrn.com/abstract=3159577)
- Covariates: 94 stock characteristics (61 annual, 13 quarterly, 20 monthly) and 74 two-digit SIC industry dummies. There are also 8 Welch–Goyal macro predictors: dp, ep, bm, ntis, tbl, tms, dfy and svar. Characteristics are interacted with the macro predictors, giving 94×(8+1)+74 = **920 covariates**.
- Sample and data: the sample starts in March 1957 and the published sample ends in December 2016. The `datashare.zip` characteristics file on Xiu's site extends to 2021.
— [KU replication guide](https://aef-course.ku.dk/additional-material/ml-data-preparation-for-python.html); [data file](https://dachxiu.chicagobooth.edu/download/datashare.zip)

#### McLean & Pontiff, "Does Academic Research Destroy Stock Return Predictability?" (JF 2016)
- **97 predictors from 79 studies**.
- Long-short returns fall **26% out of sample** (an upper bound on statistical bias) and **58% after publication**. The authors attribute the 32-point difference to publication-informed trading.
— [paper PDF](https://www.gwern.net/doc/economics/2016-mclean.pdf); [CXO](https://www.cxoadvisory.com/big-ideas/effects-of-market-adaptation)

#### Harvey, Liu & Zhu (RFS 2016) and Harvey & Liu's "Census of the Factor Zoo" (2019)
- HLZ catalogue **316 factors** from 313 published papers (plus working papers) and propose a t > 3.0 hurdle. Published in *RFS* 29(1), pp. 5–68. — [NBER w20592](https://nber.org/papers/w20592); [Marginal Revolution](https://marginalrevolution.com/marginalrevolution/2014/10/and-the-cross-section-of-expected-returns.html)
- The census update lists **382 factors** published in top journals through January 2019. The often-quoted "400+" is a rounding of that figure. — [SSRN 3341728](https://papers.ssrn.com/abstract=3341728); [CXO](https://www.cxoadvisory.com/big-ideas/equity-factor-census/)

#### Kenneth French Data Library
- Currency: the latest monthly performance table is labelled **September 2026**.
- CRSP change: CRSP discontinued its legacy FIZ files after December 2024, and from the **January 2025 release** US returns use CRSP CIZ (Flat File 2.0). Monthly returns are now compounded from daily returns with dividends reinvested on ex-dates. The FIZ-based history is archived separately.
- US files:
  - FF 3-factor (monthly, weekly, daily), FF 5-factor 2×3 (monthly, daily), momentum, short-term reversal and long-term reversal.
  - Industry portfolios with 5, 10, 12, 17, 30, 38, 48 and 49 industries.
- International files:
  - Country and index portfolios sorted on B/M, E/P, CE/P and D/P, built from MSCI data for 1975–2006 and Bloomberg data from 2007.
  - Developed-market 3- and 5-factor and momentum sets for Developed, Developed ex US, Europe, Japan, Asia Pacific ex Japan and North America.
  - Emerging-market 5-factor and momentum sets (monthly only).
— [Data Library](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html)
- Developed-market details: returns start **July 1990**, in USD. "Big" stocks are the top 90% of each region's June market cap. Momentum uses returns from t−12 to t−2 with 30/70 breakpoints among big stocks. — [Developed factors page](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/Data_Library/f-f_developed.html)

#### AQR data sets (free download; site Terms of Use apply, no dataset-specific licence shown)

| Dataset | Last updated | Notes |
|---|---|---|
| AQR Momentum Indices | Sep 30, 2026 | |
| QMJ factors (monthly, daily), 10 quality-sorted portfolios, 6 size×quality portfolios | Aug 31, 2026 | |
| Value and Momentum Everywhere factors and portfolios | Aug 31, 2026 | |
| BAB equity factors (monthly, daily) | Aug 31, 2026 | US plus 23 international markets |
| HML Devil factors | Aug 31, 2026 | Titled daily, but described as updated monthly |
| Time Series Momentum factors, monthly | May 29, 2026 | One search snippet showed Jul 31, 2026 |
| "How Do Factor Premia Vary Over Time? A Century of Evidence" factor data | Feb 27, 2026 | |
| Commodities for the Long Run index data | May 30, 2025 | |
| Original-paper data for BAB, TSMOM, VME and the preliminary Credit Risk Premium | Feb 27, 2018 | Frozen |
| Original-paper data for Commodities | Oct 3, 2018 | Frozen |
| Original-paper data for the ESG-Efficient Frontier | Oct 29, 2020 | Frozen |

— [AQR datasets p.1](https://www.aqr.com/Insights/Datasets); [p.2](https://www.aqr.com/Insights/Datasets?&page=2)

- The TSMOM factors are monthly excess returns on 58 liquid futures and forwards (equity indices, currencies, commodities, government bonds), using a 12-month lookback and a 1-month hold, from January 1985. They extend Moskowitz, Ooi & Pedersen (2012). — [AQR TSMOM](https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Factors-Monthly)

#### Factor-zoo dimension-reduction studies (methods and factor sets rather than maintained data)
- **Kozak, Nagel & Santosh, "Shrinking the Cross-Section"**: *JFE* 135(2), pp. 271–292 (2020); NBER WP 24070 (2017). It won the 2020 JFE Fama/DFA prize. — [NBER](https://nber.org/papers/w24070); [RePEc](https://ideas.repec.org/f/pko970.html); [Nagel blog](https://voices.uchicago.edu/stefannagel/2021/06/04/fama-dfa-prize)
- **Feng, Giglio & Xiu, "Taming the Factor Zoo: A Test of New Factors"**: *JF* 75(3), June 2020 (DOI 10.1111/jofi.12883). The authors assemble a **150-factor library** and combine double-selection LASSO with two-pass regressions; only a small number of factors come out significant. — [NBER w25481](https://www.nber.org/papers/w25481.pdf); [supplement](https://dachxiu.chicagobooth.edu/download/ZOO_supp.pdf); [AQR Insight Award 2018](https://www.aqr.com/About-Us/AQR-Insight-Award/2018/Taming-the-Factor-Zoo)
- **Bryzgalova, Huang & Julliard, "Bayesian Solutions for the Factor Zoo: We Just Ran Two Quadrillion Models"**: *JF* 78(1), 2023. They test **51 factors**, giving **2.25 quadrillion** possible models. The Bayesian model-averaged SDF beats both observable-factor models and KNS, and only a handful of factors are robust; a four-factor model of those beats canonical models. — [LSE PDF](https://personal.lse.ac.uk/julliard/papers/BSftFT.pdf); [LBS](https://lbsresearch.london.edu/id/eprint/2743)
- **Bryzgalova, Pelger & Zhu, "Forest through the Trees: Building Cross-Sections of Stock Returns"**: *JF* 80(5), Oct 2025, pp. 2447–2506. Decision trees ("AP-Trees") build long-only, value-weighted test portfolios. These deliver up to 3× higher out-of-sample Sharpe ratios and alphas than dozens or hundreds of single and double sorts and machine-learning portfolios. The paper argues that decile and long-short anomaly portfolios set too low a hurdle. — [RePEc](https://ideas.repec.org/a/bla/jfinan/v80y2025i5p2447-2506.html); [AFA issue](https://afajof.org/issue/volume-80-issue-5/)
- **Swade, Hanauer, Lohre & Blitz, "Factor Zoo (.zip)"**: *Journal of Portfolio Management*, pp. 11–31, DOI 10.3905/jpm.2023.1.561. About **15 factors span the whole zoo**; the factor styles persist while the representative factor for each style changes. The selection holds in global data. — [SSRN 4605976](https://papers.ssrn.com/abstract=4605976); [Robeco](https://www.robeco.com/en-za/insights/2023/11/honey-we-shrunk-the-factor-zoo)
  - The volume is reported inconsistently: 50(3) (Quantitative Special Issue 2024) on SSRN and TUM, versus "Volume 55" at Lancaster. — [TUM](https://mediatum.ub.tum.de/1775873); [Lancaster](https://www.research.lancs.ac.uk/portal/en/publications/factor-zoo-zip(770555e5-6f92-4333-b5f4-655d7fdf3da9)/export.html)

#### International and long-history replications
- **Jacobs & Müller, "Anomalies Across the Globe: Once Public, No Longer Existent?"**: *JFE* 135 (2020), pp. 213–230. Covers **241 anomalies in 39 markets**: about 59,000 firms, 7,072 anomaly–country pairs and 2.14 million anomaly-months. **Only the US** shows a significant post-publication decline. — [Univ. Duisburg-Essen](https://fin.wiwi.uni-due.de/forschung/publikationen/anomalies-across-the-globe-once-public-no-longer-existent-14591/); [SUERF slides](https://www.suerf.org/wp-content/uploads/2019/12/l_6c524f9d5d7027454a783c841250ba71_26413_suerf.pdf)
- **Baltussen, Swinkels & van Vliet, "Global Factor Premiums"**: *JFE* 142(3), Dec 2021, pp. 1128–1154. Covers **24 premiums** across equity, bond, commodity and currency markets over **1800–2016 (217 years)**. Most premiums persist out of sample with limited decay and are largely unrelated to market, downside or macro risk. Raw data are on the Erasmus repository. — [SSRN](https://papers.ssrn.com/abstract=3325720); [EUR data](https://datarepository.eur.nl/articles/dataset/Global_Factor_Premiums_dataset_with_raw_data_series/14237024)

#### Data-mining benchmark dataset
- **Chen, Lopez-Lira & Zimmermann, "Does Peer-Reviewed Research Help Predict Stock Returns?"** (arXiv 2212.10317; v7 late Dec 2025). The authors mine **~29,000 accounting ratios** and match them to about 200 published predictors. The strategies and code are on GitHub (`chenandrewy/flex-mining`). — [arXiv](https://arxiv.org/abs/2212.10317); [CFR Cologne WP](https://www.cfr-cologne.de/download/workingpaper/cfr-24-02.pdf)

### Inferences
- Which library to use:

  | Need | Resource | Data currency (as of 2026-10-31) | Access |
  |---|---|---|---|
  | US anomaly signals and portfolios, free, closest to the original papers | OSAP | Oct 2026 release (v2.1.0, CIZ) | Free (HF/pip/R); rebuild needs WRDS |
  | International factor returns | JKP | Data to Dec 2025 | Free factors (CC BY-NC); stock panel via WRDS |
  | Microcap-robust anomaly testing and q/q5 benchmarks | global-q | Data to Dec 2025, released Jul 2026 | Free |
  | Canonical FF factors | French | Monthly; table to Sep 2026 | Free |
  | Style factors (BAB, QMJ, HML Devil, VME, TSMOM) | AQR | Mostly Aug 2026; TSMOM May 2026 | Free |

- HXZ report 65% failure while OSAP and JKP report high replication. The main differences are method (NYSE breakpoints with value weights, versus following each original paper's construction) and the definition of "replicate". The collections answer different questions, so they don't contradict each other.
- Both the French library (January 2025) and OSAP (October 2026) moved US returns from CRSP FIZ to CIZ. Historical series and SIC-based signals therefore shift between vintages. Pin and record the vintage, e.g., the OSAP branch `Data-Release-2026.10`.
- These are effectively static snapshots, useful as benchmarks but not as live data: GHZ (to 2014), GKX (data extended to 2021), McLean–Pontiff, HLZ and the AQR original-paper files.
- Of the global resources, JKP is the obvious choice for non-US work; it is the only maintained, free, characteristic-level, multi-country set found.

### Gaps
- **OSAP counts for the 2026.10 release:** not confirmed. Search snippets attributed vintage-specific numbers that could not be pinned to a source: 205–207 predictors around 2022; 194 predictors with long-short returns at end-2023 versus 206 at end-2020–2022 in the October 2024 documentation; 183 after a t-filter in one study. The placebo count is also unconfirmed, as is whether CRSP- and Compustat-derived signals are excluded from the public signal files for licensing reasons.
- **JKP characteristic count:** third-party papers describe "more than 400" stock characteristics in the WRDS Global Factor Data, but no primary WRDS or JKP page confirmed it. The list of countries (including whether and from when China is covered) was not checked.
- **KNS data:** the commonly cited inputs (50 anomaly characteristics, 80 WRDS financial ratios) and Serhiy Kozak's data page (serhiykozak.com/data returned 404) could not be verified.
- **GHZ code:** whether the SAS code is still hosted and its current status, and the 330-signal count of the 2013 "supraview" paper, were not checked.
- **French emerging markets:** the start date wasn't on the main page and wasn't fetched.
- **global-q:** whether it offers international q-factors wasn't stated.
- **AQR:** the dataset list may be incomplete. Pages 1–2 showed about 20 datasets; others such as a monthly HML Devil series may exist.

---

## 2. Standard factor models that define widely used factor sets, and where free factor returns are published

### Takeaway
Almost every canonical model can be downloaded free:
- **French:** FF3, FF5 and momentum (monthly, CIZ-based since January 2025).
- **global-q:** q and q5 (to December 2025).
- **AQR:** BAB, QMJ, HML Devil and VME (to August 2026) and TSMOM (May 2026).
- **Lin Sun's site:** the Daniel–Hirshleifer–Sun FIN/PEAD factors (to December 2023).
- **Stambaugh's site:** the Stambaugh–Yuan mispricing factors, frozen at December 2016.

The Barillas–Shanken six-factor model is built by combining those sources. JKP adds 153 factor series per country.

### Cited Findings
- **Fama–French and Carhart:** FF3, FF5 (2×3), momentum, short- and long-term reversal and industry portfolios are on the French Data Library, US and international, monthly and daily (see §1). — [French Data Library](https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/data_library.html)
  - `getfactormodels` builds FF 3/5/6 and the Carhart 4-factor model from the French library. — [getfactormodels](https://github.com/x512/getfactormodels)
- **q-factor and q5 (Hou–Xue–Zhang; Hou–Mo–Xue–Zhang):** MKT, ME, IA, ROE, plus EG for q5. Six frequencies, 1967–2025, updated 7/30/2026. — [global-q factors](https://global-q.org/factors.html)
- **Stambaugh–Yuan mispricing factors (MGMT, PERF):** each factor averages rankings within one of two clusters of the 11 anomalies whose returns co-move most. Stambaugh's page lists the data as **1/1963–12/2016** (monthly and daily factors plus the 11 anomaly returns). The tidyfinance wrapper also ends in December 2016, so the series appears not to have been updated. — [Stambaugh data](https://finance.wharton.upenn.edu/~stambaug/); [tidyfinance NEWS](https://archive.linux.duke.edu/cran/web/packages/tidyfinance/news/news.html); [Penn repository](https://repository.upenn.edu/fnce_papers/163)
- **Daniel–Hirshleifer–Sun behavioural factors (FIN for long horizons, PEAD for short horizons):** from "Short- and Long-Horizon Behavioral Factors," *RFS* 33(4), 2020, pp. 1673–1736. Lin Sun's site has monthly and daily returns for **1972:07–2023:12**. A construction note is hosted at ABFER. — [Lin Sun](https://sites.google.com/view/linsunhome); [ABFER note](https://www.abfer.org/component/edocman/the-fin-and-pead-factors-motivation-construction-and-availability)
- **Barillas–Shanken:**
  - Method: a Bayesian model-comparison test computed in closed form from the F-statistic (NBER WP 21771, Dec 2015).
  - Findings: HML is redundant while UMD is crucial. Five- and six-factor models that include momentum and monthly-updated value and profitability factors beat the FF and HXZ models.
  - The six-factor model is MKT, SMB and UMD (from FF6), IA and ROE (from HXZ), and HMLm (Asness–Frazzini's monthly-updated value).
  — [NBER WP](https://www.nber.org/papers/w21771.pdf); [SSRN](https://papers.ssrn.com/abstract=2700000); [arXiv 2601.10279 (definition)](https://arxiv.org/pdf/2601.10279)
- **AQR factors:** BAB (Frazzini–Pedersen), QMJ (Asness–Frazzini–Pedersen) and HML Devil (Asness–Frazzini) are on AQR Data Sets. — [getfactormodels](https://github.com/x512/getfactormodels); [AQR datasets](https://www.aqr.com/Insights/Datasets)
  - BAB covers the US plus 23 international markets. — [AQR datasets](https://www.aqr.com/Insights/Datasets)
  - TSMOM (Moskowitz–Ooi–Pedersen) covers 58 instruments from 1985. — [AQR TSMOM](https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Factors-Monthly)
  - The "Century of Evidence" factor data were updated Feb 27, 2026. — [AQR datasets p.2](https://www.aqr.com/Insights/Datasets?&page=2)
- **Other free factor series found by `getfactormodels`:**
  - Pástor–Stambaugh liquidity, from Stambaugh's Liquidity datasets (Wharton).
  - He–Kelly–Manela intermediary capital ratio, from Zhiguo He's site.
  - Conditional CAPM variants.
  - China size and value factors (CH3/CH4), out of scope here.

  The package is AGPL-3.0, installs with `pip install getfactormodels`, and is labelled pre-alpha. — [getfactormodels](https://github.com/x512/getfactormodels)
- **Multi-asset long-history factors:** the 24 Baltussen–Swinkels–van Vliet premiums over 1800–2016 (raw data on the EUR repository). — [EUR data](https://datarepository.eur.nl/articles/dataset/Global_Factor_Premiums_dataset_with_raw_data_series/14237024)

### Inferences
- A practical free factor benchmark kit:
  - French: FF5 plus UMD.
  - global-q: q5.
  - AQR: BAB, QMJ, HML Devil, TSMOM.
  - Lin Sun: DHS (only to 2023).
  - JKP: factor-by-country returns.
  - BS6 = French MKT/SMB/UMD + global-q IA/ROE + AQR HML Devil.
- Stambaugh–Yuan and DHS lag current data (2016 and 2023 respectively). Researchers who need them past those dates must rebuild them, for example from OSAP or JKP characteristics; that is my suggestion, not something the sources describe.
- These sources use different CRSP vintages (French on CIZ; global-q's filing format unknown), so small level differences between "the same" factors from different libraries are expected.

### Gaps
- Bibliographic details not re-verified this session (from memory: *JF* 2018 for Barillas–Shanken; *JFE* 2015 and 2018 for the FF five- and six-factor papers; *JF* 1997 for Carhart).
- The Pástor–Stambaugh liquidity series' last update and Novy-Marx's own factor files were not checked.
- Whether AQR still updates TSMOM every month: the May 2026 stamp is behind the Aug 2026 stamps on other series.

---

## 3. Industry and practitioner alpha libraries and risk-model factor sets

### Takeaway
Commercial risk-model factor sets (MSCI Barra, Axioma/SimCorp, Bloomberg MAC3, Northfield) and alpha-signal libraries (S&P Alpha Signals / Alpha Factor Library, RavenPack) require an institutional licence. For an individual the realistic routes are:
- **WorldQuant BRAIN:** free account; only research consultants can simulate non-US markets.
- **Quantpedia:** about 70 free strategies, with Premium paid.
- **Numerai:** obfuscated features.
- **WRDS:** academic access to RavenPack and to JKP's stock-level data.

Also, MSCI's site no longer names a "USE5". Its current US models are the "USA Equity Factor Model" and the "US Total Market Equity Model".

### Cited Findings

#### WorldQuant BRAIN, *Finding Alphas* and Kakushadze's companion papers
- **Access:**
  - There is no fee to register for BRAIN or to enter the International Quant Championship (IQC).
  - Anyone 18 or older can open an account, but only research consultants can simulate markets outside the US.
  - Alphas are written in BRAIN's "Fast Expression" language by combining data fields with operators.
  — [WorldQuant BRAIN](https://www.worldquant.com/brain); [quantt.co.uk review](https://www.quantt.co.uk/resources/worldquant-brain); [Consultant program](https://platform.worldquantbrain.com/consultant-program)
- **Scale:** the March 17, 2026 WorldQuant release reports **~375,000 users and ~13,000 research consultants**, all eligible to be paid according to the quality of their ideas. — [Business Wire 2026-03-17](https://www.businesswire.com/news/home/20260317214840/en); [syndicated copy](https://www.news-gazette.com/worldquant-s-international-quant-championship-returns-for-its-sixth-year-following-record-global-participation-in/article_bcb8306e-1db5-5293-ab06-38c1cd75b72e.html)
  - Earlier figures conflict: 100,000+ users and 5,000+ consultants (2025), and 20,000+ users and 1,000+ consultants (2022). — [Business Wire 2025](https://www.businesswire.com/news/home/20250318849081/en); [Business Wire 2022](https://www.businesswire.com/news/home/20220801005832/en)
- **Data fields:** a 2024 release quoted in a 2026 review claims **125,000+ data fields**. — [quantt.co.uk review](https://www.quantt.co.uk/resources/worldquant-brain)
- **Consultant tiers:** Gold, Expert, Master and Grandmaster. — [quantt.co.uk review](https://www.quantt.co.uk/resources/worldquant-brain)
- **IQC 2026 (sixth edition):**
  - Stage 1 ran 17 March–18 May 2026, with registration closing 13 May 2026.
  - US$100,000 prize pool; Global Finals in Singapore.
  — [quantt.co.uk](https://www.quantt.co.uk/resources/worldquant-brain); [TARGETjobs listing](https://targetjobs.co.uk/organisations/worldquant-brain/events/iqc-2026-global-research-webinar-series-learn-how-build-quantitative-finance-models-worldquant-brain)
- ***Finding Alphas*, 2nd edition** (Wiley, October 2019; ISBN 9781119571216): edited by Igor Tulchinsky et al. of the WorldQuant Virtual Research Center.
  - It adds about nine chapters: alpha correlation, controlling biases, ETFs, event-driven investing, index alphas, intraday data, intraday trading, machine learning, and futures and forwards.
  - Part IV covers WebSim, BRAIN's predecessor.
  — [O'Reilly](https://www.oreilly.com/library/view/finding-alphas-2nd/9781119571216/); [TUM catalogue](https://search.ub.tum.de/vufind/Record/ZDB-30-ORH-067579930?print=1)
- **Kakushadze & Tulchinsky, "Performance v. Turnover: A Story by 4,000 Alphas"** (*Journal of Investment Strategies* 5(2), 2016, pp. 75–89):
  - Uses about 4,000 real US-equity alphas with holding periods of 0.7–19 days.
  - Cents-per-share scales as C ~ 1/T, where T is turnover.
  - Returns show no significant dependence on turnover and scale with volatility to a power of about 0.8–0.85.
  — [arXiv 1509.08110](https://arxiv.org/pdf/1509.08110)
- **Kakushadze & Yu, "How to Combine a Billion Alphas"** (arXiv 1603.05937): about combining very many faint, short-lived alphas into a "mega-alpha", with style and industry risk-factor approaches as an alternative. — [ar5iv](https://ar5iv.arxiv.org/html/1603.05937)

#### MSCI Barra
- **USE4 (2011):** the first of the "new Barra Equity Models". It added a market factor, a country factor and volatility-regime adjustment; its key features also include an optimization bias adjustment. — [MSCI press release](https://ir.msci.com/static-files/fbb15579-0645-410a-b3c7-c22356940f90); [USE4 fact sheet](https://www.msci.com/documents/10199/242721/Barra_US_Equity_Model_USE4.pdf); [Top1000funds](https://www.top1000funds.com/asset-classes/msci-improves-factor-risk-modelling-for-equities/)
- **US Total Market suite (2015):** the suite was completed around 2015. — [MSCI press release](https://www.msci.com/documents/10199/3df51966-3da5-42b7-acd0-e2a06ef34d59)
- **Current lineup (product page, no model codes):**
  - Global: Global Equity Factor Model (long-term and trading), Global Total Market, Global Investable Markets, Multi-Asset Class Factor Model.
  - US: **USA Equity Factor Model** (long-term and trading), **US Total Market Equity Model** (long-, medium- and trading-horizon), plus US Sector and US Small Cap models.
  - Regional and country: many, including China Local, Japan and Europe.
  - Scale: "Over 70 equity factor models across more than 90,000 securities, 49 industries and over 85 countries" (as of March 2025).
  - MSCI says it integrates "crowding, machine learning, climate and AI factors" into Barra models.
  — [MSCI Equity Factor Models](https://www.msci.com/data-and-analytics/factor-investing/equity-factor-models)

#### Axioma (now marketed by SimCorp)
- The SimCorp site labels the **Axioma Worldwide Equity Factor Risk Model** WW5.1. The suite includes fundamental and statistical models at several horizons, delivered inside Axioma Risk or as flat files. — [SimCorp WW model](https://www.simcorp.com/solutions/strategic-solutions/Axioma-Solutions/axioma-factor-risk-models/axioma-worldwide-equity-factor-risk-model); [Axioma equity models](https://www.simcorp.com/solutions/point-solutions/axioma-factor-risk-models/Axioma-Equity-Factor-Risk-Models)
- Recent launches:
  - May 2025: a new-generation Worldwide model with an ML-built "Non-linear Residual Factor".
  - January 2026: a **Trading Horizon** model for short-term trading.
  - 2024: fund-allocation risk models.
  — [SimCorp 2025](https://www.simcorp.com/about-us/news/2025/simcorp-launches-improved-axioma-worldwide-equity-factor-risk-model); [SimCorp 2026](https://www.simcorp.com/about-us/news/2026/simcorp-launches-risk-model-to-support-short-horizon-trading); [SimCorp 2024](https://www.simcorp.com/about-us/news/2024/SimCorp-launches-Axioma-fund-allocation-risk-models)

#### Bloomberg (PORT / MAC3)
- MAC3 is the risk engine behind PORT Enterprise.
  - A December 2025 release describes it as calculated daily across **3,000+ factors**, with **800+** PORT Enterprise clients.
  - There is a global equity model plus **13 local equity models**; the global model has 10 style factors, including momentum, dividend yield and profit.
  — [Bloomberg press](https://www.bloomberg.com/company/?p=44191); [Bloomberg insight](https://www.bloomberg.com/professional/insights/trading/optimize-portfolio-make-factor-bet)
- Handelsbanken Fonder adopted MAC3 as its official risk model (2022). — [Bloomberg](https://www.bloomberg.com/company/press/handelsbanken-fonder-ab-adopts-bloombergs-port-enterprise-for-portfolio-analytics-and-risk-management)

#### Northfield Information Services
- Founded in 1985; models cover most marketable securities worldwide.
- Its news-analytics overlay, "Risk Systems That Read", serves more than 300 asset-manager and asset-owner clients.
- Models are distributed through FactSet, Charles River, Thomson Reuters and State Street, and since 2024 Confluence's Revolution platform.
- No 2025 acquisition was found.
— [Northfield about](https://saas.northinfo.com/about); [Hedgeweek](https://www.hedgeweek.com/northfield-launches-news-based-risk-analysis-tool/); [Confluence 2024](https://markets.financialcontent.com/lightport.lightport3/article/bizwire-2024-5-2-confluence-partners-with-northfield-to-enhance-multi-factor-risk-and-performance-attribution-analytics); [Charles River](https://www.crd.com/news/press-releases/2017/Charles-River-and-Northfield-Expand-Portfolio-and-Risk-Analytics)

#### S&P Global Market Intelligence: Alpha Factor Library / Alpha Signals
The library has grown from 500+ to 800+ signals:

| Source | Signals | Coverage |
|---|---|---|
| 2015 press release | **500+** | 40,000+ companies, 90 countries |
| Later release | 580+ | |
| Marketplace listing | **600 factors + 60+ composite style models** | Part of the "Alpha Signals Suite" |
| Current product page (undated; returned 403 when fetched) | **800+** | 30,000+ securities, 80 countries |

— [2015 release](https://press.spglobal.com/2015-12-08-S-P-Capital-IQ-Alpha-Factor-Library-Expands-Global-Coverage-Providing-More-Than-500-Stock-Selection-Signals-on-Over-40-000-Companies-in-90-Countries-Around-the-World); [Marketplace](https://marketplace.spglobal.com/en/datasets/alpha-factor-library-(3)); [Alpha Signals Suite](https://www.marketplace.spglobal.com/en/datasets/bundle/alpha-signals-suite-(1728485746)); [product page](https://www.spglobal.com/market-intelligence/en/solutions/products/quantitative-equity-data-alpha-signals)

#### RavenPack (news and alternative-data analytics)
- History and access: archives run from 2000. WRDS lists the Dow Jones, Full and Web editions from 2000-01-01, with data through June 2026.
- Sources: 40,000+ news and social sources according to WRDS, versus about 19,000 in the RPNA 4.0 press release.
- Event taxonomy: 6,895 detected events in RPA 1.0 versus 2,064 in RPNA 4.0.
- Outputs: sentiment, relevance and market-impact analytics.
— [WRDS RavenPack](https://wrds-www.wharton.upenn.edu/pages/about/data-vendors/ravenpack/); [WRDS one-sheet](https://wrds-www.wharton.upenn.edu/documents/1164/RavenPack-one-sheet.pdf); [WRDS news](https://wrds-www.wharton.upenn.edu/pages/news/enhanced-ravenpack-analytics-gives-researchers-extensive-scope-and-depth-of-events/); [Finextra](https://www.finextra.com/pressarticle/56610/ravenpack-upgrades-rpna)

#### Quantpedia (practitioner encyclopedia of academic strategies)
- About 70 free strategies and 900+ in Premium; the API covers "1200+ quantified trading strategies". Pro tier includes about 400 Premium strategies, and new strategies are added every two weeks.
- A 2023 year-end note said "over 950"; a September 2025 note said over 850 strategies have out-of-sample backtests or code.
— [Quantpedia home](https://www.quantpedia.com/); [pricing](https://quantpedia.com/pricing-pro/); [2023 review](https://quantpedia.com/quantpedias-research-in-2023/); [Sep 2025](https://quantpedia.com/quantpedia-in-september-2025/)

#### Numerai (obfuscated ML feature set)
- Design: features are obfuscated, so no feature can be mapped to a stock attribute. Each era is one week, stock IDs reset every era, and the target is a measure of roughly 20-day forward returns. — [Numerai docs](https://docs.numer.ai/)
- Versions: V5.1 ("Faith") added 186 features, which are sparse in early eras. The docs now reference v5.3. — [Numerai forum](https://forum.numer.ai/t/data-v5-1-release-faith/8200); [Numerai docs](https://docs.numer.ai/)

### Inferences
- What an individual can actually use:
  - **Free:** WorldQuant BRAIN (US universe), Numerai, Quantpedia's free tier, and the academic libraries in §1–2.
  - **With a university WRDS login:** RavenPack, the JKP stock panel, and the CRSP/Compustat inputs needed to rebuild OSAP, GKX or JKP.
  - **Institutional licence only:** MSCI Barra, Axioma, Bloomberg MAC3 (Terminal/PORT), Northfield and S&P Alpha Signals.
- On "USE5": I found no source for a model of that name. MSCI's naming has moved to "USA Equity Factor Model" and "US Total Market Equity Model". Treat "USE5" as unconfirmed rather than wrong until MSCI documentation is checked.
- Vendor factor sets have converged on the same features: style plus industry/country structure, several horizons (long, medium, trading), and new ML, crowding and alternative-data factors (MSCI; Axioma's ML residual factor; Northfield news). That suggests risk-model factor sets now overlap with academic anomaly sets.
- BRAIN's US-only simulation for non-consultants, and its 125,000+ data fields, make it the closest free equivalent of the 101-alphas research environment. Its datasets cannot be exported, so it complements rather than replaces OSAP or JKP. The export restriction is not documented in sources fetched here; see Gaps.

### Gaps
- **Kakushadze's other papers:** the search budget ran out. From memory, not verified this session:
  - Alpha combination: "Combining Alphas via Bounded Regression" (2015).
  - Risk models: "Heterotic Risk Models" (2015), "Russian-Doll Risk Models" (2015), "Multifactor Risk Models and Heterotic CAPM" (2016), "Statistical Risk Models" (2016–17), "Worldwide Equity Risk Prediction".
  - Data: "Open Source Fundamental Industry Classification" (2017).

  The "alpha fusion" paper named in the brief was not identified.
- **WorldQuant BRAIN details:** official operator and data-field counts on the platform itself, whether data can be exported, and current consultant pay terms were not checked (the WorldQuant page failed to load).
- **MSCI:** whether any MSCI document uses "USE5", individual or academic access (e.g., via WRDS), and factor counts per model.
- **Axioma ownership:** the Qontigo/Deutsche Börse to SimCorp chain wasn't verified, nor were factor counts for WW5.1 or a US-specific Axioma model.
- **Bloomberg:** methodology and documentation (PORT HELP) were not accessible.
- **S&P:** the current count and date wasn't confirmed on a dated page; the 800+ figure comes from an undated page.
- **Not researched:** LSEG StarMine, FactSet, Two Sigma Venn and Barra-like open models (e.g., Quantopian's discontinued risk model).
- **Numerai:** total feature count for v5.x and whether the data are free to download.

---

## 4. Machine-learning-era factor sets and alpha-mining work

### Takeaway
The standard ML feature sets are:
- **GKX's 920 covariates** (94 characteristics × 8 Welch–Goyal macro predictors + 74 industry dummies; data to 2021 on Xiu's site).
- **JKP's characteristic panel** (WRDS).
- **OSAP's 200+ signals.**

Alongside these sit model families with public code: IPCA (`bkelly-lab/ipca`), Chen–Pelger–Zhu (INFORMS replication files) and AP-Trees. Text, image and LLM signals are mostly papers without packaged data. Formulaic-alpha mining has moved from genetic programming and RL (AlphaGen, AlphaForge) to LLM agents (Alpha-GPT, AlphaAgent, Microsoft RD-Agent(Q)), most with GitHub code built on Qlib and tested on Chinese and US data. TA-Lib (0.6.x) and pandas-ta (0.4.71b0 pre-release, Sep 2025) remain the common technical-indicator feature libraries.

### Cited Findings

#### Characteristic and covariate sets
- **Gu–Kelly–Xiu (RFS 2020):** 94 characteristics (61 annual, 13 quarterly, 20 monthly), 74 SIC-2 dummies and 8 Welch–Goyal predictors, giving 920 covariates. Data are on Xiu's site through 2021. — [KU guide](https://aef-course.ku.dk/additional-material/ml-data-preparation-for-python.html); [datashare.zip](https://dachxiu.chicagobooth.edu/download/datashare.zip)
- **Chen, Pelger & Zhu, "Deep Learning in Asset Pricing":** *Management Science* 70(2), 2024, pp. 714–750 (DOI 10.1287/mnsc.2023.4695).
  - Model: a feed-forward network for non-linear effects, an LSTM for hidden economic states drawn from many macro series, and a GAN that finds the test portfolios with the most unexplained pricing information. The no-arbitrage condition is the criterion.
  - It outperforms benchmarks out of sample on Sharpe ratio, explained variation and pricing errors.
  - Replication files are on the INFORMS supplemental page.
  — [INFORMS supplement](https://pubsonline.informs.org/doi/suppl/10.1287/mnsc.2023.4695); [arXiv 1904.00745](https://arxiv.org/abs/1904.00745v6); [SSRN](https://papers.ssrn.com/abstract=3350138)
- **Kelly, Pruitt & Su IPCA, "Characteristics are Covariances":** *JFE* 134(3), pp. 501–524. Implementations:
  - Python `bkelly-lab/ipca` (`pip install ipca`).
  - Independent port `sjpsjpsjp/ipca`, which warns that characteristics must be lagged before input.
  - R package `sdim` (IPCA vignette).
  — [bkelly-lab/ipca](https://github.com/bkelly-lab/ipca); [sjpsjpsjp/ipca](https://github.com/sjpsjpsjp/ipca); [sdim vignette](https://stat.ethz.ch/CRAN/web/packages/sdim/vignettes/ipca-grunfeld.html)
- **AP-Trees (Bryzgalova–Pelger–Zhu, JF 2025):** ML-built test assets; the Internet Appendix covers 36 cross-sections, each based on three characteristics. — [RePEc](https://ideas.repec.org/a/bla/jfinan/v80y2025i5p2447-2506.html)
- **Kelly–Malamud–Zhou, "The Virtue of Complexity in Return Prediction":** *JF* 79(1), Feb 2024, pp. 459–503. "Complex" models with more parameters than observations beat simple ones at predicting the market, and out-of-sample R² is a poor measure of economic value. — [JF PDF (Yale)](https://economics.yale.edu/sites/default/files/2024-01/The%20Journal%20of%20Finance%20-%202023%20-%20KELLY%20-%20The%20Virtue%20of%20Complexity%20in%20Return%20Prediction%20%281%29.pdf); [NBER w30217](https://www.nber.org/system/files/working_papers/w30217/revisions/w30217.rev0.pdf)

#### Text, image and LLM factors
- **Jiang, Kelly & Xiu, "(Re-)Imag(in)ing Price Trends":** *JF* 78(6), Dec 2023, pp. 3193–3249. A CNN reads stock price-chart images to predict up or down returns (US, 1993–2019), and the resulting decile spreads earn strong out-of-sample returns. — [JF PDF (Yale)](https://economics.yale.edu/sites/default/files/2023-11/The%20Journal%20of%20Finance%20-%202023%20-%20JIANG%20-%20Re%25E2%2580%2590%20Imag%20in%20ing%20Price%20Trends_0.pdf)
- **"Expected Returns and Large Language Models"** (Xiu and co-authors, 2022–2024 seminar versions):
  - Builds LLM (ChatGPT, LLaMA) representations of news in **16 international equity markets and 13 languages**, then forecasts next-day returns with ridge regression.
  - Prices adjust slowly to news. LLM signals beat technical signals and simpler NLP methods, especially for articles with negation or complex narratives.
  — [SJTU seminar](https://acem.sjtu.edu.cn/academic/82735.html); [Wharton discussion slides](https://jacobslevycenter.wharton.upenn.edu/wp-content/uploads/2024/09/ExpectedReturnAndLLM_Discussion_SophiaZhengziLi_NoPause.pdf); [ESSEC webinar](https://essec-amundi-chair.essec.edu/webinars/webinar-1-september-2024)
- **Kelly & Xiu, "Financial Machine Learning":** survey monograph, *Foundations and Trends in Finance* 13(3–4), 2023, pp. 205–363 (NBER WP 31502; 159 pp.). — [now publishers](https://nowpublishers.com/article/DownloadSummary/FIN-064); [NBER](https://www.nber.org/papers/w31502)

#### Formulaic and agentic alpha mining (code status)

| Project | Venue / version | What it does | Code |
|---|---|---|---|
| **AlphaGen** (Yu, Xue et al.) | KDD 2023 ADS track, DOI 10.1145/3580305.3599831; arXiv 2306.12964 | RL (maskable PPO) generates a *synergistic* alpha set, optimised for the downstream combination model rather than for individual alphas | Gitee `prg/alphagen` (maintainers Xue and Yu); GitHub copy `yutiansut/alphagen` with a Qlib data adapter and gplearn-style baselines |
| **AlphaForge** (Shi et al.) | AAAI 2025, DOI 10.1609/AAAI.V39I12.33365; arXiv 2406.18394 | A generative-predictive network mines factors, then factors are combined dynamically based on recent performance | Community repo `M1ngX/alphaforge` omits the dynamic-combination step |
| **Alpha-GPT** (Wang, Yuan, Zhou, Ni, Shum, Guo) | arXiv 2308.00016 (v2 Sep 2025); EMNLP 2025 System Demonstrations, pp. 196–206 | LLM-mediated agentic alpha mining with interactive and autonomous modes; evaluated in WorldQuant's IQC with results comparable to top humans | None found |
| **AlphaAgent** | arXiv 2502.16789 | Idea, Factor and Eval agents with three regularisers (AST-based originality, hypothesis–factor alignment, complexity control) aimed at alpha decay from crowding; tested on CSI 500 and S&P 500, 2021–2024 | `RndmVariableQ/AlphaAgent` |
| **AlphaAgentEvo** (same group) | ICLR 2026 | Follow-up | — |
| **R&D-Agent-Quant** (Li, Yang, Yang, Wang, Liu, Bian; Microsoft) | NeurIPS 2025 Datasets & Benchmarks; arXiv 2505.15155 | Research stage (hypotheses), Development stage (Co-STEER code agent) and a bandit scheduler; claims up to 2× annualised return versus classical factor libraries with 70% fewer factors | `microsoft/RD-Agent` |

— AlphaGen: [arXiv](https://arxiv.org/abs/2306.12964v1); [Gitee](https://gitee.com/prg/alphagen); [GitHub copy](https://github.com/yutiansut/alphagen)
— AlphaForge: [arXiv](https://arxiv.org/abs/2406.18394v5); [AAAI listing](https://mlanthology.org/aaai/2025/shi2025aaai-alphaforge); [repo](https://github.com/M1ngX/alphaforge)
— Alpha-GPT: [arXiv v2](https://arxiv.org/html/2308.00016v2); [ACL Anthology](https://preview.aclanthology.org/credits/2025.emnlp-demos.14)
— AlphaAgent: [arXiv](https://arxiv.org/pdf/2502.16789); [alphaXiv/code link](https://alphaxiv.org/resources/2502.16789v2); [AlphaAgentEvo, ICLR 2026](https://iclr.cc/virtual/2026/poster/10007685)
— R&D-Agent-Quant: [NeurIPS](https://papers.nips.cc/paper_files/paper/2025/hash/ac5c2b6e423883cbcacbcccf88491b78-Abstract-Datasets_and_Benchmarks_Track.html); [arXiv](https://arxiv.org/pdf/2505.15155v2)

- **flex-mining (Chen, Lopez-Lira & Zimmermann):** a public set of about 29,000 data-mined accounting-ratio strategies, useful as a "null" benchmark for any mined alpha. — [arXiv](https://arxiv.org/abs/2212.10317)

#### Technical-indicator feature libraries
- **TA-Lib:** the official PyPI listing describes ta-lib-python **0.6.x**, which "supports ta-lib 0.6.x and numpy 2" and installs with `pip install TA-Lib`. — [PyPI TA-Lib](https://pypi.python.org/pypi/TA-Lib)
- **pandas-ta:**
  - Latest on PyPI is **0.4.71b0**, a pre-release dated **Sep 14, 2025**, marked Beta and requiring Python ≥ 3.12.
  - Claims "more than 150 indicators and utilities", and 60 candlestick patterns only when TA-Lib is installed.
  - The PyPI page shows no archive or end-of-life notice.
  — [PyPI pandas-ta](https://pypi.org/project/pandas-ta/)
- **Qlib context:** AlphaGen's pipeline expects Qlib and locally stored stock data (see the AlphaGen repo), and RD-Agent(Q) is also Qlib-based. Qlib's Alpha158/Alpha360 are covered elsewhere. — [AlphaGen repo](https://github.com/yutiansut/alphagen)

### Inferences
- For a reproducible ML cross-sectional study:
  - **US:** GKX's 920-covariate design on OSAP signals, or the GKX file to 2021.
  - **Global:** JKP characteristics (WRDS).
  - **Benchmarks:** IPCA, the Chen–Pelger–Zhu GAN and AP-Trees.
- The open-code LLM and RL mining projects mostly evaluate on Chinese A-share indices (CSI 300/500) with Qlib, plus some S&P 500. Their reported gains are seldom net of realistic costs. Check them against the flex-mining null and the Chen–Velikov cost results in §5 before trusting them.
- pandas-ta's beta pre-release status and the Python ≥ 3.12 requirement make it a fragile dependency. TA-Lib 0.6.x (C core) is the steadier choice for production feature pipelines.

### Gaps
- **Feature counts not verified:** the Chen–Pelger–Zhu paper's often-cited 46 characteristics and 178 macro series (the arXiv fetch failed); the 36 characteristics in the original IPCA paper; TA-Lib's indicator count (third-party pages say 150+ functions and 61 candlestick functions) and the C library's current release (third-party mentions v0.6.4).
- **Official repos and venues:** the official AlphaGen GitHub repository (often cited as `RL-MLDM/alphagen`) and the official AlphaForge repo (`DulyHao/AlphaForge`) were not confirmed. AlphaAgent's KDD 2025 venue was not confirmed (only arXiv and the ICLR 2026 follow-up were). No public Alpha-GPT code was found.
- **Authorship:** the full author list of "Expected Returns and Large Language Models" (commonly Chen, Kelly & Xiu) wasn't confirmed.
- **Not covered for lack of search budget:** Freyberger–Neuhierl–Weber, Avramov–Cheng–Metzker ("ML vs. economic restrictions"), Lopez-Lira & Tang (ChatGPT forecasting), Ke–Kelly–Xiu SESTM, gplearn/DEAP GP baselines, `tsfresh`, `ta`, and Stefan Jansen's *ML for Algorithmic Trading* alpha-factor appendix. The pandas-ta GitHub page also failed to load, so archive status there wasn't checked.

---

## 5. Meta-research every factor user should know

### Takeaway
As of 2026:
- **Statistical replication** largely succeeds when original constructions are followed (OSAP 98%; JKP "most factors"). It largely fails under microcap-robust value-weighting (HXZ 65% failure).
- **Hurdles** of t ≈ 3 (HLZ) or 2.78 (HXZ) are standard.
- **US post-publication decay** is large: about 26% out of sample and 58% after publication (McLean–Pontiff). It is not significant outside the US (Jacobs–Müller), and data-mined signals decay about as much as published ones (Chen–Lopez-Lira–Zimmermann).
- **Net of costs and data-mining,** the average anomaly earns about 4 bps/month (Chen–Velikov).
- **The zoo compresses** to 13 themes (JKP), about 15 factors (Swade et al.) or a handful of robust factors (Bryzgalova–Huang–Julliard).
- **Factor momentum and factor timing** through principal components are the main time-series results.

### Cited Findings
- **Multiple testing:**
  - HLZ catalogue 316 factors and recommend t > 3.0. — [NBER w20592](https://nber.org/papers/w20592)
  - HXZ use a 2.78 multiple-test hurdle, under which 82% fail. — [RFS abstract](https://academic.oup.com/rfs/article-abstract/33/5/2019/5236964)
  - Harvey & Liu, "False (and Missed) Discoveries in Financial Economics" (*JF* 75(5), 2020, pp. 2503–2553), calibrate Type I and Type II errors. They set the hurdle from the acceptable ratio of misses to false discoveries and find current methods lack power to identify skilled managers. — [RePEc](https://ideas.repec.org/a/bla/jfinan/v75y2020i5p2503-2553.html); [arXiv](https://arxiv.org/abs/2006.04269v1); [Duke](https://scholars.duke.edu/publication/1307916)
  - Counterpoint: Andrew Chen argues HLZ-style false-discovery estimates actually imply most findings are true, attributing the opposite conclusion to conflating "false" with "insignificant". — [arXiv 2206.15365](https://arxiv.org/pdf/2206.15365)
  - Related Chen papers: "Do t-Statistic Hurdles Need to be Raised?" and "Publication Bias in Asset Pricing Research". — [arXiv 2204.10275](https://arxiv.org/pdf/2204.10275); [arXiv 2209.13623](https://arxiv.org/pdf/2209.13623)
- **Replication rates:**
  - HXZ: 65% of 452 fail. — [RFS abstract](https://academic.oup.com/rfs/article-abstract/33/5/2019/5236964)
  - OSAP: 98% of 161 clear predictors reproduce. — [CFR PDF](https://cfr.ivo-welch.info/published/papers/chen2021open.pdf)
  - JKP: most factors replicate, survive joint modelling and hold out of sample. — [NBER WP](https://nber.org/system/files/working_papers/w28432/w28432.pdf)
- **Post-publication decay:**
  - McLean–Pontiff: 26% out of sample, 58% after publication. — [paper](https://www.gwern.net/doc/economics/2016-mclean.pdf)
  - Jacobs–Müller: only the US shows a significant decline across 39 markets. — [UDE](https://fin.wiwi.uni-due.de/forschung/publikationen/anomalies-across-the-globe-once-public-no-longer-existent-14591/)
  - Baltussen et al.: limited out-of-sample decay over 217 years. — [SSRN](https://papers.ssrn.com/abstract=3325720)
  - Chen–Lopez-Lira–Zimmermann:
    - Peer-reviewed and data-mined predictors decay at similar rates, with about 50% of predictability remaining after the original samples.
    - Risk-based predictors, if anything, underperform their data-mined benchmarks; only about 18–20% of predictors are attributed to risk.
    - Mining tickers rather than accounting data gives near-zero out-of-sample returns.
    — [arXiv 2212.10317](https://arxiv.org/abs/2212.10317); [CFR WP](https://www.cfr-cologne.de/download/workingpaper/cfr-24-02.pdf); [Marginal Revolution, Feb 2026](https://marginalrevolution.com/marginalrevolution/2026/02/does-peer-reviewed-research-help-predict-stock-returns.html)
- **Transaction costs:**
  - **Novy-Marx & Velikov, "A Taxonomy of Anomalies and Their Trading Costs"** (*RFS* 29(1), 2016, pp. 104–147), covering 23 anomalies:
    - Most anomalies with one-sided monthly turnover below 50% keep significant net spreads when designed to reduce costs; few higher-turnover strategies do.
    - A buy/hold spread is the most effective simple fix.
    - Size, value and profitability strategies have the most capacity.
    — [NBER](https://nber.org/papers/w20721); [author PDF](https://mysimon.rochester.edu/novy-marx/research/ToAatTC.pdf); [Alpha Architect](https://alphaarchitect.com/trading-costs-destroy-factor-investing/)
  - **Chen & Velikov, "Zeroing In on the Expected Returns of Anomalies"** (*JFQA* 58(3), 2023, pp. 968–1004), covering **204 anomalies** (120 in the 2020 working paper):
    - Net of spreads, post-publication effects and the post-2000s trading era, the average anomaly earns **4 bps/month**.
    - The strongest anomalies earn at most 10 bps after controlling for data mining, and combining anomalies earns about 20 bps.
    - Price impact is not included.
    — [Cambridge/JFQA](https://www.cambridge.org/core/journals/journal-of-financial-and-quantitative-analysis/article/zeroing-in-on-the-expected-returns-of-anomalies/945133D5A3ECEEAF466AEE91551FD225); [Fed WP](https://www.federalreserve.gov/econres/feds/zeroing-in-on-the-expected-returns-of-anomalies.htm)
  - **Practitioner evidence:** across about 4,000 real alphas, returns show no significant dependence on turnover, and costs per share scale as 1/turnover. — [arXiv 1509.08110](https://arxiv.org/pdf/1509.08110)
  - **Assaying Anomalies toolkit:** Novy-Marx & Velikov (2023) published a MATLAB toolkit; a third-party Python port, `AssayingAnomalies`, is on PyPI (author Joshua Lawson; latest 2.0.6). — [PyPI](https://pypi.org/project/AssayingAnomalies/1.3.2/); [PyPI stats](https://pypistats.org/packages/assayinganomalies)
- **Compressing the zoo:**
  - Feng–Giglio–Xiu: few of 150 factors are significant. — [NBER](https://www.nber.org/papers/w25481.pdf)
  - Bryzgalova–Huang–Julliard: a handful of 51 factors are robust. — [LSE PDF](https://personal.lse.ac.uk/julliard/papers/BSftFT.pdf)
  - Swade et al.: about 15 factors span the zoo. — [SSRN](https://papers.ssrn.com/abstract=4605976)
  - JKP: 13 themes. — [jkpfactors.com](https://jkpfactors.com/)
  - Bryzgalova–Pelger–Zhu: standard test assets are too weak a hurdle. — [RePEc](https://ideas.repec.org/a/bla/jfinan/v80y2025i5p2447-2506.html)
- **Factor momentum:** Ehsani & Linnainmaa (*JF* 77(3), 2022, pp. 1877–1919).
  - Most factors are positively autocorrelated: the average factor earns 1 bp/month after a losing year versus 53 bps after a winning year.
  - Stock momentum aggregates these autocorrelations ("factor momentum but not a momentum factor").
  - Factor momentum also explains industry momentum and other forms of stock momentum.
  — [NBER w25551](https://www.nber.org/papers/w25551)
- **Factor timing:** Haddad, Kozak & Santosh (*RFS* 33(5), 2020, pp. 1980–2018).
  - The optimal factor-timing portfolio is the SDF. They forecast the first five principal components of anomaly returns, which explain 60% of the variation.
  - Timing substantially improves on static factor investing, and the implied SDF is more volatile and cyclical.
  — [NBER WP](https://nber.org/system/files/working_papers/w26708/w26708.pdf)
- **Crowding:**
  - MSCI now builds crowding factors into Barra. — [MSCI](https://www.msci.com/data-and-analytics/factor-investing/equity-factor-models)
  - AlphaAgent attributes alpha decay to homogeneous, crowded factors. — [arXiv 2502.16789](https://arxiv.org/pdf/2502.16789)
  - Isichenko's book has a section on crowding and liquidity risk. — [O'Reilly TOC](https://oreilly.com/library/view/quantitative-portfolio-management/9781119821328)
- **The causal critique:** López de Prado's *Causal Factor Investing* (CUP Elements, 2023; open access) argues that nearly all factor papers make associational claims. Without causal theory, he says, findings are likely false because of backtest overfitting and specification choices. — [RePEc](https://ideas.repec.org/b/cup/cbooks/9781009397292.html); [CFA Institute review 2026](https://rpc.cfainstitute.org/blogs/enterprising-investor/2026/book-review-causal-factor-investing)
- **Complexity:** Kelly–Malamud–Zhou argue that heavily over-parameterised models raise return predictability and economic value. — [JF PDF](https://economics.yale.edu/sites/default/files/2024-01/The%20Journal%20of%20Finance%20-%202023%20-%20KELLY%20-%20The%20Virtue%20of%20Complexity%20in%20Return%20Prediction%20%281%29.pdf)
- **New 2025–2026 evaluation infrastructure:** JKP's Common Task Framework leaderboard (model pages added Oct 2026). — [jkpfactors.com](https://jkpfactors.com/); [Pedersen research](https://www.lhpedersen.com/research)

### Inferences
- **Is the anomaly real?** The defensible position in 2026 is that most published anomalies are statistically real in-sample. Their economically exploitable part, after costs, decay and data-mining adjustment, is small for the average anomaly and concentrated in low-turnover styles (value, profitability, investment, momentum, quality).
- **Hurdles:** for new signals, use t > 3 and microcap-robust, value-weighted tests. Benchmark against data-mined nulls (flex-mining) and report net-of-cost returns using effective spreads (Chen–Velikov) and turnover-aware designs (Novy-Marx–Velikov buy/hold bands).
- **Factor momentum versus timing:** the factor-momentum and PC-timing results suggest diversified factor portfolios can be modestly tilted through time. My reading is that the robust form is slow momentum in factor returns, not aggressive valuation-based timing; that is an interpretation, not a cited claim.
- **US versus international decay:** decay is concentrated in the US (Jacobs–Müller) and weak over two centuries of multi-asset data (Baltussen et al.). Market-integration and arbitrage-cost explanations matter for global and EM implementations.

### Gaps
- Not checked for lack of search budget:
  - Gupta & Kelly, "Factor Momentum Everywhere" (JPM 2019).
  - Arnott et al. on factor momentum.
  - Asness et al., "Contrarian Factor Timing Is Deceptively Difficult".
  - Lou & Polk "Comomentum" and other formal crowding measures.
  - Linnainmaa & Roberts, "The History of the Cross-Section of Stock Returns".
  - Detzel–Novy-Marx–Velikov, "Model Comparison with Transaction Costs".
  - Frazzini–Israel–Moskowitz live trading-cost evidence.
  - Patton & Weller.
  - Falck–Rej–Thesmar, "When do systematic strategies decay?".
- No 2026-dated survey or "state of the factor zoo" review was found. The 2026 snapshot above is assembled from 2023–2026 papers and data releases.
- The official GitHub location of the Novy-Marx–Velikov MATLAB toolkit was not confirmed.

---

## 6. Essential books and long-form resources on factor investing and alpha research

### Takeaway
The core shelf is unchanged, but recent additions matter:
- **New since 2023:** Paleologo's *The Elements of Quantitative Investing* (Wiley, April 2025); Bali–Engle–Murray's 2nd edition (2023, per a retailer listing); López de Prado's open-access *Causal Factor Investing* (2023); the Python edition of Coqueret & Guida (2023); *Tidy Finance with Python* (2024, free online); and Kelly & Xiu's *Financial Machine Learning* monograph (2023).
- **Correction:** the brief's "Zhou/Coqueret-Guida" title is by Coqueret and Guida only; no Zhou is credited.

### Cited Findings
- **Grinold & Kahn, *Advances in Active Portfolio Management: New Developments in Quantitative Investing*** (McGraw-Hill, 2019/2020; ISBN 9781260453713): a "companion and successor" to *Active Portfolio Management*. It collects award-winning JPM articles on dynamic analysis, signal weighting, implementation efficiency, holdings-based attribution, expected returns, risk, portfolio construction and fees. — [McGraw-Hill](https://www.mheducation.com/highered/mhp/product/advances-active-portfolio-management-new-developments-quantitative-investing.html); [Q-Group](https://q-group.org/about-advances-in-active-portfolio)
- **Qian, Hua & Sorensen, *Quantitative Equity Portfolio Management: Modern Techniques and Applications*** (Chapman & Hall/CRC, 2007; 464 pp.): covers return forecasting, multi-factor alpha models, factor timing, risk, portfolio construction and transaction costs. — [sack.de listing](https://www.sack.de/qian-hua-sorensen-quantitative-equity-portfolio-management/9781584885580)
- **Ilmanen, *Expected Returns: An Investor's Guide to Harvesting Market Rewards*** (2011) and ***Investing Amid Low Expected Returns*** (Wiley, April 12, 2022): the 2022 book updates the 2011 one and is organised in three parts (setting the stage; liquid and illiquid, style and alpha premia; portfolio construction, risk, costs and timing). — [AQR press release](https://www.aqr.com/Our-Firm/News/2022/Press-Release); [SPE review](https://spe.org.uk/reading-room/book-reviews/investing-amid-low-expected-returns/)
- **Pedersen, *Efficiently Inefficient*** (Princeton UP, 2015; paperback 2019): covers equity, macro and arbitrage hedge-fund strategies, with interviews of Asness, Griffin, Harding, Scholes, Soros and others. — [Princeton UP](https://press.princeton.edu/node/57127); [CBS](https://www.cbs.dk/en/node/352572); [Ingram](https://ingramacademic.com/products/efficiently-inefficient-9780691196091)
- **Ang, *Asset Management: A Systematic Approach to Factor Investing*** (Oxford UP, 2014): treats factor risks as the "hard times" that cut across asset classes. It is a broad asset-management text more than a factor manual. — [Investing by the Books review](https://www.investingbythebooks.com/book-reviews-chronologically/2018/4/15/ang-andrew-asset-management); [Lavoisier](https://www.lavoisier.fr/livre/economie/asset-management/descriptif_3724935)
- **Berkin & Swedroe, *Your Complete Guide to Factor-Based Investing*** (BAM Alliance Press/Buckingham, 2016; foreword by Asness):
  - Factors must be persistent, pervasive, robust, investable and intuitive.
  - Eight pass: market beta, size, value, momentum, profitability, quality, term and carry.
  - It cites 106 papers.
  — [CFA Institute review](https://blogs.cfainstitute.org/investor/2017/06/29/book-review-your-complete-guide-to-factor-based-investing/); [FAJ review](https://rpc.cfainstitute.org/research/financial-analysts-journal/2017/your-complete-guide-factor-based-investing)
- **López de Prado:**
  - *Advances in Financial Machine Learning* (Wiley, May 2018). — [Wiley-VCH](https://www.wiley-vch.de/en/areas-interest/finance-economics-law/advances-in-financial-machine-learning-978-1-119-48208-6)
  - *Machine Learning for Asset Managers* (Cambridge Elements in Quantitative Finance, April 2020; the first title in the series). — [Cambridge](https://www.cambridge.org/core/elements/abs/machine-learning-for-asset-managers/6D9211305EA2E425D33A9F38D0AE3545); [CFA review](https://rpc.cfainstitute.org/blogs/enterprising-investor/2021/book-review-machine-learning-for-asset-managers)
  - *Causal Factor Investing* (Cambridge Elements, 2023; open access). — [RePEc](https://ideas.repec.org/b/cup/cbooks/9781009397292.html)
- **Isichenko, *Quantitative Portfolio Management: The Art and Science of Statistical Arbitrage*** (Wiley, August 2021): covers market data, forecasting, forecast combining, risk (including crowding and liquidity), trading costs, portfolio construction and simulation. — [O'Reilly](https://oreilly.com/library/view/quantitative-portfolio-management/9781119821328)
- **Paleologo:**
  - *Advanced Portfolio Management: A Quant's Guide for Fundamental Investors* (Wiley, 2021; 208 pp.): portfolio construction and risk for fundamental PMs, with a quantitative appendix. — [O'Reilly](https://www.oreilly.com/library/view/advanced-portfolio-management/9781119789796/)
  - *The Elements of Quantitative Investing* (Wiley, April 2025; about 400 pp.; ISBN 978-1-394-26545-9): the full quant workflow from idea to execution and review, including return statistics and factor models (including PCA). Paleologo is Head of Quantitative Research at Balyasny. — [Wiley-VCH](https://www.wiley-vch.de/en/areas-interest/finance-economics-law/the-elements-of-quantitative-investing-978-1-394-26545-9); [Bookshop](https://bookshop.org/p/books/the-elements-of-quantitative-investing-giuseppe-a-paleologo/516e89be3a445c84)
- **Tulchinsky et al., *Finding Alphas*, 2nd edition** (Wiley, October 2019): see §3. — [O'Reilly](https://www.oreilly.com/library/view/finding-alphas-2nd/9781119571216/)
- **Bali, Engle & Murray, *Empirical Asset Pricing: The Cross Section of Stock Returns*** (Wiley, 2016; 494 pp.): Fama–MacBeth and portfolio methods, with chapters on beta, size, value, momentum, liquidity, skewness and idiosyncratic volatility. A **2nd edition (2023, ISBN 9781119822059)** is listed by a retailer. — [BL catalogue](https://eld.bl.uk/catalog/017768273); [Porchlight](https://www.porchlightbooks.com/products/empirical-asset-pricing-turan-g-bali-9781118095041); [2nd-ed. listing](https://www.quialu.ca/produit/9781119822059)
- **Coqueret & Guida, *Machine Learning for Factor Investing*** (Chapman & Hall/CRC): an R version (reviewed in 2020) and a Python version (2023-08-08). Examples run on a public dataset with 90+ predictors. — [Routledge, R version](https://www.routledge.com/Machine-Learning-for-Factor-Investing-R-Version/Coqueret-Guida/p/book/9780367545864); [MIT Press Bookstore, Python version](https://mitpressbookstore.mit.edu/book/9780367639723); [ESSEC Alumni essay, 2020](https://www.essecalumni.com/article/essay-machine-learning-for-factor-investing-by-guillaume-coqueret-e06/04/08/2020/4224)
- **Kelly & Xiu, *Financial Machine Learning*** (FnT Finance, 2023; 159 pp. survey). — [now publishers](https://nowpublishers.com/article/DownloadSummary/FIN-064)
- ***Tidy Finance with Python*** (Chapman & Hall/CRC, July 2024; Scheuch, Voigt, Weiss and Frey): free online, and builds standard factor datasets in code. The companion R package `tidyfinance` wraps JKP and Stambaugh–Yuan data. — [sack.de](https://www.sack.de/frey-scheuch-voigt-tidy-finance-with-python/9781032684291); [tidy-finance.org](https://www.tidy-finance.org/python/index.html); [tidyfinance JKP](https://rdrr.io/cran/tidyfinance/man/download_data_jkp.html)

### Inferences
One-line "best for" guide, based on the content descriptions above:

| Book | Best for |
|---|---|
| Grinold–Kahn (both) | The fundamental law, signal weighting and the information-ratio framework |
| Qian–Hua–Sorensen | Building and combining multi-factor alpha models in a QEPM shop |
| Ilmanen (both) | Evidence on premia across asset classes and setting realistic expectations |
| Pedersen | How each hedge-fund strategy family works, and its limits to arbitrage |
| Ang | Factor-based asset allocation and institutional framing |
| Berkin–Swedroe | A non-technical factor-selection checklist |
| López de Prado (AFML, MLAM) | Backtest overfitting, labelling and financial ML hygiene |
| López de Prado (*Causal Factor Investing*) | The causal critique of factor research |
| Isichenko | An end-to-end stat-arb production pipeline |
| Paleologo (2021) | Risk and sizing for fundamental PMs |
| Paleologo (2025) | A modern factor-model-centred quant workflow |
| *Finding Alphas* | WorldQuant-style alpha idea generation and BRAIN context |
| Bali–Engle–Murray | Cross-sectional econometrics reference, with tables of replicated results |
| Coqueret–Guida | Hands-on ML for factor investing with code |
| Kelly–Xiu | A rigorous survey of the GKX/IPCA/LLM literature |
| Tidy Finance | Free, reproducible code to build CRSP/Compustat factors |

### Gaps
- **Editions not re-verified this session (from memory):** Grinold & Kahn's *Active Portfolio Management* 2nd ed. (1999/2000); *Finding Alphas* 1st ed. (2015); *Tidy Finance with R* (2023).
- **Bali–Engle–Murray 2nd edition:** it comes from one retailer listing and should be confirmed on Wiley's site.
- **Free Coqueret–Guida text:** the online version (often cited as mlfactor.com) wasn't confirmed.
- **Not checked for lack of search budget:** Nagel's *Machine Learning in Asset Pricing* (Princeton, 2021); Chincarini & Kim's *Quantitative Equity Portfolio Management* (2nd ed.); Narang's *Inside the Black Box*; Jansen's *Machine Learning for Algorithmic Trading* (2nd ed., with its alpha-factor library appendix); Cochrane's *Asset Pricing*.
