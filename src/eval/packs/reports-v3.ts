import { rng } from '../metrics/stats.js';
import { seededKey } from '../pack.js';
import { cnNum } from './separation.js';

/**
 * Recipe v3 of the weekly reports (docs/design/33 §4): the hidden script.
 *
 * Two and a half years of one company (2024-W01 … 2026-W26, 130 weeks), in
 * divisions of three teams named after their city ("杭州平台组", "Oslo
 * Platform": no team's name lies inside another's at any size). Weeks 1–122
 * are the corpus, 123–126 four update batches, 127–130 the holdout. Beside the
 * weekly reports the script decides what the long documents say — quarterly
 * reviews, incident postmortems, monthly meeting minutes — and what the PMO's
 * monthly summary corrects (it says so, and says that it prevails).
 *
 * Everything a division holds is drawn in division order from one seeded
 * stream, so the first division is the same at 1×, 10× and 100× and so are its
 * questions (design 33 D5). Customers belong to their division; names of
 * people, projects, customers and nicknames are unique company-wide except the
 * planted namesakes and look-alikes.
 */

export type Lang = 'zh' | 'en';

export const V3_WEEKS = 130;
export const V3_CORPUS = 122;
export const V3_BATCHES = 4;
const START = Date.UTC(2024, 0, 1); // Monday of 2024-W01
const DAY = 86_400_000;

export const dayOf = (week: number, d = 0) => new Date(START + ((week - 1) * 7 + d) * DAY);
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const weeksUpTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
export const inCorpus = (w: number) => w >= 1 && w <= V3_CORPUS;

/** The ISO week of a report (by its Thursday, as ISO 8601 counts). */
export function isoWeek(week: number): { year: number; week: number } {
  const thu = dayOf(week, 3);
  const year = thu.getUTCFullYear();
  const doy = Math.floor((thu.getTime() - Date.UTC(year, 0, 1)) / DAY);
  return { year, week: Math.floor(doy / 7) + 1 };
}
export const weekLabel = (w: number) => {
  const x = isoWeek(w);
  return `${x.year}-W${String(x.week).padStart(2, '0')}`;
};
/** How a report names its week: "2025年第14周", "week 14 of 2025". */
export const weekName = (lang: Lang, w: number) => {
  const x = isoWeek(w);
  return lang === 'zh' ? `${x.year}年第${x.week}周` : `week ${x.week} of ${x.year}`;
};
/** Every way an answer may name a week. */
export function weekForms(w: number): string[] {
  const x = isoWeek(w);
  return [`${x.year}-W${String(x.week).padStart(2, '0')}`, `${x.year}年第${x.week}周`, `week ${x.week} of ${x.year}`, `${x.year} week ${x.week}`, iso(dayOf(w))];
}
/** A report is dated by its Monday: the month and quarter it belongs to. */
export const ymOf = (w: number) => ({ year: dayOf(w).getUTCFullYear(), month: dayOf(w).getUTCMonth() + 1 });
export const ymKey = (w: number) => `${ymOf(w).year}-${String(ymOf(w).month).padStart(2, '0')}`;
export const quarterOf = (w: number) => ({ year: ymOf(w).year, q: Math.ceil(ymOf(w).month / 3) });
export const quarterKey = (w: number) => `${quarterOf(w).year}-Q${quarterOf(w).q}`;
export const MONTHS_EN = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (lang: Lang, year: number, month: number) => (lang === 'zh' ? `${year}年${month}月` : `${MONTHS_EN[month]} ${year}`);
export const quarterName = (lang: Lang, year: number, q: number) => (lang === 'zh' ? `${year}年第${cnNum(q)}季度` : `Q${q} ${year}`);
/** The weeks of a month (by their Monday) and its last one. */
export const weeksOfMonth = (key: string, upTo = V3_WEEKS) => weeksUpTo(upTo).filter((w) => ymKey(w) === key);
export const weeksOfQuarter = (key: string, upTo = V3_WEEKS) => weeksUpTo(upTo).filter((w) => quarterKey(w) === key);
/** Months and quarters whose last week lies inside the corpus. */
export const corpusMonths = () => [...new Set(weeksUpTo(V3_CORPUS).map(ymKey))].filter((m) => Math.max(...weeksOfMonth(m)) <= V3_CORPUS);
export const corpusQuarters = () => [...new Set(weeksUpTo(V3_CORPUS).map(quarterKey))].filter((q) => Math.max(...weeksOfQuarter(q)) <= V3_CORPUS);

/* ---------------------------------- pools ---------------------------------- */

/** The first ten cities in the other language (cross-lingual questions); further divisions keep their own name. */
const CITY_ALT: Record<Lang, string[]> = {
  zh: ['Hangzhou', 'Chengdu', 'Wuhan', "Xi'an", 'Nanjing', 'Xiamen', 'Qingdao', 'Changsha', 'Kunming', 'Chongqing'],
  en: ['奥斯陆', '里斯本', '都柏林', '布拉格', '维也纳', '京都', '塞维利亚', '卑尔根', '克拉科夫', '里昂'],
};

