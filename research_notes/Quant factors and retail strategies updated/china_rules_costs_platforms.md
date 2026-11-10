# Rules, costs, access thresholds and trading platforms for individual quantitative traders in mainland China (as of 2026-10-31)

Sourcing conventions used below. "Official" means the text was read from a regulator, exchange, broker or vendor page or attachment (docx/PDF attachments were extracted locally). "(search excerpt)" means the claim was seen only in a search-result summary of that URL, not read in full. "Weaker" marks claims resting on Q&A sites, forums, social media, self-media or broker sales content. This pass builds on the earlier notes in `Quant factor libraries and retail strategies/china_retail_strategies.md` (Sections 8–10) and fills their gaps; it does not repeat their findings except where a date or rule needed confirming.

## 1. Broker quant terminals for individuals in 2026 (迅投 QMT/miniQMT, 恒生 PTrade, other routes) and whether access was tightened in 2024–2026

### Takeaway
Access thresholds for QMT/miniQMT and PTrade are set by each broker, not by any regulator: 2026 press reports name 国金证券 (in-app, 自有资产 ≥10万元) and 申万宏源 (≥1 year of trading experience and T-1 assets ≥50万元), while other brokers ask ≥300万元 or do not open these tools to individuals at all. Regulation has tightened in layers: the CSRC's 2024 rules made brokers verify every client system before connecting it, the exchanges' rules (effective 2025-07-07) name 个人投资者 (individual investors) among program traders who must report before trading, and the SAC/AMAC 《证券公司交易信息系统接入管理规范（试行）》 (issued and effective 2026-08-28) imposes full-process "penetrating" management on all external system access. Forum and social-media reports (weaker) say that after 2026-08-28 some brokers stopped granting new miniQMT-style external access to individuals. Broker-controlled QMT/PTrade environments remain available.

