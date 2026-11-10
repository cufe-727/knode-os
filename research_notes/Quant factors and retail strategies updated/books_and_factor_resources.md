# Books, Chinese-language resources and factor-research items: verification of earlier "unverified" items (as of 2026-10-31)

Scope: confirms or corrects the books, Chinese-language resources, China broker factor series and factor meta-research papers that the earlier notes in `research_notes/Quant factor libraries and retail strategies/` listed under Gaps. Bibliographic facts come from publisher pages (Wiley, Harriman House, McGraw-Hill, Princeton UP), library catalogues (Open Library, British Library), Douban (豆瓣读书) listings, Crossref/OpenAlex/arXiv metadata, and GitHub. Chinese broker-report facts come from the original 方正金工 WeChat posts and two GitHub catalogues of broker reports. "Best for" judgements are mine and sit in the Inferences sections.

## 1. Strategy books: titles, authors, publishers, editions, coverage, Chinese editions

### Takeaway
Most titles are confirmed as the earlier notes recalled them, but several have newer editions or companions that the earlier notes missed:
- *Following the Trend* has a **2nd edition** (Wiley, January 2023).
- Ernest Chan has **two 2025 Wiley books**: *Generative AI for Trading and Asset Management* and *Hands-On AI Trading with Python, QuantConnect, and AWS*.
- Carver's fifth book, ***The Art and Science of Trading***, is forthcoming from Harriman House on **1 December 2026**, so it is not yet published.
- Gray & Vogel's *Quantitative Momentum* got a **paperback in October 2025**.

Chinese editions exist for most titles. Clenow (four), Chan (three), Carver's *Systematic Trading* (December 2025), Antonacci, Sinclair's *Volatility Trading*, Natenberg (two), Gray–Carlisle, Gray–Vogel and Harris are all translated. I found none for Vidyamurthy, Connors–Alvarez, Sinclair's *Positional Option Trading*, or Carver's other four books.

### Cited Findings