/** Divisions by city: two-character names (no composite name inside another), the first ten described without their name. */
export const CITIES: Record<Lang, string[]> = {
  zh: ['杭州', '成都', '武汉', '西安', '南京', '厦门', '青岛', '长沙', '昆明', '重庆', '苏州', '合肥', '郑州', '济南', '福州', '贵阳', '南宁', '兰州', '太原', '沈阳',
    '大连', '长春', '南昌', '海口', '银川', '西宁', '宁波', '温州', '无锡', '常州', '南通', '徐州', '扬州', '镇江', '泰州', '盐城', '淮安', '绍兴', '嘉兴', '湖州',
    '舟山', '丽水', '衢州', '芜湖', '蚌埠', '安庆', '滁州', '阜阳', '泉州', '漳州', '莆田', '三明', '龙岩', '九江', '赣州', '吉安', '上饶', '烟台', '潍坊', '淄博',
    '威海', '日照', '临沂', '聊城', '滨州', '菏泽', '洛阳', '开封', '新乡', '许昌', '南阳', '信阳', '宜昌', '襄阳', '荆州', '十堰', '黄冈', '株洲', '湘潭', '衡阳',
    '岳阳', '益阳', '郴州', '珠海', '佛山', '东莞', '惠州', '江门', '汕头', '湛江', '茂名', '柳州', '桂林', '绵阳', '德阳', '宜宾', '泸州', '乐山', '南充', '遵义'],
  en: ['Oslo', 'Lisbon', 'Dublin', 'Prague', 'Vienna', 'Kyoto', 'Seville', 'Bergen', 'Krakow', 'Lyon', 'Madrid', 'Berlin', 'Munich', 'Zurich', 'Geneva', 'Milan', 'Turin', 'Naples', 'Athens', 'Sofia',
    'Warsaw', 'Riga', 'Tallinn', 'Vilnius', 'Helsinki', 'Malmo', 'Aarhus', 'Ghent', 'Bruges', 'Leiden', 'Utrecht', 'Porto', 'Valencia', 'Bilbao', 'Lille', 'Nantes', 'Bordeaux', 'Toulouse', 'Marseille', 'Genoa',
    'Verona', 'Bologna', 'Florence', 'Zagreb', 'Ljubljana', 'Graz', 'Salzburg', 'Basel', 'Lucerne', 'Dresden', 'Leipzig', 'Bremen', 'Hamburg', 'Cologne', 'Hanover', 'Galway', 'Belfast', 'Leeds', 'Bristol', 'Oxford',
    'Cardiff', 'Glasgow', 'Dundee', 'Quebec', 'Toronto', 'Ottawa', 'Calgary', 'Halifax', 'Denver', 'Austin', 'Boston', 'Seattle', 'Phoenix', 'Tucson', 'Omaha', 'Tulsa', 'Dallas', 'Houston', 'Atlanta', 'Memphis',
    'Nashville', 'Raleigh', 'Richmond', 'Tampa', 'Orlando', 'Miami', 'Santiago', 'Bogota', 'Quito', 'Recife', 'Manaus', 'Osaka', 'Sapporo', 'Busan', 'Hanoi', 'Manila', 'Jakarta', 'Hobart', 'Auckland', 'Wellington'],
};
/** Where the first ten divisions sit, in words that name no city (the hops' anchors). */
export const CITY_DESC: Record<Lang, string[]> = {
  zh: ['西湖边', '熊猫基地旁', '黄鹤楼下', '兵马俑附近', '秦淮河畔', '鼓浪屿对岸', '栈桥边', '橘子洲旁', '滇池边', '洪崖洞附近'],
  en: ['by the fjord', 'on the Tagus', 'on the Liffey', 'on the Vltava', 'by the Danube canal', 'near the bamboo grove', 'by the Guadalquivir', 'among the seven mountains', 'below Wawel hill', 'where the Rhone meets the Saone'],
};

export const KINDS: Record<Lang, { team: string; desc: string; metric: string; unit: string; base: number; step: number; titles: string[] }[]> = {
  zh: [
    { team: '平台组', desc: '管基础设施的那个组', metric: '服务可用性', unit: '%', base: 99.9, step: 0.0008, titles: ['缓存击穿', '数据延迟', '配置下发失败', '证书轮换中断'] },
    { team: '支付组', desc: '管收款的那个组', metric: '支付成功率', unit: '%', base: 97.2, step: 0.012, titles: ['支付超时', '账单错误', '退款卡单', '对账差异'] },
    { team: '增长组', desc: '管拉新的那个组', metric: '周活跃用户', unit: '万', base: 120, step: 0.6, titles: ['推送重复', '登录失败', '活动页白屏', '邀请码失效'] },
  ],
  en: [
    { team: 'Platform', desc: 'the infrastructure group', metric: 'service availability', unit: '%', base: 99.9, step: 0.0008, titles: ['cache stampede', 'data lag', 'config push failure', 'certificate rotation break'] },
    { team: 'Payments', desc: 'the group that moves the money', metric: 'payment success rate', unit: '%', base: 97.2, step: 0.012, titles: ['payment timeout', 'billing error', 'stuck refunds', 'ledger mismatch'] },
    { team: 'Growth', desc: 'the user-acquisition group', metric: 'weekly active users', unit: 'k', base: 1200, step: 6, titles: ['duplicate push', 'login failure', 'blank campaign page', 'broken invite codes'] },
  ],
};

const NAMES: Record<Lang, { sur: string[]; given: string[]; given2: string[]; twinSur: string[] }> = {
  zh: {
    sur: ['王', '李', '张', '刘', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗', '蒋', '蔡', '贾', '丁', '魏', '薛', '阎', '余', '潘', '杜', '戴', '夏', '钟',
      '汪', '田', '任', '姜', '范', '方', '石', '姚', '谭', '廖', '邹', '熊', '金', '陆', '郝', '孔', '白', '崔', '康', '毛', '邱', '秦', '史', '顾', '侯', '邵', '孟', '龙', '万', '段', '雷', '钱', '汤', '尹', '黎', '易', '常', '武', '乔', '贺', '赖', '龚', '文'],
    given: ['芳', '娜', '敏', '静', '强', '磊', '洋', '艳', '勇', '军', '杰', '涛', '明', '超', '霞', '平', '晨', '宇', '欣', '博', '鹏', '婷', '雪', '浩', '凯', '琳'],
    // two-character given names whose first character is no one-character given name: 王芳 is never inside 王芳菲
    given2: ['子涵', '雨萱', '安然', '梓轩', '思远', '嘉怡', '俊熙', '一诺', '若溪', '沐阳', '书瑶', '亦凡', '语桐', '景行', '知秋', '清扬', '以安', '星河', '慕白', '南乔',
      '可馨', '奕辰', '诗涵', '泽宇', '梦琪', '皓轩', '语嫣', '振华', '永康', '德胜', '立新', '国栋', '志远', '少卿', '怀瑾', '承泽', '韵寒', '紫萱', '晓东', '铭远',
      '天佑', '乐瑶', '睿哲', '海峰', '义山', '红梅', '秋生', '春兰', '冬梅', '玉兰'],
    twinSur: ['陈', '叶', '江', '彭', '吕', '苏', '卢', '蒋'],
  },
  en: {
    sur: ['Smith', 'Johnson', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Thomas', 'Lee', 'Martin', 'Clark', 'Lewis', 'Walker', 'Hall', 'Young', 'King', 'Wright', 'Scott',
      'Allen', 'Baker', 'Carter', 'Evans', 'Foster', 'Gray', 'Hughes', 'James', 'Kelly', 'Long', 'Morgan', 'Price', 'Reed', 'Stone', 'Turner', 'Ward', 'West', 'Wood', 'Bell', 'Cook', 'Fox',
      'Grant', 'Hill', 'Lane', 'Mills', 'Nash', 'Page', 'Rowe', 'Shaw', 'Webb', 'Adler', 'Baxter', 'Crane', 'Dalton', 'Ellis', 'Fowler', 'Garner', 'Hayes', 'Ingram', 'Jarvis', 'Keane'],
    given: ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Zoe', 'Ryan', 'Nina', 'Owen', 'Leah', 'Jack', 'Iris', 'Sam', 'Ruby', 'Max', 'Ella', 'Ben', 'Cara', 'Dean', 'Faye', 'Gabe', 'Hope', 'Ivan',
      'Jade', 'Kurt', 'Lena', 'Milo', 'Nora', 'Otto', 'Pia', 'Quinn', 'Rosa', 'Tess', 'Uma', 'Vera', 'Wade', 'Yara'],
    given2: ['ABCDEFGHJKLMNPRSTVW'],
    twinSur: ['Chen', 'Park', 'Rivera', 'Novak', 'Okafor', 'Silva', 'Haddad', 'Kowalski'],
  },
};

