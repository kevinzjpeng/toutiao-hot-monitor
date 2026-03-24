const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SQLITE_PATH = path.join(__dirname, '../data/hotspots.db');
const LEGACY_JSON_PATH = path.join(__dirname, '../data/hotspots.json');

const dataDir = path.dirname(SQLITE_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(SQLITE_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function formatLocalDateTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_time TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hotspot_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_id INTEGER NOT NULL,
      rank INTEGER,
      topic TEXT NOT NULL,
      heat TEXT,
      trend TEXT,
      category TEXT,
      url TEXT,
      FOREIGN KEY(snapshot_id) REFERENCES snapshots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(snapshot_time);
    CREATE INDEX IF NOT EXISTS idx_hotspot_items_snapshot ON hotspot_items(snapshot_id);
    CREATE INDEX IF NOT EXISTS idx_hotspot_items_topic ON hotspot_items(topic);
  `);
}

function getSnapshotByTime(snapshotTime) {
  return db.prepare('SELECT id, snapshot_time AS snapshotTime FROM snapshots WHERE snapshot_time = ?').get(snapshotTime) || null;
}

function insertSnapshotIfNeeded(snapshotTime) {
  db.prepare('INSERT OR IGNORE INTO snapshots(snapshot_time) VALUES (?)').run(snapshotTime);
  return getSnapshotByTime(snapshotTime);
}

function getItemsBySnapshotId(snapshotId) {
  return db.prepare(`
    SELECT
      rank,
      topic,
      heat,
      trend,
      category,
      url
    FROM hotspot_items
    WHERE snapshot_id = ?
    ORDER BY rank ASC, id ASC
  `).all(snapshotId);
}

function migrateFromJsonIfNeeded() {
  const snapshotCount = db.prepare('SELECT COUNT(1) AS count FROM snapshots').get().count;
  if (snapshotCount > 0) return;
  if (!fs.existsSync(LEGACY_JSON_PATH)) return;

  try {
    const content = fs.readFileSync(LEGACY_JSON_PATH, 'utf8');
    const legacy = JSON.parse(content);
    const snapshots = Array.isArray(legacy.snapshots) ? legacy.snapshots : [];
    if (snapshots.length === 0) return;

    const tx = db.transaction((rows) => {
      const insertItemStmt = db.prepare(`
        INSERT INTO hotspot_items(snapshot_id, rank, topic, heat, trend, category, url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of rows) {
        if (!row || !row.snapshotTime) continue;
        const snapshot = insertSnapshotIfNeeded(row.snapshotTime);
        if (!snapshot) continue;

        const items = Array.isArray(row.items) ? row.items : [];
        for (const item of items) {
          insertItemStmt.run(
            snapshot.id,
            Number.isFinite(Number(item?.rank)) ? Number(item.rank) : null,
            item?.topic || '',
            item?.heat == null ? null : String(item.heat),
            item?.trend || null,
            item?.category || null,
            item?.url || null
          );
        }
      }
    });

    tx(snapshots);
    console.log(`✅ 已迁移 ${snapshots.length} 个快照到 SQLite：${SQLITE_PATH}`);
  } catch (error) {
    console.error('⚠️ 迁移 JSON 数据到 SQLite 失败:', error.message);
  }
}

function init() {
  ensureSchema();
  migrateFromJsonIfNeeded();
  console.log('✅ SQLite 数据库初始化完成');
  console.log(`📁 数据库位置：${SQLITE_PATH}`);
}

