import { createApp } from "./app";
import { config } from "./core/config/config";

// 启动服务端应用并监听配置的主机与端口
void createApp()
  .then(async (app) => {
    await app.listen(config.port, config.host);
    console.log(`Platform API ready: http://${config.host}:${config.port}/api/health`);
  })
  .catch(() => {
    console.error("平台后端启动失败，请检查本地数据库和 .env 配置。");
    process.exitCode = 1;
  });