/** Nicknames, unique company-wide: when they run out a person simply has none. */
const NICKS: Record<Lang, string[]> = {
  zh: ['老K', '大熊', '阿飞', '小鱼', '老猫', '大鹏', '阿蛮', '小满', '老炮', '大圣', '阿福', '小乔', '老枪', '大头', '阿宝', '小米', '老蔫', '大壮', '阿紫', '小钢炮',
    '老顽童', '大白', '阿杜', '小灰', '老鬼', '大侠', '阿离', '小豆', '老铁', '大川', '阿九', '小七', '老烟', '大饼', '阿丑', '小蛮', '老表', '大雁', '阿冲', '小石头',
    '老班长', '大刀', '阿木', '小辣椒', '老狐', '大眼', '阿正', '小黑', '老夫子', '大胡子', '阿甘', '小火车', '老船长', '大象', '阿桂', '小青', '老教授', '大个子', '阿虎', '小蜜蜂',
    '老秀才', '大掌柜', '阿星', '小猴', '老黄牛', '大马', '阿凯', '小雨点', '老司机', '大松', '阿兰', '小土豆', '老算盘', '大海', '阿彬', '小橙子', '老学究', '大将', '阿伟', '小喇叭',
    '老鹰', '大管家', '阿诚', '小竹', '老舵手', '大锤', '阿杰', '小雪球', '老园丁', '大树'],
  en: ['Ace', 'Bear', 'Bolt', 'Doc', 'Sparky', 'Moose', 'Ziggy', 'Rocket', 'Pebble', 'Scout', 'Biscuit', 'Comet', 'Dash', 'Echo', 'Fizz', 'Gizmo', 'Hawk', 'Jinx', 'Kipper', 'Lucky',
    'Mango', 'Nugget', 'Otter', 'Pickle', 'Quill', 'Rusty', 'Sarge', 'Tank', 'Viper', 'Waffles', 'Yeti', 'Zeppelin', 'Badger', 'Cobra', 'Dingo', 'Falcon', 'Goose', 'Hopper', 'Iceman', 'Juggler',
    'Koala', 'Lynx', 'Maverick', 'Noodle', 'Owl', 'Panda', 'Raven', 'Skipper', 'Turtle', 'Walrus', 'Bandit', 'Chief', 'Duke', 'Ember', 'Frosty', 'Gecko', 'Hound', 'Jester', 'Kestrel', 'Llama',
    'Marble', 'Nimbus', 'Oracle', 'Puffin', 'Ranger', 'Sprout', 'Tiger', 'Umpire', 'Vortex', 'Wizard', 'Anchor', 'Blaze', 'Cricket', 'Domino', 'Flint', 'Grizzly', 'Harpoon', 'Igloo', 'Jumbo', 'Kodiak',
    'Lobster', 'Magpie', 'Nomad', 'Ozzy', 'Pirate', 'Rhino', 'Sherpa', 'Tornado', 'Unicorn', 'Wombat'],
};

/** Project names: a star and a word, every name four characters (zh) or two words (en), none inside another. */
const PROJECT_POOL: Record<Lang, { head: string[]; tail: string[] }> = {
  zh: {
    head: ['天枢', '天璇', '天玑', '天权', '玉衡', '开阳', '摇光', '北辰', '南斗', '紫微', '太微', '少微', '文昌', '司命', '织女', '牵牛', '河鼓', '天狼', '轩辕', '天船',
      '天苑', '天仓', '天廪', '天囷', '天园', '天社', '天稷', '天关', '天江', '天渊', '天弁', '天籥', '天柱', '天床', '天棓', '天厨', '天枪', '天枰', '天乳', '天田',
      '天庙', '天潢', '角宿', '亢宿', '氐宿', '房宿', '心宿', '尾宿', '箕宿', '斗宿', '女宿', '虚宿', '危宿', '室宿', '壁宿', '奎宿', '娄宿', '胃宿', '昴宿', '毕宿'],
    tail: ['计划', '工程', '系统', '引擎', '网关', '看板', '工坊', '门户', '枢纽', '助手', '雷达', '罗盘', '灯塔', '星图', '方舟', '引航', '织网', '天梯', '云图', '驿站',
      '魔方', '积木', '指南', '棱镜', '回声', '拼图', '号角', '舵盘', '风帆', '锚点', '桥梁', '烽火', '画卷', '钥匙', '马车', '纸鸢'],
  },
  en: {
    head: ['Altair', 'Capella', 'Deneb', 'Electra', 'Fomalhaut', 'Hadar', 'Izar', 'Kochab', 'Lesath', 'Mira', 'Nunki', 'Polaris', 'Rigel', 'Sirius', 'Thuban', 'Vega', 'Wezen', 'Zosma', 'Alcor', 'Merak',
      'Mizar', 'Spica', 'Antares', 'Bellatrix', 'Castor', 'Pollux', 'Regulus', 'Arcturus', 'Aldebaran', 'Betelgeuse', 'Canopus', 'Procyon', 'Achernar', 'Hamal', 'Markab', 'Sabik', 'Tarazed', 'Unuk', 'Vindemiatrix', 'Yildun',
      'Acrux', 'Gacrux', 'Shaula', 'Kaus', 'Nashira', 'Ankaa', 'Diphda', 'Menkar', 'Mirfak', 'Algol', 'Alnair', 'Peacock', 'Avior', 'Miaplacidus', 'Alphard', 'Denebola', 'Zubenelgenubi', 'Rasalhague', 'Eltanin', 'Sadr'],
    tail: ['Hub', 'Core', 'Suite', 'Gate', 'Desk', 'Forge', 'Beacon', 'Compass', 'Lens', 'Loom', 'Bridge', 'Signal', 'Prism', 'Echo', 'Mosaic', 'Ladder', 'Relay', 'Pulse', 'Orbit', 'Vault',
      'Lantern', 'Quill', 'Spark', 'Grove', 'Shield', 'Rudder', 'Sextant', 'Keystone', 'Atlas', 'Harp', 'Kite', 'Wagon', 'Mill', 'Tower', 'Ferry', 'Well'],
  },
};

