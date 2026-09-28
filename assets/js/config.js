// Supabase project used by every page. The publishable key is meant to be public (read + append only, see supabase_schema.sql).
export const SUPABASE_URL = 'https://xyejiowiupwrxvgvqwfr.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_MqFx0d8g34iu-bgYAjSBMw_kPuSfBN8';
export const APP_VERSION = '0.1.0';

export const QUALITY_REASONS = ['云', '雾 / 霾', '阴影', '黑块 / 缺失', '条纹', '太亮 / 太暗', '模糊'];

export const CHANGE_TAGS = [
  { key: 'bare+', label: '裸土 / 施工 增加' }, { key: 'bare-', label: '裸土 / 施工 减少' },
  { key: 'building+', label: '建筑 增加' }, { key: 'building-', label: '建筑 减少' },
  { key: 'road+', label: '道路 增加' }, { key: 'road-', label: '道路 减少' },
  { key: 'veg+', label: '植被 增加' }, { key: 'veg-', label: '植被 减少' },
  { key: 'water+', label: '水面 扩大' }, { key: 'water-', label: '水面 缩小' },
  { key: 'unclear', label: '有差别，但说不清是什么' },
];

export const SITE_ORDER = ['ZZ', 'HY', 'SG'];

// Shown on the home page and in the background story. person: fill in the teammate who reads that site.
export const SITE_INFO = {
  ZZ: { person: '', concern: '湘江东北岸，铁路紧贴山脚。关注长大边坡和铁路上方的山体。', refDate: '2023-03-05' },
  HY: { person: '', concern: '铁路上方有大片红土施工区。关注施工范围扩大和雨后泥沙下泄。', refDate: '2023-11-20' },
  SG: { person: '', concern: '北江东南岸，铁路一侧贴山、一侧临河。关注山坡裸露、滑塌和河岸变化。', refDate: '2023-11-20' },
};
