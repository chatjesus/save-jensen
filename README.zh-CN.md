# Save Jensen

[主站](https://savejensen.ai/) · [中文站](https://savejensen.ai/zh/) · [English README](README.md)

这是一个由支持者发起的公益社区项目，聚合黄仁勋相关时间线、内容、应援、经审核的留言、公开信和 Discord 社区。项目代码现已开放，欢迎贡献翻译、可访问性改进与修复。

## 本地运行

需要 Python 3 与 Node.js 24 或以上版本。

```sh
python3 build.py
cd server
npm ci
npm test
npm run dev
```

打开 `http://localhost:8787/`。默认英文，中文地址 `/zh/`；旧 `/en/` 与 `?lang=en|zh` 链接兼容跳转。不按浏览器语言自动跳转。本地服务仅监听本机，使用内存数据库，重启即清空。本地审核 token 默认为 `local-admin`，可用环境变量 `ADMIN_TOKEN` 覆盖；不能把此开发默认值用于生产。

构建只生成仓库内 `server/public/`，不需要 macOS 图像工具。部署到自己的 Cloudflare Worker 和 D1 的完整步骤见 [英文 README](README.md#deploy-your-own-instance)。请复制示例配置，创建自己的数据库与秘密变量，并替换域名、链接与内容；不要复用主站数据。仓库不含生产凭据、生产数据库、访客内容、发件人私人联系方式或邮件回执。

## 公益捐赠

本站直接链接到 [NumFOCUS](https://numfocus.org/donate)、[scikit-learn](https://numfocus.org/donate-to-scikit-learn)、[NumPy](https://numfocus.org/donate-to-numpy) 的官方捐赠页，后两项由 NumFOCUS 接收项目定向捐赠。Save Jensen 不经手资金、不收佣金、也不展示未经确认的捐赠金额。机构收录不意味着其支持或参与本倡议。捐赠适用收款方的条款。

本项目的公益运营方向不代表已注册慈善机构，也不限制 MIT 对代码的使用授权。

## 统计和隐私

应援能量包含可重复的 +1 / +10 操作，不代表独立人数或正式签名；分享数是按钮点击次数。留言和头像经审核后公开，可由同设备凭据撤回。生产用户内容不在仓库中；邮箱订阅、账号登录、正式联署尚未实现。行情展示与应援点击不存在因果关系。

## 许可

代码使用 [MIT](LICENSE)。第三方图片保留各自 CC0、CC BY 或 CC BY-SA 许可，详见 [图片来源与许可](IMAGE-CREDITS.md)，不受代码 MIT 许可覆盖。重用时保留署名与许可。