/** Customers: a brand and an industry. Industries are described without their words (the hops' anchors). */
const CUSTOMER_POOL: Record<Lang, { a: string[]; b: string[]; near: Record<string, string>; industry: string[]; industryDesc: string[] }> = {
  zh: {
    a: ['华', '青', '星', '易', '恒', '远', '云', '北', '海', '启', '东', '南', '金', '白', '嘉', '万', '瑞', '安', '博', '永'],
    b: ['鼎', '禾', '联', '信', '景', '杉', '辰', '岳', '航', '帆', '泰', '澜', '源', '盛', '明', '和', '川', '峰', '晟', '程'],
    near: { 鼎: '顶', 禾: '河', 联: '连', 信: '新', 景: '境', 杉: '珊', 辰: '晨', 岳: '悦', 航: '杭', 帆: '凡', 泰: '太', 澜: '岚', 源: '元', 盛: '胜', 明: '鸣', 和: '合', 川: '穿', 峰: '锋', 晟: '胜', 程: '诚' },
    industry: ['零售', '教育', '物流', '出行', '保险', '银行', '医药', '传媒'],
    industryDesc: ['开连锁超市的', '办培训班的', '送快递的', '做网约车的', '卖保单的', '放贷款的', '卖药的', '拍短视频的'],
  },
  en: {
    a: ['Bright', 'Green', 'Stellar', 'Swift', 'Harbor', 'Vista', 'Cedar', 'Polar', 'Summit', 'Voyage', 'Hearth', 'Breeze', 'Granite', 'Maple', 'River', 'Silver', 'Golden', 'North', 'Ocean', 'Meadow'],
    b: ['mart', 'field', 'line', 'way', 'point', 'crest', 'wood', 'stone', 'light', 'view', 'port', 'ridge', 'haven', 'brook', 'vale', 'hill', 'works', 'bay', 'gate', 'star'],
    near: { mart: 'mark', field: 'feld', line: 'lyne', way: 'wey', point: 'pointe', crest: 'crist', wood: 'wode', stone: 'ston', light: 'lite', view: 'vue', port: 'porte', ridge: 'rigde', haven: 'havn', brook: 'brooke', vale: 'vail', hill: 'hyll', works: 'werks', bay: 'baye', gate: 'gait', star: 'starr' },
    industry: ['Retail', 'Learning', 'Logistics', 'Mobility', 'Insurance', 'Bank', 'Pharma', 'Media'],
    industryDesc: ['the supermarket chain', 'the tutoring company', 'the parcel courier', 'the ride-hailing firm', 'the underwriter', 'the lender', 'the drug maker', 'the video studio'],
  },
};

/** Settings each kind of team tracks: name, short alias, unit, five values. */
const SETTINGS: Record<Lang, { name: string; short: string; unit: string; values: number[] }[][]> = {
  zh: [
    [{ name: '订单库连接池上限', short: '池上限', unit: '个连接', values: [200, 240, 320, 280, 360] }, { name: '日志保留天数', short: '保留期', unit: '天', values: [30, 45, 60, 90, 75] }, { name: '核心接口超时阈值', short: '超时线', unit: '毫秒', values: [800, 1200, 1000, 900, 1500] }],
    [{ name: '单笔退款审批上限', short: '审批线', unit: '元', values: [5000, 8000, 6500, 7000, 9000] }, { name: '对账批次间隔', short: '批次间隔', unit: '分钟', values: [15, 30, 20, 25, 10] }, { name: '风控拦截分数线', short: '拦截线', unit: '分', values: [80, 85, 75, 78, 82] }],
    [{ name: '每日推送上限', short: '推送配额', unit: '条', values: [3, 5, 4, 6, 2] }, { name: '新人礼包金额', short: '礼包额度', unit: '元', values: [20, 30, 25, 35, 15] }, { name: '活动页缓存时长', short: '缓存期', unit: '分钟', values: [10, 30, 15, 20, 45] }],
  ],
  en: [
    [{ name: 'order DB connection pool cap', short: 'the pool cap', unit: ' connections', values: [200, 240, 320, 280, 360] }, { name: 'log retention period', short: 'retention', unit: ' days', values: [30, 45, 60, 90, 75] }, { name: 'core API timeout threshold', short: 'the timeout line', unit: ' ms', values: [800, 1200, 1000, 900, 1500] }],
    [{ name: 'per-refund approval limit', short: 'the approval line', unit: ' dollars', values: [5000, 8000, 6500, 7000, 9000] }, { name: 'reconciliation batch interval', short: 'the batch gap', unit: ' minutes', values: [15, 30, 20, 25, 10] }, { name: 'fraud block score', short: 'the block line', unit: ' points', values: [80, 85, 75, 78, 82] }],
    [{ name: 'daily push cap', short: 'the push quota', unit: ' pushes', values: [3, 5, 4, 6, 2] }, { name: 'welcome bonus amount', short: 'the bonus size', unit: ' dollars', values: [20, 30, 25, 35, 15] }, { name: 'campaign page cache time', short: 'the cache window', unit: ' minutes', values: [10, 30, 15, 20, 45] }],
  ],
};

/** Root causes, five kinds, six ways to say each (no two of a kind share a word). */
export const CAUSES: Record<Lang, string[][]> = {
  zh: [
    ['配置项写错', '参数填反了', '开关下发有误', '上线时漏改了一个设置', '阈值设得不对', '灰度规则没生效'],
    ['容量不足', '机器不够用', '流量超出预估', '连接数被打满', '磁盘写满了', '峰值压垮了实例'],
    ['依赖服务超时', '下游接口迟迟不返回', '第三方回调丢失', '上游推送中断', '外部网关限流', '合作方证书过期'],
    ['代码缺陷', '一处空指针', '并发写入冲突', '边界条件没覆盖', '新版本引入的回归', '死循环耗尽线程'],
    ['数据迁移遗漏', '旧表字段格式不一', '脏记录混入', '索引没重建', '导入脚本中途退出', '缓存与库对不上'],
  ],
  en: [
    ['a bad config', 'a flag pushed with the wrong value', 'a threshold set too low', 'a setting missed during rollout', 'swapped parameters', 'a canary rule that never applied'],
    ['capacity', 'not enough machines', 'traffic beyond the forecast', 'an exhausted connection pool', 'a full disk', 'peak load crushing the instances'],
    ['a dependency timing out', 'a downstream API that stopped answering', 'lost third-party callbacks', 'an upstream feed that broke off', 'rate limiting at an external gateway', "a partner's expired certificate"],
    ['a code defect', 'a null pointer', 'a race between concurrent writes', 'an untested edge case', 'a regression in the new release', 'an infinite loop starving threads'],
    ['a missed data migration', 'mismatched legacy formats', 'dirty records slipping in', 'an index never rebuilt', 'an import script that died halfway', 'a cache out of sync with the database'],
  ],
};

