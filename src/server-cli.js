import { startServer } from "./server.js";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

startServer({ port, host })
  .then((srv) => {
    console.log(`节奏恢复图形界面已启动：${srv.url}`);
    console.log(`（按 Ctrl+C 停止）`);
  })
  .catch((err) => {
    console.error("启动失败：", err.message);
    process.exit(1);
  });
