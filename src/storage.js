const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/hotspots.json');

// 确保 data 目录存在
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('⚠️ 读取数据库失败:', error.message);
  }
  return { snapshots: [] };
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function init() {
  const data = loadDB();
  saveDB(data);
  console.log('✅ 数据库初始化完成');
  console.log(`📁 数据库位置：${DB_PATH}`);
}

function saveHotSearches(items, snapshotTime) {
  const data = loadDB();
  data.snapshots.push({
    snapshotTime,
    items
  });
  saveDB(data);
  console.log(`✅ 已保存 ${items.length} 条热点数据`);
}

function getLatestSnapshot() {
  const data = loadDB();
  if (data.snapshots.length === 0) return null;
  return data.snapshots[data.snapshots.length - 1].snapshotTime;
}

function getHotSearchesBySnapshot(snapshotTime) {
  const data = loadDB();
  const snapshot = data.snapshots.find(s => s.snapshotTime === snapshotTime);
  return snapshot ? snapshot.items : [];
}

function getRecentSnapshots(limit = 10) {
  const data = loadDB();
  return data.snapshots
    .slice(-limit)
    .reverse()
    .map(s => ({
      snapshotTime: s.snapshotTime,
      count: s.items.length
    }));
}

function getTopicHistory(topic, days = 7) {
  const data = loadDB();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  
  return data.snapshots
    .filter(s => new Date(s.snapshotTime) >= cutoff)
    .flatMap(s => s.items.filter(item => item.topic === topic))
    .sort((a, b) => new Date(a.snapshotTime) - new Date(b.snapshotTime));
}

function cleanupOldData(days = 7) {
  const data = loadDB();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  
  const originalCount = data.snapshots.length;
  data.snapshots = data.snapshots.filter(s => new Date(s.snapshotTime) >= cutoff);
  saveDB(data);
  
  const cleaned = originalCount - data.snapshots.length;
  console.log(`🧹 已清理 ${cleaned} 个旧快照`);
  return cleaned;
}

function getAllData() {
  return loadDB();
}

/**
 * 获取上升最快的热点（对比最近两次快照）
 */
function getFastestRising(limit = 10, newOnly = false) {
  const data = loadDB();
  if (data.snapshots.length < 2) return [];
  
  const latest = data.snapshots[data.snapshots.length - 1];
  const previous = data.snapshots[data.snapshots.length - 2];
  
  // 建立上次的排名映射
  const prevRankMap = new Map();
  previous.items.forEach(item => {
    prevRankMap.set(item.topic, item.rank);
  });
  
  // 计算每个热点的排名变化
  const rising = latest.items.map(item => {
    const prevRank = prevRankMap.get(item.topic);
    const rankChange = prevRank ? prevRank - item.rank : null; // 正数表示上升
    const isNew = !prevRank;
    
    return {
      ...item,
      prevRank: prevRank || null,
      rankChange: rankChange,
      isNew: isNew,
      risingSpeed: isNew ? 999 : (rankChange || 0), // 新上榜的优先级最高
      category: categorizeTopic(item.topic) // 添加分类
    };
  });
  
  // 按上升速度排序
  rising.sort((a, b) => b.risingSpeed - a.risingSpeed);
  
  // 如果只要新上榜的
  if (newOnly) {
    return rising.filter(item => item.isNew).slice(0, limit);
  }
  
  return rising.slice(0, limit);
}

/**
 * 获取新上榜热点
 * 如果只有 1 个快照，返回所有热点作为"新上榜"
 */
function getNewEntries(limit = 10) {
  const data = loadDB();
  
  // 如果只有 1 个快照，返回所有作为新上榜
  if (data.snapshots.length === 1) {
    return data.snapshots[0].items.map(item => ({
      ...item,
      isNew: true,
      risingSpeed: 999,
      category: categorizeTopic(item.topic)
    })).slice(0, limit);
  }
  
  return getFastestRising(limit, true);
}

/**
 * 对新闻话题进行分类
 */