export const RISKS: Record<Lang, string[][]> = {
  zh: [
    ['核心依赖年底停止维护', '底层组件明年不再有补丁', '所用框架即将停更'],
    ['关键岗位只有一人', '某个模块仅一位工程师熟悉', '人员单点，请假即停摆'],
    ['供应商合同到期', '外包协议快要失效', '采购的服务年中续约未定'],
    ['压测环境不足', '没有地方做性能演练', '缺少仿真流量的机器'],
  ],
  en: [
    ['a core dependency reaches end of life', 'an underlying component stops getting patches next year', 'the framework we build on is being discontinued'],
    ['a key role has one person', 'only a single engineer understands one module', 'if one engineer is away, that area stalls'],
    ['a vendor contract expires', 'the outsourcing agreement is about to lapse', 'renewal of a purchased service is unsettled'],
    ['no load-test environment', 'nowhere to rehearse performance', 'no machines to replay simulated traffic'],
  ],
};
export const RESOLUTIONS: Record<Lang, string[]> = { zh: ['已完成替换', '已补招一人', '已续签', '已申请到资源'], en: ['replaced', 'a second hire made', 'contract renewed', 'resources granted'] };

/* --------------------------------- the script -------------------------------- */

export interface V3Person {
  id: string; name: string; team: string; role: string; joined: number; left?: number;
  move?: { team: string; week: number };
  /** A nickname, stated once (`where`, in week `week`), then used alone in some long documents. */
  nick?: { text: string; week: number; where: 'weekly' | 'minutes' };
  /** The leaver this hire replaces, and who mentors them (stated in a quarterly review). */
  replaces?: string; mentor?: string;
}
export interface V3Team {
  id: string; name: string; alt: string; kind: number; div: number; lead: string;
  leadChanges: { week: number; to: string }[];
  metric: { name: string; alt: string; unit: string; values: number[]; redefined?: number };
}
export interface V3Project {
  id: string; team: string; name: string; rename?: { week: number; to: string }; owner: string; takeover?: { week: number; to: string };
  start: number; planned: number; launch: number; sponsor: string; budget?: { amount: number; month: string };
}
export interface V3Incident {
  id: string; team: string; week: number; sev: 'P1' | 'P2' | 'P3'; title: string; customer?: string; fixer: string; causeKind: number; cause: string;
  /** P1s only: what their postmortem alone says. */
  minutes?: number; affected?: number; actionOwner?: string; detected?: number;
}
export interface V3Risk { id: string; team: string; kind: number; opened: number; raisedBy: string; owner: string; handover?: { week: number; to: string }; closed?: number; text: string; resolution: string }
export interface V3SettingEvent { week: number; value: number; how: 'intro' | 'change' | 'correction' | 'revert'; via: 'name' | 'code' | 'short'; by: 'team' | 'pmo' }
export interface V3Setting { id: string; team: string; kind: number; name: string; alt: string; short: string; unit: string; history: V3SettingEvent[] }
export interface V3Customer { id: string; name: string; industry: number; rename?: { week: number; to: string }; lookalikeOf?: string }
/** A weekly metric the PMO corrected in its summary of that month. */
export interface V3MetricFix { team: string; week: number; reported: number; actual: number }

export type StyleId = 'terse' | 'narrative' | 'formal' | 'data';
export const STYLES: StyleId[] = ['terse', 'narrative', 'formal', 'data'];

export interface V3Division {
  index: number; city: string; cityAlt: string; desc?: string;
  teams: V3Team[]; people: V3Person[]; projects: V3Project[]; incidents: V3Incident[]; risks: V3Risk[];
  settings: V3Setting[]; customers: V3Customer[]; metricFixes: V3MetricFix[]; twins: string[]; styles: Record<string, StyleId>;
  /** Per team and quarter: the OKR score and budget execution only the quarterly review states. */
  okr: Record<string, Record<string, { score: number; budget: number }>>;
}

export interface V3World { lang: Lang; seed: string; divisions: V3Division[] }

const ROLES: Record<Lang, string[]> = {
  zh: ['后端工程师', '前端工程师', '测试工程师', '数据工程师', '产品经理', '运维工程师'],
  en: ['backend engineer', 'frontend engineer', 'QA engineer', 'data engineer', 'product manager', 'site reliability engineer'],
};

/** The whole company: `size` divisions, drawn in order from one stream (the first division is the same at every size). */
export function makeV3World(lang: Lang, seed: string | number, size = 1): V3World {
  const r = rng(parseInt(seededKey(seed, `reports-v3-${lang}`).slice(0, 8), 16));
  const N = NAMES[lang];
  const cities = CITIES[lang];
  const used = new Set<string>();
  const usedNicks = new Set<string>();
  const usedProjects = new Set<string>();
  const usedCustomers = new Set<string>();
  const blocked = [...cities, ...CITIES[lang === 'zh' ? 'en' : 'zh']];
  const person = (): string => {
    for (let i = 0; ; i++) {
      const s = N.sur[Math.floor(r() * N.sur.length)];
      const g = N.given[Math.floor(r() * N.given.length)];
      const g2 = lang === 'zh' ? N.given2[Math.floor(r() * N.given2.length)] : N.given2[0][Math.floor(r() * N.given2[0].length)];
      const name = lang === 'zh' ? (i < 20 ? `${s}${g}` : `${s}${g2}`) : i < 20 ? `${g} ${s}` : `${g} ${g2}. ${s}`;
      if (!used.has(name) && !blocked.some((c) => name.includes(c))) {
        used.add(name);
        return name;
      }
    }
  };
  const divisions: V3Division[] = [];
  for (let d = 0; d < Math.max(1, Math.floor(size)); d++) {
    divisions.push(buildDivision(lang, r, d, { person, used, usedNicks, usedProjects, usedCustomers }));
  }
  linkDivisions(divisions, seed);
  return { lang, seed: String(seed), divisions };
}

interface Pools { person: () => string; used: Set<string>; usedNicks: Set<string>; usedProjects: Set<string>; usedCustomers: Set<string> }

