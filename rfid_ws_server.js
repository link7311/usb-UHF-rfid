// Node.js 版：多標籤掃描（等同你給的 Python 邏輯）
// 依賴：npm i serialport
// 若要開 WebSocket + 靜態網頁：另外 npm i express ws

const { SerialPort } = require('serialport');
const os = require('os');

// ====== 參數區（照你的 Python 預設） ======
const PORT = process.env.PORT || 'COM5';   // Linux 可用 /dev/ttyUSB0、/dev/ttyS0…
const BAUD = parseInt(process.env.BAUD || '115200', 10);
const WINDOW_MS = parseInt(process.env.WINDOW_MS || '400', 10); // 單輪收包時間窗

// 指令：INVENTORY，一樣使用 16 進位 bytes
const CMD_INVENTORY = Buffer.from('BB00220000227E', 'hex');

// ======（選用）開啟 WS + 靜態前端 ======
// 設定 ENABLE_WS=1 時生效
const ENABLE_WS = process.env.ENABLE_WS === '1';
let wss = null;
let server = null;
if (ENABLE_WS) {
  const path = require('path');
  const http = require('http');
  const express = require('express');
  const WebSocket = require('ws');

  const WEB_PORT = parseInt(process.env.WEB_PORT || '3000', 10);
  const app = express();

  // ⬇️ 改這裡：直接伺服「同層目錄」的檔案（例如 get_uid.htm）
  app.use(express.static(__dirname));

  // 若仍想保留 public/ 也可加：
  // app.use(express.static(path.join(__dirname, 'public')));

  server = http.createServer(app);
  wss = new WebSocket.Server({ server, path: '/ws' });

  server.listen(WEB_PORT, () => {
    console.log(`[WS] HTTP on http://localhost:${WEB_PORT}`);
    console.log(`[WS] WebSocket on ws://localhost:${WEB_PORT}/ws`);
    console.log(`[WS] 打開 http://localhost:${WEB_PORT}/get_uid.htm`);
  });
}

function wsBroadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

// ====== 輔助：切 frame（以 0xBB 起始、0x7E 結尾） ======
function cutFrames(rawBuf) {
  const frames = [];
  let buf = rawBuf;
  while (true) {
    const s = buf.indexOf(0xBB);
    if (s < 0) break;
    const e = buf.indexOf(0x7E, s + 1);
    if (e < 0) break;
    frames.push(buf.slice(s, e + 1));
    buf = buf.slice(e + 1);
  }
  return frames;
}

// ====== 解析單一 frame ======
// 格式：BB | addr | cmd | lenH lenL | data... | chkH chkL | 7E
function parseFrame(fr) {
  if (fr.length < 9 || fr[0] !== 0xBB || fr[fr.length - 1] !== 0x7E) return null;

  const len = (fr[3] << 8) + fr[4];
  const data = fr.slice(5, 5 + len);
  if (data.length < 5) return null;

  const pc = data.slice(0, 2);
  const rest = data.slice(2);

  // 嘗試「有/無 1 byte 天線/RSSI 欄位」
  for (const skip of [1, 0]) {
    if (rest.length - skip >= 3) {
      const epc = rest.slice(skip, -2);
      const crc = rest.slice(-2);
      if (epc.length >= 4) {
        return {
          pc: pc.toString('hex'),
          epc: epc.toString('hex').toUpperCase(),
          crc: crc.toString('hex')
        };
      }
    }
  }
  return null;
}

// ====== 發一次指令並在時間窗內收集一輪 EPC（去重） ======
async function inventoryRound(port, windowMs = 400) {
  let raw = Buffer.alloc(0);

  await portWrite(port, CMD_INVENTORY);
  const endAt = Date.now() + windowMs;

  return new Promise((resolve) => {
    const onData = (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (Date.now() >= endAt) finish();
    };

    function finish() {
      port.off('data', onData);
      const epcs = new Set();
      for (const fr of cutFrames(raw)) {
        const info = parseFrame(fr);
        if (info && info.epc) epcs.add(info.epc);
      }
      resolve(epcs);
    }

    port.on('data', onData);

    // 保險計時器
    setTimeout(() => {
      if (port.listenerCount('data') > 0) finish();
    }, windowMs + 50);
  });
}

// ====== 封裝 serialport write 成 promise ======
function portWrite(port, buf) {
  return new Promise((resolve, reject) => {
    port.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

// ====== 主流程 ======
async function main() {
  console.log(`開始多標籤測試（Ctrl+C 結束） on ${PORT}@${BAUD}`);
  const port = new SerialPort({ path: PORT, baudRate: BAUD, autoOpen: false });

  port.on('error', (e) => console.error('Serial error:', e.message));

  // 打開
  await new Promise((resolve, reject) => {
    port.open((err) => (err ? reject(err) : resolve()));
  });

  // 提高讀取即時性
  port.set({ dtr: true, rts: true }, () => {});

  let roundId = 1;
  const loop = async () => {
    try {
      const epcs = await inventoryRound(port, WINDOW_MS);
      if (epcs.size > 0) {
        const arr = [...epcs].sort();
        console.log(`[Round ${roundId}] 共 ${arr.length} 張： ${arr.join(', ')}`);
        // 若啟用 WS，就把本輪 EPC 廣播出去
        wsBroadcast({ epcs: arr, round: roundId, ts: Date.now() });
      } else {
        console.log(`[Round ${roundId}] 未偵測到標籤`);
      }
      roundId += 1;
      setTimeout(loop, 200);
    } catch (e) {
      console.error('Loop error:', e);
      setTimeout(loop, 500);
    }
  };

  loop();

  // 優雅關閉
  process.on('SIGINT', async () => {
    try { port.close(); } catch (_) {}
    if (server) server.close();
    console.log(os.EOL + '已關閉連線');
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('啟動失敗：', e);
  process.exit(1);
});