### Cited Findings
**Named brokers and thresholds (financial press, 2026)**
- 财联社 (2026-09-29, reporter 王晨, "又一量化权限进驻券商APP，PTrade/QMT热起来，哪类股民能享有？") reports the following. — [财联社](https://www.cls.cn/detail/2494979)
  - **国金证券:** clients can apply for PTrade/QMT permission inside the broker app ("APP内支持Ptrade/QMT权限开通") with own assets of 10万元 or more ("账户自有资产10万元及以上").
  - **申万宏源:** offers PTrade and QMT permission to individuals with "1年以上证券、场内基金投资经验，且T-1日资产50万元以上" (over a year of securities or listed-fund experience and assets of at least 50万元 on T-1).
  - **中信证券 and 山西证券:** promote PTrade/QMT services on platforms but "并未直接在APP中上线" (have not put them in the app).
  - **招商证券:** has put Iceberg (冰山) and an enhanced market-liquidity algorithm in its app.
  - **Other brokers:** thresholds "门槛各不相同" (vary), some requiring assets above 300万元. Some brokers have never opened QMT/PTrade applications to individuals, citing "内部合规原因" (internal compliance reasons).
  - **Article lead:** standard QMT/PTrade run on broker-controlled terminals or broker cloud, so individuals can still use them.
- The Sohu repost of that 财联社 story carries an extra passage (search excerpt). It says miniQMT's mode, in which a local, independent Python process generates orders and miniQMT forwards them, counts as external access (外接) under the 2026 access rules, and that individuals can now use only quant channels inside the broker's sandbox, whitelist and risk controls. — (search excerpt) [搜狐 repost of 财联社](https://www.sohu.com/a/1082177789_222256)

**Weaker claims about thresholds (Q&A sites and self-media; numbers conflict)**
- A "basic" miniQMT tier commonly needs a 20-trading-day average of 10万元 in assets. Full QMT commonly needs 50万元. Other answers give 5万–20万元. Answers also cite at least six months of trading experience and a risk rating of C4 or above, and name 中金, 国金, 华西 and 国信 as providers. — (weaker; search excerpts) [理财问答 qa_6937679](https://licai.cofool.com/ask/qa_6937679.html); [理财问答 qa_7145665](https://licai.cofool.com/ask/qa_7145665.html); [东方财富财富号 2026-05-26](https://caifuhao.eastmoney.com/news/20260526143644756268270)
- Head brokers such as 中信 and 华泰 are said to want 50万–100万元. Risk-rating claims vary between C3 and C4. Account opening involves signing a 《量化交易风险揭示书》 (quant-trading risk disclosure) and a 《程序化交易协议》 (program-trading agreement). — (weaker; search excerpts) [网易 2026 PTrade guide](https://www.163.com/dy/article/KQIO7G6T05564AHL.html); [叩富网](https://licai.jiantou8.com/user/guide_view_3061176.html)

**Other retail routes (official pages where available)**
- **东方财富证券 "VIP交易" (official page).** This intelligent trading terminal offers conditional orders, grid trading, take-profit/stop-loss, strategy liquidation, basket trading and cloud pre-placed orders (云端埋单). An individual qualifies through either route below, plus a risk rating of C2 or above and two special assessments. The page states no individual fee and does not mention an API. — [东方财富 VIP交易](https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/aitrade.html)
  - Route 1: a 沪深 ordinary trading account at 东方财富证券 with "账户资产>=200万元且近3个月交易次数>=10次" (assets of at least 200万元 and at least 10 trades in the last three months).
  - Route 2: an open 东方财富期权账户 (options account).
  - Special assessments: a VIP-specific risk-tolerance assessment and a device/network security admission assessment.
- **东方财富证券 EMT counter.** EMT is 东方财富证券's low-latency counter, alongside 中泰 XTP and 华鑫奇点 TORA. The open-source openctp project provides CTP-compatible APIs for all three plus 东方证券 OST and Interactive Brokers TWS. Live access to EMT is described as having high thresholds, without figures. — (search excerpt) [openctp GitHub](https://github.com/openctp/openctp)
- **华鑫证券 奇点 (TORA).** 华鑫's own usage notes, in a version dated 2023-08, say that once 奇点 is enabled, the client's centralized trading terminal can no longer place orders. An application made before 15:00 on day T is opened that day, and trading starts on T+1. A 2021 vn.py community post (weaker) says self-built counters typically require professional-investor status, about 300万元 and one year of stock trading. — (search excerpt) [华鑫证券 奇点系列软件使用注意事项](https://www.cfsc.com.cn/www/html/155/1.html?v=1606209412044); [CSDN 2024 (weaker)](https://blog.csdn.net/sohoqq/article/details/142024114)
- **迅投 XtQuant documentation (official).** A MiniQMT client must be running before any XtQuant program ("在运行使用 XtQuant 的程序前需要先启动 MiniQMT 客户端"). Python 3.6–3.12, 64-bit, is supported. The page names no brokers and gives no prices. — [迅投知识库](https://dict.thinktrader.net/nativeApi/start_now.html)
- **同花顺 SuperMind (official homepage).** It offers Python strategy simulation (模拟交易). Live trading is through "同花顺智能交易" on forfunds.cn via an application form. Partner logos include 中国银河证券, 华创证券, 长江证券 and 长城证券, but the page does not say what each broker offers or what it costs. — [SuperMind](https://quant.10jqka.com.cn/)
- **掘金量化 (MyQuant).** The official homepage did not render any broker list. Q&A pages name many brokers (海通, 中金, 东北, 银河, 安信, 国信, 国金, 国盛 "20万左右"), but none of this ties to 掘金's live interface. — (weaker; search excerpts) [理财问答 qa_5494226](https://licai.cofool.com/ask/qa_5494226.html)

**Regulatory tightening of retail API access, 2024–2026**
- **CSRC 《证券市场程序化交易管理规定（试行）》, effective 2024-10-08.**
  - Article 15 requires securities and futures firms to manage access by client program-trading systems, set up an access-verification regime, run verification tests and risk assessments before connecting a system, and never connect an unverified one.
  - Article 16 requires an access agreement with the client.
  - (search excerpt) [CSRC](https://www.csrc.gov.cn/csrc/c100028/c7480577/content.shtml)
- **SSE 《程序化交易管理实施细则》, effective 2025-07-07 (official text).**
  - Article 3 lists "私募基金管理人、合格境外投资者、个人投资者等会员客户" (broker clients, including private fund managers, QFIs and individual investors) as program-trading investors.
  - Article 11 makes brokers detect clients who meet reporting criteria and verify their reports, including the software information. Brokers must refuse program-trading orders from clients who still do not report after being urged.
  - Article 21 lists the cases in which brokers must refuse orders or cancel them.
  - [SSE 实施细则 (docx)](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781696/files/c60d05e3e84f4529956bbca3b9704170.docx)
- **《证券公司交易信息系统接入管理规范（试行）》 (official contents as reported).** The 中国证券业协会 (SAC) and 中国证券投资基金业协会 (AMAC) issued it on **2026-08-28**, effective the same day, in 5 chapters and 33 articles.
  - **Scope:** it applies whenever a broker provides "交易信息系统接入" (trading-system access) to brokerage clients. Access is defined as the broker using system interfaces or similar means to interact with the client's own order-generation system ("外部信息系统") and accept its orders.
  - **Broker duties:** full-process and penetrating management (穿透管理) of client identity, accounts, source of funds and trading behaviour. Unverified or unauthorised access must be refused and blocked.
  - **Fairness:** brokers must "公平对待交易信息系统接入客户" and may not give any access client differentiated technical or business resources.
  - **Article 23 bans:** submitting orders from unreviewed external systems, transferring system-management responsibility, and facilitating 场外配资 (off-exchange margin lending).
  - **Article 24:** clients with off-exchange margin lending or illegal-business violations in the past three years may not connect.
  - **Deployment limits:** client systems may not be deployed in broker server rooms or connected over a LAN. Technology providers may not install or run trading terminals or order-generation systems on public cloud or other shared computing.
  - **Private funds:** separate conditions apply to private fund managers, for example first product filed at least one year earlier and at least two technical staff. Brokers report private-fund-manager access quarterly, within 10 working days of quarter-end, plus an annual report by April 30.
  - The press reports do not mention individual investors, QMT/PTrade or any asset threshold.
  - Sources: [每日经济新闻 2026-08-28](https://www.mrjjxw.com/articles/2026-08-28/4565387.html); [第一财经 2026-08-28](https://www.yicai.com/news/103339460.html); [蓝鲸新闻 2026-08-28](https://www.lanjinger.com/t/2468123)
- A press summary adds that under equal conditions brokers should steer clients toward the broker's own trading terminals first. — (search excerpt) [财联社](https://www.cls.cn/detail/2494979)
- **Weaker: post-2026-08-28 reports from social media and forums.**
  - An X post claims individuals "暂时申请不了QMT" (cannot apply for QMT for now) because the new rules tightened individual program-trading access. It says no individual can currently apply for any "类外接通道" (external-access-like channel), that some brokers stopped new quant permissions around 2026-09-11, and that existing users kept theirs. It cites the rule as both "中证协发〔2026〕182号" and "中基协发〔2026〕19号", an inconsistency it does not resolve.
  - A V2EX user reports that a branch told individuals it would phase out file orders (文件单), batch pre-placed orders and miniQMT permissions.
  - Sources: (weaker; search excerpts) [X post](https://x.com/XiaoM17/status/2098307669660668121); [V2EX](https://www.v2ex.com/t/1240326); [行业文章 "8.28 接入新规落地"](https://www.0632999.com/news/1584.html)
  - These claims are partly contradicted by 财联社's 2026-09-29 report that 国金 and 申万宏源 offer QMT/PTrade to individuals. — [财联社](https://www.cls.cn/detail/2494979)

### Inferences
- **Two tiers have emerged.**
  - Broker-hosted or broker-controlled environments (PTrade on broker servers, strategies run inside the QMT client) remain open to individuals at thresholds from about 10万 to 50万元 at some brokers.
  - Local "external process" setups (miniQMT plus the user's own Python) are what the 2026 access rules reach. Since XtQuant needs a local MiniQMT client that the user's own program drives, it fits the rule's definition of a client order-generation system interacting through a broker interface.
  - Anyone planning a retail stack should confirm with the broker, in writing, whether miniQMT remains permitted for individuals.
- **Reporting obligations follow.** Any of these routes used for fully automated trading also triggers the program-trading report (Section 2). Brokers may only connect systems they have verified, and the software name, version and developer must be reported.

### Gaps
- I found no broker's own official web page stating QMT/miniQMT/PTrade thresholds, risk ratings, experience requirements or fees. The best evidence is 财联社's reporting. No fee information (software or data fees, or commission tie-ins) was found anywhere official.
- I could not read the full text of the 2026-08-28 access rules from SAC or AMAC, so I cannot confirm whether they mention individuals or broker-provided terminals such as QMT/PTrade. The document number is also unconfirmed.
- 掘金量化 broker integrations, 金字塔 (Pyramid), 文华财经 and TB were not verified, and no official broker list for 迅投 or 恒生 was found. Their sites rendered no content to the fetch tool.

## 2. How an individual files the 程序化交易报告 (program-trading report) through a broker, and whether 条件单, 网格交易 or 智能单 count

### Takeaway
An individual whose trading meets any of five SSE reporting triggers must report to the broker before the first program trade. The broker verifies the report, confirms it to the client, and forwards it to the exchange within five trading days. Material changes must be reported by about the fifth trading day of the following month. The form covers identity, funds and leverage, strategy and execution type, peak order-rate bands, and software name, version and developer. The SSE's filling instructions exempt investors who trade with broker-provided client software that has "一定自动化功能" (some automation) and who meet no trigger. Ordinary 条件单 (conditional orders) and 网格 (grid) use is therefore normally not reportable, but a fully automated QMT/PTrade strategy, or self-written software, is. Since 2026-01-12, northbound Stock Connect investors report on equal terms.

### Cited Findings
**Rules and their status**
- **SSE 实施细则 (issued 2025-04-03, effective 2025-07-07; official text).**
  - **Article 2 definition:** program trading is "通过计算机程序自动生成或者下达交易指令" (computer programs automatically generating or submitting orders). It includes automatic selection of securities and timing, and "按照设定的算法自动执行交易指令" (automatic execution of orders by a set algorithm). It covers stocks, bonds, funds and DRs.
  - **Article 8 timing:** a broker client must report to the broker before its first program trade ("首次进行程序化交易前"), and may trade only after the broker has fully checked the information and confirmed it. The broker reports to the SSE within five trading days.
  - **Article 9 contents:** account basics; fund size and source; leverage size, source and ratio; strategy type and main content; order execution method; maximum order rate; maximum daily order count; software name, version and developer; contacts.
  - **Article 10 material changes:** changes in fund size or leverage, contacts, rate bands, main strategy or software, or stopping program trading. A client must report a change to the broker "在下一个自然月的第五个交易日之前" (before the fifth trading day of the following month), and the broker forwards it within five trading days.
  - **Article 13 sanctions:** reminders, then oral or written warnings, regulatory talks, or suspending or restricting the account.
  - **Article 15:** brokers keep records for at least 20 years.
  - [SSE 实施细则 (docx)](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781696/files/c60d05e3e84f4529956bbca3b9704170.docx)
- **The 2023 reporting notice remains in force.** 《关于股票程序化交易报告工作有关事项的通知》 (上证发〔2023〕144号) was issued 2023-09-01 and took effect 2023-10-09. It lists the same items and the 300-per-second and 20,000-per-day extra-reporting triggers. Its attachments are the 《程序化交易投资者信息报告表》 (report form, xlsx) and its 填报说明 (filling instructions, docx). — [SSE notice page](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20250612_10781705.shtml)
  - The SSE said on 2025-04-03 that the earlier stock and CB program-trading reporting notices do not conflict with the new rules and "继续为市场相关主体履行报告义务提供具体指引" (continue to guide reporting), with possible consolidation later. — [SSE 2025-04-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250403_10776805.shtml)

**Who must report: the five triggers and the client-software exemption (official SSE 填报说明)**
- An investor must report if its SSE stock trading meets any one of these. — [SSE 填报说明 (docx)](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781705/files/5c50468ec61547c8a0d775f2a34d9f89.docx)
  1. **"下单自动化程度高"** (highly automated order placement): code, direction, quantity, price and the timing of orders are all decided by computer.
  2. **"申报速率快"** (fast order rate): "1天出现10次以上1秒钟内10笔以上申报（含撤单申报）", i.e. on at least 10 occasions in a day, 10 or more orders (including cancels) within one second.
  3. **Many stocks and high turnover:** a 30-trading-day average of at least 50 SSE stocks traded per day, and 30-day annualised turnover of 30 times or more.
  4. **"使用自主研发或其他定制软件"** (self-developed or other custom software).
  5. Other cases the exchange designates.
- **Exemption (quoted):** "使用会员为客户提供的带有一定自动化功能的客户端软件进行交易的，且不符合上述条件的投资者，无需进行报告。" Investors who trade with broker-provided client software that has some automation, and who meet none of the triggers, need not report. — [SSE 填报说明](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781705/files/5c50468ec61547c8a0d775f2a34d9f89.docx)
- 华鑫证券 hosts the same 填报说明 with a footnote defining annualised turnover as "该账户（最近30个交易日沪市日均交易金额）/（最近30个交易日沪市日均持仓金额）×当年交易日天数" (average daily traded value ÷ average daily holdings value × trading days in the year). — [华鑫证券 copy (PDF)](https://www.cfsc.com.cn/www/doc/ssexxtbbtbsm_gpjj.pdf)
- **Existing program traders:** those who had traded programmatically in the year before 2023-10-09 had to report within 60 trading days. — [SSE 填报说明](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781705/files/5c50468ec61547c8a0d775f2a34d9f89.docx)

**What the form contains (official SSE 填报说明; one CSV row per account)**
- **Identity:** broker name and code; account name; ID number as registered with 中国结算; product code (for product accounts); SSE account code(s); product manager. — [SSE 填报说明](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781705/files/5c50468ec61547c8a0d775f2a34d9f89.docx)
- **Report type and date:** 报告类型 is "首次" (first), "变更" (change) or "停止使用" (stopped). A stopped account must re-report as a first report before resuming. The report date for a client is the date it reported to the broker.
- **Funds and leverage:**
  - 账户资金规模 (assets used for stock, fund and DR trading, in 万元).
  - Source of funds: 自有 (own), 募集 (raised), 杠杆 (leveraged) or 其他 (other), with percentage shares.
  - 杠杆资金规模 and source: 融资融券 (margin), 场外衍生品 such as 收益互换 (OTC derivatives such as total-return swaps), or 其他 such as 个人借贷 (personal loans).
  - 杠杆率 (total assets ÷ net assets).
- **Products traded:** 股票, 基金, 存托凭证.
- **Strategy (if 量化交易, quantitative trading):** main strategy, pick one: 指数增强 (index enhancement), 市场中性 (market neutral), 多空灵活 (flexible long-short), 量化多头 (quant long-only), 管理期货 CTA, 参与新股发行 (IPO participation), 量化套利 (quant arbitrage), 日内回转 (intraday round trips), 其他. Up to two secondary strategies may be added, each with a summary, plus the names and codes of any futures hedging accounts.
- **Execution algorithms:** TWAP, VWAP, POV or other, with a summary.
- **账户最高申报速率 (peak orders per second band):** 500 and above, 300–499, 100–299, or below 100.
- **账户单日最高申报笔数 (peak daily orders band):** 25,000 and above, 20,000–24,999, 15,000–19,999, 10,000–14,999, or below 10,000.
- **High-frequency bands:** choosing either of the top two bands in either measure requires the server location, a system test report and a contingency plan.
- **Software:** program-trading software full name and version; developer.
- **Contacts:** broker contact, and the investor's responsible person ("如为个人客户，填写本人及其联系方式", for an individual, the client and their contact details).

**When to update (official SSE 填报说明)**
- **Material changes that must be reported:**
  - fund size changes by 5 times or more and by 1,000万元 or more;
  - the leverage source changes;
  - leverage size changes by 1 time or more and by 500万元 or more;
  - contacts change;
  - the peak order-rate or daily-count band changes;
  - the main strategy type changes;
  - the system information changes;
  - the account stops program trading.
- **Timing:** clients report "在变更发生后下一个自然月的前5个交易日内" (within the first five trading days of the month after the change), and the broker forwards within five trading days of receipt.
- The 2025 实施细则's wording ("before the fifth trading day of the next month") is marginally stricter than the 2023 instructions ("within the first five trading days").
- [SSE 填报说明](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781705/files/5c50468ec61547c8a0d775f2a34d9f89.docx); [SSE 实施细则](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781696/files/c60d05e3e84f4529956bbca3b9704170.docx)

**Northbound and HKEX FAQ (for contrast)**
- **Rules:** the SSE/SZSE northbound reporting guidelines (报告指引) were issued 2025-07-11 and took effect **2026-01-12**. They use the same five triggers and the same broker-software exemption. Existing northbound program traders had until **2026-04-10**, and new ones must report before their first trigger.
- **HKEX FAQ:** HKEX's FAQ (2026-01-09) says that when core order elements are generated automatically, it does not matter whether the algorithm belongs to the investor or to the HKEX participant (broker).
- [君合 legal update 2026-01-27](https://junhe.com/legal-updates/2899)

**Broker conditional, grid and smart tools**
- Brokers market server-side grid and conditional tools, for example 国投证券's "AI智能网格" (AI grid) and 西部证券's margin-account intelligent trading with grid, take-profit/stop-loss and pullback-sell orders. In the coverage found, none states a reporting duty for using them. — (search excerpts) [财联社](https://www.cls.cn/detail/2437221); [新浪 2025-02-27](https://finance.sina.cn/2025-02-27/detail-inemxvrz7687487.d.html)
- I found no exchange FAQ that names 条件单, 网格交易 or 智能单 specifically. The SSE 2023 notice and 2025 rules do not mention them. — [SSE notice page](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20250612_10781705.shtml); [SSE 2025-04-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250403_10776805.shtml)

**Futures (from the earlier pass, for completeness)**
- Futures program traders must report "先报告、后交易" (report first, then trade) from 2025-10-09 if any of these apply: 10 or more occasions per day of 10 or more orders/cancels within one second; fully automated order decisions; self-developed or custom software; other cases. Pre-existing traders had until 2026-04-08. — [界面](https://m.jiemian.com/article/13185947.html); [同花顺 2025-08-12](https://news.10jqka.com.cn/20250812/c670294168.shtml)

### Inferences
- **Conditional and grid orders.** These are inside the broad Article 2 definition, since conditions are preset and execution is automatic. In practice they fall under the client-software exemption: the user fixes code, direction, quantity and price, so trigger 1 (computer decides all of them plus timing) is not met. Their order rates are far below trigger 2, and they rarely span 50 stocks at 30 times turnover (trigger 3).
- **Fully automated strategies.** A strategy that picks stocks and sizes orders in QMT/PTrade meets trigger 1. Self-written Python driving miniQMT likely also meets trigger 4. Both must be reported.
- **Northbound contrast.** HKEX's position that a broker-owned algorithm does not exempt an investor is stricter in tone than the SSE's broker-software exemption.

### Gaps
- I did not retrieve the SZSE equivalents (实施细则 and 填报说明) or the SSE/SZSE CB program-trading reporting notice. The SSE says such CB notices exist; their date and triggers are unverified. The SZSE triggers are presumed but not confirmed to match.
- No exchange or broker document addresses broker server-side 条件单/网格 explicitly. The conclusion above rests on the general exemption.
- Futures exchanges' treatment of futures-firm server-side conditional orders (文华, 快期) under the "fully automated" trigger was not found.

## 3. Exchange monitoring of abnormal program trading under the 2025 实施细则, and differentiated HFT fees

### Takeaway
The 2025 rules (effective 2025-07-07) define four abnormal types, but only qualitatively ("达到一定标准", reaching a certain standard). The numeric indicators, on trial since 2024-04, have not been published. The SSE says they were triggered mainly by quant private funds and broker proprietary desks, and "中小个人投资者基本未发生相关情况" (small individual investors basically never triggered them). The only published numbers are the HFT definition, 300 or more orders and cancels per second or 20,000 or more per day for one account. Differentiated HFT fees, meaning extra flow and cancellation fees, are authorised in Article 37, but as of 2026-10-31 I found no published fee schedule. The 2024 consultation figures (0.1→1元 per order, 5元 per cancel) remain unconfirmed.

### Cited Findings
- **The four abnormal types (SSE 实施细则 Article 18, official text).**
  1. "瞬时申报速率异常" (abnormal instantaneous order rate): order and cancel counts within one second reach a certain standard.
  2. "频繁瞬时撤单" (frequent instantaneous cancels): several occurrences in a day of an order placed and cancelled within one second, together with a full-day cancel ratio reaching a standard.
  3. "频繁拉抬打压" (frequent ramping or suppression): several occurrences in a day of one-minute price moves in a stock, together with the investor's share of volume in that minute, reaching a standard.
  4. "短时间大额成交" (large trades in a short time): the one-minute move of the SSE Composite or STAR 50 index, together with the investor's aggressive buy or sell value and share, reaching a standard.
  5. Other behaviour the SSE designates.
  - Bonds, funds and DRs are monitored by reference to the same standards, and the SSE may adjust them.
  - Behaviour that stays under the indicators but repeatedly comes close ("接近指标且多次实施同类型交易行为") may still be deemed abnormal.
  - Institutions may not split products to evade monitoring.
  - [SSE 实施细则](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781696/files/c60d05e3e84f4529956bbca3b9704170.docx)
- **Sanctions and related measures (same rules).**
  - Article 17: real-time monitoring.
  - Article 25: suspensions or restrictions are reported to CSRC local offices and the associations.
  - Article 31: brokers must suspend a client's co-location use after repeated account restrictions within one month.
  - Article 35: HFT abnormal trading is punished "从严从重" (more severely).
  - Article 40: northbound investors are monitored on identical standards.
  - Article 32: investors whose order and cancel counts reach a set standard may be charged higher fees for value-added market data. Details are "由本所另行规定" (to be set separately).
  - [SSE 实施细则](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781696/files/c60d05e3e84f4529956bbca3b9704170.docx)
- **HFT definition (Article 33):** "单个账户每秒申报、撤单的最高笔数达到300笔以上" or "单日申报、撤单的最高笔数达到20000笔以上" ("以上" includes the number itself, Article 46).
- **HFT extra reporting (Article 34):** server location, system test report and contingency plan. Public funds, asset-management members and QFIs using impact-reducing order-splitting algorithms are exempt.
- **Differentiated fees (Article 37):** the SSE "可以对高频交易实施差异化收费…加收流量费和撤单费等费用。具体收费标准由本所另行规定" (may charge HFT differentiated fees, adding flow and cancellation fees; the schedule is to be set separately). — [SSE 实施细则](https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/10781696/files/c60d05e3e84f4529956bbca3b9704170.docx)
- **SSE statement (2025-04-03).**
  - Indicators for the four types have been on trial "自2024年4月起".
  - Triggers came mainly from "量化私募、券商自营等机构投资者", and "中小个人投资者基本未发生相关情况".
  - Normal trading was not affected.
  - The differentiated-fee plan will be set "在证监会统一指导下，适时制定出台" (under CSRC guidance, at an appropriate time), with no date.
  - [SSE 2025-04-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250403_10776805.shtml)
- **Thresholds unpublished.** Legal commentary confirms the numeric indicators have not been published, and that the rules give no standard for "一定标准" or "小幅拉抬打压". — (search excerpts) [通力律师 commentary](https://www.llinkslaw.com/Public/Uploads/uploadfile3/files/20260711c/63_1744246813.pdf); [21世纪经济报道 2025-04-04](https://www.21jingji.com/article/20250404/f16ffa519a5ccd89d208e2d07747833c.html)
- **2024 consultation (never confirmed as final).** HFT accounts' flow fee would rise from 0.1元 to 1元 per order, plus 5元 per cancel. Head quant firms told 界面 they had received no formal document. — [华尔街见闻 2024-07-28](https://wallstreetcn.com/articles/3721499); (search excerpt) [界面](https://www.jiemian.com/article/9658596.html)
- **Futures exchanges.** Yicai Global reported (January 2025) that China's five major futures exchanges said they would not lower HFT fees. — (search excerpt) [Yicai Global](https://www2.yicaiglobal.com/news/chinas-futures-exchanges-wont-lower-high-frequency-trading-fees)
- **INE 2026 revisions.** INE's rule list shows its 异常交易行为管理细则 (abnormal-trading rules) dated 2026-07-06 and its 实际控制关系账户管理细则 (actual-control account rules) dated 2026-10-09. I did not read their contents. — [SHFE/INE 业务办法 list](https://www.shfe.com.cn/regulation/ineregulation/businessmethods/)

### Inferences
- **Retail exposure is low but not zero.** HFT surcharges (once issued) and HFT reporting are irrelevant to almost all individuals. The open-ended "接近指标且多次" clause and the 1-second order/cancel and cancel-ratio tests can still catch aggressive limit-up (打板) bots that repeatedly place and cancel queue orders, even at low daily counts. Bots should rate-limit cancels and avoid sub-second place/cancel cycles.
- **Fee schedules.** Because no fee schedule has been issued in the 18 months since the 2025-04-03 announcement, cost models should treat the 2024 consultation figures as hypothetical.

### Gaps
- No numeric thresholds are published for any of the four abnormal types (searched three ways). No evidence was found that a differentiated HFT fee schedule, or the Article 32 market-data surcharge, was issued by 2026-10-31.
- The SZSE and BSE versions of Article 18 were not read. The SSE wording covers the SSE Composite and STAR 50, and the other exchanges presumably use their own indices.

## 4. T+0 (当日回转, same-day round-trip) instruments in 2026, and what the 2026-07-06 rule changes did to them

### Takeaway
The SSE's 2026 trading rules (上证发〔2026〕41号, issued 2026-04-24, effective 2026-07-06) list the official T+0 instruments in Article 3.1.5:
- bond ETFs;
- exchange-traded money-market funds;
- gold ETFs;
- commodity-futures ETFs;
- cross-border ETFs and cross-border LOFs (only where the underlying market itself allows T+0);
- warrants;
- other products the CSRC approves.

B shares settle from the next day, and ordinary equity ETFs, LOFs and stocks stay T+1. SZSE CBs are T+0 under SZSE's 2025 CB rules. The 2026 revision did not change the T+0 list. It changed execution: SSE funds now close by a 14:57–15:00 call auction, and post-close fixed-price trading (15:05–15:30, at the close) covers all A-shares and ETFs.

### Cited Findings
- **The T+0 list (SSE 交易规则（2026年修订）, Articles 3.1.4–3.1.5, official text).**
  - Article 3.1.4: securities bought may not be sold before settlement unless they are round-trip eligible.
  - Article 3.1.5: "下列品种实行当日回转交易：（一）债券交易型开放式指数基金；（二）交易型货币市场基金；（三）黄金交易型开放式证券投资基金；（四）商品期货交易型开放式指数基金；（五）跨境交易型开放式指数基金；（六）跨境上市开放式基金；（七）权证；（八）经证监会同意的其他品种。" The cross-border ETF and LOF items cover only funds whose index constituents or investment targets themselves allow same-day round trips. "B股实行次交易日起回转交易" (B shares round-trip from the next day).
  - [SSE rules page](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml); [rules text (docx)](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/e3a3b98e36894edca77841837936e006.docx)
- **Price limits for funds (Article 3.3.13):** SSE stocks and funds have a 10% daily limit. Funds tracking only STAR or other 20%-limit stocks (or at least 80% invested in them) have 20% (Article 6.6). — [rules text](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/e3a3b98e36894edca77841837936e006.docx)
- **What the 2026 revision changed (drafting note, official).** The changes are:
  - the fund closing session moves from continuous trading to a closing call auction "与股票保持一致" (same as stocks);
  - post-close fixed-price trading expands from STAR stocks to "全部A股和交易型开放式基金" (all A-shares and ETFs);
  - main-board risk-warning (ST) stocks' limit goes from 5% to 10%;
  - housekeeping, including deleting the discipline chapter.
  - The consultation ran 2026-04-10 to 04-17 and drew 14 comments. The note lists no change to round-trip rules.
  - [起草说明 (docx)](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/982290258b184b4b9c2b56a625202a9c.docx)
- **New execution mechanics (rules text).**
  - Article 2.4.2: continuous auction runs 9:30–11:30 and 13:00–14:57, then a closing call auction 14:57–15:00.
  - Article 3.3.1: the SSE host accepts no cancels from 9:20 to 9:25 or from 14:57 to 15:00 ("本所交易主机不接受撤单申报").
  - Article 4.1.3: the closing price is set by call auction. Failing that, it is the VWAP of the last minute up to and including the last trade.
  - Articles 3.7.1–3.7.10: post-close fixed-price trading is open to A-shares and ETFs. Orders are accepted 9:30–11:30 and 13:00–15:30 and can carry a limit price. Matching is by time priority at the closing price from 15:05 to 15:30, and the volume counts toward the day's turnover.
  - [rules text](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/e3a3b98e36894edca77841837936e006.docx)
- **Deferred provisions (official).** Block-trade fixed-price orders at the day's VWAP, a 16:00–17:00 block-trade session with T+1 settlement, and the related price bands were published but deferred, with timing "另行通知" (to be announced). — [暂缓实施条文 (docx)](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/f6bd756cdd8248f49b7795f62e73237f.docx)
- **Convertible bonds (SZSE 《可转换公司债券交易实施细则（2025年修订）》, official text; publication date inferred as 2025-03-27 from the file name; effective on issue, replacing the 2022-07-29 version 深证上〔2022〕719号).**
  - Article 5: "实行当日回转交易或者转让" (T+0).
  - Article 6: priced per 100元 of face value, tick 0.001元.
  - Article 13: buy orders in multiples of 1,000元 face value, up to 1亿元 per order.
  - Article 15: ±20% limit except on the listing day.
  - Article 16: on the listing day, intraday halts for 30 minutes at ±20% from the issue price and until 14:57 at ±30%.
  - Article 17: on the listing day, the opening-auction band is ±30% of the issue price and the continuous band ±10% of the last trade, with an all-day cap of 157.3% and floor of 56.7% of the issue price. Methods are 匹配成交 (matching), 协商成交 (negotiated) and 盘后定价成交 (post-close pricing).
  - [SZSE CB rules 2025 (PDF)](https://docs.static.szse.cn/www/lawrules/rule/allrules/bussiness/W020250327576698646997.pdf)
- **SZSE 2026-07-06 changes (from the earlier pass).** SZSE extended post-close fixed-price trading from ChiNext to all A-shares and ETFs. — [同花顺 2026-07-01](https://news.10jqka.com.cn/20260701/c677870245.shtml)

### Inferences
- **What stays T+1.** Ordinary A-share index ETFs (CSI 300, sector ETFs) and non-cross-border LOFs are absent from the list and therefore T+1. That includes commodity LOFs such as silver-futures LOFs, since the list names only commodity-futures ETFs. Intraday strategies on A-share beta must use CBs, or 底仓做T against existing holdings.
- **Closing auction for T+0 ETFs.** Since 2026-07-06, SSE T+0 ETFs (gold, bond, cross-border, commodity, money-market) close via a call auction with no cancellations after 14:57. Intraday strategies that flattened positions in the last minutes must now finish by 14:57 or accept an uncancellable auction order.
- **Post-close window.** The 15:05–15:30 window gives a guaranteed close-price execution for ETFs. It suits daily rotation strategies, and backtests that cross 2026-07-06 should model the change.

### Gaps
- I did not read the SZSE 2026 trading rules' round-trip article. The SZSE ETF/LOF T+0 list is presumed but not confirmed to match the SSE list.
- I did not read the SSE CB and bond rules. SSE CB T+0 is presumed from the SZSE rule and market practice.
- No official list of individual T+0 fund codes (for example a list of which cross-border funds qualify) was found.

## 5. Trading costs in 2026: exchange fees, transfer fee, regulatory fee, stamp duty, commissions, and ETF, CB and repo schedules

### Takeaway
Statutory and exchange charges on an A-share trade in 2026:

| Charge | Rate | Side |
|---|---|---|
| Stamp duty (印花税) | 0.05% | seller only, since 2023-08-28 |
| SSE/SZSE handling fee (经手费) | 0.00341% | both sides, since the 2023-08-28 cut |
| CSRC regulatory fee (证管费) | 0.002% | both sides |
| CSDC transfer fee (过户费) | 0.001% | both sides, since 2022-04-29 |

Broker schedules cap commissions at 3‰ with a 5元 minimum per trade. Retail offers run at about 万0.85–万1 of value, but whether waiving the 5元 minimum (免五) on stocks is allowed is disputed, and a 2025 rumour of a ban was not confirmed.

Other SSE handling fees:
- ETFs and LOFs pay 0.004% both sides, and money-market and bond ETFs are exempt.
- Listed-company CBs pay 0.004% both sides.
- Plain bonds (excluding CBs) are waived through 2026-12-31.

Reverse-repo commissions scale with tenor, from 0.001% for 1 day to 0.03% for 91–182 days. The 2025-12-26 waivers for 2026 do not touch stock, ETF or CB handling fees.

### Cited Findings
**Statutory and exchange charges on stocks**
- **Stamp duty (印花税).** It was halved to 1‰→0.5‰, paid by the seller only, from **2023-08-28**. — [华尔街见闻 2023-08-27](https://wallstreetcn.com/articles/3696465); (search excerpt) [新华网 2023-08-28](https://www.news.cn/2023-08/28/c_1212260850.htm). A broker schedule dated June 2025 still shows "印花税 0.5‰, charged to the seller only". — [德邦证券 收费标准](https://www.tebon.com.cn/main/businessGuide/economicBusiness/zqjyfgs/index.html)
- **经手费 (handling fee, official).** The SSE fee schedule, updated January 2026 and tax-inclusive, gives A-shares (main board and STAR) at "成交金额的0.00341%（双向）" (0.00341% of value, both sides), including STAR post-close fixed-price trades. Block trades are 30% lower. — [SSE 收费标准](https://www.sse.com.cn/services/tradingservice/charge/ssecharge/)
  - The cut from 0.00487% took effect **2023-08-28**. — (weaker; search excerpt) [理财问答](https://licai.cofool.com/ask/qa_2989412.html); (search result title) [证券时报 "正式降费、28日起实施！"](https://www.stcn.com/article/detail/952079.html)
- **证管费 (CSRC regulatory fee).** 0.02‰ (0.002%), both sides. — [德邦证券 收费标准 (June 2025)](https://www.tebon.com.cn/main/businessGuide/economicBusiness/zqjyfgs/index.html)
  - Some sources say 经手费 and 证管费 are collected within the quoted commission (佣金价内), while 过户费 and stamp duty are charged on top. — (weaker; search excerpts) [CSDN](https://blog.csdn.net/richardzhutalk/article/details/132956272); [摸鱼盯盘](https://moyukanpan.com/guide/stock-trading-fees/)
- **过户费 (transfer fee, 中国结算).** CSDC halved it from **2022-04-29**: SH/SZ A-shares went from 0.02‰ to 0.01‰ (0.001%), both sides, and BSE A-shares and NEEQ shares from 0.025‰ to 0.01‰. — (search excerpts) [第一财经](https://www.yicai.com/news/101396958.html); [HKEX circular CT037-22](https://www.hkex.com.hk/-/media/HKEX-Market/Services/Circulars-and-Notices/Participant-and-Members-Circulars/SEHK/2022/CT03722B.pdf)
- **Broker official schedule (德邦证券, June 2025).**
  - A-share commission is "按成交金额双向收取，不高于3‰" (both sides, no more than 3‰), and "每笔交易佣金不足5元的，按5元收取" (commissions under 5元 are charged as 5元).
  - ETFs, closed-end funds and LOFs have the same 3‰ cap and 5元 minimum.
  - BSE: commission cap 3‰, 经手费 0.125‰ both sides, 过户费 0.01‰, stamp duty 0.5‰ on the seller, and a 0.1‰ 结算费 (settlement fee) "暂免" (currently waived).
  - [德邦证券](https://www.tebon.com.cn/main/businessGuide/economicBusiness/zqjyfgs/index.html)

**Commission levels and the 5元 minimum**
- 证券日报 surveyed 27 brokers' new-client rates in May 2026. The lowest had fallen to 0.641‱ (万0.641), which industry interviewees called non-compliant.
  - The 2002 CSRC 《关于调整证券交易佣金收取标准的通知》 set a ceiling with downward floating.
  - SAC data show commission disputes were the largest complaint category in Q1 2026, at 19.2%.
  - (search excerpt) [证券日报 via 新浪 2026-05-30](https://finance.sina.com.cn/esg/2026-05-30/doc-inhzrrew0422786.shtml)
- 财联社 (late September 2025) reported a rumour that regulators would ban "万1免5" (1bp commission with the 5元 minimum waived). It was not confirmed, and brokers said they had received no notice. — (search excerpt) [财联社](https://www.cls.cn/detail/2160172)
- Some 国元证券 branches advertised "万0.854免五". 国元 replied that company policy requires branches to charge the 5元 minimum. — (search excerpt) [证券时报](https://www.stcn.com/article/detail/1076275.html)
- Self-media "2026 low-commission account" guides claim 万0.75–万0.85 免五 offers. Other self-media say compliant stock accounts can no longer waive the 5元 minimum, while ETF and CB waivers are within broker pricing discretion. — (weaker; search excerpts) [新浪 self-media 2026](https://k.sina.cn/article_7857141524_1d452771401901y8zg.html); [搜狐 2026 compliance explainer](https://www.sohu.com/a/1048438752_122920632)

**ETFs, CBs, bonds, repo and options (official SSE schedule unless noted)**
- **Funds (closed-end, ETF, LOF):** 竞价 (auction) handling fee "成交金额的0.004%（双向）" with "货币ETF、债券ETF暂免" (money-market and bond ETFs exempt). Fund block trades are 50% lower. REITs pay 0.0045% both sides, "试点期间暂免" (exempt during the pilot). — [SSE 收费标准](https://www.sse.com.cn/services/tradingservice/charge/ssecharge/)
- **Convertible bonds:** "成交金额的0.004%（双向）". The exemption covers only "除上市公司可转换公司债券以外" (CBs other than listed companies') from 2022-07-01 to 2026-12-31, plus listed-company CB 回售 (put) trades over the same period. — [SSE 收费标准](https://www.sse.com.cn/services/tradingservice/charge/ssecharge/). 德邦 likewise lists CB 经手费 at 0.04‰ both sides. — [德邦证券](https://www.tebon.com.cn/main/businessGuide/economicBusiness/zqjyfgs/index.html)
- **Bonds (债券现券):** 0.0001% both sides, capped at 100元 per trade, "自2022年7月1日起至2026年12月31日暂免" (waived 2022-07-01 to 2026-12-31). — [SSE 收费标准](https://www.sse.com.cn/services/tradingservice/charge/ssecharge/)
- **Repo, exchange fee:** 债券通用质押式回购 (general pledged repo) is 0.00005% for 1 day and 0.00015% for other tenors, both sides, capped at 100元. As rendered, the page shows a "试点期间暂免" note on the repo rows. — [SSE 收费标准](https://www.sse.com.cn/services/tradingservice/charge/ssecharge/)
- **Repo, broker commission (德邦, June 2025):** 1天 0.01‰, 2天 0.02‰, 3天 0.03‰, 4天 0.04‰, 7天 0.05‰, 14天 0.1‰, 28天 0.2‰, 91天 0.3‰, 182天 0.3‰. — [德邦证券](https://www.tebon.com.cn/main/businessGuide/economicBusiness/zqjyfgs/index.html)
- **Options, exchange fee:** 3元 per contract for stock underlyings and 1.3元 per contract for ETF underlyings, with "暂免收取卖出开仓交易经手费" (sell-to-open fee waived). — [SSE 收费标准](https://www.sse.com.cn/services/tradingservice/charge/ssecharge/)

**Fee changes, 2024–2026**
- **2025-12-26 (2026 measures).** The SSE's 《关于暂免收取部分2026年度费用的通知》 waives listed companies' listing fees, reduces trading-unit usage fees, waives handling fees on bonds other than CBs, and cuts gateway flow-speed and other subsidiary fees, for an estimated 11.13亿元. SZSE's 《关于减免2026年度相关费用的通知》 waives listing fees for listed companies and funds, SZSE fund trading-unit flow fees, and bond and ABS (ex-CB) trading-unit flow fees and handling fees. Neither touches stock, ETF or CB handling fees. — [新华网 2025-12-26](http://www.news.cn/fortune/20251226/ae9c29607e4945c9b830b819a10da276/c.html). 每日经济新闻 put the two exchanges' combined relief at more than 19亿元. — (search excerpt) [每日经济新闻](https://www.nbd.com.cn/articles/2025-12-26/4197841.html)
- **2024-12-27/28 (2025 measures).** The SSE cut trading-unit fees for 2025-07-01 to 2026-06-30. — (search excerpts) [人民网](http://finance.people.com.cn/n1/2024/1228/c1004-40391292.html); [新浪 2024-12-27](https://finance.sina.com.cn/china/2024-12-27/doc-ineawxxx4232355.shtml)
- **BSE.** The BSE extended its waiver of bond cash-trade handling fees (excluding CBs) to 2026-12-31. — (search excerpt) [北京日报](https://xinwen.bjd.com.cn/content/s684c04f5e4b0aabe0a024f59.html). The BSE stock handling fee was halved in August 2023, from 0.025% to 0.0125% both sides. — (search excerpt; attribution among results uncertain) [证券时报](https://www.stcn.com/article/detail/952079.html); current rate confirmed at 0.125‰ by [德邦证券](https://www.tebon.com.cn/main/businessGuide/economicBusiness/zqjyfgs/index.html)
- **HFT surcharges:** not issued (Section 3).

### Inferences
- **Worked examples (SSE/SZSE stock), from the rates above.**
  - Per side, regulated fees total 0.00641%: 经手费 0.341bp + 证管费 0.2bp + 过户费 0.1bp.
  - A 1万元 order at 万1 hits the 5元 minimum, which is 5bp per side. The round trip then costs about 5 + 5 + 5 (stamp) + 1.3 ≈ 16bp.
  - A 10万元 order at 万1 pays 10元 per side. The round trip costs about 1 + 1 + 5 + 1.3 ≈ 8.3bp.
  - Small-ticket strategies such as grids on low-priced stocks should therefore size orders above about 5万元 at 万1, or use instruments where brokers waive the minimum.
  - If a broker's quoted commission already includes 经手费 and 证管费 (the weaker "价内" claim above), subtract about 1.1bp from each round trip.
- **ETFs.** The fee pages list no stamp duty or transfer fee on ETFs. A round trip is then commission plus 0.4bp handling per side, or zero handling for bond and money-market ETFs. This makes T+0 bond and gold ETFs the cheapest high-turnover vehicles.
- **Commission ceilings versus market levels.** The 3‰ cap and 5元 minimum on broker schedules are ceilings and defaults. Negotiated levels of 万0.85–万1 are common, but "免五" on stocks sits in a regulatory grey zone.

### Gaps
- I found no official CSRC page for the 0.002% 证管费; it is confirmed only via a broker schedule.
- I found no official SZSE fee page (rates presumed equal to the SSE's). The SSE page doesn't say whether gold and cross-border ETFs pay the 0.004%; they are not listed as exempt.
- CB commission minimums (many brokers charge less than 5元 on CBs) and whether stamp duty or transfer fees apply to ETFs and CBs were not confirmed from official text.
- Whether the SSE "试点期间暂免" note really applies to the 通用质押式回购 row (204001 and others) could not be confirmed.

## 6. IPO subscription rules (新股申购): market-value requirements and units, BSE subscription and account threshold, the 2023 registration reform and the no-limit first five days, 2025–2026 changes

### Takeaway
On the SSE (rules revised March 2025) and SZSE, an investor needs at least 1万元 (10,000元) of unrestricted A-share and DR market value on that exchange, averaged over the 20 trading days ending T-2. Each 5,000元 buys one 500-share unit, capped at one-thousandth of the initial online tranche, with no cash paid until a win. Three unpaid wins in 12 months bring a 180-day ban that also covers CB and EB subscriptions. STAR IPOs additionally need STAR permission (50万元 plus 24 months). BSE IPOs are cash-subscribed and fully prepaid in 100-share units, capped at 5% of the online tranche, and require BSE permission (50万元 plus 24 months, set in 2021).

The full registration reform was issued and took effect on 2023-02-17. Main-board registration IPOs first listed on 2023-04-10, with no price limit for the first five days (previously a 44% first-day cap), and SSE halts of 10 minutes at ±30% and ±60% from the open. No 2026 change to retail subscription rules was found.

### Cited Findings
**SSE online issuance rules (《上海市场首次公开发行股票网上发行实施细则（2025年3月修订）》, official text; effective on issue, replacing 上证发〔2023〕35号)**
- **Article 3:** "持有上海市场非限售A股股份和非限售存托凭证总市值…10000元以上（含10000元）的投资者方可参与网上发行" (only investors with at least 10,000元 of unrestricted SH A-shares and DRs may subscribe).
- **Articles 4–9, market value:** measured per investor as the daily average over the 20 trading days ending T-2, including T-2. Multiple accounts and margin credit accounts are combined. Accounts younger than 20 days are averaged over 20 days anyway. Frozen or pledged shares still count.
- **Article 10, units and caps:** "每5000元市值可申购一个申购单位…每一个新股申购单位为500股". Subscriptions are capped at "当次网上初始发行股数的千分之一" (one-thousandth of the initial online shares) and at 9,999.95万 shares. Oversized orders are invalid.
- **Article 11:** subscription on day T, 9:30–11:30 and 13:00–15:00, "无需缴付申购资金" (no payment at subscription).
- **Article 13:** one account per investor; only the first order counts.
- **Article 15:** STAR IPOs require STAR suitability.
- **Article 18:** pay by the end of T+2.
- **Article 21:** "连续12个月内累计出现3次中签但未足额缴款" (three unpaid wins within 12 months) brings a 6-month ban (180 calendar days) from online IPO, DR, CB and EB subscriptions, counted per investor across all accounts.
- **Article 33:** investors in the offline tranche may not also subscribe online.
- [SSE 网上发行实施细则 2025 (doc)](https://www.sse.com.cn/lawandrules/sselawsrules/other/c/10776510/files/4964c44f4055468d980ef6cd7fa93613.doc)
- The rule number 上证发〔2025〕43号 comes from a search summary. — (search excerpt) [same document](https://www.sse.com.cn/lawandrules/sselawsrules/other/c/10776510/files/4964c44f4055468d980ef6cd7fa93613.doc)

**SSE 2023 changes (registration reform)**
- The main-board subscription unit fell from 1,000 to 500 shares and the market value per unit from 10,000元 to 5,000元, while the 10,000元 entry threshold stayed. Main-board IPOs have no limit for the first five days and 10% after; the previous first-day cap was 44%. — [证券时报 2023-02-21](https://www.stcn.com/article/detail/798434.html)

**SZSE**
- 2025–2026 SZSE IPO announcements still cite 《深圳市场首次公开发行股票网上发行实施细则》 (深证上〔2018〕279号) for online subscription, alongside the 2025 revision of the offline rules (深证上〔2025〕224号).
- Their terms: at least 1万元 of unrestricted SZ A-shares and DRs (20-day average to T-2); 5,000元 per 500-share unit; capped at one-thousandth of the initial online shares (for example 14,500 shares for 海安橡胶 and 6,500 shares for 纳百川).
- (search excerpts) [杭州高特 发行公告 2026-05-28](https://disc.static.szse.cn/download/disc/disk03/finalpage/2026-05-28/75907cea-148e-49ee-b218-363f49ebf029.PDF); [海安橡胶 初步询价公告 2025-11-06](https://disc.static.szse.cn/disc/disk03/finalpage/2025-11-06/af7a0ec9-ae12-4ac2-a3f1-715c7512b35d.PDF); [中国结算 2025-03 notice](http://www.chinaclear.cn/zdjs/gszb/202503/d43d590290184ef18287efa994559df6.shtml)

**BSE**
- **2026 BSE IPO announcements (发行公告):**
  - subscriptions in 100 shares or multiples;
  - "申购上限不超过网上发行数量的5%" (cap of 5% of the online tranche), for example 95.44万 shares for 康美特 (T = 2026-06-29);
  - oversized orders invalid;
  - investors must hold full subscription funds, with underfunded parts invalid;
  - one account per investor, first order counts.
  - (search excerpts) [康美特 发行公告 2026-06-25](https://dataclouds.cninfo.com.cn/sjother2/documents/2026/2026-06-25/bfb71f80702669f2d30ba8ff4ab56e53.pdf); [千岸科技 2026-07-16](http://dataclouds.cninfo.com.cn/sjother2/documents/2026/2026-07-16/20182dea38c2b9f1b7ba8eca090b86de.pdf); [维琪科技 2026-07-09](http://dataclouds.cninfo.com.cn/sjother2/documents/2026/2026-07-09/95cc8601b7f68afd5e5b130b393e1712.pdf)
- No holding of BSE market value is required, and oversubscribed tranches are allocated pro rata (比例配售). Rumours of a switch to market-value-based subscription are unsubstantiated. — (weaker; search excerpts) [理财问答 qa_7164895](https://licai.cofool.com/ask/qa_7164895.html); [bilibili](https://www.bilibili.com/read/cv43981388)
- **BSE account threshold:** set by the BSE's 2021 suitability rules. Individuals need "申请权限开通前20个交易日证券账户和资金账户内的资产日均不低于人民币50万元" (a 20-day average of at least 50万元, excluding margin) and 24 months of trading. Institutions have no threshold, and the BSE may adjust conditions with CSRC approval. — (search excerpt) [中证网 2021-09-18](https://cs.com.cn/xwzx/hg/202109/t20210918_6205179.html). Holders of STAR permission can add BSE "with one click" if rated professional or C4+. — [佣金宝 (国金证券) via 新浪 2025-10-31](https://finance.sina.com.cn/roll/2025-10-31/doc-infvupat5579785.shtml)

**Registration reform and listing-day rules**
- The CSRC issued the full-registration rules on **2023-02-17**, effective on publication: 165 rules in all, 57 from the CSRC and 108 from the exchanges, NEEQ and CSDC. The reform abolished the issuance review committees and removed administrative limits on IPO price and size. — (search excerpts) [CSRC](https://www.csrc.gov.cn/csrc/c100028/c7123213/content.shtml); [中国政府网](https://www.gov.cn/xinwen/2023-02/17/content_5741947.htm)
- The SSE and SZSE began accepting main-board applications on 2023-02-20. — (search excerpt) [中证网 2023-02-17](https://cs.com.cn/xwzx/hg/202302/t20230217_6324150.html)
- The first main-board registration IPOs (10 stocks) listed on **2023-04-10**. — (search excerpt) [21世纪经济报道](https://www.sfccn.com/2023/4-10/4NMDE1MjRfMTgxODY4NQ.html)
- **SSE 2026 rules, Article 3.3.13:** no price limit for "首次公开发行上市的股票上市后的前5个交易日" (the first five trading days after an IPO), for the first day of delisting-arrangement trading, or for the first day after relisting. STAR has the same five-day rule and a 20% limit thereafter (Article 6.6).
- **Article 4.2.4:** a stock without price limits is halted for 10 minutes when it first moves ±30% from the day's open, and again at ±60%.
- **Article 3.3.15:** for stocks without limits, opening-auction orders must be within 50%–900% of the previous close. Closing-auction orders must be within ±10% of the last trade.
- [SSE rules text](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/e3a3b98e36894edca77841837936e006.docx)

**2025–2026 changes**
- **SSE online rules** revised in March 2025 (above).
- **SZSE offline rules** revised in 2025 (深证上〔2025〕224号). — (search excerpt) [杭州高特 发行公告](https://disc.static.szse.cn/download/disc/disk03/finalpage/2026-05-28/75907cea-148e-49ee-b218-363f49ebf029.PDF)
- **SSE consultation (2025-01-03)** on the offline allocation rules for unprofitable STAR issuers: agreed lock-up tiers, and investors accepting longer lock-ups getting allocation ratios at least as high as others. It followed the CSRC's 2024-06-19 STAR "eight measures". It is a consultation, not a final rule, and does not change online subscription. — [SSE 2025-01-03](https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20250103_10767722.shtml)
- **科创成长层 (STAR growth tier):** a new 2025 permission that requires existing STAR permission plus professional or C4+ status. — [佣金宝 via 新浪 2025-10-31](https://finance.sina.com.cn/roll/2025-10-31/doc-infvupat5579785.shtml)

### Inferences
- **Effective cap for retail.** The market value at which an account reaches the 千分之一 cap varies by deal. For example, the 6,500-share cap on 纳百川 corresponds to 13 units, or 6.5万元 of SZ market value (6,500 ÷ 500 × 5,000元), and the 14,500-share cap on 海安橡胶 to 14.5万元. Beyond that, extra market value buys nothing for that IPO. I did not survey caps across deals, so how typical these levels are is unknown; large IPOs have higher caps.
- **BSE subscriptions.** BSE subscription ties up full cash for the subscription days and allocates pro rata. Expected value scales with cash committed, not holdings, and the 50万元 permission threshold is the real barrier.

### Gaps
- I did not read the SZSE online rules (2018 version) or the BSE issuance rules directly. BSE's pro-rata allocation detail rests on Q&A sources.
- I did not verify ChiNext's five-day no-limit rule and 20% limit (from 2020-08-24), or BSE's first-day no-limit and 30% limit thereafter, from official text in this pass.
- The official launch date and investor rules of 科创成长层 were not verified.

## 7. Access thresholds for derivatives and other markets: index futures, commodity futures and special products, commodity options, STAR/ChiNext, 港股通, and 2025–2026 changes

### Takeaway

| Market or permission | Individual requirement | Source and date |
|---|---|---|
| Ordinary commodity futures | No exchange-mandated asset threshold | SHFE suitability rules apply only to options and designated products |
| Commodity options and SHFE designated products (特定品种) | ≥10万元 available for 5 consecutive trading days, plus knowledge and experience | SHFE rules effective 2025-08-08 |
| INE crude oil futures and options | 50万元 | INE documents |
| CFFEX financial futures | 50万元 for 5 consecutive days, CFA test ≥80, and 10 days/20 simulated trades or 10 real trades in 3 years | CFFEX 2019 rules |
| STAR | 50万元 20-day average + 24 months | SSE 2026 rules §6.2 |
| ChiNext | 10万元 + 24 months | from 2020-04-28 |
| BSE | 50万元 + 24 months | 2021 |
| 港股通 | 50万元 | SZSE 深港通实施办法 (2023 revision); SSE rules |
| CBs (new individuals) | 10万元 + 24 months | revised March 2025 |
| Stock/ETF options | 50万元 + experience, test and simulation | earlier pass |

The only 2025–2026 changes found were procedural rule revisions: SHFE suitability rules (2025-08-08) and CB suitability notices (March 2025). The CSRC also designated SHFE nickel futures and options as 特定品种 in January 2026, and approved INE options on 20号胶, 低硫燃料油 and 国际铜. No change was found to the STAR, ChiNext, BSE or 港股通 thresholds.

### Cited Findings
**Commodity futures and options**
- **SHFE 《期货交易者适当性管理办法》 (issued 2025-08-07, effective 2025-08-08; official text).**
  - **Article 2:** "交易所期权合约交易和特定品种期货合约交易实行适当性制度" (suitability applies to options and designated-product futures).
  - **Article 6, individuals:**
    - full civil capacity;
    - futures knowledge;
    - experience, any one of: "累计不少于10个交易日且20笔及以上…仿真交易成交记录" (at least 10 days and 20 simulated trades), 10 or more domestic derivative trades in the past three years, or 10 or more recognised overseas trades;
    - "连续5个交易日保证金账户可用资金余额均不低于人民币10万元或者等值外币" (at least 10万元 available for five consecutive trading days);
    - no serious bad credit record.
  - **Article 7:** holding one suitability product at an institution lets the client add others without repeating assessments, unless the new product has a higher funds requirement.
  - **Article 8:** professional investors, holders of the permission elsewhere, clients with "近一年内具有累计不少于50个交易日" (50 or more trading days of domestic derivatives trades in the past year), and market makers are exempt from the knowledge, experience and funds requirements.
  - **Article 9:** the exchange may adjust the standards.
  - [SHFE 2025](https://www.shfe.com.cn/regulation/exchangerules/otherrules/202508/t20250807_828511.html)
- **ZCE.** ZCE's suitability rules use the same 10万元, five-consecutive-day available-funds test for options and designated products. — (search excerpt) [ZCE 期货交易者适当性管理办法](https://www.czce.com.cn/cn/rootfiles/2022/08/22/1655820773088227-1655820773120584.pdf)
- **INE crude oil.**
  - INE's 2017 operating guide includes a template stating individual clients must have "申请交易编码前5个交易日保证金账户可用资金余额均不低于人民币50万元或者等值外币" (at least 50万元 available for the five days before applying).
  - INE's 2021 crude-oil options manual repeats 50万元 for five consecutive days for individuals.
  - (search excerpts) [INE 适当性制度操作指南 2017 (doc)](https://www.ine.cn/upload/20170612/1497262445707.doc); [INE 原油期权操作手册 2021](https://www.ine.cn/upload/20210617/1623896844158.pdf)
  - The current 《上海国际能源交易中心期货交易者适当性管理细则》 took effect **2021-06-11**, per its official announcement page. Its PDF text could not be extracted (fonts without Unicode maps). — [INE notice page](https://www.shfe.com.cn/regulation/ineregulation/businessmethods/permitentry/202106/t20210611_797477.html)
- **Weaker: Q&A list of designated products and terms.** Designated products are said to include 原油, 铁矿石, PTA, 棕榈油, 20号胶, 低硫燃料油, 国际铜, 豆一, 豆二, 豆油, 豆粕, 菜油, 菜粕, 花生 and 集运指数(欧线). For 20号胶, 国际铜 and 低硫燃料油, the cited terms are 10万元 for five days, a test score of 80 or more, experience and C4, or alternatively 50 trading days of futures trading in the past year. — (weaker; search excerpts) [理财问答 qa_4603387](https://licai.cofool.com/ask/qa_4603387.html)
- **2026 designations.** The CSRC notice of **2026-01-23** designated SHFE nickel futures and options as 境内特定品种 (domestic designated products) and approved registration of INE options on 20号胶, 低硫燃料油 and 国际铜. SHFE said opening preparations were under way. — [中证网 2026-01-24](https://cs.com.cn/zzqh2020/202601/t20260124_6534940.html)

**Financial futures and options**
- **CFFEX financial futures.** CFFEX's 《交易者适当性制度管理办法》 and 《操作指引》 were both issued **2019-12-14**. Individuals need:
  - margin-account available funds of at least 50万元 on each of the five consecutive trading days before applying (a 2017 revision replaced the earlier point-in-time test);
  - the CFA knowledge test, passed at 80 of 100;
  - at least 10 trading days and 20 simulated financial-futures trades, or 10 or more real futures trades in the past three years.
  - (search excerpts) [CFFEX 管理办法 2019](http://www.cffex.com.cn/u/cms/www/202003/271635174xwg.pdf); [CFFEX 操作指引 2019](http://www.cffex.com.cn/u/cms/www/202003/27172125rlui.pdf); [CFFEX 2017 revision notice](http://www.cffex.com.cn/jysdt/20170628/20317.html); [CFA test outline 2023](https://www.cfachina.org/servicesupport/examination/executivetest/testoutline/202312/P020231227501636175867.pdf)
- **CFA knowledge test.** It has 20 questions (10 single choice and 10 true/false, 5 points each) and lasts 30 minutes. The pass mark has been 80 for all subjects since 2019-05-31. — (search excerpt) [中国期货业协会 2020-12-14](https://www.cfachina.org/servicesupport/examination/suitabilitytest/testinstructions/202012/t20201214_9387.html)
- **CFFEX 2026 trading rules.** A revised CFFEX trading rulebook dated 2026-04-10 exists. Its Article 21 restates members' suitability duties. — (search excerpt) [CFFEX 交易规则](http://www.cffex.com.cn/cn/gzjygz/20260410/43076.html)
- **Stock/ETF options (from the earlier pass).** Individuals need:
  - a 50万元 20-day average;
  - six months of trading plus margin or financial-futures experience;
  - the SSE-recognised test;
  - simulated trading.
  - [深圳证监局 2024-01-18](https://www.csrc.gov.cn/shenzhen/c105614/c7461701/content.shtml)

**Equity permissions**
- **STAR.** SSE 交易规则（2026年修订） §6.2: individuals need "申请权限开通前20个交易日证券账户及资金账户内的资产日均不低于人民币50万元" (excluding margin) and "参与证券交易24个月以上". The SSE may adjust these. — [SSE rules text](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/e3a3b98e36894edca77841837936e006.docx)
- **ChiNext.** The revised 《深圳证券交易所创业板投资者适当性管理实施办法（2020年修订）》 was published 2020-04-27 and took effect **2020-04-28**. New individual applicants need a 10万元 20-day average and 24 months of trading. Earlier holders are grandfathered, and moving to another broker requires re-qualifying. — (search excerpts) [深交所 解读](https://investor.szse.cn/institute/rules/t20200428_576517.html); [中证网 2020-04-27](https://www.cs.com.cn/app/weix/01/202004/t20200427_6051048.html); [天津证监局 Q&A](https://www.csrc.gov.cn/tianjin/c105375/c1263463/content.shtml)
- **港股通 (Southbound Connect).**
  - SZSE's 《深港通业务实施办法（2023年修订）》 still requires individuals' securities and fund account assets to total at least 50万元, and lets the exchange adjust this. — (search excerpt) [SZSE 深港通业务实施办法 2023](http://docs.static.szse.cn/www/disclosure/notice/W020230303594294153199.pdf)
  - The SSE requires 50万元, excluding margin, plus no serious bad credit record, a knowledge and risk assessment, and a risk disclosure. — (search excerpt) [SSE 投教 2014](http://edu.sse.com.cn/best/article/mcontent/c/4731141.shtml)
  - The SSE's 《沪港通业务实施办法（2024年修订）》 exists, but its text was not read. — [SSE page](https://www.sse.com.cn/lawandrules/sselawsrules2025/global/hkexsc/c/c_20251017_10795123.shtml)
  - A broker compilation gives the operational test as a 50万元 20-day average with professional or C4+ status and no experience requirement. — [佣金宝 via 新浪 2025-10-31](https://finance.sina.com.cn/roll/2025-10-31/doc-infvupat5579785.shtml)
  - At the 2024 NPC session, 雷添良 (Hong Kong SFC chairman) proposed lowering the threshold to 10万元. No adoption was found. — (weaker; search excerpt) [雪球](https://www.xueqiu.com/3070746985/281472756)
  - In 2017 the CSRC said the threshold would be studied with the Hong Kong SFC "根据市场条件". — (search excerpt) [CSRC reply](https://www.csrc.gov.cn/csrc/c101800/c1003930/content.shtml)
- **CBs (可转债).**
  - Individuals newly opening CB trading need a 10万元 20-day average and 24 months of trading. Holders before the original notice are grandfathered.
  - The SSE notice was originally issued 2022-06-17 and revised in March 2025. SZSE revised its notice on 2025-03-28, repealing 深证上〔2023〕511号.
  - Buying CBs in the delisting-arrangement period needs 50万元 plus 24 months.
  - (search excerpts) [SSE 2025-03 revision (doc)](https://www.sse.com.cn/lawandrules/sselawsrules/other/c/10776508/files/1613e3c9eabe4bbaa86ce24858a853fb.doc); [SSE 2022-06-17 page](https://www.sse.com.cn/lawandrules/sselawsrules/bond/convertible/trading/c/c_20220617_10776076.shtml); [SZSE 2025-03-28](http://www.szse.cn/lawrules/rule/memberty/t20250327_612574.html); [中证网 2023-06-16](https://cs.com.cn/xwzx/hg/202306/t20230616_6350737.html)
- **Delisting-arrangement stocks (退市整理股票):** individuals need 24 months of trading and a 50万元 20-day average (SSE 2026 rules §4.4.5). — [SSE rules text](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/10816482/files/e3a3b98e36894edca77841837936e006.docx)
- **Other permissions (broker compilation, dated 2025-10-31; the requirements are "具体以办理时要求为准", subject to those in force at application).**
  - Risk-warning stocks: professional or C4+.
  - REITs: C3+.
  - NEEQ innovation tier: 100万元 10-day average plus two years.
  - NEEQ base tier: 200万元.
  - Bond professional investor: 500万元 of financial assets, or 50万元 annual income over three years, plus experience.
  - Reverse repo: no condition beyond signing an agreement.
  - [佣金宝 via 新浪 2025-10-31](https://finance.sina.com.cn/roll/2025-10-31/doc-infvupat5579785.shtml)

### Inferences
- **Cheapest derivative routes.** For a retail quant with less than 10万元, ordinary commodity futures via CTP or vn.py are the only derivative market open, subject to program-trading reporting (Section 2). From 10万元, commodity options and most designated products open up. From 50万元, index futures, stock/ETF options, crude oil, STAR, BSE and 港股通 open up.
- **Nickel.** Once SHFE nickel trades as a designated product, new nickel traders will presumably face the 10万元 suitability test under SHFE Article 2. This is my inference; the 2026-01-24 report does not say so.

### Gaps
- The CFFEX site refused connections, and INE's site shows a slider CAPTCHA (not attempted). CFFEX and INE thresholds therefore rest on search excerpts of their own documents.
- INE's thresholds for 20号胶, 低硫燃料油, 国际铜 and 集运指数(欧线) were not verified (Q&A says 10万元).
- I did not verify whether DCE/ZCE designated products (铁矿石, PTA, 棕榈油) impose the 10万元 test on domestic individuals.
- I did not verify any futures-firm-level requirements for ordinary futures, such as risk-rating or knowledge tests under CSRC suitability rules.

## 8. Overseas access for mainland individuals (富途, 老虎, 盈透/Interactive Brokers), the legal routes (QDII, Connect, Wealth Connect), and crypto

### Takeaway
The cross-border online-broker route is being shut down. After the CSRC's 2022-12-30 rectification order (no new mainland clients; existing clients could trade but not add funds in breach of FX rules), the CSRC on 2026-05-22 opened investigations and issued penalty pre-notices against Tiger, Futu and Longbridge, proposing to confiscate all illegal gains. Eight departments' implementation plan, approved by the State Council, sets a two-year campaign during which existing mainland clients may only sell and withdraw funds, after which the firms must shut their mainland-facing apps, websites and servers. Tiger stopped mainland buying and deposits from 2026-06-12, per Caixin. The legal routes are QDII funds, 港股通 (50万元) and, for Greater Bay Area residents, Wealth Connect 2.0. Crypto trading is illegal onshore: the 2026-02-06 eight-department notice (银发〔2026〕42号) repealed and replaced the 2021 notice and also bans RWA tokenization and unapproved offshore RMB stablecoins.

### Cited Findings
**Cross-border brokers**
- **CSRC, 2022-12-30 (official).** Futu and UP Fintech (Tiger) conducted cross-border securities business with mainland investors without CSRC approval, which is illegal securities business. The plan was to "依法取缔增量非法业务活动": no soliciting of mainland investors, no new mainland clients, no new accounts. Existing investors could keep trading, but the firms "不得接受违反外汇管理规定的增量资金转入" (may not accept incremental funds transferred in breach of FX rules). Local offices would conduct on-site inspections. — [CSRC 2022-12-30](https://www.csrc.gov.cn/csrc/c100028/c6940083/content.shtml)
- **CSRC, 2023-02-15 Q&A.** The CSRC reiterated that existing clients would not be restricted without cause and that similar rectification would apply to the offshore subsidiaries of domestic brokers. — (search excerpt) [每日经济新闻 2023-02-15](https://www.mrjjxw.com/articles/2023-02-15/2670632.html)
- **CSRC, 2026-05-22 (official).**
  - It opened investigations and issued 行政处罚事先告知 (penalty pre-notices) to Tiger Brokers (NZ) Limited, 富途证券国际（香港）有限公司, 长桥证券（香港）有限公司 "境内外相关主体" (and related onshore and offshore entities).
  - It found they "未经我会核准，未取得经营证券经纪业务许可、经营证券融资融券业务许可" (had no CSRC approval and no brokerage or margin licences) while marketing and handling orders in mainland China. This breaches Securities Law Article 120, Fund Law Article 97 (illegal public fund sales) and Futures and Derivatives Law Article 63 (illegal futures brokerage).
  - It "拟决定没收…全部违法所得，并依法严厉处罚" (proposes to confiscate all illegal gains and impose severe penalties).
  - [CSRC 2026-05-22](https://www.csrc.gov.cn/csrc/c100028/c7634330/content.shtml)
- **Implementation plan.** 《综合整治非法跨境证券期货基金经营活动实施方案》 was issued by the CSRC and seven other departments "经国务院同意" (with State Council approval). It aims to "经过两年集中整治全面取缔境外证券期货基金经营机构非法跨境经营活动" (eliminate illegal cross-border activity within two years). — [每日经济新闻 2026-05-22](https://www.mrjjxw.com/articles/2026-05-22/4405416.html)
  - During the campaign it bans "为存量投资者在境内非法提供买入交易、转入资金等服务" (buying and deposits for existing investors) and allows "只允许单向卖出交易并转出资金" (only one-way selling and withdrawals).
  - Afterwards firms must "全面关停境内网站、交易软件及配套服务器" (shut down mainland websites, trading apps and servers).
  - The article gives no start or end date and names no firms beyond the three.
- **Futu's proposed fine.** Futu disclosed a proposed fine of 18.5亿元 and a personal fine of 125万元 on its founder and CEO. — (search excerpt) [澎湃](https://m.thepaper.cn/detail/33213504)
- **Mainland exposure.** Futu said mainland clients were about 13% of funded accounts, 17% of client assets and 20% of revenue. — (search excerpts) [Finance Magnates](https://datalab.financemagnates.com/compliance-insights/331-million-in-penalties-and-a-two-year-deadline-china-moves-to-end-cross-border-brokerage); [Yicai Global](https://www.yicaiglobal.com/news/chinese-mainland-client-assets-account-for-17-of-futus-total-ceo-says)
- **Conflict in secondary reporting.** Finance Magnates describes the firms as "fined" on 2026-05-22, but the CSRC text shows penalty pre-notices (proposed), not final decisions. — compare [Finance Magnates](https://datalab.financemagnates.com/compliance-insights/331-million-in-penalties-and-a-two-year-deadline-china-moves-to-end-cross-border-brokerage) with [CSRC](https://www.csrc.gov.cn/csrc/c100028/c7634330/content.shtml)
- **Tiger's cut-off.** Tiger Brokers stopped mainland clients from opening new positions or depositing funds from **2026-06-12**. — (search excerpt) [Caixin Global 2026-06-03](https://www.caixinglobal.com/2026-06-03/tiger-brokers-to-curb-chinese-mainland-trades-under-beijing-clampdown-102450415.html)
- **Hong Kong brokers.** Guotai Junan International reportedly restricted deposits and buy orders for mainland clients logging in from mainland IP addresses. — (search excerpt) [The Standard](https://www.thestandard.com.hk/finance/article/344121/Guotai-Junan-International-reportedly-curbs-trading-for-mainland-clients-amid-regulatory-clampdown). Hong Kong brokers are reportedly tightening checks, requiring proof that funds come from outside the mainland and in-person account opening in Hong Kong. — (weaker; search excerpt) [Crypto Briefing](https://cryptobriefing.com/chinese-brokerages-tighten-account-checks-regulatory-crackdown/)
- **Interactive Brokers (unconfirmed).** IBKR reportedly pulled its app from Chinese app stores in September 2025 and began requiring proof of overseas residency or employment from new mainland applicants. — (weaker; single secondary source) [Caproasia](https://www.caproasia.com/?p=77556)

**Legal routes**
- **QDII.** The cumulative approved quota was 1,830.09亿美元 by end-August 2026, with securities and fund firms passing 1,000亿美元. — (search excerpt, from the earlier pass) [同花顺 2026-09-01](https://news.10jqka.com.cn/20260901/c679463485.shtml). 港股通 requires 50万元 (Section 7).
- **Wealth Connect 2.0 (跨境理财通), revised GBA implementation rules effective 2024-02-26.**
  - Southbound eligibility needs full civil capacity, plus Greater Bay Area mainland-city hukou or two years of social-security or income-tax payments there (cut from five years).
  - It also needs two or more years of investment experience, plus any one of: household net financial assets of at least 100万元 at each of the last three month-ends; household financial assets of at least 200万元; or personal annual income of at least 40万元 over the last three years (a new option).
  - The individual quota rose from 100万元 to 300万元: 150万元 via banks and 150万元 via securities firms, which joined the pilot.
  - (search excerpts) [中国人民银行](https://www.pbc.gov.cn/goutongjiaoliu/113456/113475/67fdfc7c586b49f4a6f1085ebb4f49b7/index.html); [广东省人民政府](http://www.gd.gov.cn/zwgk/zcjd/snzcsd/content/post_4340135.html); [外汇局深圳分局](https://www.safe.gov.cn/shenzhen/2024/0308/1746.html)

**Crypto**
- **The 2026 notice (official text).** 《关于进一步防范和处置虚拟货币等相关风险的通知》 (银发〔2026〕42号) was issued by eight departments (PBoC, NDRC, MIIT, MPS, SAMR, NFRA, CSRC, SAFE) on **2026-02-06**, effective on issue. It states "银发〔2021〕237号同时废止" (the 2021 ten-department notice is repealed).
  - **Legal status:** virtual currency "不具有与法定货币等同的法律地位" (has no legal status equal to fiat) and "不具有法偿性" (is not legal tender).
  - **Illegal activities:** onshore exchange between fiat and crypto or among cryptos, acting as central counterparty, information intermediation and pricing services, token financing, and trading of crypto-related financial products are illegal financial activities, "一律严格禁止" (strictly prohibited).
  - **Offshore services:** "境外单位和个人不得以任何形式非法向境内主体提供虚拟货币相关服务" (offshore entities and individuals may not provide crypto services to onshore persons in any form).
  - **Stablecoins:** no RMB-pegged stablecoin may be issued offshore without approval.
  - **RWA tokenization:** onshore RWA tokenization and related services are banned unless approved and run on "特定金融基础设施" (designated financial infrastructure).
  - **Mining:** existing mining is to be shut down and new projects are banned.
  - **Individuals:** where individuals invest in crypto, RWA tokens or related products "违背公序良俗的，相关民事法律行为无效，由此引发的损失由其自行承担" (contracts contrary to public order and good morals are void, and losses are self-borne). Activity damaging financial order is investigated. Onshore persons who knowingly assist offshore providers face liability.
  - [CSRC copy of 银发〔2026〕42号](https://www.csrc.gov.cn/c100028/c7614318/content.shtml); (search excerpt) [新华网 2026-02-06](https://www.news.cn/fortune/20260206/b569f51297ce4d6c980c4954922cd7c2/c.html)
- **Lead-up (2025-11-28).** At its coordination-mechanism meeting on cracking down on crypto speculation, the PBoC said crypto business activities are illegal financial activities and that stablecoins are a form of virtual currency that cannot meet KYC and AML requirements. — (search excerpt) [华尔街见闻](https://wallstreetcn.com/articles/3760380)

### Inferences
- **No cross-border broker route remains.** For a mainland resident without overseas residency, from mid-2026 there is no compliant way to open or fund an account at Futu, Tiger, Longbridge or (probably) IBKR. Existing accounts are in run-off mode, sell and withdraw only, for about two years. Overseas-market quant exposure must come through QDII funds (often at premiums, see the earlier notes), 港股通 for Hong Kong stocks, or Wealth Connect for GBA residents.
- **Crypto.** Under the 2026 notice, crypto trading by mainland residents on offshore platforms is not compliant. Contracts are at risk of being void, and onshore facilitation is sanctionable. The notice does not expressly criminalise an individual merely holding crypto, so legal risk sits mainly in civil unenforceability and in any facilitation or fund-flow offences.

### Gaps
- I did not retrieve the text of the eight-department 实施方案 or its start date (hence the end of the two-year window), or the final penalty decisions.
- Interactive Brokers' current policy for mainland residents is unverified (single weak source).
- The status of the 5万美元 annual personal FX purchase quota and its restriction on overseas securities investment was not checked in this pass.
- I found no court guidance after the 2026 notice on whether individuals' crypto holdings are protected property.
