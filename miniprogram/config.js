/* 小程序端唯一需要你改的文件。
 *
 * 三种玩法，看你要哪一种：
 *
 *  ① 局域网自测（今天就能跑，零成本）
 *     TRANSPORT = 'http'，dev 填电脑内网 IP；手机和电脑同一个 WiFi；
 *     开发者工具勾「不校验合法域名」，真机预览时右上角菜单 → 开发调试 → 打开调试。
 *
 *  ② 给朋友玩 · 体验版 + 调试模式（零成本、零备案，朋友第一次要手动开一下调试）
 *     TRANSPORT = 'http'，dev 填服务器的公网地址（http://1.2.3.4:8898）。
 *     朋友被加为体验成员 → 打开体验版 → 右上角 ··· → 开发调试 → 打开调试 → 重进。
 *     开过一次长期有效，但你的服务器得一直开着。
 *
 *  ③ 给朋友玩 · 云托管内网通道（免域名、免备案、朋友什么都不用设置）
 *     TRANSPORT = 'cloud'，填 CLOUD.env（云环境 ID）与 CLOUD.service（服务名）。
 *     请求走 wx.cloud.callContainer 的微信内网，不经过公网域名，
 *     因此不需要买域名、不需要备案、也不需要配 request 合法域名。
 *     代价：云托管要把最小副本设成 1 才不丢房间（缩容到 0 会清掉内存里的对局），
 *     另外 callContainer 客户端超时上限 15s，长轮询挂起时间要压到 10s。
 *
 * 正式上线（想被搜到、想长期跑）才需要 ICP 备案 + HTTPS 域名，那是另一回事。
 */
const TRANSPORT = 'http';             // 'http' | 'cloud'

const ENV = {
  dev: 'http://192.168.8.119:8898',   // ① 局域网填电脑内网 IP；② 体验版填服务器公网地址
  prod: 'https://dice.example.com',   // 备案域名上线用
};

const CUR = 'dev';

const CLOUD = {
  env: '',                            // 云开发环境 ID，例如 'prod-3gxxxxx'
  service: '',                        // 云托管服务名，例如 'guidie'
};

// callContainer 客户端超时不得超过 15s（官方硬限制），挂起时间必须比它更短。
const CLOUD_WAIT_MS = 10000;

module.exports = {
  TRANSPORT,
  CLOUD,
  ENV: CUR,
  BASE_URL: ENV[CUR],

  // 长轮询：挂多久、客户端等多久。cloud 模式自动收紧到 15s 以内。
  POLL_WAIT_MS: TRANSPORT === 'cloud' ? CLOUD_WAIT_MS : 25000,
  POLL_TIMEOUT_MS: TRANSPORT === 'cloud' ? 14000 : 33000,

  REQUEST_TIMEOUT_MS: TRANSPORT === 'cloud' ? 14000 : 32000,
  CLOUD_WAIT_MS,
  APP_NAME: '鬼骰',
};