function categorizeTopic(topic) {
  // 关键词分类规则
  const categories = {
    '政治': [
      '习近平', '总理', '国务院', '两会', '政治局', '常委', '考察', '会议',
      '雄安', '党建', '政府', '政策', '改革', '外交', '外交部', '联合国',
      '金正恩', '普京', '拜登', '特朗普', '总统', '主席', '会谈', '峰会'
    ],
    '财经': [
      '油价', '油价调整', '成品油', '股票', '股市', '基金', '银行', '利率',
      '黄金', '卖金', '套现', '房价', '楼市', '房地产', '经济', 'GDP',
      '通胀', 'CPI', 'PPI', '贸易', '出口', '进口', '关税', '税收',
      '菜百', '金融', '投资', '理财', '保险', '证券', '期货', '汇率'
    ],
    '科技': [
      '华为', '鸿蒙', '余承东', '发布会', '手机', '芯片', 'AI', '人工智能',
      '5G', '6G', '互联网', '软件', '硬件', '数码', 'APP', '系统',
      '自动驾驶', '电动车', '新能源', '电池', '卫星', '航天', '火箭',
      '量子', '区块链', '元宇宙', 'VR', 'AR', '机器人', '算法'
    ],
    '体育': [
      '郑钦文', '萨巴伦卡', '网球', '足球', '篮球', '世界杯', '奥运',
      '冠军', '比赛', '运动员', '教练', '球队', '进球', '得分', '赛事',
      '乒乓球', '羽毛球', '游泳', '田径', '体操', '拳击', '格斗', 'UFC'
    ],
    '娱乐': [
      '演唱会', '电影', '电视剧', '演员', '歌手', '明星', '综艺', '晚会',
      '颁奖', '红毯', '绯闻', '恋情', '离婚', '结婚', '生子', '出道',
      '专辑', 'MV', '直播', '网红', '抖音', '快手', 'B 站', 'UP 主'
    ],
    '社会': [
      '地铁', '医院', '学校', '学生', '老师', '医生', '护士', '警察',
      '火灾', '事故', '车祸', '案件', '判决', '法院', '检察院', ' arrest',
      '献血', '志愿者', '公益', '慈善', '失踪', '寻找', '救援', '地震',
      '台风', '暴雨', '天气', '温度', '雾霾', '环保', '污染', '垃圾分类',
      '吐血', '擦拭', '行李箱', '商户', '顾客', '曝光', '调查', '立案'
    ],
    '国际': [
      '美伊', '伊朗', '美国', '俄罗斯', '乌克兰', '以色列', '巴勒斯坦',
      '朝鲜', '韩国', '日本', '印度', '欧盟', '北约', '中东', '战争',
      '冲突', '制裁', '导弹', '军事', '军队', '国防部', '核武', '拥核',
      '罗生门', '叙利亚', '阿富汗', '巴基斯坦', '沙特', '石油储备'
    ],
    '健康': [
      '医疗', '健康', '疫苗', '病毒', '疫情', '疾控', '卫健委', '医院',
      '减肥', '健身', '运动', '饮食', '营养', '癌症', '糖尿病', '高血压',
      '活鱼麻醉', '食品', '安全', '检测', '超标', '有害', '塑料微粒'
    ],
    '其他': []
  };
  
  // 遍历分类，匹配关键词
  for (const [category, keywords] of Object.entries(categories)) {
    if (keywords.length === 0) continue;
    
    for (const keyword of keywords) {
      if (topic.includes(keyword)) {
        return category;
      }
    }
  }
  
  return '其他';
}

// 命令行初始化
if (process.argv.includes('--init')) {
  init();
  process.exit(0);
}

// 导出 scraper 中的函数（用于 server.js）
let scraper = null;
try {
  scraper = require('./scraper');
} catch (e) {
  // 忽略
}

module.exports = {
  init,
  saveHotSearches,
  getLatestSnapshot,
  getHotSearchesBySnapshot,
  getRecentSnapshots,
  getTopicHistory,
  cleanupOldData,
  getAllData,
  getFastestRising,
  getNewEntries,
  categorizeTopic,
  // 从 scraper 导出
  getCachedUserInfo: scraper?.getCachedUserInfo || (() => null),
  fetchUserInfo: scraper?.fetchUserInfo || (() => null)
};
