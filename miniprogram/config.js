/* 小程序端唯一需要你改的文件：把 BASE_URL 指到你自己的服务。
 *
 * 开发期（不需要备案域名）：
 *   1) 电脑上 HOST=0.0.0.0 PORT=8898 bash live.sh
 *   2) 手机和电脑连同一个 WiFi
 *   3) 开发者工具「详情 → 本地设置 → 勾选：不校验合法域名」
 *      真机预览/开发版：右上角菜单 → 开发调试 → 打开调试（此后才不校验域名）
 *   4) 把下面 dev 改成电脑的内网地址（hostname -I 看，别写 127.0.0.1 —— 手机访问不到）
 *
 * 上线期（必须）：
 *   - 域名过 ICP 备案、配好 HTTPS 证书
 *   - 小程序后台「开发管理 → 开发设置 → 服务器域名」把域名加进 request 合法域名
 *   - 把 ENV 改成 'prod'
 *
 * 注意：小程序不允许请求 IP 之外的 localhost；也不允许带端口时又在白名单里写别的端口。
 * 备案下来之前，正式版/体验版是连不上你自己的服务器的 —— 这是微信的规矩，不是代码问题。
 */
const ENV = {
  dev: 'http://192.168.8.119:8898',
  prod: 'https://dice.example.com',
};

const CUR = 'dev';

module.exports = {
  BASE_URL: ENV[CUR],
  ENV: CUR,
  // 长轮询挂多久（服务端上限 25s）。小程序 wx.request 超时要留余量，否则会误判断线。
  POLL_WAIT_MS: 25000,
  REQUEST_TIMEOUT_MS: 32000,
  APP_NAME: '鬼骰',
};