function buildDivision(lang: Lang, r: () => number, d: number, pools: Pools): V3Division {
  const zh = lang === 'zh';
  const other: Lang = zh ? 'en' : 'zh';
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const city = CITIES[lang][d % CITIES[lang].length] + (d >= CITIES[lang].length ? String(Math.floor(d / CITIES[lang].length) + 1) : '');
  const cityAlt = CITY_ALT[lang][d] ?? city;
  const N = NAMES[lang];

  // customers: six industries, a look-alike of the first and of the fourth, one renamed halfway
  const C = CUSTOMER_POOL[lang];
  const customers: V3Customer[] = [];
  const { usedCustomers } = pools;
  const brand = () => {
    for (;;) {
      const a = pick(C.a);
      const b = pick(C.b);
      if (!usedCustomers.has(`${a}${b}`) && !usedCustomers.has(`${a}${C.near[b]}`)) {
        usedCustomers.add(`${a}${b}`);
        usedCustomers.add(`${a}${C.near[b]}`);
        return { a, b };
      }
    }
  };
  const cname = (a: string, b: string, ind: number) => (zh ? `${a}${b}${C.industry[ind]}` : `${a}${b} ${C.industry[ind]}`);
  const firstInd = d % C.industry.length;
  const brands: { a: string; b: string }[] = [];
  for (let k = 0; k < 6; k++) {
    const x = brand();
    brands.push(x);
    customers.push({ id: `D${d + 1}C${k}`, name: cname(x.a, x.b, (firstInd + k) % C.industry.length), industry: (firstInd + k) % C.industry.length });
  }
  customers.push({ id: `D${d + 1}C6`, name: cname(brands[0].a, C.near[brands[0].b], customers[0].industry), industry: customers[0].industry, lookalikeOf: customers[0].id });
  customers.push({ id: `D${d + 1}C7`, name: cname(brands[3].a, C.near[brands[3].b], customers[3].industry), industry: customers[3].industry, lookalikeOf: customers[3].id });
  {
    const x = brand();
    customers[4].rename = { week: int(64, 76), to: zh ? `${x.a}${x.b}科技` : `${x.a}${x.b} Labs` };
  }

  // namesakes: three names, each given to two people of this division
  const twins: string[] = [];
  for (let k = 0; k < 3; k++) {
    for (;;) {
      const s = N.twinSur[(d * 3 + k) % N.twinSur.length];
      const name = zh ? `${s}${pick(N.given)}${d === 0 ? '' : pick(N.given2)}` : `${pick(N.given)} ${s}`;
      if (!pools.used.has(name)) {
        pools.used.add(name);
        twins.push(name);
        break;
      }
    }
  }

  const teams: V3Team[] = [];
  const people: V3Person[] = [];
  const projects: V3Project[] = [];
  const incidents: V3Incident[] = [];
  const risks: V3Risk[] = [];
  const settings: V3Setting[] = [];
  const metricFixes: V3MetricFix[] = [];
  const styles: Record<string, StyleId> = {};
  const okr: V3Division['okr'] = {};
  const projectName = () => {
    const P = PROJECT_POOL[lang];
    for (let i = 0; ; i++) {
      const n = zh ? `${pick(P.head)}${pick(P.tail)}${i > 200 ? cnNum(1 + (i % 9)) : ''}` : `${pick(P.head)} ${pick(P.tail)}${i > 200 ? ` ${1 + (i % 9)}` : ''}`;
      if (!pools.usedProjects.has(n)) {
        pools.usedProjects.add(n);
        return n;
      }
    }
  };
  const nickOf = (): string | undefined => {
    const pool = NICKS[lang].filter((n) => !pools.usedNicks.has(n));
    if (!pool.length) return undefined;
    const n = pick(pool);
    pools.usedNicks.add(n);
    return n;
  };

  for (let k = 0; k < 3; k++) {
    const K = KINDS[lang][k];
    const team = `D${d + 1}T${k + 1}`;
    const name = zh ? `${city}${K.team}` : `${city} ${K.team}`;
    const alt = zh ? `${cityAlt} ${KINDS.en[k].team}` : `${cityAlt}${KINDS.zh[k].team}`;
    // m0 lead · m1, m2 move to the other teams · m3, m4 namesake slots · m5 owns the third project and leaves late
    // · m6, m7 leave · m8 the successor lead (where the lead changes)
    const members = Array.from({ length: 9 }, () => pools.person());
    if (k === 0) { members[3] = twins[0]; members[4] = twins[2]; }
    if (k === 1) { members[3] = twins[0]; members[4] = twins[1]; }
    if (k === 2) { members[3] = twins[2]; members[4] = twins[1]; }
    members.forEach((m, i) => people.push({ id: `${team}-${i}`, name: m, team, role: i === 0 ? (zh ? '负责人' : 'lead') : pick(ROLES[lang]), joined: 1 }));
    const P = (i: number) => people.find((p) => p.id === `${team}-${i}`)!;
    // three leave, three are hired in their place, each mentored by a colleague
    const leaves = [int(16, 26), int(50, 60), int(96, 106)];
    [7, 6, 5].forEach((i, n) => {
      P(i).left = leaves[n];
      // mentors: m8 for the first and third hire, m5 (still there) for the second
      people.push({ id: `${team}-h${n + 1}`, name: pools.person(), team, role: pick(ROLES[lang]), joined: leaves[n] + int(2, 4), replaces: P(i).id, mentor: P(n === 1 ? 5 : 8).id });
    });
    const leadChanges = k === 1 ? [{ week: 61, to: P(8).name }] : k === 2 ? [{ week: 95, to: P(8).name }] : [];
    const metric = {
      name: K.metric, alt: KINDS[other][k].metric, unit: K.unit,
      values: Array.from({ length: 130 }, (_, w) => {
        const noise = (r() - 0.5) * K.step * 6;
        const drift = k === 2 && w >= 59 ? -K.base * 0.08 : 0;
        const v = K.base + K.step * w + noise + drift;
        return Number(Math.min(K.unit === '%' ? 99.999 : Infinity, v).toFixed(K.unit === '%' ? (K.base > 99 ? 3 : 2) : 0));
      }),
      ...(k === 2 ? { redefined: 60 } : {}),
    };
    teams.push({ id: team, name, alt, kind: k, div: d, lead: P(0).name, leadChanges, metric });
    styles[P(0).name] = STYLES[(k + d) % 4];
    for (const c of leadChanges) styles[c.to] = STYLES[(k + d + 2) % 4];

    // projects: five, staggered; the second and the fourth renamed halfway; owners m1, m2, m5, h1, h2
    const owners = [P(1), P(2), P(5), people.find((p) => p.id === `${team}-h1`)!, people.find((p) => p.id === `${team}-h2`)!];
    for (let i = 0; i < 5; i++) {
      const start = Math.max(2, 2 + i * 22 + int(0, 5), owners[i].joined + 1);
      const planned = start + 18 + int(0, 10);
      const launch = planned + (i % 2 === 1 ? int(5, 10) : int(0, 2));
      const sponsor = customers[(k * 2 + i + d) % 6].id;
      projects.push({
        id: `${team}-J${i + 1}`, team, name: projectName(), owner: owners[i].name, start, planned, launch, sponsor,
        ...(i % 2 === 1 ? { rename: { week: start + int(8, 12), to: projectName() } } : {}),
        ...(i % 2 === 0 ? { budget: { amount: 60 + 20 * int(0, 12), month: '' } } : {}),
      });
    }

    // incidents: every five weeks or so; every third a P1 with a postmortem
    for (let i = 0; ; i++) {
      const week = 3 + k + i * 5 + int(0, 2);
      if (week > V3_WEEKS - 2) break;
      const sev = i % 3 === 0 ? 'P1' : i % 3 === 1 ? 'P2' : 'P3';
      incidents.push({ id: `INC-${d + 1}${k + 1}${String(i + 1).padStart(2, '0')}`, team, week, sev, title: K.titles[i % K.titles.length], fixer: '', causeKind: i % 5, cause: '',
        ...(sev === 'P1' ? { minutes: 15 + 5 * int(0, 45), affected: 100 * int(5, 600), detected: i % 3 } : {}) });
    }
    // risks: eight, raised and owned by members, half handed over, all but the last closed
    for (let i = 0; i < 8; i++) {
      const opened = 4 + i * 14 + int(0, 4);
      risks.push({ id: `R-${d + 1}${k + 1}${i + 1}`, team, kind: i % 4, opened, raisedBy: '', owner: '', ...(i % 2 === 1 ? { handover: { week: opened + int(4, 7), to: '' } } : {}),
        ...(i < 7 ? { closed: opened + int(9, 20) } : {}), text: RISKS[lang][i % 4][k], resolution: RESOLUTIONS[lang][i % 4] });
    }
    // settings: introduced by name, then changed, corrected and reverted under the code or the short alias; one correction is the PMO's
    SETTINGS[lang][k].forEach((x, s) => {
      const id = `${zh ? ['PLT', 'PAY', 'GRW'][k] : ['PLT', 'PAY', 'GRW'][k]}${d + 1}-C${s + 1}`;
      const pattern: V3SettingEvent['how'][] = [['change', 'correction', 'change', 'revert'], ['change', 'change', 'correction', 'change'], ['correction', 'change', 'revert', 'change']][(s + k + d) % 3] as V3SettingEvent['how'][];
      const history: V3SettingEvent[] = [{ week: 3 + s * 5 + int(0, 3), value: x.values[0], how: 'intro', via: 'name', by: 'team' }];
      let at = history[0].week;
      let vi = 1;
      const values: number[] = [x.values[0]];
      pattern.forEach((how, n) => {
        at += 18 + int(0, 10);
        const value = how === 'revert' ? values[values.length - 2] : x.values[vi++ % x.values.length];
        values.push(value);
        // one setting a team: its correction comes from the PMO's summary, not the team's report
        const by = how === 'correction' && (s + k + d) % 3 === 0 ? 'pmo' : 'team';
        history.push({ week: Math.min(at, V3_CORPUS - 2), value, how, via: (['code', 'short'] as const)[(n + s + k) % 2], by });
      });
      // a change in the update stream for the first setting of each team, corrected a batch later for the first team
      if (s === 0) {
        history.push({ week: V3_CORPUS + 1 + k, value: x.values[(vi + 1) % x.values.length], how: 'change', via: 'code', by: 'team' });
        if (k === 0) history.push({ week: V3_CORPUS + 3, value: x.values[(vi + 2) % x.values.length], how: 'correction', via: 'short', by: 'team' });
      }
      settings.push({ id, team, kind: k, name: x.name, alt: SETTINGS[other][k][s].name, short: x.short, unit: x.unit, history: dedupeWeeks(history) });
    });
    // the PMO corrects four of the team's weekly figures, in the summary of that month
    for (let i = 0; i < 4; i++) {
      const week = 10 + i * 27 + k * 3 + int(0, 4);
      const actual = metric.values[week - 1];
      const off = K.unit === '%' ? (K.base > 99 ? 0.004 : 0.18) * (i % 2 ? 1 : -1) : 3 * (i % 2 ? 1 : -1);
      const reported = Number((actual + off).toFixed(K.unit === '%' ? (K.base > 99 ? 3 : 2) : 0));
      metricFixes.push({ team, week, reported: Math.min(reported, 99.999), actual });
    }
    okr[team] = {};
  }

  // transfers: m1 to the next team early, m2 to the one after later; each takes over a project running there
  for (const [k, n, to, lo, hi] of [[0, 1, 1, 36, 44], [1, 1, 2, 36, 44], [2, 1, 0, 36, 44], [0, 2, 2, 72, 80], [1, 2, 0, 72, 80], [2, 2, 1, 72, 80]] as const) {
    const mover = people.find((p) => p.id === `${teams[k].id}-${n}`)!;
    const week = int(lo, hi);
    mover.move = { team: teams[to].id, week };
    const target = projects.find((p) => p.team === teams[to].id && p.start < week && p.launch > week + 8 && !p.takeover);
    if (target) target.takeover = { week: week + 2, to: mover.name };
  }

  // nicknames: m8, m5 and the first hire of each team; stated once (a weekly report or the minutes), then used alone
  for (const t of teams) {
    for (const [pid, where] of [[`${t.id}-8`, 'weekly'], [`${t.id}-5`, 'minutes'], [`${t.id}-h1`, 'weekly']] as const) {
      const p = people.find((x) => x.id === pid)!;
      const text = nickOf();
      if (!text) continue;
      const week = where === 'weekly' ? Math.max(p.joined + 3, 8 + t.kind * 2) : 30 + t.kind * 4;
      p.nick = { text, week, where };
    }
  }

  // who fixes, raises and owns: people on the team that week, never its lead
  const roster = (team: string, week: number) => rosterOf(people, team, week);
  const leadAt = (t: V3Team, week: number) => leadOf(t, week);
  for (const i of incidents) {
    const t = teams.find((x) => x.id === i.team)!;
    const on = roster(i.team, i.week).filter((p) => p.name !== leadAt(t, i.week) && roster(i.team, i.week + 2).includes(p));
    i.fixer = on[Math.floor(r() * on.length)].name;
    if (i.sev === 'P1') {
      const rest = on.filter((p) => p.name !== i.fixer);
      i.actionOwner = rest[Math.floor(r() * rest.length)].name;
    }
  }
  for (const rk of risks) {
    const t = teams.find((x) => x.id === rk.team)!;
    const on = roster(rk.team, rk.opened).filter((p) => p.name !== leadAt(t, rk.opened) && (!p.left || p.left > (rk.closed ?? V3_WEEKS)) && !(p.move && p.move.week <= (rk.closed ?? V3_WEEKS)));
    rk.raisedBy = on[Math.floor(r() * on.length)].name;
    const owners = on.filter((p) => p.name !== rk.raisedBy);
    rk.owner = owners[Math.floor(r() * owners.length)].name;
    if (rk.handover) {
      const next = owners.filter((p) => p.name !== rk.owner);
      rk.handover.to = next[Math.floor(r() * next.length)].name;
    }
  }
  // escalations: every P1 and every other P2 by a customer of the division, the look-alikes and the renamed one among them
  let e = 0;
  for (const i of [...incidents].sort((a, b) => a.week - b.week || a.team.localeCompare(b.team))) {
    if (i.sev === 'P1' || (i.sev === 'P2' && e % 2 === 0)) i.customer = customers[(e * 3 + d) % customers.length].id;
    if (i.sev !== 'P3') e++;
  }
  // one phrasing per incident cause, never the same twice in a row for one kind
  const seen = new Map<number, number>();
  for (const i of [...incidents].sort((a, b) => a.week - b.week || a.team.localeCompare(b.team))) {
    const n = seen.get(i.causeKind) ?? 0;
    seen.set(i.causeKind, n + 1);
    i.cause = CAUSES[lang][i.causeKind][n % CAUSES[lang][i.causeKind].length];
  }
  // budgets approved in the minutes of the month after a project starts
  for (const p of projects) if (p.budget) p.budget.month = ymKey(Math.min(V3_CORPUS, p.start + 4));
  // OKR scores and budget execution per team and quarter (quarterly reviews only)
  for (const t of teams) for (const q of [...new Set(weeksUpTo(V3_WEEKS).map(quarterKey))]) okr[t.id][q] = { score: Number((0.5 + 0.05 * int(0, 9)).toFixed(2)), budget: 70 + int(0, 35) };

  return { index: d, city, cityAlt, ...(d < CITY_DESC[lang].length ? { desc: CITY_DESC[lang][d] } : {}), teams, people, projects, incidents, risks, settings, customers, metricFixes, twins, styles, okr };
}

