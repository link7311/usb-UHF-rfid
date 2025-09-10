// rfid_ws_server.js —— 支援黑名單、COM 自動/參數設定、熱切換 API、WS 心跳、穩定性強化
// 依賴：npm i serialport express ws

const { SerialPort } = require('serialport');
const os = require('os');

// ====== 參數 ======
function arg(name, def) {
  const cli = process.argv.find(s => s.startsWith(`--${name}=`));
  if (cli) return cli.split('=').slice(1).join('=');
  const env = process.env[name.toUpperCase()];
  return env ?? def;
}
let PORT_PATH = arg('port', 'auto');          // e.g. COM5, /dev/ttyUSB0, 或 auto
const BAUD = parseInt(arg('baud', '115200'), 10);
const WINDOW_MS = parseInt(arg('window_ms', '400'), 10);
const ENABLE_WS = arg('enable_ws', '1') === '1';
const WEB_PORT = parseInt(arg('web_port', '3000'), 10);

// 指令：INVENTORY
const CMD_INVENTORY = Buffer.from('BB00220000227E', 'hex');

// ====== 黑名單 ======
const BLACKLIST_DEFAULT = new Set(["E280F3372000F000135FFABE"]);
function makeBlacklist() {
  const s = new Set([...BLACKLIST_DEFAULT]);
  const envList = (process.env.BLACKLIST || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
  for (const id of envList) s.add(id.toUpperCase());
  return s;
}
let BLACKLIST = makeBlacklist();

// ====== (可選) WS + 靜態網頁 ======
let wss = null;
let server = null;
let app = null;
if (ENABLE_WS) {
  const path = require('path');
  const http = require('http');
  const express = require('express');
  const WebSocket = require('ws');

  app = express();
  app.use(express.static(__dirname));                    // 直接伺服同層 (get_uid.htm)

  // 列出可用序列埠
  app.get('/ports', async (_req, res) => {
    try {
      const list = await SerialPort.list();
      res.json(list.map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || null,
        vendorId: p.vendorId || null,
        productId: p.productId || null,
        friendlyName: p.friendlyName || p.serialNumber || null,
      })));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 熱切換序列埠：/set-port?path=COM7
  app.get('/set-port', async (req, res) => {
    const nextPath = req.query.path;
    if (!nextPath) return res.status(400).json({ error: 'missing ?path=' });
    try {
      await switchPort(nextPath);
      res.json({ ok: true, port: nextPath });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  server = http.createServer(app);
  wss = new WebSocket.Server({ server, path: '/ws' });

  // WS 心跳，清掉殭屍連線
  function heartbeat() { this.isAlive = true; }
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
  });
  const hb = setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false; ws.ping();
    });
  }, 30000);
  wss.on('close', () => clearInterval(hb));

  server.listen(WEB_PORT, () => {
    console.log(`[WS] HTTP on http://localhost:${WEB_PORT}`);
    console.log(`[WS] WebSocket on ws://localhost:${WEB_PORT}/ws`);
    console.log(`[WS] UI: http://localhost:${WEB_PORT}/get_uid.htm`);
    console.log(`[API] List ports:   GET /ports`);
    console.log(`[API] Switch port:  GET /set-port?path=COM7`);
  });
}

function wsBroadcast(obj) {
  if (!wss) return;
  const msg = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ====== 工具：切 frame ======
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
function parseFrame(fr) {
  if (fr.length < 9 || fr[0] !== 0xBB || fr[fr.length - 1] !== 0x7E) return null;
  const len = (fr[3] << 8) + fr[4];
  const data = fr.slice(5, 5 + len);
  if (data.length < 5) return null;

  const pc = data.slice(0, 2);
  const rest = data.slice(2);
  for (const skip of [1, 0]) {
    if (rest.length - skip >= 3) {
      const epc = rest.slice(skip, -2);
      const crc = rest.slice(-2);
      if (epc.length >= 4) {
        return { pc: pc.toString('hex'), epc: epc.toString('hex').toUpperCase(), crc: crc.toString('hex') };
      }
    }
  }
  return null;
}

// ====== 發一次指令並在時間窗內收集一輪 EPC ======
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
    setTimeout(() => { if (port.listenerCount('data') > 0) finish(); }, windowMs + 50);
  });
}

// ====== 封裝 write ======
function portWrite(port, buf) {
  return new Promise((resolve, reject) => {
    port.write(buf, (err) => (err ? reject(err) : resolve()));
  });
}

// ====== 串口管理：自動挑選 / 開啟 / 熱切換 ======
let port = null;             // SerialPort 物件
let running = false;         // 掃描 loop 是否運行中
let roundId = 1;
let health = { ok: 0, empty: 0, blkOnly: 0 };