#### Andreas F. Clenow
- ***Following the Trend: Diversified Managed Futures Trading***
  - **1st edition:** Wiley, 14 January 2013; hardcover, 300 pp.; ISBN 9781118410851. — [Douban](https://book.douban.com/subject/19990593/)
  - **Latest: 2nd edition.** Wiley, January 2023; 336 pp.
    - ISBNs: hardcover 978-1-119-90898-2, e-book 978-1-119-90900-2, O-Book 978-1-394-32051-6 (September 2024).
    - New material: performance and attribution for every year 2002–2021, and how markets, the CTA industry and the strategy changed since the 1st edition.
    - It also asks whether CTA funds still show high internal correlation, covers the effects of low and negative rates, equity inflows and quant firms, and combines model types, with rulesets.
    - Wiley pitches it at retail traders, private investors, portfolio managers and institutional investors.
    — [Wiley](https://www.wiley.com/en-us/following-the-trend-diversified-managed-futures-trading-2nd-edition-p-9781119908982); [Open Library](https://openlibrary.org/books/OL37992586M/Following_the_Trend)
  - **Chinese editions:**
    - 《趋势交易》 ("Trend trading"), 机械工业出版社 (China Machine Press), June 2017, translated by 黄菊 and 杨睿; 308 pp.; ISBN 9787111568438. — [Douban](https://book.douban.com/subject/27069088/)
    - 《趋势交易（第2版）》, 机械工业出版社, January 2025, translated by 马海涌; 306 pp.; ISBN 9787111768685; original title given as *Following the Trend: Diversified Managed Futures Trading*. — [Douban](https://book.douban.com/subject/37228822/)
- ***Stocks on the Move*** (self-published)
  - CreateSpace Independent Publishing Platform, 10 June 2015; paperback, 286 pp.; ISBN 9781511466141. Clenow's site dates the release to 2015-06-10. — [Douban](https://book.douban.com/subject/26433217/); [followingthetrend.com](https://www.followingthetrend.com/stocks-on-the-move/)
  - No later edition was found in Open Library. — [Open Library search](https://openlibrary.org/search.json?q=stocks+on+the+move+clenow)
  - **Chinese edition:** 《趋势永存——打败市场的动量策略》 ("Trends endure: momentum strategies that beat the market"), 电子工业出版社 (Publishing House of Electronics Industry, PHEI), October 2018, translated by 陈杰, 王小川 and 郑志勇; 200 pp.; ISBN 9787121349201.
    - The blurb describes a single strategy: "buy the stocks that are rising".
    - Its backtests account for cash dividends, historical index membership and delistings, and the table of contents includes an S&P 500 trading system.
    - Translator 郑志勇 is described as a vice-president of 集思录 (Jisilu).
    — [Douban](https://book.douban.com/subject/30333960/)
- ***Trading Evolved: Anyone can Build Killer Trading Strategies in Python*** (self-published)
  - Independently published, 7 August 2019; paperback, 442 pp.; ISBN 9781091983786. — [Douban](https://book.douban.com/subject/34808974/)
  - Clenow's own page calls it "nearly 500 pages", written because Python has "leveled the playing field in systematic trading" while Python documentation for traders was poor. — [followingthetrend.com](https://www.followingthetrend.com/trading-evolved/)
  - **Chinese edition:** 《动量策略》 ("Momentum strategies"), 北京理工大学出版社 / 颉腾文化, September 2023, translated by 庄庆鸿 and 张坤; 424 pp.; ISBN 9787576328189. Its original title is given as *Trading Evolved*. — [Douban](https://book.douban.com/subject/36680403/)

#### Ernest P. Chan
- ***Quantitative Trading: How to Build Your Own Algorithmic Trading Business***
  - **1st edition:** John Wiley & Sons; Open Library catalogues it as 2009; 181 pp.; ISBN 9780470284889. — [Open Library](https://openlibrary.org/books/OL16842964M/Quantitative_trading)
  - **Latest: 2nd edition.** Wiley, July 2021 (e-book June 2021); 256 pp.; ISBN 978-1-119-80006-4. Described as "newly revised". — [Wiley](https://www.wiley.com/en-us/quantitative-trading-how-to-build-your-own-algorithmic-trading-business-2nd-edition-p-9781119800064)
  - **Chinese edition:** 《量化交易》, 东北财经大学出版社, January 2014, translated by 黄嵩; 157 pp.; ISBN 9787565413254; in the 金融瞭望译丛 series. — [Douban](https://book.douban.com/subject/25878150/)
- ***Algorithmic Trading: Winning Strategies and Their Rationale***
  - Wiley, May 2013; 224 pp.; ISBN 978-1-118-46014-6.
  - Wiley's endorsements describe mean-reversion and momentum strategies, each with its rationale, how it was tested and improved, and implementation issues.
  — [Wiley](https://www.wiley.com/en-us/algorithmic-trading-winning-strategies-and-their-rationale-p-9781118460146)
  - **Chinese editions:**
    - 《算法交易：制胜策略与原理》, 机械工业出版社, January 2017, translated by 高闻酉 and 黄蕊; 232 pp.; ISBN 9787111556923. — [Douban](https://book.douban.com/subject/26951842/)
    - A 珍藏版 (collector's edition), ISBN 9787111780663, 304 pp., in 机械工业出版社's 量化交易经典丛书 (quant-trading classics series). Douban lists no year. — [Douban](https://book.douban.com/subject/37398975/)
- ***Machine Trading: Deploying Computer Algorithms to Conquer the Markets***
  - Wiley, February 2017 (e-book December 2016); 272 pp.; ISBN 978-1-119-21960-6.
  - Covers platforms, new markets, and quantitative strategies for stocks, options, futures, currencies and bitcoin, with MATLAB code.
  — [Wiley](https://www.wiley.com/en-us/machine-trading-deploying-computer-algorithms-to-conquer-the-markets-p-9781119219606)
  - **Chinese edition:** 《机器交易：利用算法赢得市场先机》, 清华大学出版社 (Tsinghua University Press), June 2019, translated by 林通; 197 pp.; ISBN 9787302530268. — [Douban](https://book.douban.com/subject/34440822/)
- **Newer books (not in the earlier notes):**
  - ***Generative AI for Trading and Asset Management***, by Hamlet Medina and Ernest P. Chan.
    - Wiley, May 2025 (e-book April 2025); 320 pp.; ISBN 978-1-394-26697-5.
    - Uses unsupervised, supervised and reinforcement learning and LLMs to suggest strategies, manage risk and optimise portfolios, including real-time trading on Fed chair press conferences.
    — [Wiley](https://www.wiley.com/en-us/generative-ai-for-trading-and-asset-management-p-9781394266975)
  - ***Hands-On AI Trading with Python, QuantConnect, and AWS***, by Jiri Pik, Ernest P. Chan, Jared Broad, Philip Sun and Vivek Singh.
    - Wiley, January 2025; 416 pp.; e-book 978-1-394-26766-8, hardcover 978-1-394-26843-6.
    - Strategy-design examples on QuantConnect with full Python code.
    — [Wiley](https://www.wiley.com/en-us/hands-on-ai-trading-with-python-quantconnect-and-aws-p-9781394267668); [Open Library](https://openlibrary.org/books/OL57735091M/Hands-On_AI_Trading_with_Python_QuantConnect_and_AWS)

#### Robert Carver (all Harriman House)
- ***Systematic Trading: A Unique New Method for Designing Trading and Investing Systems***
  - 14 September 2015; 325 pp.; ISBN 9780857194459.
  - Harriman calls it "a complete guide to developing your own systems".
  — [Harriman House](https://www.harriman-house.com/authors/robert-carver/systematic-trading/9780857194459); [Open Library](https://openlibrary.org/books/OL29551041M/Systematic_Trading)
  - **Chinese edition:** 《系统化交易》, 中信出版集团 (CITIC Press) / 墨菲, 25 December 2025, translated by 量化鲲; 420 pp.; ISBN 9787521781236. — [Douban](https://book.douban.com/subject/38179419/)
- ***Smart Portfolios: A Practical Guide to Building and Maintaining Intelligent Investment Portfolios***
  - 18 September 2017; 546 pp.; ISBN 9780857195319. It is about investing rather than trading.
  — [Harriman House](https://www.harriman-house.com/authors/robert-carver/smart-portfolios/9780857195319); [Open Library](https://openlibrary.org/books/OL34569750M/Smart_Portfolios)
- ***Leveraged Trading: A professional approach to trading FX, stocks on margin, CFDs, spread bets and futures for all traders***
  - 29 October 2019; 346 pp. (Open Library: 323); ISBN 9780857197214.
  - Harriman's blurb: with the right broker and a few hundred dollars or pounds, anyone can become a leveraged trader.
  — [Harriman House](https://www.harriman-house.com/authors/robert-carver/leveraged-trading/9780857197214); [Open Library](https://openlibrary.org/books/OL29117602M/Leveraged_Trading)
- ***Advanced Futures Trading Strategies***
  - 18 April 2023; 630 pp. (Open Library: 638); ISBN 9780857199683.
  - "A complete practical guide to 30 trading strategies for the futures markets".
  — [Harriman House](https://www.harriman-house.com/authors/robert-carver/advanced-futures-trading-strategies/9780857199683)
- **Newest: *The Art and Science of Trading* (fifth book, forthcoming)**
  - Publication date 1 December 2026, pre-order only; hardback and e-book; 400 pp.; ISBN 9781804094792 (e-book 9781804094808).
  - Harriman's pitch: intuitive "artists" and systematic "scientists" alike succeed only by following a common set of scientifically grounded rules.
  — [Harriman House](https://harriman-house.com/authors/robert-carver/the-art-and-science-of-trading/9781804094792)
  - Carver's blog post of 4 September 2026 describes it further:
    - It is "the delta-one counterpart" to *Leveraged Trading*, covering unleveraged trading of shares, ETFs and crypto.
    - It is his most introductory book.
    - It covers backtesting, judging outcomes under uncertainty and the Kelly criterion. The "art" is discretionary trade selection under systematic sizing and risk rules.
    — [qoppac blog](https://qoppac.blogspot.com/)
- **Author:** ex-Barclays exotic-derivatives trader. At AHL he created the fundamental global macro strategy and ran the multi-billion-dollar fixed-income portfolio. He is now a visiting lecturer at Queen Mary, University of London and research advisor to Stylus Digital, a crypto hedge fund. — [Harriman House author page](https://harriman-house.com/authors/profile/robertcarver/17482)
- **No Chinese editions found** for *Smart Portfolios*, *Leveraged Trading* or *Advanced Futures Trading Strategies*: Douban lists only English editions. — [Douban LT](https://book.douban.com/subject/36300546/); [Douban SP](https://book.douban.com/subject/27596160/); [Douban AFTS](https://book.douban.com/subject/36300547/)

#### Gary Antonacci
- ***Dual Momentum Investing: An Innovative Strategy for Higher Returns with Lower Risk***, 1st edition (no later edition found).
  - McGraw-Hill: "Published October 10, 2014", ©2015. ISBNs: print 9780071849449, e-book 9780071849456. Open Library counts 216 pp.
  - Covers Global Equities Momentum (GEM): relative-strength plus absolute momentum, switching among US equities, non-US equities and bonds.
  - Also covers momentum research across asset classes, modern portfolio theory, behavioural explanations, smart beta, and risk measurement.
  - Appendices give monthly GEM results and an absolute-momentum trend-following overlay.
  — [McGraw-Hill](https://www.mheducation.com/highered/mhp/product/dual-momentum-investing-innovative-strategy-higher-returns-lower-risk.html); [Open Library](https://openlibrary.org/books/OL26977608M/Dual_momentum_investing)
- **Chinese edition:** 《双动量投资：高回报低风险策略》, 中国人民大学出版社 (Renmin University Press), January 2018, translated by 牛红军 and 许增坤; 255 pp.; ISBN 9787300251127. — [Douban](https://book.douban.com/subject/27615690/)

#### Ganapathy Vidyamurthy
- ***Pairs Trading: Quantitative Methods and Analysis*** (Wiley Finance), the only edition.
  - Wiley, August 2004; 224 pp.; ISBN 978-0-471-46067-1 (e-book February 2011).
  - Billed as "the first in-depth analysis of pairs trading", with tested formulas for identifying pairs and choosing the hedge ratio.
  — [Wiley](https://www.wiley.com/en-us/pairs-trading-quantitative-methods-and-analysis-p-9780471460671)
- No Chinese edition was found on Douban: a 配对交易 query returned an unrelated title.

#### Laurence A. Connors & Cesar Alvarez
- ***Short Term Trading Strategies That Work: A Quantified Guide to Trading Stocks and ETFs***
  - TradingMarkets Publishing Group.
  - Hardcover: Douban dates it 1 November 2008 (140 pp.); Open Library catalogues it as 2009 (144 pp.). ISBN 9780981923901.
  - Paperback: 14 January 2010; ISBN 9781616586386.
  - Both authors are credited.
  — [Douban hardcover](https://book.douban.com/subject/6861572/); [Douban paperback](https://book.douban.com/subject/5962115/); [Open Library](https://openlibrary.org/books/OL27087463M/Short_term_trading_strategies_that_work)
- No Chinese edition of this title was found. Connors's earlier *Street Smarts*, written with Linda Bradford Raschke, is translated: 《华尔街智慧》 (万卷出版公司, 2011) and 《华尔街交易智慧》 (山西人民出版社, 2018). — [Douban 2011](https://book.douban.com/subject/6850959/); [Douban 2018](https://book.douban.com/subject/31223756/)

#### Euan Sinclair
- ***Volatility Trading***
  - **Latest: 2nd edition**, *Volatility Trading, + Website*. Wiley, April 2013 (e-book March 2013); 320 pp.; ISBN 978-1-118-34713-3.
  - Covers volatility measurement, option pricing, hedging, money management and trade evaluation.
  - New chapters cover the dynamics of realized and implied volatility, trading the variance premium, and options in equity special situations.
  - 1st edition: 2008.
  — [Wiley](https://www.wiley.com/en-us/volatility-trading-website-2nd-edition-p-9781118347133); [Open Library](https://openlibrary.org/works/OL21458823W)
  - **Chinese edition:** 《波动率交易（第2版）》, 机械工业出版社, May 2017, translated by 王琦; 340 pp.; ISBN 9787111565178; Douban rating 8.8. — [Douban](https://book.douban.com/subject/27057344/)
- ***Positional Option Trading: An Advanced Guide***
  - Wiley, September 2020; 240 pp.; ISBN 978-1-119-58351-6.
  - Written for professional options traders.
  - Identifies edges (the volatility premium, term-structure premia, earnings effects) and how to choose the option structure that exploits them.
  - Includes directional option trading and the robustness of Black–Scholes.
  — [Wiley](https://www.wiley.com/en-us/positional-option-trading-an-advanced-guide-p-9781119583516)
  - No Chinese edition was found.
- Also by Sinclair: *Option Trading* (Wiley, 2010). — [Open Library](https://openlibrary.org/works/OL21419513W)

#### Sheldon Natenberg
- ***Option Volatility and Pricing: Advanced Trading Strategies and Techniques***
  - **Latest: 2nd edition.** McGraw-Hill Education, 21 November 2014; 592 pp.; ISBN 9780071818773. — [Open Library](https://openlibrary.org/books/OL28159900M/Option_Volatility_and_Pricing)
  - Earlier editions: Probus 1988 (*Option Volatility and Pricing Strategies*) and the 1994 edition. — [Open Library 1988](https://openlibrary.org/works/OL4774034W); [Open Library 1994](https://openlibrary.org/works/OL4774036W)
  - A companion *Option Volatility and Pricing Workbook* exists; a McGraw-Hill Education printing has ISBN 9781260116939. — [Open Library](https://openlibrary.org/works/OL4774035W)
  - Open Library's description: theory and reality of option trading, and how to select strategies to fit market views and risk tolerance. — [Open Library](https://openlibrary.org/works/OL4774036W)
- **Chinese editions:**
  - 《期权波动率与定价》, 机械工业出版社, October 2014, translated by 韩冰洁; 524 pp.; ISBN 9787111477044. — [Douban](https://book.douban.com/subject/26220899/)
  - 《期权波动率与定价（原书第2版）》, 机械工业出版社, February 2018; 560 pp.; ISBN 9787111589662; Douban rating 9.4. — [Douban](https://book.douban.com/subject/30144377/)

#### Wesley R. Gray with Tobias E. Carlisle, and with Jack R. Vogel
- ***Quantitative Value: A Practitioner's Guide to Automating Intelligent Investment and Eliminating Behavioral Errors, + Web Site*** (Gray & Carlisle)
  - Wiley, December 2012 (e-book November 2012); 288 pp.; ISBN 978-1-118-32807-1.
  - Pitched as combining Buffett-style value investing with Thorp-style quantitative investing.
  — [Wiley](https://www.wiley.com/en-us/quantitative-value-a-practitioner's-guide-to-automating-intelligent-investment-and-eliminating-behavioral-errors-web-site-p-9781118328071)
  - **Chinese edition:** 《量化价值投资》, 中国青年出版社 (China Youth Press), August 2018; 344 pp.; ISBN 9787515351636. — [Douban](https://book.douban.com/subject/30284937/)
- ***Quantitative Momentum: A Practitioner's Guide to Building a Momentum-Based Stock Selection System*** (Gray & Vogel)
  - Wiley, October 2016 (e-book September 2016); 208 pp.; ISBN 978-1-119-23719-8.
  - **New paperback October 2025**, ISBN 978-1-394-37793-0.
  - "The individual investor's comprehensive guide to momentum investing", covering momentum as stock selection and its behavioural roots.
  — [Wiley](https://www.wiley.com/en-us/quantitative-momentum-a-practitioner's-guide-to-building-a-momentum-based-stock-selection-system-p-9781119237198)
  - **Chinese edition:** 《构建量化动量选股系统的实用指南》, 中国青年出版社, October 2018, translated by 马林梅; 248 pp.; ISBN 9787515352329. — [Douban](https://book.douban.com/subject/30318740/)

#### Larry Harris
- ***Trading and Exchanges: Market Microstructure for Practitioners***
  - Oxford University Press, 2003; 643 pp.; ISBN 9780195144703.
  - Open Library shows no later edition. — [Open Library](https://openlibrary.org/books/OL18178856M/Trading_and_exchanges); [Open Library search](https://openlibrary.org/search.json?q=trading+and+exchanges+harris)
- **Chinese edition:** 《交易与交易所》, 格致出版社 (Truth & Wisdom Press), June 2021, translated by 上海证券交易所产品创新中心 (Shanghai Stock Exchange Product Innovation Centre); 588 pp.; ISBN 9787543232303; in the 上海证券交易所金融创新文库 series; Douban rating 9.0. — [Douban](https://book.douban.com/subject/35473621/)

### Inferences
**Best-for guide** (my judgement from the coverage above):

| Book (latest edition) | Best for |
|---|---|
| Clenow, *Following the Trend*, 2nd ed. (2023) | Building a diversified futures trend system the way CTAs do, with 20 years of year-by-year attribution |
| Clenow, *Stocks on the Move* (2015) | A single, simple equity-momentum strategy with survivorship-aware backtests; individuals running long-only stock portfolios |
| Clenow, *Trading Evolved* (2019) | Traders learning Python backtesting from scratch |
| Chan, *Quantitative Trading*, 2nd ed. (2021) | Setting up an independent quant-trading operation; first quant book for individuals |
| Chan, *Algorithmic Trading* (2013) | Mean-reversion and momentum recipes with rationale and pitfalls |
| Chan, *Machine Trading* (2017) | Platforms, data and execution for multi-asset retail algos (MATLAB-centric) |
| Medina & Chan (2025); Pik, Chan et al. (2025) | LLM/ML applications (GenAI) and QuantConnect-based AI strategies |
| Carver, *Systematic Trading* (2015) | Designing a robust rule-based framework (forecasts, volatility targeting, position sizing) |
| Carver, *Smart Portfolios* (2017) | DIY long-only portfolio construction |
| Carver, *Leveraged Trading* (2019) | A first leveraged systematic account with small capital |
| Carver, *Advanced Futures Trading Strategies* (2023) | Running 30 futures strategies with a production mindset |
| Carver, *The Art and Science of Trading* (Dec 2026) | Unleveraged traders who want discretion inside systematic risk rules |
| Antonacci (2014/15) | One rules-based tactical allocation model (GEM) explained in full |
| Vidyamurthy (2004) | The cointegration framework for pairs trading |
| Connors & Alvarez (2008/09) | Quick-to-test short-term stock and ETF rules (RSI-type pullbacks) |
| Sinclair, *Volatility Trading*, 2nd ed. (2013) | Measuring volatility edges and sizing option trades |
| Sinclair, *Positional Option Trading* (2020) | Experienced option traders choosing structures to harvest a known edge |
| Natenberg, 2nd ed. (2014/15) | The standard practitioner foundation for option pricing, Greeks and spreads |
| Gray & Carlisle (2012) | Systematising value stock selection |
| Gray & Vogel (2016) | Systematising momentum stock selection |
| Harris (2003) | Understanding order types, liquidity and who wins and loses in trading |

- **Edition corrections to carry forward:**
  - *Following the Trend*: cite the 2nd edition (2023).
  - *The Art and Science of Trading*: describe as forthcoming (1 December 2026), not published.
  - *Quantitative Momentum*: has an October 2025 paperback.
  - Chan's 2025 books belong in any "latest Chan" list.
- **Chinese title confusion:** the Chinese titles do not map one-to-one onto the English ones.
  - 《趋势交易》 is *Following the Trend*.
  - 《趋势永存》 is *Stocks on the Move*.
  - 《动量策略》 is *Trading Evolved*, not *Stocks on the Move*.

  A Chinese reader searching "动量策略 Clenow" would land on the Python book.
- **Which edition was translated** (inferred from publication dates):
  - The 2014 Chinese Natenberg (October 2014) predates the English 2nd edition (November 2014), so it is a translation of an earlier edition; the 2018 one is the 2nd edition.
  - Chan's 2014 《量化交易》 can only be the 1st edition.
- **Translation gaps:** Carver's four later books, Vidyamurthy, Connors–Alvarez and *Positional Option Trading* appear untranslated, so Chinese-only readers lack the main futures-sizing and options-positioning texts beyond *Systematic Trading* and *Volatility Trading*.

### Gaps
- **Self-published Clenow books:** *Stocks on the Move* and *Trading Evolved* have no publisher blurbs; coverage comes from Clenow's site and the Chinese edition's Douban blurb. The English subtitle of *Stocks on the Move* was not confirmed in a catalogue.
- **Pages not loaded:** Natenberg's McGraw-Hill page and Harris's OUP page did not load (OUP returned HTTP 202), so Open Library is the catalogue source for both.
- **Chan's 1st edition:** the exact release month of *Quantitative Trading* is not confirmed; Open Library says 2009.
- **No Chinese editions found** for Vidyamurthy, Connors–Alvarez, *Positional Option Trading*, *Smart Portfolios*, *Leveraged Trading*, *Advanced Futures Trading Strategies* and *The Art and Science of Trading*. Douban suggestion search may miss titles listed under unexpected Chinese names.
- **Year missing:** Douban gives no year for the 《算法交易》 珍藏版.

## 2. Factor and ML books: editions, coverage, open-access status, Chinese editions

### Takeaway
Corrections the earlier notes need:
- **Jansen** published a **3rd edition in 2026** (Packt), retitled *Machine Learning for Trading* (no longer "Algorithmic"). Its code is a 27-chapter rebuild; the 2nd edition's **Alpha Factor Library appendix** (TA-Lib indicators plus WorldQuant's 101 Formulaic Alphas) now lives only on the repository's `second-edition` branch.
- **Narang's** latest is the **3rd edition** (Wiley, July 2024), retitled *A Simple Guide to Systematic Investing*.
- ***151 Trading Strategies*** is a Palgrave Macmillan book (hardcover 2018, softcover 2020). It is not open access as a book, but the authors posted its complete version free on SSRN.

The other items are confirmed: Nagel (Princeton, May 2021), Chincarini & Kim 2nd ed. (McGraw Hill, October 2022), Cochrane revised ed. (Princeton, January 2005), Grinold & Kahn 2nd ed. (McGraw-Hill, catalogued 2000), *Finding Alphas* 1st ed. (Wiley, October 2015) and Ilmanen (Wiley, March 2011). All except Jansen and Kakushadze–Serur have Chinese editions, including a 2022 Nagel translation co-translated by 石川.

### Cited Findings

#### Stefan Jansen
- **1st edition:** *Hands-On Machine Learning for Algorithmic Trading* (Packt, 2018). — [Open Library](https://openlibrary.org/works/OL24773301W)
- **2nd edition:** ***Machine Learning for Algorithmic Trading: Predictive models to extract signals from market and alternative data for systematic trading strategies with Python***.
  - Packt, 31 July 2020; 820 pp.; ISBN 9781839217715. — [Open Library](https://openlibrary.org/books/OL33561730M/Machine_Learning_for_Algorithmic_Trading)
  - Its code is "complete and stable on the `second-edition` branch". The v2.0 code release (2021-02-27) refreshed the Docker environments. — [GitHub README](https://github.com/stefan-jansen/machine-learning-for-trading); [GitHub releases](https://github.com/stefan-jansen/machine-learning-for-trading/releases)
- **2nd-edition appendix, "Alpha Factor Library"** (folder `24_alpha_factor_library`):
  - It collects the book's feature-engineering lessons and computes "several dozen" TA-Lib indicators. TA-Lib has "over 150" indicators across overlap, momentum, volume, volatility, price-transform, cycle, math and statistic groups.
  - It implements WorldQuant's *101 Formulaic Alphas* (Kakushadze 2016).
  - It evaluates signals with rank correlation, mutual information, feature importance, SHAP values and Alphalens.
  — [GitHub second-edition appendix](https://github.com/stefan-jansen/machine-learning-for-trading/tree/second-edition/24_alpha_factor_library)
- **Latest: 3rd edition.** ***Machine Learning for Trading: Integrate GenAI, Causal Inference, and Reinforcement Learning into Real World Trading Systems***.
  - Packt Publishing; e-book ISBN 9781803231686; 827 pp.; Helion gives an e-book date of 2026-09-04. — [Helion listing](https://helion.pl/ksiazki/machine-learning-for-trading-integrate-genai-causal-inference-and-reinforcement-learning-into-rea-stefan-jansen,e_4q6h.htm)
  - Print ISBN 9781803246970. O'Reilly lists July 2026, and Hatchards lists a paperback date of 31 July 2026 (both via search results). — [O'Reilly](https://www.oreilly.com/library/view/machine-learning-for/9781803246970/); [Hatchards](https://www.hatchards.co.uk/book/machine-learning-for-trading/stefan-jansen/9781803246970)
  - The book site says "Third Edition · Out now". — [ml4trading.io](https://ml4trading.io)
  - **Contents:** 27 chapters and nine case studies "rebuilt from the ground up around one end-to-end workflow". New material:
    - wider model coverage: XGBoost, LightGBM and CatBoost; PatchTST, iTransformer, TSMixer and Mamba; TabPFN and autoencoders;
    - new chapters on transaction costs and on risk management;
    - live trading with IBKR, Alpaca and QuantConnect, plus MLOps;
    - RAG on SEC filings, knowledge graphs and multi-agent systems;
    - causal ML, reinforcement learning, and synthetic data;
    - Deflated Sharpe Ratio and White's Reality Check, Polars and Docker.
  - **Code release dates:**
    - v3.0.0-alpha.1 on 2026-06-19, "toward the full launch in July";
    - v3.0.0 case-study artifacts on 2026-07-24;
    - v3.1 artifacts on 2026-09-20.
  - **Repository:** MIT licence, about 21,600 stars, last push 2026-10-29.
  — [GitHub README](https://github.com/stefan-jansen/machine-learning-for-trading); [GitHub releases](https://github.com/stefan-jansen/machine-learning-for-trading/releases)
  - The 3rd-edition repository's top-level chapters (for example `08_financial_features`, `09_model_based_features`, `14_latent_factors`) include no `alpha_factor_library` folder. — [GitHub repository](https://github.com/stefan-jansen/machine-learning-for-trading)
- No Chinese edition was found on Douban for any Jansen edition.

#### Stefan Nagel
- ***Machine Learning in Asset Pricing*** (Princeton Lectures in Finance), the only edition.
  - Princeton University Press, 11 May 2021 (US); 160 pp.; ISBN 9780691218700.
  - Argues that ML prediction tools must be adapted to asset pricing using economic reasoning: portfolio optimisation, absence of near-arbitrage, and investor learning.
  - Starts with a survey of supervised ML, then covers empirical and theoretical uses.
  - Written for finance academics and quantitative investors.
  — [Princeton UP](https://press.princeton.edu/books/hardcover/9780691218700/machine-learning-in-asset-pricing)
- **Chinese edition:** 《机器学习与资产定价》, 电子工业出版社 / 博文视点, July 2022, translated by **王熙 and 石川**; 248 pp.; ISBN 9787121434365; Douban rating 8.4. — [Douban](https://book.douban.com/subject/35963565/)

#### Ludwig B. Chincarini & Daehwan Kim
- ***Quantitative Equity Portfolio Management, Second Edition: An Active Approach to Portfolio Construction and Management*** (latest).
  - McGraw Hill, published 11 October 2022 (©2023). ISBNs: print 9781264268924, e-book 9781264268931.
  - "Fully updated with new data, research, information, and insights".
  - Covers basic models, factors and factor choice, screening and ranking, fundamental and economic factor models, and forecasting factor premiums and exposures.
  - Each chapter has problems with solutions and labs on real data; online appendices are included.
  — [McGraw Hill](https://www.mheducation.com/highered/mhp/product/quantitative-equity-portfolio-management-second-edition-active-approach-portfolio-construction-and-management.html)
  - 1st edition: McGraw-Hill, 2006. — [Open Library](https://openlibrary.org/works/OL16960831W)
- **Chinese editions:**
  - 《量化股票组合管理》, 机械工业出版社, September 2018, translated by 陈志岗 and 李腾; 507 pp.; ISBN 9787111606123; Douban rating 9.0. — [Douban](https://book.douban.com/subject/30323464/)
  - A hardcover reissue in the 量化交易经典丛书 series, October 2025, same translators; 556 pp.; ISBN 9787111776086. — [Douban](https://book.douban.com/subject/37811798/)

#### Rishi K. Narang
- ***Inside the Black Box: A Simple Guide to Systematic Investing***, **3rd edition** (latest).
  - Wiley, July 2024 (e-book June 2024); 368 pp.; ISBN 978-1-119-93189-8.
  - Explains quant and algorithmic strategies "in non-mathematical terms".
  - Covers developments since the 2013 2nd edition: ML for alphas, signal mixing, data extraction and execution; alternative data; research approaches; portfolio optimisation; and the frontiers of quant investing.
  — [Wiley](https://www.wiley.com/en-us/inside-the-black-box-a-simple-guide-to-systematic-investing-3rd-edition-p-9781119931898)
- **2nd edition:** *Inside the Black Box: A Simple Guide to Quantitative and High-Frequency Trading* (Wiley, 2013; 317 pp.). — [Open Library](https://openlibrary.org/books/OL27045795M/Inside_the_black_box)
- **Chinese editions:**
  - 《打开量化投资的黑箱（第2版）》, 机械工业出版社, May 2016, translated by 上官丽英, 王思洋 and 王锦炎; 356 pp.; ISBN 9787111537298. — [Douban](https://book.douban.com/subject/26803274/)
  - A new 《打开量化投资的黑箱》, 机械工业出版社, March 2026, translated by 方志; ISBN 9787111802723; original title *Inside the Black Box*. — [Douban](https://book.douban.com/subject/38405085/)

#### John H. Cochrane
- ***Asset Pricing: Revised Edition*** (latest).
  - Princeton University Press, 23 January 2005; 560 pp.; ISBN 9780691121376.
  - Unifies asset pricing around the stochastic discount factor.
  - Covers consumption-based models, CAPM, multifactor, term-structure and option models; GMM; and predictability, cross-sectional puzzles and the equity premium.
  - The page mentions no newer edition.
  — [Princeton UP](https://press.princeton.edu/books/hardcover/9780691121376/asset-pricing)
  - 1st edition: 2001. — [Open Library](https://openlibrary.org/works/OL5730928W)
- **Chinese edition:** 《资产定价》, 中国人民大学出版社, May 2022, translated by 陈宋生, 潘远哲, 刘子轩 and 李晓青; hardcover, 455 pp.; ISBN 9787300301303. — [Douban](https://book.douban.com/subject/35931319/)

#### Richard C. Grinold & Ronald N. Kahn
- ***Active Portfolio Management: A Quantitative Approach for Producing Superior Returns and Controlling Risk***, **2nd edition** (latest).
  - McGraw-Hill, catalogued 2000; 596 pp.; ISBN 9780070248823. — [Open Library](https://openlibrary.org/books/OL16958322M/Active_portfolio_management)
  - Later listings: a 2001 McGraw-Hill printing (ISBN 9780071376952) and a 2023 McGraw-Hill Education paperback (ISBN 9781265919719). — [Open Library 2001](https://openlibrary.org/books/OL24290996M/Active_Portfolio_Management); [Open Library 2023](https://openlibrary.org/books/OL48684636M/Active_Portfolio_Management_%28PB%29)
- **1st edition:** *Active Portfolio Management: Quantitative Theory and Applications* (Irwin Professional, 1995; 388 pp.). — [Open Library](https://openlibrary.org/books/OL15378744M/Active_portfolio_management)
- **Chinese editions:**
  - 《主动投资组合管理（第2版）》, 机械工业出版社, September 2014, translated by 李腾, 杨柯敏 and 刘震; 528 pp.; ISBN 9787111474722; Douban rating 8.7. — [Douban](https://book.douban.com/subject/25984361/)
  - A hardcover reissue, December 2025, in the 量化交易经典丛书 series; 532 pp.; ISBN 9787111788157. — [Douban](https://book.douban.com/subject/37898856/)

#### Igor Tulchinsky et al., *Finding Alphas* (1st edition)
- ***Finding Alphas: A Quantitative Approach to Building Trading Strategies***, 1st edition.
  - Wiley, 26 October 2015; hardcover, 272 pp.; ISBN 9781119057864. — [Douban](https://book.douban.com/subject/26613752/); [Open Library](https://openlibrary.org/books/OL33546961M/Finding_Alphas)
- **The 2nd edition** (October 2019; 320 pp.) adds nine chapters: alpha correlation, controlling biases, ETFs, event-driven investing, index alphas, intraday data, intraday trading, machine learning, and the "triple axis plan". — [Wiley](https://www.wiley.com/en-us/finding-alphas-a-quantitative-approach-to-building-trading-strategies-2nd-edition-p-9781119571216)
- **Chinese edition:** 《寻找Alpha：量化交易策略》, 电子工业出版社, August 2019, translated by 杨旭光 et al.; 192 pp.; ISBN 9787121331367; in the 量化交易丛书 series; Douban rating 5.3. — [Douban](https://book.douban.com/subject/34788897/)

#### Antti Ilmanen
- ***Expected Returns: An Investor's Guide to Harvesting Market Rewards***.
  - Wiley, March 2011 (e-book April 2011); 608 pp.; ISBN 978-1-119-99072-7.
  - Covers the expected returns of major asset classes and strategies, and risk factors such as growth, inflation and liquidity.
  - Balances historical returns against theory and current conditions, with empirical evidence and surveys of risk-based and behavioural theories.
  — [Wiley](https://www.wiley.com/en-us/expected-returns-an-investor's-guide-to-harvesting-market-rewards-p-9781119990727)
- **Chinese edition:** 《预期收益》, 格致出版社, May 2018, translated by 钱磊; 590 pp.; ISBN 9787543228092; Douban rating 9.3. — [Douban](https://book.douban.com/subject/30218503/)

#### Zura Kakushadze & Juan Andrés Serur, *151 Trading Strategies*
- **Publisher and dates:** Palgrave Macmillan, a Springer imprint.
  - Hardcover ISBN 978-3-030-02791-9; Open Library's Springer record is dated 29 December 2018, 500 pp.
  - Softcover: 12 January 2020, 480 pp., ISBN 978-3-030-40383-6.
  - The e-book DOI 10.1007/978-3-030-02792-6 resolves to SpringerLink, but the page returned 404 from this network.
  — [Open Library hardcover record](https://openlibrary.org/books/OL28336046M/151_Trading_Strategies); [Open Library softcover](https://openlibrary.org/books/OL30108242M/151_Trading_Strategies); [British Library](https://eld.bl.uk/catalog/019204088); [DOI](https://doi.org/10.1007/978-3-030-02792-6)
- **Open-access status:** the book is sold, not open access (a LexisNexis shop listing for ISBN 9783030403836 shows €54.99), but the complete English version is free on SSRN (abstract 3247865), which cites the Palgrave 1st edition (2018). — [SSRN](https://papers.ssrn.com/abstract=3247865); [LexisNexis shop](https://shop.lexisnexis.at/151-trading-strategies-9783030403836.html)
  - A Spanish edition, *151 Estrategias de Trading* (2019; 398 pp.; ISBN 978-1071261873), is free on arXiv and SSRN. — [arXiv 1912.04492](https://arxiv.org/abs/1912.04492); [SSRN](https://papers.ssrn.com/abstract=3402665)
- **Scope** (from the Spanish edition's abstract):
  - Over 150 strategies with over 550 formulas.
  - Asset classes: stocks, options, fixed income, futures, ETFs, indexes, commodities, FX, convertibles, structured assets, volatility, real estate, distressed assets, cash, crypto, weather, energy, inflation, global macro, infrastructure and tax arbitrage.
  - Some strategies are ML-based. The book adds backtesting source code, about 2,000 references and over 900 glossary entries.
  — [arXiv 1912.04492](https://arxiv.org/abs/1912.04492)

### Inferences
**Best-for guide** (my judgement):

| Book (latest edition) | Best for |
|---|---|
| Jansen, 3rd ed. (2026) | An end-to-end ML trading workflow in modern Python, including costs, risk, MLOps and LLM agents |
| Jansen, 2nd ed. (2020) | The Alpha Factor Library appendix: ready-made TA-Lib and 101 Formulaic Alphas code with IC, SHAP and Alphalens evaluation |
| Nagel (2021) | Researchers deciding how to constrain ML with economics in return prediction |
| Chincarini & Kim, 2nd ed. (2022) | A textbook course on building a factor-based equity portfolio, with exercises and labs |
| Narang, 3rd ed. (2024) | Allocators and newcomers who need a non-mathematical map of how quant firms work |
| Cochrane (2005) | The graduate-level theory behind factor models (SDF, GMM) |
| Grinold & Kahn, 2nd ed. (2000) | The information ratio, fundamental law, alpha forecasting and risk-model framework |
| *Finding Alphas*, 1st ed. (2015) | WorldQuant-style alpha ideation; the 2nd ed. supersedes it in breadth |
| Ilmanen (2011) | Setting realistic premia expectations across asset classes |
| Kakushadze & Serur (2018) | A formula-level catalogue for scanning strategy ideas; free on SSRN |

- **For the Jansen 2nd-edition appendix,** point readers to the `second-edition` branch. The 3rd edition's top level has no comparable appendix folder, which suggests the material was folded into its feature-engineering chapters. That is an inference from the folder list, not a documented statement.
- **Which edition was translated** (inferred from dates):
  - The March 2026 Chinese 《打开量化投资的黑箱》 has a new translator and appeared after the July 2024 English 3rd edition, so it is probably that edition.
  - The August 2019 Chinese 《寻找Alpha》 appeared before the English 2nd edition (October 2019), so it must be the 1st edition, consistent with its 192 pages.
  - Whether the 2025 hardcover of 《量化股票组合管理》 (556 pp. versus 507 pp.) translates the 2022 2nd edition cannot be told from the listing.
- **A reissue wave:** 机械工业出版社's 量化交易经典丛书 reissued Grinold–Kahn (December 2025), Chincarini–Kim (October 2025) and Chan's *Algorithmic Trading* (珍藏版) as hardcovers, suggesting fresh Chinese demand for the classic texts in 2025–2026.

### Gaps
- **Jansen 3rd-edition print date:** sources disagree. O'Reilly and Hatchards give July 2026 (via search results); Helion gives a 4 September 2026 e-book date. The Packt page was behind a bot wall. Whether the 3rd edition keeps any alpha-factor appendix is not documented.
- **Grinold & Kahn:** I did not establish whether the 2nd edition is properly dated 1999 or 2000; it is commonly cited as 1999, and Open Library says 2000.
- **SpringerLink:** I could not load the page to check for an open-access badge; my "not open access" conclusion rests on the retail price and SSRN's description.
- **Not found:** Chinese editions of Jansen and of *151 Trading Strategies*.

## 3. Chinese-language resources: 石川 et al., 川总写量化, Chinese-original books, translations, communities

### Takeaway
- **石川, 刘洋溢, 连祥斌《因子投资：方法与实践》** ("Factor investing: methods and practice") is 电子工业出版社 / 博文视点, **September 2020**, 440 pp. It is still flagged in 2026 lists as the Chinese factor-investing classic.
- **石川** runs the 公众号 (WeChat official account) **川总写量化** ("Boss Chuan writes quant"), is 知乎 user `mitcshi`, and leads the **因子动物园** (Factor Zoo) account. He is now a Professor of Practice in Financial Engineering at CUHK-Shenzhen.
- **Other Chinese-original books commonly recommended:** 丁鹏《量化投资：策略与技术》 (2012 修订版; 2016 全新改版, "fully revised") and 蔡立耑《量化投资：以Python为工具》 (2017). Catalogue-only finds include 阿布《量化交易之路》 (2017) and 陆一潇《股票多因子模型实战》 (2021).
- **Translations:** most key Western texts are translated.
- **Communities:** 聚宽, BigQuant, 集思录 and 雪球 are live. 米筐's community URL now redirects to a B2B product page. 知乎 blocks automated access.

### Cited Findings

#### 石川, 刘洋溢, 连祥斌《因子投资：方法与实践》
- **Bibliographic details:** 电子工业出版社, imprint 博文视点, September 2020; paperback, 440 pp.; ISBN 9787121394287; ¥108; Douban rating 8.8. — [Douban](https://book.douban.com/subject/35192979/)
- **Content:** a 量化投资与机器学习 (QIML) 公众号 post calls it "国内第一本因子投资领域著作" ("China's first book in the factor-investing field").
  - Seven parts: foundations, methodology, mainstream factors, multi-factor models, anomalies, the state of factor research, and practice.
  - It has independent, replicable A-share empirical results and 400+ references.
  - It integrates and extends the 川总写量化 and 因子动物园 content.
  — [QIML post (GitHub mirror)](https://github.com/opendoccn0/geekdoc-quant-zh/blob/master/docs/quantml-2020/quantml-2020_073.md)
- **Still recommended in 2026:** a Chinese quant-interview guide (repository last updated 25 August 2026) stars it as "中文因子投资经典" (the Chinese factor-investing classic). — [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)
- **No 2nd edition** of this book was found on Douban. — [Douban suggest](https://book.douban.com/j/subject_suggest?q=%E5%9B%A0%E5%AD%90%E6%8A%95%E8%B5%84)

#### 石川 and the 川总写量化 / 因子动物园 accounts
- **Accounts:** "石川 / 川总写量化" is listed with a 知乎 profile (`zhihu.com/people/mitcshi`) and a 公众号, described as systematic factor-investing content usually backed by academic papers. 因子动物园 (Factor Zoo) is a 公众号 "石川团队出品" (produced by 石川's team) that tracks academic factor literature. — [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview); [知乎 profile](https://www.zhihu.com/people/mitcshi)
- **QIML link:** a 2019 QIML post names 石川 as a special columnist of the 量化投资与机器学习 公众号 and directs readers to his account 川总写量化. — [QIML post (GitHub mirror)](https://github.com/opendoccn0/geekdoc-quant-zh/blob/master/docs/quantml-2019/quantml-2019_160.md)
- **Bio** (personal site, as of 2026-10-31):
  - Professor of Practice in Financial Engineering, The Chinese University of Hong Kong, Shenzhen.
  - PhD in operations research from MIT; B.Eng. and M.Eng. from Tsinghua.
  - Co-founded Beijing Liangxin Investment Management Co. Ltd. (北京量信投资管理有限公司).
  - The site calls him "co-author of several books on factor investing and quantitative investment".
  — [mitcshi.github.io](https://mitcshi.github.io/)
- **Translation:** he co-translated Nagel's *Machine Learning in Asset Pricing* (2022; see §2). — [Douban](https://book.douban.com/subject/35963565/)

#### Chinese-original books for A-share quant work
- **丁鹏《量化投资：策略与技术》** ("Quantitative investing: strategies and techniques"), 电子工业出版社.
  - **2012 修订版** (revised edition): April 2012; 545 pp.; ISBN 9787121165368; 60+ cases on stock selection, timing, index-futures and commodity arbitrage, stat arb, options arbitrage, algo trading and asset allocation. — [Douban](https://book.douban.com/subject/10583167/)
  - **2016 全新改版** (fully revised edition): September 2016; hardcover, 639 pp.; ISBN 9787121297137; adds a 金融理论篇 (finance-theory part). — [Douban](https://book.douban.com/subject/26910084/)
  - Listed as an entry-level classic by quant-wiki and by awesome-quant-interview. — [quant-wiki book list](https://github.com/LLMQuant/quant-wiki/blob/master/docs/library/book/beginner.md); [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)
- **蔡立耑《量化投资：以Python为工具》** ("Quantitative investing with Python"), 电子工业出版社 (金融科技丛书), February 2017; 620 pp.; ISBN 9787121305146.
  - Five parts: Python, statistics, finance theory and stock selection, time series with pairs trading, and technical indicators.
  — [Douban](https://book.douban.com/subject/26945535/)
  - awesome-quant-interview recommends this title but credits it to "杨博理 等", which conflicts with Douban's 蔡立耑. — [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)
- **阿布《量化交易之路》** ("The road to quantitative trading"), 机械工业出版社, September 2017; 393 pp.; ISBN 9787111575214. — [Douban](https://book.douban.com/subject/27149594/)
- **陆一潇《股票多因子模型实战》** ("Equity multi-factor models in practice"), 电子工业出版社, April 2021; 232 pp.; ISBN 9787121408755; Douban rating 7.1. — [Douban](https://book.douban.com/subject/35446933/)
- **王小川《Python量化交易入门》** ("Introduction to Python quant trading"), 电子工业出版社: listed by quant-wiki as a beginner text. quant-wiki also links a PDF download, whose licensing is unclear. — [quant-wiki book list](https://github.com/LLMQuant/quant-wiki/blob/master/docs/library/book/beginner.md)

#### Chinese translations of key Western texts (consolidated; details and links in §1–2)

| Western book | Chinese edition (publisher, date; translator) | Source |
|---|---|---|
| Grinold & Kahn, *Active Portfolio Management* 2nd ed. | 《主动投资组合管理（第2版）》 (机械工业, 2014-09; 李腾/杨柯敏/刘震); hardcover reissue 2025-12 | [Douban](https://book.douban.com/subject/25984361/); [Douban](https://book.douban.com/subject/37898856/) |
| Chan, *Quantitative Trading* (1st ed.) | 《量化交易》 (东北财经大学, 2014-01; 黄嵩) | [Douban](https://book.douban.com/subject/25878150/) |
| Chan, *Algorithmic Trading* | 《算法交易：制胜策略与原理》 (机械工业, 2017-01; 高闻酉/黄蕊); 珍藏版 (n.d.) | [Douban](https://book.douban.com/subject/26951842/) |
| Chan, *Machine Trading* | 《机器交易：利用算法赢得市场先机》 (清华大学, 2019-06; 林通) | [Douban](https://book.douban.com/subject/34440822/) |
| Narang, *Inside the Black Box* 2nd ed. / new edition | 《打开量化投资的黑箱（第2版）》 (机械工业, 2016-05); 《打开量化投资的黑箱》 (机械工业, 2026-03; 方志) | [Douban](https://book.douban.com/subject/26803274/); [Douban](https://book.douban.com/subject/38405085/) |
| López de Prado, *Advances in Financial Machine Learning* | 《金融机器学习》 (中信出版集团, 2021-05; 林华) | [Douban](https://book.douban.com/subject/35473328/) |
| López de Prado, *Machine Learning for Asset Managers* | 《面向资产管理者的机器学习》 (机械工业, 2022-01; 冯鑫/张大庆/王飞跃) | [Douban](https://book.douban.com/subject/35749540/) |
| Carver, *Systematic Trading* | 《系统化交易》 (中信出版集团, 2025-12-25; 量化鲲) | [Douban](https://book.douban.com/subject/38179419/) |
| Clenow, *Following the Trend* 1st/2nd ed. | 《趋势交易》 (机械工业, 2017-06); 《趋势交易（第2版）》 (机械工业, 2025-01; 马海涌) | [Douban](https://book.douban.com/subject/27069088/); [Douban](https://book.douban.com/subject/37228822/) |
| Clenow, *Stocks on the Move* | 《趋势永存——打败市场的动量策略》 (电子工业, 2018-10) | [Douban](https://book.douban.com/subject/30333960/) |
| Clenow, *Trading Evolved* | 《动量策略》 (北京理工大学, 2023-09) | [Douban](https://book.douban.com/subject/36680403/) |
| Antonacci, *Dual Momentum Investing* | 《双动量投资：高回报低风险策略》 (人大, 2018-01) | [Douban](https://book.douban.com/subject/27615690/) |
| Sinclair, *Volatility Trading* 2nd ed. | 《波动率交易（第2版）》 (机械工业, 2017-05; 王琦) | [Douban](https://book.douban.com/subject/27057344/) |
| Natenberg, *Option Volatility and Pricing* | 《期权波动率与定价》 (机械工业, 2014-10); 原书第2版 (2018-02) | [Douban](https://book.douban.com/subject/26220899/); [Douban](https://book.douban.com/subject/30144377/) |
| Gray & Carlisle; Gray & Vogel | 《量化价值投资》 (中国青年, 2018-08); 《构建量化动量选股系统的实用指南》 (中国青年, 2018-10) | [Douban](https://book.douban.com/subject/30284937/); [Douban](https://book.douban.com/subject/30318740/) |
| Harris, *Trading and Exchanges* | 《交易与交易所》 (格致, 2021-06; SSE Product Innovation Centre) | [Douban](https://book.douban.com/subject/35473621/) |
| Ilmanen, *Expected Returns* | 《预期收益》 (格致, 2018-05; 钱磊) | [Douban](https://book.douban.com/subject/30218503/) |
| Chincarini & Kim | 《量化股票组合管理》 (机械工业, 2018-09); hardcover 2025-10 | [Douban](https://book.douban.com/subject/30323464/); [Douban](https://book.douban.com/subject/37811798/) |
| Cochrane, *Asset Pricing* | 《资产定价》 (人大, 2022-05) | [Douban](https://book.douban.com/subject/35931319/) |
| Nagel, *Machine Learning in Asset Pricing* | 《机器学习与资产定价》 (电子工业, 2022-07; 王熙/石川) | [Douban](https://book.douban.com/subject/35963565/) |
| Tulchinsky et al., *Finding Alphas* | 《寻找Alpha：量化交易策略》 (电子工业, 2019-08; 杨旭光 等) | [Douban](https://book.douban.com/subject/34788897/) |
| Coqueret & Guida, *ML for Factor Investing* (R version) | 《机器学习与因子投资》 (人民邮电, 2023-09; 周亮/周凡程) | [Douban](https://book.douban.com/subject/36566682/) |
| Bali, Engle & Murray, *Empirical Asset Pricing* | 《实证资产定价》 (人大, 2020-01; 张学勇/朱一峰) | [Douban](https://book.douban.com/subject/34935112/) |

The earlier notes already found a Taiwanese translation of Berkin & Swedroe (《因子投資》, 大雁文化, translator 李玮). — [eslite listing](https://www.eslite.com/product/10012117772683129507001)

#### Communities and platforms (live checks on 2026-10-31)
- **聚宽 (JoinQuant):** homepage titled "聚宽研究量化平台"; the community list page loads (rendered by JavaScript). — [JoinQuant](https://www.joinquant.com/)
  - awesome-quant-interview describes it as a common platform with free data, a backtest engine and shared community strategies, suited to beginners. — [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)
  - JoinQuant's "2024年度精选策略" (curated 2024 strategies), including a replication of 方正's 球队硬币 factor, are mirrored in many GitHub repositories. — [GitHub example](https://github.com/fangmingyang2001/JoinQuant)
- **米筐 (RiceQuant):** `ricequant.com/community` now redirects to `ricequant.com/welcome/`. That page describes 米筐 as a vendor of a "新一代量化资产管理系统" (next-generation quant asset-management system: data, research, risk/performance attribution and an integrated platform). — [RiceQuant welcome page](https://www.ricequant.com/welcome/)
- **BigQuant:** its "策略社区" (strategy community) page is live. — [BigQuant square](https://bigquant.com/square)
  - Notes from BigQuant's 2026 members' sessions list replications of 方正金工 factors, including 适度冒险, 勇攀高峰, 跳跃 (飞蛾扑火), 球队硬币 and 滴水穿石. — [Obsidian-wiki notes](https://github.com/pillaryzc/Obsidian-wiki/blob/main/BigQuant_2026%E5%B9%B4%E5%BA%A6%E7%A7%81%E4%BA%AB%E4%BC%9A/%E5%9B%A0%E5%AD%90%E7%A0%94%E7%A9%B6%E6%8A%95%E7%A0%94%E5%9B%A2.md)
- **集思录 (Jisilu):** describes itself as "一个以数据为本的投资社区" (a data-first investing community). — [Jisilu](https://www.jisilu.cn/)
  - Its 实时数据 (real-time data) pages cover 可转债 (convertible bonds), LOF and QDII funds, REITs, closed-end funds, A/H premiums and 套利 (arbitrage).
  - It sells paid data and membership tiers (for example a convertible-bond scoring table) and hosts long-running community threads such as bank-stock and options-player boards.
- **雪球 (Xueqiu/Snowball):** its site description claims "超过7800万投资者" (more than 78 million investors) using it as an investment community and wealth-management platform. — [Xueqiu](https://xueqiu.com/)
- **知乎 (Zhihu):** the 量化交易 topic (`zhihu.com/topic/19815465`) is recommended for Q&A and columns. — [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)
  - Zhihu topic and column pages returned HTTP 403 to automated requests here. — [Zhihu topic](https://www.zhihu.com/topic/19815465)
- **Other platforms** named in 2026 lists: 优矿 Uqer (通联数据) and FMZ 发明者量化 (crypto and futures). — [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)

### Inferences
- **The Chinese book canon** is now broader than "丁鹏 (2012)" in the earlier notes. 石川 et al. (2020) is the factor-specific anchor. The 2018–2026 translation wave (Grinold–Kahn, Chincarini–Kim, Narang, López de Prado, Carver, Clenow, Natenberg, Ilmanen, Cochrane, Nagel, Coqueret–Guida, Bali et al.) means a Chinese-only reader can now cover most of the Western core.
- **石川 is a hub:** author, translator (Nagel), and the person behind 川总写量化 and 因子动物园. The 2020 book consolidates his public-account writing, so readers who know the accounts get a curated, extended version.
- **米筐's community** appears discontinued as a retail forum. This is inferred from the redirect and the B2B description; no closure announcement was found. For A-share retail community research, 聚宽, BigQuant, 集思录 (fund, convertible-bond and arbitrage data and discussion) and 雪球 remain the live venues.

### Gaps
- **知乎:** the column name, URL and posting activity of 川总写量化 on 知乎 could not be checked (403).
- **WeChat accounts:** 川总写量化 and 因子动物园 post frequency in 2026 is unverified.
- **Platform activity:** 聚宽 forum activity in 2026 could not be quantified (the page is JS-rendered), and 米筐's community closure date is unknown.
- **石川's "several books":** only the 2020 book and the 2022 Nagel translation were found.
- **Unverified listings:** 王小川's 《Python量化交易入门》 was not confirmed in a catalogue, and the "杨博理 等" attribution is unresolved.

## 4. China factor-research gaps: 方正 named factors, 筹码分布, 机构调研, and the 光大, 国信 and 招商 series

### Takeaway
**All six 方正金工 factor names exist,** and all six are 2022 reports in 方正证券's **多因子选股系列研究** (multi-factor stock-selection research series; analyst 曹春晓):

| No. | Report date | Factor |
|---|---|---|
| #1 | 2022-04-12 | 适度冒险 (moderate risk-taking) |
| #2 | 2022-05-08 | 潮汐 (tide) |
| #3 | 2022-05-30 | 勇攀高峰 (bravely climbing peaks) |
| #5 | 2022-08-04 | 云开雾散 (clouds part, fog lifts) |
| #6 | 2022-09-22 | 飞蛾扑火 (moth to the flame) |
| #8 | 2022-12-13 | 草木皆兵 (every bush an enemy) |

None needs dropping. The 2023 instalments named other factors: 水中行舟, 花隐林间, 待著而救, 真知灼见, 多空博弈 and 预期惯性. The series reached #24 in December 2025.

**筹码分布** (chip/cost distribution) factors go back to 2016: 广发 多因子Alpha #27 and 长江's "筹码分布中的Alpha". They resurfaced in 2025–2026 as AI and vision-model factors (长江, 华泰, 申万宏源).

**机构调研** (company-visit) factors begin with 银河 (January 2016) and 广发 event-driven reports. A 2021–2023 wave followed: 开源, 长江, 中信, 中信建投, 光大 量化选股 #8/#9, 华泰, 国元, 国金 and 信达.

**Main series by broker:**
- **光大:** 多因子系列报告 (#1–#38, 2017–2020), then 量化选股系列报告 (#1–#15, 2021–2024), plus RSRS timing.
- **国信:** 数量化投资(技术)系列 (2009–2012), 多因子系列研究报告 (2013), then unnumbered 金融工程专题研究 factor deep-dives and a 学术文献研究 series.
- **招商:** 因子模型系列 (2017–2019), "青出于蓝" (2019–2024), "高频寻踪", "琢璞" and AI series.

### Cited Findings

#### 方正证券 多因子选股系列研究: verified instalments
The six named factors are verified against the original 【方正金工】 posts on the WeChat channel 春晓量化. Each post states the report date and the analyst, 曹春晓 (SAC registration S1220522030005).

| No. | Report date | Title (gloss) | Named factor | Headline monthly backtest from the post (A-shares) | Source |
|---|---|---|---|---|---|
| 1 | 2022-04-12 | 成交量激增时刻蕴含的alpha信息 (alpha in volume-surge moments) | **适度冒险**: "耀眼波动率" plus "耀眼收益率" (glaring volatility and returns in surge minutes) | Rank IC −8.89%, RankICIR −4.84, long-short 37.46% a year, IR 4.10 | [WeChat](https://mp.weixin.qq.com/s/2pObrtp3V0dv50MFGg_fhw) |
| 2 | 2022-05-08 | 个股成交量的潮汐变化及"潮汐"因子构建 (tidal changes in volume) | **潮汐**: 全潮汐, 强势/弱势半潮汐 → 完整潮汐 | Rank IC −7.90%, ICIR −4.13, long-short 27.09%, IR 3.08, monthly win rate 83.96%; style-neutral Rank IC −3.47%, IR 2.53 | [WeChat](https://mp.weixin.qq.com/s/_2xWXM8iyNzYDYolT9vVsw) |
| 3 | 2022-05-30 | 个股波动率的变动及"勇攀高峰"因子构建 (changes in stock volatility) | **勇攀高峰** | Rank IC +5.62%, ICIR 4.47, long-short 19.76%, IR 3.45, win rate 83.02%; style-neutral Rank IC 1.95%, ICIR 1.61 | [WeChat](https://mp.weixin.qq.com/s/-IxH3n-uR0BwOIbOyzqPrw) |
| 5 | 2022-08-04 | 波动率的波动率与投资者模糊性厌恶 (vol-of-vol and ambiguity aversion) | **云开雾散** | Rank IC −9.81%, ICIR −4.48 | [WeChat](https://mp.weixin.qq.com/s/vX4I9SpKRF3_HKQOGhtZcQ) |
| 6 | 2022-09-22 | 个股股价跳跃及其对振幅因子的改进 (price jumps and an improved amplitude factor) | **飞蛾扑火**: "月跳跃度" (monthly jump) plus "修正振幅" (corrected amplitude), a lottery-preference story | Rank IC −8.90%, ICIR −4.52, long-short 37.30%, IR 3.51 | [WeChat](https://mp.weixin.qq.com/s/V8r1Xbz5J0A9D5J_9GD_IA) |
| 8 | 2022-12-13 | 显著效应、极端收益扭曲决策权重和"草木皆兵"因子 (salience and distorted decision weights) | **草木皆兵**: "原始惊恐" improved for volatility spikes, retail-trading share and attention decay | Rank IC −8.90%, ICIR −4.54, long-short 32.50%, IR 3.92, win rate 85.71%; style-neutral Rank IC −3.59%, IR 2.03 | [WeChat](https://mp.weixin.qq.com/s/hdtzQaCF2h6ZjZd-0HAftQ) |
| 9 | 2023-02-15 | 个股成交额的市场跟随性与"水中行舟"因子 (turnover's market-following) | **水中行舟** = 随波逐流 + 孤雁出群 | Rank IC −9.36%, ICIR −4.95, long-short 36.24%, IR 4.40, win rate 86.67%; style-neutral IR 3.34 | [WeChat](https://mp.weixin.qq.com/s/Zv6XX8ddUvBCtG-4LM1MKQ) |
| 14 | 2023-11-29 | 股票日内多空博弈激烈程度度量与"多空博弈"因子构建 (intraday bull-bear contest) | **多空博弈** | Rank IC −9.73%, ICIR −5.51, long-short 40.12%, IR 4.51; style-neutral IR 3.12 | [WeChat](https://mp.weixin.qq.com/s/04H8mVTVxa6OznMSj3JKgg) |

**Other instalments** (dates and titles from a GitHub catalogue of broker-report summaries whose filenames are date-broker-title; not checked against 方正 originals) — [sharkblue2009/papers catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary):

| No. | Date | Title |
|---|---|---|
| 4 | 2022-06-11 | 个股动量效应的识别及"球队硬币"因子构建 (team-and-coin momentum factor); QuantsPlaybook cites the same date — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook) |
| 7 | 2022-10-24 | 基于Wind偏股混合型基金指数的增强选股策略 (enhanced strategy against the Wind equity-hybrid fund index) |
| 10 | 2023-03-27 | 推动个股价格变化的因素分解与"花隐林间" |
| 11 | 2023-06-11 | 大单成交后的跟随效应与"待著而救" |
| 12 | 2023-07-18 | 剥离分析师预期调整中的动量效应与"真知灼见" (analyst-revision factor) |
| 13 | 2023-09-20 | 中证2000指数增强策略及小盘价值/成长/均衡组合 (CSI 2000 enhancement) |
| 15 | 2023-12-23 | 超预期陷阱与估值动态及"预期惯性" (earnings-surprise factor) |
| 16 | 2024-03-19 | "协同效应" (intraday co-moving stocks) |
| 17 | 2024-04-12 | 新闻中的有限注意力和"凸显效应" (news-based) |
| 18 | 2024-05-23 | 成交量激增与骤降时刻的对称性与"一视同仁" |
| 19 | 2024-08-29 | "激流勇进" (buying intensity during volume expansion) |
| 20 | 2024-11-29 | 30-second and 15-second data versus minute factors |
| 21 | 2024-11-30 | 订单簿视角的开盘分歧刻画与跳空博弈因子 (order-book view of opening divergence) |
| 22 | 2025-03-12 | 股票舆情热度的反转效应与"热点反应" (public-opinion heat; authors 曹春晓, 陈泽鹏) |
| 23 | 2025-08-27 | 个股日内成交量分布特征与日内流动性弹性 (intraday liquidity elasticity) |
| 24 | 2025-12-16 | 个股日内成交量周期性节奏刻画与"滴水穿石" (intraday volume rhythm) |

- **Numbering discrepancy:** that catalogue files the 2023-11-29 多空博弈 report as "之十三", but the original post says "之十四". — [WeChat](https://mp.weixin.qq.com/s/04H8mVTVxa6OznMSj3JKgg)
- **Factor names inside reports:** 适度冒险, 云开雾散 and 飞蛾扑火 do not appear in report titles; they are named in the reports' abstracts (table above).
- **Replication code** exists for all six factors, plus 灾后重建 (a 勇攀高峰 component), 水中行舟 and 一视同仁, in a minute-data repository. Its own 2018-01-01 to 2024-03-31 all-A backtest shows:

  | Factor | Rank IC | Rank ICIR |
  |---|---|---|
  | 适度冒险 | −6.36% | −1.58 |
  | 云开雾散 | −9.94% | −4.09 |
  | 飞蛾扑火 | −7.62% | −4.18 |
  | 草木皆兵 | −8.18% | −3.88 |

  — [BryanQuant/FangZheng_multifactor](https://github.com/BryanQuant/FangZheng_multifactor)
  - A second replication in polars lists the 方正金工 WeChat links for #1–#3, #5, #6, #8–#11, #14 and #16. — [C-X-Lu replication](https://github.com/C-X-Lu/Replication-of-Minute-Frequency-Factor-refer-FZ)
- **Mislabelled source:** QuantsPlaybook files the 草木皆兵 report under "方大证券". The original post shows it is 方正. — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook); [WeChat](https://mp.weixin.qq.com/s/hdtzQaCF2h6ZjZd-0HAftQ)
- **方正's own 2023 reviews** stressed "高频因子低频化" (using high-frequency factors at low frequency):
  - 2023-06-30: "高频因子低频化选股效果显著" (low-frequency use of HF factors works markedly well).
  - 2023-10-19: "高频因子低频化样本外表现出色" (excellent out-of-sample).

  — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary)
- **Later 方正 work:**
  - 机器学习选股系列 (ML stock-selection series): #1 differentiable RankIC loss (2025-12-08); #2 a Dask genetic-programming HF factor-mining framework (2026-03-10); #3 (2026-06-09); #4 LLM-enhanced genetic programming (2026-09-21).
  - An AI-Agent series running from 2025-09 to 2026-08.
  - Earlier 方正 series: 聆听高频世界的声音 (2016–2017), 星火 多因子 (2018) and 因子七十二变 (2018).

  — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary)

#### 筹码分布 (chip / cost-distribution) factors: who introduced them
- **广发证券 多因子Alpha系列报告之（二十七）——基于筹码分布的选股策略** (stock selection based on chip distribution). QuantsPlaybook replicates it with the CYQ chip-distribution algorithm (triangular and uniform variants, attributed to 陈浩) and turnover-half-life weighting, which it notes underlies the CGO (capital-gains overhang) factor. — [QuantsPlaybook chip-factor README](https://github.com/hugo2046/QuantsPlaybook/blob/master/B-%E5%9B%A0%E5%AD%90%E6%9E%84%E5%BB%BA%E7%B1%BB/%E7%AD%B9%E7%A0%81%E5%9B%A0%E5%AD%90/README.md)
- The same catalogue dates 广发 #26 to 2016-01-27 and #28 to 2016-07-25. — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary)
- **Other chip reports in the catalogue** — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary):

| Date | Broker | Report |
|---|---|---|
| 2016-08-23 / 2016-09-04 | 长江 | 筹码分布中的Alpha：交易行为的非对称性选股 (asymmetric trading behaviour) |
| 2016-11-30 | 长江 | Portfolio report including a 筹码分布 strategy |
| 2015-09-01 | 兴业 | 筹码减少的利与弊 (pros and cons of fewer chips) |
| 2019-08-20 | 华创 | 双重筹码集中 (dual chip concentration) |
| 2020-05-13 | 中泰 | 筹码浮盈率 (industry momentum) |
| 2022-05-20 | 华西 | 筹码结构 industry rotation |
| 2025-05-29 | 华西 | 留存筹码比率 (retained-chip ratio factor) |
| 2025-04-17 | 开源 | 开源量化评论（108）: momentum-reversal fusion from a chip-structure view |
| 2025-11-30 | 长江 | 神经网络因子挖掘（六）：筹码分布因子 |
| 2026-06-02 | 华泰 | 基于筹码分层结构的端到端AI因子 (end-to-end AI factor) |
| 2026-08-11 | 申万宏源 | 筹码分布图形 with a Vision Transformer |

- Related behavioural-cost factor: 广发 2017-07-07 CGO (资本利得突出量) with risk preference. — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook)

#### 机构调研 (institutional company-visit) factors: who introduced them
From the same catalogue — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary):
- **Early (2016 or undated):**
  - 广发金工 事件驱动策略之3 (analyst visits) and 之6 (visits in the SME and ChiNext boards), undated;
  - 招商 事件驱动周报 with a 调研组合 (visit portfolio), 2016-01-18;
  - **银河证券 "量化选股：基于机构调研的选股策略", 2016-01-28;**
  - 长江 "独具慧眼or万众瞩目——分析师调研行为解析", 2016-08-18.
- **2021–2023 wave:**
  - 开源量化评论（33）: excess returns after institutional visits, 2021-09-09;
  - 长江 机构调研事件优选策略, 2022-09-07;
  - 中信 机构行为/调研数据, 2022-09-22;
  - 中信建投: visit-event stock selection 2022-09-23; industry rotation 2022-11-20; Q&A-text industry rotation 2023-08-28;
  - **光大 量化选股系列报告之八 "机构调研火热，如何提炼超额收益？", 2022-10-22, and 之九 "再探机构调研", 2023-03-14;** — [catalogue file, #8](https://github.com/sharkblue2009/papers/blob/main/records/summary/20221022-%E5%85%89%E5%A4%A7%E8%AF%81%E5%88%B8-%E9%87%8F%E5%8C%96%E9%80%89%E8%82%A1%E7%B3%BB%E5%88%97%E6%8A%A5%E5%91%8A%E4%B9%8B%E5%85%AB%EF%BC%9A%E6%9C%BA%E6%9E%84%E8%B0%83%E7%A0%94%E7%81%AB%E7%83%AD%EF%BC%8C%E5%A6%82%E4%BD%95%E6%8F%90%E7%82%BC%E8%B6%85%E9%A2%9D%E6%94%B6%E7%9B%8A%EF%BC%9F.pdf.summary.md)
  - 开源（69）: 龙虎榜, visits and block trades, 2022-12-27;
  - 华泰: text plus reversal to improve visit factors, 2023-02-09;
  - 国元, 2023-02-23;
  - 国金: 2023-04-10, 2023-07-29, and ChatGPT chain-of-thought visit selection 2024-12-16;
  - 信达 分域选股系列之一, 2023-04-12.
- **Later:** 民生, 2025-02-18 (an AI system combining reports, announcements, visits and price-volume).

#### 光大证券 金工 series
From the catalogue — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary):
- **多因子系列报告 (multi-factor series), #1 2017-04-10 "因子测试框架" (factor-testing framework) to #38 2020-09-15.** Highlights:

| No. | Date | Topic |
|---|---|---|
| #3 | 2017-05-01 | 光大Alpha 1.0 |
| #5 | 2017-09-01 | 成交量占比 HF factors (volume share) |
| #8 | 2017-11-23 | Intraday volume HF factor |
| #9 | 2018-01-03 | 一致交易因子 (consensus-trading factor) |
| #11 | 2018-04-15 | 一致预期 (consensus expectations) |
| #17 | 2018-11-03 | EBQC composite quality |
| #18 | 2019-01-02 | Factor timing |
| #19 | 2019-04-04 | 光大 Alpha 3.0 |
| #22 | 2019-06-15 | Momentum revisited |
| #24 | 2019-08-04 | Short-horizon factors |
| #27 | 2020-01-03 | ESG |
| #31, #33 | 2020 | Patent-data factors |
| #37 | 2020-09-04 | Shareholder factors |

- **量化选股系列报告 (quant stock-selection series), #1 2021-07-22 to #15 2024-10-27.** Highlights:
  - #2: refined intraday-return splits for momentum and reversal, 2021-10-22;
  - #3: PBROE with surprise, 2021-10-24;
  - #5–6: high-quality stock pools, 2022;
  - #7: expected dividend yield, 2022-08-24;
  - #8–9: institutional visits;
  - #12: private placements, 2023-11-25;
  - #13: buybacks, 2024-05-12;
  - #14–15: factor domain-splitting (分域), 2024-09 and 2024-10.
- **Technical series:** 技术指标系列 and 择时系列, including RSRS (2017-05-01; revisited 2019-11-17). — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook)
- **Team specialties per 2026 lists:** QuantsPlaybook names 光大金工's RSRS and QRS series. awesome-quant-interview characterises 光大金工 as factor timing and event-driven. — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook); [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)

#### 国信证券 金工 series
From the catalogue — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary):
- **Historic numbered series:**
  - 数量化投资系列 and 数量化投资技术系列报告 (2009–2012, numbered to at least #53), including the 2010 多因子Alpha选股 report (#26) and the 2011 区分度 momentum and reversal reports (#45, #48);
  - 多因子系列研究报告 #1–#4 (2013);
  - 行为金融学系列 (2019): #2 disposition effect (2019-05-31), #4 prospect theory and lottery stocks (2019-08-30);
  - 学术文献研究系列 (academic-literature series), 2021-04 to 2023-03 (#54).
- **Recent factor work, mostly unnumbered 金融工程专题研究 reports:**
  - northbound factor (2021-05-17);
  - global anomaly decay test (2021-09-22);
  - 动量类因子全解析 (momentum-factor deep-dive, 2021-12-13);
  - 反转因子全解析 (reversal deep-dive, 2022-06-14; also filed as 多因子选股系列, 2022-07-14);
  - 特质类因子改进 (idiosyncratic factors, 2022-08-17);
  - 联合动量因子 (stock–industry joint momentum, 2024-01-09);
  - HF order factors from active buy/sell features (2024-08-16).
- **HF report:** 国信's "交易量时钟，对高频交易模式的洞察" (volume clock) is dated 2021-06-08. — [quant-wiki HF page](https://lzw.me/doc/quant-wiki/advanced/%E7%A0%94%E6%8A%A5%E7%B2%BE%E9%80%89/a%E8%82%A1%E9%AB%98%E9%A2%91%E7%A0%94%E6%8A%A5/)
- **Team specialties:** QuantsPlaybook names 国信金工's timing series and behavioural finance. — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook)

#### 招商证券 金工 series
From the catalogue — [catalogue](https://github.com/sharkblue2009/papers/tree/main/records/summary):
- **因子模型系列 (factor-model series), #1 2017-10-17 to #13 2019-06-21.** Single-factor tests by family (size, profitability, valuation, leverage, liquidity, growth, volatility, technical), factor screening (#11), XGBoost size timing (#12) and LSTM fund exposures (#13).
- **"青出于蓝"系列 ("better than the teacher" series), #1 2019-09-04 to #9 2024-12-16:**
  - #1 short-term reversal origins;
  - #2 HP-filter value;
  - #3 report-date effects;
  - #4 "凸显性收益" (salience-return) factor STR, 2022-12-14;
  - #7 "注意力溢出" (attention spillover from ticker ordering), 2023-07-10;
  - #8 AFH improvement on tick data, 2024-08-16;
  - #9 价变共振 (price-change resonance), 2024-12-16.
- **"高频寻踪"系列 (HF tracing):** #1 交易指令流中的Alpha (alpha in order flow), 2020-06-20; #2, 2021-01-07; a VCV informed-trader factor, 2023-05-13.
- **Other series:** "琢璞" literature series (2019-10 to 2024-01); AI系列 (2023–2024); 基本面量化系列 (2024-12 to 2026-03).
- **Team specialties:** QuantsPlaybook names 招商金工 for technical analysis and HHT models; awesome-quant-interview says multi-factor models and industry rotation. — [QuantsPlaybook](https://github.com/hugo2046/QuantsPlaybook); [awesome-quant-interview](https://github.com/SoYuCry/awesome-quant-interview)

### Inferences
- **方正's distinctive contribution** (2022–2025) was minute-bar behavioural factors with mnemonic Chinese idiom names. Each is built from a behavioural story (over- and under-reaction, ambiguity aversion, lottery preference, salience) and then compressed to monthly frequency. The eight posts verified here report Rank ICs of about −7.9% to −9.8% (勇攀高峰 is positive at +5.6%). Where reported, style-neutral information ratios are about 2.0–3.3 (lower for 勇攀高峰). The series is a natural successor to the 2016–2020 HF canon in the earlier notes.
- **Decay versus construction:** the one independent replication shows much weaker ICIR for 适度冒险 (−1.58 versus −4.84). The others are close (云开雾散, 飞蛾扑火, 草木皆兵). This hints at decay or construction sensitivity for some factors; a single replication cannot separate the two.
- **"Introduced" for chip factors:** the earliest dated broker work is 2016 (广发 #27, whose numbering places it between January and July 2016, then 长江 in August 2016). After quiet years, chip structure returned in 2025–2026 as an input to neural-network, end-to-end and vision models.
- **Two meanings of "筹码":** in Chinese practice it can mean the CYQ cost distribution (广发, 长江) or shareholder concentration (股东户数, as the 兴业 2015 title likely means). Users should check which a report means.
- **Visit factors** split into two eras. A 2016 event-driven era (银河, 广发, 长江) used public disclosure of visits. A 2021–2023 era added text, Q&A content and ML (华泰, 中信建投, 国金 ChatGPT). 光大 #8/#9 sit at the turn.
- **Series continuity:** 光大's flagship numbered factor series ended at #38 (2020). 国信's current factor research is published as unnumbered 金融工程专题研究. 招商's "青出于蓝" is the most consistently numbered recent factor series of the three.

### Gaps
- **Unverified 方正 instalments:** report dates for #4, #7, #10–13 and #15–24 come from a third-party summary catalogue, not 方正 originals.
- **广发 #27:** its exact date was not found.
- **Unread reports:** the 2015 兴业 "筹码减少" report's content was not read.
- **Catalogue coverage:** the catalogue is one collector's library (about 6,900 summaries), so series counts and first/last dates are lower bounds. 光大 量化选股 #4, #10 and #11 are missing, and two different reports carry the number #9.
- **Not obtained:** factor counts per series, report authors for 光大, 国信 and 招商, and any 2026 out-of-sample tracking of the 方正 factors.

## 5. Factor meta-research gaps: factor momentum and timing, crowding, ML versus characteristics, Kakushadze's practitioner papers

### Takeaway
All requested papers are confirmed with venues:
- **Gupta & Kelly**, *JPM* 45(3), 2019: 65 factors; time-series factor momentum Sharpe 0.84.
- **Asness, Chandra, Ilmanen & Israel**, *JPM* 43(5), 2017: value-spread timing adds little to a diversified factor portfolio.
- **Lou & Polk**, *RFS* 35(7), 2022: high comomentum predicts momentum reversals.
- **MSCI Integrated Factor Crowding Model** (June 2018): a standardised score where >1 has historically preceded drawdowns.
- **Freyberger, Neuhierl & Weber**, *RFS* 33(5), 2020: many characteristics add no incremental information; nonlinearity matters.
- **Avramov, Cheng & Metzker**, *Management Science* 69(5), 2023: deep-learning profits concentrate in hard-to-arbitrage stocks and states and erode after costs.

Kakushadze's risk-model, industry-classification and alpha-combination papers are confirmed with journal references. One correction: "Worldwide Equity Risk Prediction" is **not** a Kakushadze paper; it is by Ardia & Hoogerheide (*Applied Economics Letters*, 2013).

### Cited Findings

#### Factor momentum and factor timing
- **Gupta, T. & Kelly, B., "Factor Momentum Everywhere".**
  - *The Journal of Portfolio Management* 45(3), pp. 13–36. Crossref dates print to 28 February 2019 and online to 1 March 2019. It appeared in JPM's 2019 Quantitative Special Issue.
  - Abstract findings:
    - Robust momentum in 65 widely studied characteristic-based equity factors around the globe.
    - Individual factors can be timed from their own recent performance.
    - A combined time-series factor-momentum portfolio earns an annual Sharpe ratio of 0.84.
    - Factor momentum adds to traditional momentum, industry momentum and value. Momentum is driven largely by persistence in common factors, not just idiosyncratic stock performance.
  — [DOI 10.3905/jpm.2019.45.3.013](https://doi.org/10.3905/jpm.2019.45.3.013); [OpenAlex abstract](https://api.openalex.org/works/doi:10.3905/jpm.2019.45.3.013); [AQR PDF](https://www.aqr.com/-/media/AQR/Documents/Insights/Journal-Article/Factor-Momentum-Everywhere-JPM-Quant-19.pdf)
  - It won the JPM Bernstein Fabozzi/Jacobs Levy best-paper award for 2019. — [Yale SOM](https://som.yale.edu/blog/professor-bryan-kelly-wins-bernstein-fabozzijacobs-levy-award)
  - Secondary summaries report that a 1-month lookback beats 12 months, and stress transaction-cost and data-snooping caveats. — [CXO Advisory](https://cxoadvisory.com/momentum-investing/ubiquitous-equity-factor-momentum); [Institutional Investor](https://institutionalinvestor.com/article/b1cmczbjjl4qgs/Factor-Momentum-Is-Real-Researchers-Argue)
- **Asness, C., Chandra, S., Ilmanen, A. & Israel, R., "Contrarian Factor Timing is Deceptively Difficult".**
  - *JPM* 43(5), pp. 72–87, 31 March 2017. A summary appeared in *Practical Applications* 5(3) (2018).
  - Findings:
    - Value spreads did not show value, momentum or defensive styles as markedly overvalued.
    - Valuation timing looks promising mainly because it reflects value's own efficacy.
    - Adding it to a multi-style portfolio that already holds value is "disappointing": it overlaps value and can reduce diversification.
    - Timing works only weakly, even over long horizons or at extremes.
  — [AQR](https://www.aqr.com/Insights/Research/Journal-Article/Contrarian-Factor-Timing-is-Deceptively-Difficult); [DOI 10.3905/jpm.2017.43.5.072](https://doi.org/10.3905/jpm.2017.43.5.072); [DOI Practical Applications](https://doi.org/10.3905/pa.5.3.247)

#### Crowding measures
- **Lou, D. & Polk, C., "Comomentum: Inferring Arbitrage Activity from Return Correlations".**
  - *The Review of Financial Studies* 35(7), pp. 3272–3302. Online 27 October 2021; July 2022 issue. Working paper on SSRN as 2023989.
  - Comomentum is the high-frequency abnormal return correlation among the stocks a typical momentum strategy would trade.
  - When comomentum is low, momentum strategies are stabilising (they correct underreaction). When it is high, momentum stocks' returns strongly revert, reflecting overreaction from crowded momentum trading.
  — [RFS](https://academic.oup.com/rfs/article/35/7/3272/6375702); [DOI 10.1093/rfs/hhab117](https://doi.org/10.1093/rfs/hhab117); [OpenAlex abstract](https://api.openalex.org/works/doi:10.1093/rfs/hhab117)
- **China application:** Yue, Huang & Ruan, "Comomentum in China: Inferring arbitrage activity from return correlation", *Pacific-Basin Finance Journal* 85 (June 2024), 102351. Title only; findings not retrieved. — [DOI](https://doi.org/10.1016/j.pacfin.2024.102351)
- **MSCI Integrated Factor Crowding Model** (George Bonne, Leon Roisenberg, Roman Kouzmenko and Peter Zangari; 18 June 2018).
  - It complements Barra models by showing how the market is positioned relative to factors, combining several metrics into "one standardized measure of factor crowding". The full paper requires registration. — [MSCI paper page](https://www.msci.com/research-and-insights/paper/msci-integrated-factor-crowding-model)
  - Per MSCI notes (via search results):
    - **Inputs:** valuation spreads, short-interest spreads, pairwise correlation, factor volatility and trailing factor performance.
    - **Interpretation:** factors scoring above 1 were historically more likely to suffer significant drawdowns in the following months.
    - **Structure:** four levels of scores, combined with linear weights.
    - **Security level:** the MSCI Security Crowding Model extends the framework to individual stocks.
    - **Example:** as of 28 June 2021, beta, liquidity and residual volatility were the most crowded US factors, at levels last seen in the late 1990s.
    — [MSCI blog](https://www.msci.com/research-and-insights/blog-post/eyeing-the-crowds-from-multiple-perspectives); [MSCI Security Crowding Model](https://www.msci.com/research-and-insights/paper/msci-security-crowding-model); [MSCI "Which factors may be crowded?"](https://www.msci.com/insights-gallery/which-factors-may-be-crowded)

#### ML versus characteristics and economic restrictions
- **Freyberger, J., Neuhierl, A. & Weber, M., "Dissecting Characteristics Nonparametrically".**
  - *RFS* 33(5), pp. 2326–2377 (May 2020; online 8 October 2019). NBER Working Paper 23227 (March 2017).
  - Uses the adaptive group LASSO to select characteristics and estimate their effects nonparametrically.
  - Findings: many previously identified predictors add no incremental information, and nonlinearities matter.
  - Per the NBER abstract, out-of-sample explanatory power beats linear panel regressions and Sharpe ratios rise by 50%.
  — [NBER](https://www.nber.org/papers/w23227); [DOI 10.1093/rfs/hhz123](https://doi.org/10.1093/rfs/hhz123); [OpenAlex abstract](https://api.openalex.org/works/doi:10.1093/rfs/hhz123)
- **Avramov, D., Cheng, S. & Metzker, L., "Machine Learning vs. Economic Restrictions: Evidence from Stock Return Predictability".**
  - *Management Science* 69(5), pp. 2587–2619 (May 2023; online 29 June 2022). SSRN 3450322.
  - Findings:
    - Deep-learning signals extract profit from difficult-to-arbitrage stocks and high limits-to-arbitrage periods.
    - Excluding microcaps, distressed stocks or high-volatility episodes "considerably attenuates profitability".
    - Reasonable trading costs erode performance further, because of high turnover and extreme positions.
    - The methods still identify mispricing consistent with most anomalies, and are profitable on the long side, in recent years and with low downside risk.
  — [DOI 10.1287/mnsc.2022.4449](https://doi.org/10.1287/mnsc.2022.4449); [OpenAlex abstract](https://api.openalex.org/works/doi:10.1287/mnsc.2022.4449); [INFORMS supplement](https://pubsonline.informs.org/doi/suppl/10.1287/mnsc.2022.4449)

#### Kakushadze's practitioner papers (venues from arXiv journal references; one-line findings from the abstracts)
All sources are the arXiv abstract pages linked in the table, and the [arXiv API listing](https://export.arxiv.org/api/query?search_query=au:Kakushadze&max_results=200).

| Paper (co-author) | Venue, year | One-line finding | arXiv |
|---|---|---|---|
| **Russian-Doll Risk Models** | *Journal of Asset Management* 16(3), 2015, 170–185 | Nested factor-model embedding (sector → industry → sub-industry) cuts or eliminates the factors whose covariance must be estimated | [1412.4342](https://arxiv.org/abs/1412.4342) |
| **Heterotic Risk Models** | *Wilmott* 2015(80), 40–55 | Combines industry granularity, diagonal PC covariance within sub-clusters and the Russian-doll reduction; out-of-sample-stable short-lookback models that improve intraday mean-reversion Sharpe | [1508.04883](https://arxiv.org/abs/1508.04883) |
| **Multifactor Risk Models and Heterotic CAPM** (Willie Yu) | *Journal of Investment Strategies* 5(4), 2016, 1–49 | Full algorithm and code for general risk models from any mix of style factors, principal components and industries | [1602.04902](https://arxiv.org/abs/1602.04902) |
| **Statistical Risk Models** (Yu) | *JoIS* 6(2), 2017, 1–40 | Algorithms for PCA risk models, fixing the number of factors via effective rank (eRank) | [1602.08070](https://arxiv.org/abs/1602.08070) |
| **Machine Learning Risk Models** (Yu) | *Journal of Risk & Control* 6(1), 2019, 37–64 | ML-built covariance matrices (not factor models), backtested against statistical and industry-based models | [1903.06334](https://arxiv.org/abs/1903.06334) |
| **Custom v. Standardized Risk Models** (Jim Kyung-Soo Liew) | *Risks* 3(2), 2015, 112–138 | Standardised models suit long-horizon funds; short-horizon quant needs custom ones (long-horizon factors add noise trades, arbitrary factors neutralise alpha, standard industries too coarse) | [1409.2575](https://arxiv.org/abs/1409.2575) |
| **Shrinkage = Factor Model** | *JAM* 17(2), 2016, 69–72 | A shrunk sample covariance matrix is a special factor model and inherits its instability, so it is not an alternative to multifactor models | [1511.04764](https://arxiv.org/abs/1511.04764) |
| **Dead Alphas as Risk Factors** (Yu) | *JAM* 19(2), 2018, 110–115 | Extracts risk factors from "flatlined" alphas to improve tradable alphas | [1709.06641](https://arxiv.org/abs/1709.06641) |
| **ETF Risk Models** (Yu) | *Bulletin of Applied Economics* 9(1), 2022, 1–17 | Builds an ETF taxonomy from constituent data, then heterotic or general risk models on it | [2110.07138](https://arxiv.org/abs/2110.07138) |
| **Statistical Industry Classification** (Yu) | *Journal of Risk & Control* 3(1), 2016, 17–65 | Multilevel clustering-based classifications with code; what you cluster (neither raw correlations nor raw returns) matters in backtests; hybrid versions improve fundamental classifications | [1607.04883](https://arxiv.org/abs/1607.04883) |
| **Open Source Fundamental Industry Classification** (Yu) | *Data* 2(2), 2017, 20 | Code to build a fundamental classification from free public data, compared via short-horizon alphas on heterotic risk models | [1706.04210](https://arxiv.org/abs/1706.04210) |
| **Combining Alphas via Bounded Regression** | *Risks* 3(4), 2015, 474–490 | Bounds on weights in regression over principal components fix poorly diversified or turnover-skewed alpha weights | [1501.05381](https://arxiv.org/abs/1501.05381) |
| **How to Combine a Billion Alphas** (Yu) | *JAM* 18(1), 2017, 64–80 | An optimal-weight algorithm whose cost scales linearly with the number of alphas; no PCA, matrix inversion or iteration | [1603.05937](https://arxiv.org/abs/1603.05937) |
| **Combining Alpha Streams with Costs** | *Journal of Risk* 17(3), 2015, 57–78 | With internal crossing of trades, allocation weights can be negative and cost effects change | [1405.4716](https://arxiv.org/abs/1405.4716) |
| **Factor Models for Alpha Streams** | *JoIS* 4(1), 2014, 83–109 | Factor models for alpha covariance (style, cluster, principal-component and underlying-stock factors) when the sample covariance is singular | [1406.3396](https://arxiv.org/abs/1406.3396) |
| **Is It Possible to OD on Alpha?** (Liew) | *Journal of Alternative Investments* 18(2), 2015, 39–49 | Turnover from crossing many alphas falls to a non-zero limit set by alpha correlations | [1404.0746](https://arxiv.org/abs/1404.0746) |
| **Decoding Stock Market with Quant Alphas** (Yu) | *JAM* 19(1), 2018, 38–48 | Maps alpha expected returns straight to stock expected returns, bypassing alpha combos; combos cost about 3% of P&L versus about 10% for alphas | [1708.02984](https://arxiv.org/abs/1708.02984) |
| **Mean-Reversion and Optimization** | *JAM* 16(1), 2015, 14–40 | Teaching sequence: pairs → demeaning → regression → constrained optimisation → factor models, with cost-aware optimisation pitfalls | [1408.2217](https://arxiv.org/abs/1408.2217) |
| **4-Factor Model for Overnight Returns** | *Wilmott* 2015(79), 56–62 | Four intraday-data factors (price, volatility, momentum, volume) predict overnight returns; value and growth do not | [1410.5513](https://arxiv.org/abs/1410.5513) |
| **Performance v. Turnover: A Story by 4,000 Alphas** (Igor Tulchinsky) | *JoIS* 5(2), 2016, 75–89 | Covered in the earlier notes | [1509.08110](https://arxiv.org/abs/1509.08110) |
| **101 Formulaic Alphas** | *Wilmott* 2016(84), 72–80 | Covered in the earlier notes | [1601.00991](https://arxiv.org/abs/1601.00991) |
| **Betas, Benchmarks and Beating the Market** (Yu) | *Journal of Trading* 13(3), 2018, 44–66 | Long-only benchmark portfolios from a tailored multifactor risk model, without PCA or iterations | [1807.09919](https://arxiv.org/abs/1807.09919) |
| **Cryptoasset Factor Models** | *Algorithmic Finance* 7(3–4), 2018, 87–104 | Factor models and out-of-sample code for daily crypto returns; finds a leading factor | [1811.07860](https://arxiv.org/abs/1811.07860) |
| **Quant Bust 2020** | *World Economics* 21(2), 2020, 183–217 | Non-technical account of why dollar-neutral equity stat arb lost heavily in the COVID-19 sell-off, with backtests | [2006.05632](https://arxiv.org/abs/2006.05632) |

- **Correction:** "Worldwide Equity Risk Prediction" (SSRN 2065224; *Applied Economics Letters* 20(14), 2013, pp. 1333–1339) is by **David Ardia and Lennart F. Hoogerheide**. The earlier notes' memory-based attribution to Kakushadze was wrong. — [DOI 10.1080/13504851.2013.806775](https://doi.org/10.1080/13504851.2013.806775)

### Inferences
- **Factor momentum and contrarian timing point the same way.** Gupta–Kelly and Ehsani–Linnainmaa (earlier notes) support momentum-style timing of factors. Asness et al. show that value-spread (contrarian) timing mostly re-buys value exposure. For a diversified factor book, mild trend-following tilts on factor returns are better supported than valuation timing. That is consistent with the earlier notes' inference, now with the two primary sources confirmed.
- **Crowding measures** have a sound academic core (Lou–Polk comomentum: return co-movement among the traded names) and a commercial composite (MSCI, which also uses spreads, short interest, volatility and performance). For A-shares, the 2024 Pacific-Basin paper and the sell-side crowding reports in the earlier notes are the local analogues.
- **FNW and ACM bound ML gains.** FNW says nonlinearity matters and many characteristics are redundant. ACM says much of the ML premium sits in hard-to-trade corners and erodes after costs. Combined with the A-share HF-factor decay in the earlier notes, ML or HF signals should be judged net of costs and outside microcaps.
- **Kakushadze's corpus** is the most complete free, code-bearing set of practitioner risk-model and alpha-combination methods: Russian-doll and heterotic constructions, statistical and ML risk models, industry classification, and alpha combination at scale. Most are 2014–2019 journal papers with arXiv preprints.

### Gaps
- **FNW counts:** the often-quoted 62 characteristics and "about 13 selected" were not verified (the abstract gives no counts).
- **Not extracted:** Lou–Polk's effect sizes and ACM's return and cost magnitudes; only abstracts were read.
- **MSCI:** component weights and normalisation sit behind a registration wall; the >1 threshold and inputs come from MSCI blog text seen in search results.
- **Gupta–Kelly:** the 1-month versus 12-month lookback detail rests on secondary summaries.
- **China:** the findings of the 2024 "Comomentum in China" paper were not retrieved.
- **Unidentified:** an earlier MSCI crowding paper (often cited as "Lost in the Crowd?", 2015) was not found in Crossref, and the "alpha fusion" paper named in the earlier brief remains unidentified among Kakushadze's 2014–2022 papers.