/**
 * Divisions two and three, four and five …: someone of each team moves late to the same kind of team of the
 * other division (both ways) and takes over a project there — the link hops across divisions follow. The first division is never
 * linked (it stays the same at every size), and a separate stream leaves every division's own draws alone.
 */
function linkDivisions(divisions: V3Division[], seed: string | number): void {
  const r = rng(parseInt(seededKey(seed, 'reports-v3-links').slice(0, 8), 16));
  for (let d = 1; d + 1 < divisions.length; d += 2) {
    for (const [a, b] of [[divisions[d], divisions[d + 1]], [divisions[d + 1], divisions[d]]]) {
      for (let k = 0; k < 3; k++) {
        // whoever on the team is free soonest of everything the script gives them at home, and has a project to take over there
        const free = (p: V3Person) => Math.max(p.joined, ...a.incidents.flatMap((i) => [i.fixer === p.name ? i.week + 2 : 0, i.actionOwner === p.name ? i.week + 2 : 0]),
          ...a.risks.flatMap((x) => [x.raisedBy === p.name || x.owner === p.name || x.handover?.to === p.name ? (x.closed ?? V3_WEEKS) : 0]),
          ...a.projects.filter((x) => x.owner === p.name || x.takeover?.to === p.name).map((x) => x.launch));
        const t = a.teams[k];
        const candidates = a.people.filter((p) => p.team === t.id && !p.move && !p.left && !a.twins.includes(p.name) && p.name !== t.lead && !t.leadChanges.some((c) => c.to === p.name))
          .map((p) => ({ p, week: Math.max(free(p) + 2, 60) + Math.floor(r() * 3) })).sort((x, y) => x.week - y.week || x.p.id.localeCompare(y.p.id));
        for (const { p, week } of candidates) {
          if (week > V3_CORPUS - 8) break;
          const target = b.projects.find((x) => x.team === b.teams[k].id && x.start < week && x.launch > week + 4 && !x.takeover);
          if (!target) continue;
          p.move = { team: b.teams[k].id, week };
          target.takeover = { week: week + 2, to: p.name };
          b.people.push(p);
          break;
        }
      }
    }
  }
}

