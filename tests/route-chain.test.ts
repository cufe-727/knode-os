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
    'Which team owns Atlas? Who leads that team?',
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
});