async function pickPort(autoHint = PORT_PATH) {
  if (autoHint !== 'auto') return autoHint;
  const list = await SerialPort.list();
  if (!list || list.length === 0) throw new Error('找不到任何序列埠');
  // 優先挑 COM*/ttyUSB*/ttyACM*
  const preferred = list.find(p => /COM\d+|ttyUSB\d+|ttyACM\d+/.test(p.path)) || list[0];
  console.log(`[Serial] auto 選擇: ${preferred.path} (${preferred.friendlyName || preferred.manufacturer || ''})`);
  return preferred.path;
}

async function openPort(path) {
  return new Promise((resolve, reject) => {
    const p = new SerialPort({ path, baudRate: BAUD, autoOpen: false });
    p.open(err => (err ? reject(err) : resolve(p)));
  });
}

async function safeOpen(path) {
  while (true) {
    try {
      const p = await openPort(path);
      p.set({ dtr: true, rts: true }, () => {});
      console.log(`[Serial] 已開啟 ${path}@${BAUD}`);
      // 斷線自動重連（沿用同一路徑）
      p.on('close', async () => {
        console.warn('[Serial] 連線關閉，5 秒後嘗試重連…');
        try { p.removeAllListeners('data'); } catch(_) {}
        await new Promise(r => setTimeout(r, 5000));
        if (PORT_PATH) {
          try { port = await safeOpen(PORT_PATH); } catch(e) { console.error('[Serial] 重連失敗：', e.message); }
        }
      });
      p.on('error', async (e) => {
        console.error('[Serial] 錯誤：', e.message);
        try { p.close(); } catch(_) {}
      });
      return p;
    } catch (e) {
      console.error(`[Serial] 開啟失敗 (${path})，5 秒後重試：`, e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

async function switchPort(newPath) {
  if (!newPath) throw new Error('無效的埠路徑');
  if (newPath === PORT_PATH) return;
  console.log(`[Serial] 正在切換埠：${PORT_PATH} -> ${newPath}`);
  PORT_PATH = newPath;
  // 關閉舊埠
  if (port) {
    try { port.removeAllListeners('data'); } catch(_) {}
    try { await new Promise(res => { try { port.close(()=>res()); } catch(_) { res(); } }); } catch(_) {}
  }
  // 開新埠
  port = await safeOpen(PORT_PATH);
}

// ====== 主流程（可在切換埠後持續運行） ======
async function main() {
  console.log(`RFID 多標籤掃描（Ctrl+C 結束）`);
  if (process.env.BLACKLIST) console.log(`[BL] 來自環境變數的黑名單：${process.env.BLACKLIST}`);
  console.log(`[BL] 黑名單共 ${BLACKLIST.size} 筆`);
  PORT_PATH = await pickPort(PORT_PATH);
  port = await safeOpen(PORT_PATH);

  running = true;
  const loop = async () => {
    if (!running) return;
    try {
      const epcs = await inventoryRound(port, WINDOW_MS);
      let arr = [...epcs].map(s => s.toUpperCase()).filter(epc => !BLACKLIST.has(epc));
      if (arr.length > 0) {
        arr = arr.sort();
        health.ok++;
        console.log(`[Round ${roundId}] 共 ${arr.length} 張（已排除黑名單）： ${arr.join(', ')}`);
        wsBroadcast({ epcs: arr, round: roundId, ts: Date.now() });
      } else {
        if (epcs.size > 0) { health.blkOnly++; console.log(`[Round ${roundId}] 全部在黑名單內，已忽略`); }
        else { health.empty++; console.log(`[Round ${roundId}] 未偵測到標籤`); }
      }
      roundId += 1;
      setTimeout(loop, 200);
    } catch (e) {
      console.error('Loop error:', e);
      setTimeout(loop, 500);
    }
  };
  loop();

  // 健康輸出
  setInterval(() => {
    console.log(`[HEALTH] ${new Date().toISOString()} | OK=${health.ok} EMPTY=${health.empty} BLK_ONLY=${health.blkOnly} | WS=${wss? wss.clients.size:0} | PORT=${PORT_PATH}`);
  }, 60_000);

  // 安全收尾
  process.on('SIGINT', async () => {
    running = false;
    try { port && port.close(); } catch(_) {}
    if (server) server.close();
    console.log(os.EOL + '已關閉連線');
    process.exit(0);
  });
  process.on('uncaughtException', (err) => console.error('[FATAL] Uncaught:', err));
  process.on('unhandledRejection', (r) => console.error('[FATAL] UnhandledRejection:', r));
}

main().catch((e) => { console.error('啟動失敗：', e); process.exit(1); });