function dedupeWeeks(h: V3SettingEvent[]): V3SettingEvent[] {
  const out: V3SettingEvent[] = [];
  for (const x of h) {
    if (out.some((y) => y.week === x.week)) continue;
    if (out.length && out[out.length - 1].value === x.value) continue;
    out.push(x);
  }
  return out;
}

/* --------------------------------- queries -------------------------------- */

/** Who is on a team in a week. */
export function rosterOf(people: V3Person[], team: string, week: number): V3Person[] {
  return people.filter((p) => {
    const inTeam = p.team === team ? !(p.move && week >= p.move.week) : p.move?.team === team && week >= p.move.week;
    return inTeam && p.joined <= week && !(p.left && week >= p.left);
  });
}
export const leadOf = (t: V3Team, week: number) => t.leadChanges.filter((c) => c.week <= week).at(-1)?.to ?? t.lead;
export const projectNameAt = (p: V3Project, week: number) => (p.rename && week >= p.rename.week ? p.rename.to : p.name);
export const customerNameAt = (c: V3Customer, week: number) => (c.rename && week >= c.rename.week ? c.rename.to : c.name);
export const ownerAt = (p: V3Project, week: number) => (p.takeover && week >= p.takeover.week ? p.takeover.to : p.owner);
export const progressAt = (p: V3Project, week: number) => (week < p.start ? 0 : week >= p.launch ? 100 : Math.min(99, Math.round(((week - p.start) / Math.max(1, p.launch - p.start)) * 100)));
/** A setting's value after week `week` (a correction replaces what it corrects; the PMO's included). */
export function settingAt(x: V3Setting, week: number): number | undefined {
  let v: number | undefined;
  for (const h of x.history) if (h.week <= week) v = h.value;
  return v;
}
/** A team's weekly figure as the PMO verified it. */
export const metricActual = (s: V3Division, team: string, week: number) => s.teams.find((t) => t.id === team)!.metric.values[week - 1];
/** A team's weekly figure as its own report gave it. */
export const metricReported = (s: V3Division, team: string, week: number) => s.metricFixes.find((f) => f.team === team && f.week === week)?.reported ?? metricActual(s, team, week);
export const fmtMetric = (lang: Lang, t: V3Team, v: number) => (t.metric.unit === '%' ? `${v}%` : lang === 'zh' ? `${v}万` : `${v}k`);
export const personByName = (s: V3Division, name: string, team?: string) => s.people.find((p) => p.name === name && (!team || p.team === team || p.move?.team === team));
