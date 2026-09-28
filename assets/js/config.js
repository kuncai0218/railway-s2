// Supabase project used by every page. The publishable key is meant to be public (read + append only, see supabase_schema.sql).
export const SUPABASE_URL = 'https://xyejiowiupwrxvgvqwfr.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_MqFx0d8g34iu-bgYAjSBMw_kPuSfBN8';
export const APP_VERSION = '0.2.0';

export const QUALITY_REASONS = ['云', '雾 / 霾', '阴影', '黑块 / 缺失', '条纹', '太亮 / 太暗', '模糊'];

export const CHANGE_TAGS = [
  { key: 'bare+', label: '裸土 / 施工 增加' }, { key: 'bare-', label: '裸土 / 施工 减少' },
  { key: 'building+', label: '建筑 增加' }, { key: 'building-', label: '建筑 减少' },
  { key: 'road+', label: '道路 增加' }, { key: 'road-', label: '道路 减少' },
  { key: 'veg+', label: '植被 增加' }, { key: 'veg-', label: '植被 减少' },
  { key: 'water+', label: '水面 扩大' }, { key: 'water-', label: '水面 缩小' },
  { key: 'unclear', label: '有差别，但说不清是什么' },
];

// Step 1: how readable is this image (pick one)
export const QUALITY_LEVELS = [
  { key: 'yes', label: '清楚', hint: '地面看得清清楚楚' },
  { key: 'blurry', label: '整体模糊，但还能看', hint: '整幅发灰、发雾或偏暗，地物还认得出来' },
  { key: 'partial', label: '有些地方看不清', hint: '局部被云、云影、黑块挡住，要画框圈出来' },
  { key: 'no', label: '基本看不清', hint: '整幅被云雾盖住，看不出地面，这一期不用对比' },
];
export const QUALITY_NAME = Object.fromEntries(QUALITY_LEVELS.map(q => [q.key, q.label]));

// Step 2: what differs between the two images (pick any)
export const OVERALL = [
  { key: 'none', label: '没有明显不同' },
  { key: 'local', label: '地面有局部变化（画框标出）' },
  { key: 'color', label: '整体颜色或亮度变了' },
  { key: 'clarity', label: '清晰程度不一样' },
  { key: 'shift', label: '整体错位、重影' },
  { key: 'cloud', label: '云或云影的位置不同' },
  { key: 'shadow', label: '山的阴影不一样' },
  { key: 'season', label: '植被整体变绿或变黄（季节）' },
  { key: 'watercolor', label: '水的颜色变了' },
];
export const OVERALL_NAME = Object.fromEntries(OVERALL.map(o => [o.key, o.label]));

export const SITE_ORDER = ['ZZ', 'HY', 'SG'];

// Shown on the home page and in the background story. person: fill in the teammate who reads that site.
export const SITE_INFO = {
  ZZ: { person: '', concern: '湘江东北岸，铁路紧贴山脚。关注长大边坡和铁路上方的山体。', refDate: '2023-03-05' },
  HY: { person: '', concern: '铁路上方有大片红土施工区。关注施工范围扩大和雨后泥沙下泄。', refDate: '2023-11-20' },
  SG: { person: '', concern: '北江东南岸，铁路一侧贴山、一侧临河。关注山坡裸露、滑塌和河岸变化。', refDate: '2023-11-20' },
};
