import { describe, expect, it } from 'vitest';
import { classifyQuestion, isChainQuestion } from '../src/search/route.js';

/**
 * Questions that chain through a relation go to the relation walk
 * (docs/design/30 §3). The 2026-11 benchmark's deep-hop and nonlexical-hop
 * questions all reached `lookup`: their hops run across sentences and refer
 * back ("此人", "那个项目"), which the noun-phrase rules never read.
 */
describe('chained questions', () => {
  const chains = [
    // the benchmark's four deep-hop shapes and two nonlexical-hop shapes
    '（第一事业部）2月华鼎零售升级的那起P1事故，修复它的工程师后来调到了另一个组，并在那里接手了一个项目。那个项目最终是在第几周上线的？',
    '（第一事业部）风险R-02后来换了负责人。新负责人自己负责的是哪个项目？那个项目到第44周为止情况如何？',
    '（第一事业部）提出风险R-03的人修复过一起由客户升级的事故。同一个客户还在另一个组升级过事故——那一起是谁修复的？',
    '第一事业部管基础设施的那个组今年第一起最严重一档的故障，是谁处理好的？此人名下的那个项目是在哪一周投产的？',
    '第一事业部管收款的那个组今年第二起最严重一档的故障，是谁处理好的？此人曾预警过一个隐患，眼下是谁在盯着那个隐患？',
    // other wordings
    '谁修复了INC-001？他现在负责哪个项目？',
    '平台组哪位同事处理了上周的故障？该同事今年还提出过哪些风险？',
    'Who handled the first P1 incident this year? Which project does that person own, and when did it launch?',
    'Who fixed INC-001? What project do they lead now?',
    'An engineer fixed INC-001 and later moved teams. When did their new project launch?',
    // past tense: isListQuestion reads "which team owns" as a which-plural, so the list route keeps it
    'Which team built Atlas? Who leads that team?',
  ];
  it.each(chains)('walks relations for %s', (q) => {
    expect(isChainQuestion(q), q).toBe(true);
    expect(classifyQuestion(q)).toMatchObject({ kind: 'multihop', by: 'rule:chain' });
  });

  const lookups = [
    'What is Atlas? When did it launch?',
    'Atlas项目最后上线了吗？哪一周？',
    'Atlas是什么？它是哪一周上线的？',
    '陈伟在哪个组？',
    '风险R-01是哪一周、由谁最早提出的？最后是在哪一周、怎么关闭的？',
    '截至2025年3月1日，平台组的订单库连接池上限是多少？',
    '平台组最新一周的服务可用性是多少？',
    'Who founded Borealis Logistics?',
    '(Division 1) As of week 44, what is the Platform 1 team\'s log retention period?',
    '其他组也有类似的问题吗？',
  ];
  it.each(lookups)('keeps %s off the walk', (q) => {
    expect(isChainQuestion(q), q).toBe(false);
    expect(classifyQuestion(q).kind, q).not.toBe('multihop');
  });

  it('leaves lists and counts that only say "the same kind" or "those" to the enumeration', () => {
    expect(classifyQuestion('（第一事业部）风险R-01说的那件事，在第一事业部的三个组的其他组里也被提出过吗？列出说的其实是同一个问题的风险编号。').kind).toBe('list');
    expect(classifyQuestion('INC-001-T1的根本原因，和第一事业部的三个组里哪些别的事故其实是同一类问题？列出事故编号。').kind).toBe('list');
    expect(classifyQuestion('Which P1 incidents did the Platform team have this year? Give each incident\'s ID.').kind).toBe('list');
    expect(classifyQuestion('How many incidents did the Platform team report? Which were they?').kind).toBe('aggregate');
    expect(classifyQuestion('风险R-01从提出到关闭经历了什么？按时间列出每一步（谁、哪一周）。').kind).toBe('timeline');
  });

  // found by an independent review (2026-11-16), each one sent to the walk and so losing its count or list
  const reviewed: [string, string][] = [
    ['宁德时代的人均产值是多少，它在行业里排第几', 'aggregate'], // 的人均 is not "the person who"
    ['哪家公司今年营收最高，它的净利润是多少', 'aggregate'], // a superlative the count route computes
    ['中国的人工智能公司有哪些，它们的估值一共多少', 'aggregate'], // a plural back to a list
    ['给我讲一个关于茅台的故事，它最近股价怎么样', 'lookup'], // a storytelling 一个, and 它 is 茅台
    ['List all incidents in 2025. Who fixed them?', 'list'], // they are the list
  ];
  it.each(reviewed)('is not a chain: %s', (q, kind) => {
    expect(isChainQuestion(q), q).toBe(false);
    expect(classifyQuestion(q)).toMatchObject({ kind });
  });

  it('gives a question that is both a list or count and a chain the route of whatever finds the thing', () => {
    // the count is what identifies the company: the count route
    expect(classifyQuestion('哪家银行的存款利率最高？那家银行的总部在哪？').kind).toBe('aggregate');
    expect(classifyQuestion('Which suppliers delivered late last quarter? Who manages that supplier?').kind).toBe('list');
    // the list or count is asked of the person the first part finds: the walk
    expect(classifyQuestion('谁修复了INC-001？他今年还修复过哪些事故？')).toMatchObject({ kind: 'multihop', by: 'rule:chain' });
    expect(classifyQuestion('Who fixed INC-001? How many incidents has that engineer fixed this year?')).toMatchObject({ kind: 'multihop', by: 'rule:chain' });
  });

  it('reads 那几个 as "those", not as a count', () => {
    const q = '西湖边办公的那几个组的甲方里，送快递的那一家记作甲；甲头一回闹出来的故障记作乙；乙事后领了改进活儿的人记作丙；丙走后顶了其位置的人记作丁。问：丁叫什么名字？只回答这一问。';
    expect(classifyQuestion(q)).toMatchObject({ kind: 'multihop', by: 'rule:chain' });
    expect(classifyQuestion('平台组今年出了几起事故？').kind).toBe('aggregate');
  });
});