function saveHotSearches(items, snapshotTime = formatLocalDateTime()) {
  const tx = db.transaction((rows, time) => {
    const snapshot = insertSnapshotIfNeeded(time);
    if (!snapshot) throw new Error('无法创建快照记录');

    db.prepare('DELETE FROM hotspot_items WHERE snapshot_id = ?').run(snapshot.id);

    const insertItemStmt = db.prepare(`
      INSERT INTO hotspot_items(snapshot_id, rank, topic, heat, trend, category, url)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of rows) {
      insertItemStmt.run(
        snapshot.id,
        Number.isFinite(Number(item?.rank)) ? Number(item.rank) : null,
        item?.topic || '',
        item?.heat == null ? null : String(item.heat),
        item?.trend || null,
        item?.category || null,
        item?.url || null
      );
    }
  });

  tx(Array.isArray(items) ? items : [], snapshotTime);
  console.log(`✅ 已保存 ${Array.isArray(items) ? items.length : 0} 条热点数据`);
}

function getLatestSnapshot() {
  const row = db.prepare('SELECT snapshot_time AS snapshotTime FROM snapshots ORDER BY snapshot_time DESC LIMIT 1').get();
  return row ? row.snapshotTime : null;
}

function getHotSearchesBySnapshot(snapshotTime) {
  const snapshot = getSnapshotByTime(snapshotTime);
  if (!snapshot) return [];
  return getItemsBySnapshotId(snapshot.id);
}

function getRecentSnapshots(limit = 10) {
  return db.prepare(`
    SELECT
      s.snapshot_time AS snapshotTime,
      COUNT(i.id) AS count
    FROM snapshots s
    LEFT JOIN hotspot_items i ON i.snapshot_id = s.id
    GROUP BY s.id, s.snapshot_time
    ORDER BY s.snapshot_time DESC
    LIMIT ?
  `).all(limit);
}

function getTopicHistory(topic, days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = formatLocalDateTime(cutoff);

  return db.prepare(`
    SELECT
      i.rank,
      i.topic,
      i.heat,
      i.trend,
      i.category,
      i.url,
      s.snapshot_time AS snapshotTime
    FROM hotspot_items i
    INNER JOIN snapshots s ON s.id = i.snapshot_id
    WHERE i.topic = ? AND s.snapshot_time >= ?
    ORDER BY s.snapshot_time ASC
  `).all(topic, cutoffStr);
}

function cleanupOldData(days = 7) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = formatLocalDateTime(cutoff);

  const result = db.prepare('DELETE FROM snapshots WHERE snapshot_time < ?').run(cutoffStr);
  console.log(`🧹 已清理 ${result.changes} 个旧快照`);
  return result.changes;
}

function getAllData() {
  const snapshots = db.prepare('SELECT id, snapshot_time AS snapshotTime FROM snapshots ORDER BY snapshot_time ASC').all();
  return {
    snapshots: snapshots.map((s) => ({
      snapshotTime: s.snapshotTime,
      items: getItemsBySnapshotId(s.id)
    }))
  };
}

/**
 * 获取上升最快的热点（对比最近两次快照）
 */
function getFastestRising(limit = 10, newOnly = false) {
  const latestTwo = db.prepare(`
    SELECT id, snapshot_time AS snapshotTime
    FROM snapshots
    ORDER BY snapshot_time DESC
    LIMIT 2
  `).all();

  if (latestTwo.length < 2) return [];

  const latest = latestTwo[0];
  const previous = latestTwo[1];
  const latestItems = getItemsBySnapshotId(latest.id);
  const previousItems = getItemsBySnapshotId(previous.id);
  
  // 建立上次的排名映射
  const prevRankMap = new Map();
  previousItems.forEach(item => {
    prevRankMap.set(item.topic, item.rank);
  });
  
  // 计算每个热点的排名变化
  const rising = latestItems.map(item => {
    const prevRank = prevRankMap.get(item.topic);
    const rankChange = prevRank ? prevRank - item.rank : null; // 正数表示上升
    const isNew = !prevRank;
    
    return {
      ...item,
      snapshotTime: latest.snapshotTime,
      publishedAt: latest.snapshotTime,
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
  const snapshotCount = db.prepare('SELECT COUNT(1) AS count FROM snapshots').get().count;
  if (snapshotCount === 0) return [];

  const latest = db.prepare('SELECT id, snapshot_time AS snapshotTime FROM snapshots ORDER BY snapshot_time DESC LIMIT 1').get();
  
  // 如果只有 1 个快照，返回所有作为新上榜
  if (snapshotCount === 1 && latest) {
    const onlySnapshotTime = latest.snapshotTime;
    return getItemsBySnapshotId(latest.id).map(item => ({
      ...item,
      snapshotTime: onlySnapshotTime,
      publishedAt: onlySnapshotTime,
      isNew: true,
      risingSpeed: 999,
      category: categorizeTopic(item.topic)
    })).slice(0, limit);
  }

  const newEntries = getFastestRising(limit, true);
  if (newEntries.length > 0) {
    return newEntries;
  }

  // 如果本轮没有新上榜，回退到显示最新一轮的上升榜，避免页面空白
  return getFastestRising(limit, false).map(item => ({
    ...item,
    isNew: false
  }));
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

init();

// 延迟加载 scraper，避免与 scraper.js 的循环依赖
function getScraperModule() {
  try {
    return require('./scraper');
  } catch (e) {
    return null;
  }
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
  getCachedUserInfo: () => {
    const scraper = getScraperModule();
    return scraper?.getCachedUserInfo ? scraper.getCachedUserInfo() : null;
  },
  fetchUserInfo: () => {
    const scraper = getScraperModule();
    return scraper?.fetchUserInfo ? scraper.fetchUserInfo() : null;
  }
};
