// 全局配置 —— 上线前逐项核对（详见 docs/开发方案 第 4.1 节）
module.exports = {
  // ============ 产品信息 ============
  APP_NAME: '音乐转调',         // 小程序名（用于结果文件名前缀【音乐转调-升N半音】；改名以 MP 后台为准后同步这里）

  // ============ 商业化开关 ============
  // ⚠️ 审核期必须都为 false；开流量主/虚拟支付后再打开
  AD_ENABLED: false,          // 激励视频广告总开关
  PAY_ENABLED: true,          // 虚拟支付总开关（2026-11-09 打开：云函数已按官方文档重写）
  AD_UNIT_ID: '',             // 激励视频广告位 ID（adunit-开头）
  OFFER_ID: '',               // 虚拟支付 OfferID（真实值只放云函数环境变量，前端不需要）
  REWARD_ENABLED: true,       // 赞赏组件总开关（个人主体专属，须先在「开发者助手」小程序开通并绑定贴图号）
  // ⚠️ 赞赏与「开发者助手」的免代码智能接入二选一：若走智能接入（它自动往页面插组件），
  //    必须关掉本开关 —— 官方限制全小程序只能有一个 reward，出现两个全部不渲染

  // ============ 账号与管理员 ============
  CLOUD_LOGIN_ENABLED: true,  // 云开发部署后置 true：启动自动换 openid
  CLOUD_ENV: 'tiaodiao-d2gx2mgmwaf534c61', // 微信云开发环境（已通过小程序认证/关联）
  ADMIN_OPENIDS: [],          // 管理员 openid 白名单（管理页可复制自己的 openid 填这里）
  // 云服务不可达时的兜底：true = 按内测免费放行，保证 App 可用；
  // ⚠️ 云函数部署完成、开始真实收款前必须改 false（否则断网/云故障时会被白用）
  PAY_OFFLINE_FREE: false,

  // ============ 音频处理 ============
  MAX_DURATION_SEC: 480,      // 歌曲时长上限：8 分钟
  MAX_FILE_MB: 25,            // chooseMessageFile 单文件上限
  PREVIEW_SEC: 180,           // 免费试听秒数（3 分钟；歌曲不足 3 分钟时试听=全曲）
  ENCODE: 'mp3',              // 输出 mp3（3 分钟约 4MB；wav 是 8 倍大，仅作兼容备份项）
  MP3_KBPS: 160,              // MP3 码率
  WMA_DECODE_ENABLED: true,   // wma 由自带 FFmpeg WASM 解码（Worker 内 WXWebAssembly）

  // ============ 计费规则（已定稿，勿随意改） ============
  // 计费分钟 = max(1, round(秒/60))      四舍五入，最少 1 分钟
  // 广告数   = ceil(分钟/3)              每 3 分钟 1 个
  // 金额     = 分钟 × 0.1 元
  PRICE_PER_MIN_FEN: 10,      // 0.1 元/分钟 = 10 分
  AD_MINUTES_PER_UNIT: 3,     // 每 3 分钟 1 个广告

  // ============ 风控 ============
  AD_FAIL_GRANT_MAX_PER_DAY: 3,  // 广告失败放行每日上限（防断网刷免费）
  RETRY_FREE_MINUTES: 30,        // 同一首歌重转不重复扣费的窗口（分钟）

  // ============ 商品（必须与 MP 后台道具配置完全一致，单位分） ============
  // 2026-11-09 收敛为两个商品：60 分钟 1 元（促销价）、包月 9.9 元。
  // 改价时三处同步：这里 / cloudfunctions/createOrder / MP 后台道具管理。
  PRODUCTS: [
    { id: 'pkg_60',    price: 100, minutes: 60, name: '60 分钟' },
    { id: 'pkg_month', price: 990, monthly: true, name: '包月' },
  ],
}
