/* CH32 BLE UART: FFF1 notifies telemetry; FFF2 accepts F/B/L/R/S commands. */
const BLE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const BLE_NOTIFY_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
const BLE_WRITE_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
const HISTORY_KEY = 'car-environment-history-v2';
const THEME_KEY = 'car-dashboard-theme';
const MAX_HISTORY = 360;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const state = { history: loadHistory(), samples: 0, visiblePoints: 60, device: null, writeCharacteristic: null, buffer: '', paused: false, pressedKey: null };
const ids = ['connect-button', 'disconnect-button', 'pause-button', 'clear-button', 'export-button', 'theme-button', 'connection-dot', 'connection-text', 'temperature-value', 'humidity-value', 'temperature-note', 'humidity-note', 'updated-at', 'sample-count', 'range-title', 'trend-chart', 'chart-empty', 'drive-status', 'toast'];
const els = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function loadHistory() { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]').filter((item) => item && Number.isFinite(item.time) && Number.isFinite(item.temperature) && Number.isFinite(item.humidity)).slice(-MAX_HISTORY); } catch { return []; } }
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); }
function timeText(time) { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time); }
function relativeText(time) { const seconds = Math.max(0, Math.round((Date.now() - time) / 1000)); return seconds < 3 ? '刚刚更新' : `${seconds} 秒前更新`; }
function notify(message) { els.toast.textContent = message; els.toast.classList.add('show'); clearTimeout(notify.timer); notify.timer = setTimeout(() => els.toast.classList.remove('show'), 3200); }
function isConnected() { return Boolean(state.device?.gatt?.connected && state.writeCharacteristic); }

function applyTheme(theme) {
  const light = theme === 'light';
  document.body.classList.toggle('light', light);
  document.documentElement.style.setProperty('color-scheme', light ? 'light' : 'dark');
  document.querySelector('meta[name="theme-color"]').content = light ? '#edf3fa' : '#0a1627';
  els['theme-button'].textContent = light ? '☾ 深色' : '☀ 浅色';
  els['theme-button'].setAttribute('aria-label', light ? '切换深色模式' : '切换浅色模式');
  localStorage.setItem(THEME_KEY, theme); drawChart();
}

function setConnection(connected, label = '未连接') {
  els['connection-dot'].className = `status-dot${connected ? ' connected' : ''}`;
  els['connection-text'].textContent = label;
  els['connect-button'].disabled = connected;
  els['disconnect-button'].disabled = !connected;
  els['export-button'].disabled = state.history.length === 0;
  document.querySelectorAll('.drive-key').forEach((button) => { button.disabled = !connected; });
  els['drive-status'].textContent = connected ? '已连接，按住 W / A / S / D 即可控制小车' : '连接后可使用键盘或方向按钮控制小车';
}

function renderSummary() {
  const latest = state.history.at(-1);
  els['sample-count'].textContent = state.samples;
  els['export-button'].disabled = state.history.length === 0;
  els['chart-empty'].style.display = state.history.length ? 'none' : 'block';
  if (latest) {
    els['temperature-value'].textContent = latest.temperature.toFixed(2);
    els['humidity-value'].textContent = latest.humidity.toFixed(2);
    els['temperature-note'].textContent = `${relativeText(latest.time)} · SHT30 实测`;
    els['humidity-note'].textContent = `采样时间 ${timeText(latest.time)}`;
    els['updated-at'].textContent = state.paused ? '曲线已暂停，数据仍在接收' : `${relativeText(latest.time)} · 最后采样 ${timeText(latest.time)}`;
  } else {
    els['temperature-value'].textContent = '--'; els['humidity-value'].textContent = '--';
    els['temperature-note'].textContent = '等待传感器数据'; els['humidity-note'].textContent = '等待传感器数据';
    els['updated-at'].textContent = '等待连接小车';
  }
  drawChart();
}

function addSample(temperature, humidity) {
  if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || temperature < -45 || temperature > 130 || humidity < 0 || humidity > 100) return;
  state.samples += 1;
  if (!state.paused) { state.history.push({ time: Date.now(), temperature, humidity }); state.history = state.history.slice(-MAX_HISTORY); saveHistory(); }
  renderSummary();
}

function parseMessage(text) {
  state.buffer = (state.buffer + text).slice(-160);
  const pattern = /T\s*=\s*(-?\d+(?:\.\d+)?)\s*C\s*,\s*H\s*=\s*(\d+(?:\.\d+)?)\s*%/g;
  let match; let parsedEnd = 0;
  while ((match = pattern.exec(state.buffer))) { addSample(Number(match[1]), Number(match[2])); parsedEnd = pattern.lastIndex; }
  if (parsedEnd) state.buffer = state.buffer.slice(parsedEnd);
}

function onNotification(event) { parseMessage(decoder.decode(event.target.value)); }
function releaseDrive() { if (state.pressedKey) { state.pressedKey = null; sendCommand('S'); document.querySelectorAll('.drive-key').forEach((button) => button.classList.remove('active')); } }
function onDisconnected() { releaseDrive(); state.device = null; state.writeCharacteristic = null; setConnection(false); notify('蓝牙连接已断开，数据已保留。'); }

async function connect() {
  if (!navigator.bluetooth) { notify('当前浏览器不支持 Web Bluetooth，请使用 Chrome 或 Edge。'); return; }
  try {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [BLE_SERVICE_UUID] });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    const [notifyCharacteristic, writeCharacteristic] = await Promise.all([service.getCharacteristic(BLE_NOTIFY_UUID), service.getCharacteristic(BLE_WRITE_UUID)]);
    await notifyCharacteristic.startNotifications();
    notifyCharacteristic.addEventListener('characteristicvaluechanged', onNotification);
    device.addEventListener('gattserverdisconnected', onDisconnected);
    state.device = device; state.writeCharacteristic = writeCharacteristic; state.samples = 0; state.buffer = '';
    setConnection(true, device.name || '小车已连接'); renderSummary(); notify('已连接，温湿度与控制功能已就绪。');
  } catch (error) {
    if (error.name !== 'NotFoundError') notify(`连接失败：${error.message || '请确认小车已开启且处于广播状态'}`);
  }
}
function disconnect() { releaseDrive(); if (state.device?.gatt?.connected) state.device.gatt.disconnect(); }

async function sendCommand(command) {
  if (!isConnected()) return;
  try {
    if (state.writeCharacteristic.writeValueWithoutResponse) await state.writeCharacteristic.writeValueWithoutResponse(encoder.encode(command));
    else await state.writeCharacteristic.writeValue(encoder.encode(command));
  } catch { notify('控制命令发送失败，连接可能已断开。'); }
}
function pressDrive(command, source) {
  if (!isConnected() || state.pressedKey === source) return;
  releaseDrive(); state.pressedKey = source; sendCommand(command);
  document.querySelector(`.drive-key[data-command="${command}"]`)?.classList.add('active');
}

function exportCsv() {
  if (!state.history.length) return;
  const rows = ['time,temperature_c,humidity_rh', ...state.history.map((item) => `${new Date(item.time).toISOString()},${item.temperature.toFixed(2)},${item.humidity.toFixed(2)}`)];
  const url = URL.createObjectURL(new Blob([`\uFEFF${rows.join('\n')}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `car-environment-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
}

function drawChart() {
  const canvas = els['trend-chart']; const box = canvas.getBoundingClientRect(); if (!box.width || !box.height) return;
  const style = getComputedStyle(document.body); const color = (name) => style.getPropertyValue(name).trim(); const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); const width = box.width; const height = box.height; const pad = { top: 15, right: 53, bottom: 38, left: 52 };
  const data = state.history.slice(-state.visiblePoints); const innerW = width - pad.left - pad.right; const innerH = height - pad.top - pad.bottom;
  ctx.clearRect(0, 0, width, height); ctx.font = '14px "Microsoft YaHei", sans-serif';
  if (!data.length) return;
  const scale = (values, minimum, limits) => { const low = Math.min(...values); const high = Math.max(...values); const delta = Math.max(high - low, minimum); return [Math.max(limits[0], low - delta * .25), Math.min(limits[1], high + delta * .25)]; };
  const [tempMin, tempMax] = scale(data.map((item) => item.temperature), 4, [-45, 130]); const [humMin, humMax] = scale(data.map((item) => item.humidity), 12, [0, 100]);
  for (let i = 0; i < 5; i += 1) { const y = pad.top + innerH * i / 4; ctx.strokeStyle = color('--border'); ctx.globalAlpha = .65; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke(); ctx.globalAlpha = 1; ctx.fillStyle = color('--subtle'); ctx.textAlign = 'right'; ctx.fillText((tempMax - (tempMax - tempMin) * i / 4).toFixed(1), pad.left - 10, y + 5); ctx.textAlign = 'left'; ctx.fillText((humMax - (humMax - humMin) * i / 4).toFixed(0), width - pad.right + 10, y + 5); }
  const pointX = (index) => pad.left + (data.length === 1 ? innerW / 2 : innerW * index / (data.length - 1)); const pointY = (value, min, max) => pad.top + innerH * (1 - (value - min) / (max - min));
  const drawLine = (key, min, max, stroke) => { ctx.strokeStyle = stroke; ctx.lineWidth = 2.2; ctx.beginPath(); data.forEach((item, index) => { const x = pointX(index); const y = pointY(item[key], min, max); index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); const last = data.at(-1); ctx.fillStyle = stroke; ctx.beginPath(); ctx.arc(pointX(data.length - 1), pointY(last[key], min, max), 4, 0, Math.PI * 2); ctx.fill(); };
  drawLine('temperature', tempMin, tempMax, color('--temperature')); drawLine('humidity', humMin, humMax, color('--humidity'));
  ctx.fillStyle = color('--subtle'); ctx.textAlign = 'center'; const labels = Math.min(5, data.length); for (let i = 0; i < labels; i += 1) { const index = Math.round(i * (data.length - 1) / Math.max(labels - 1, 1)); ctx.fillText(timeText(data[index].time), pointX(index), height - 10); }
}

els['connect-button'].addEventListener('click', connect); els['disconnect-button'].addEventListener('click', disconnect);
els['pause-button'].addEventListener('click', () => { state.paused = !state.paused; els['pause-button'].textContent = state.paused ? '继续曲线' : '暂停曲线'; renderSummary(); });
els['clear-button'].addEventListener('click', () => { state.history = []; state.samples = 0; localStorage.removeItem(HISTORY_KEY); renderSummary(); });
els['export-button'].addEventListener('click', exportCsv);
els['theme-button'].addEventListener('click', () => applyTheme(document.body.classList.contains('light') ? 'dark' : 'light'));
document.querySelectorAll('.range-button').forEach((button) => button.addEventListener('click', () => { state.visiblePoints = Number(button.dataset.range); els['range-title'].textContent = state.visiblePoints; document.querySelectorAll('.range-button').forEach((item) => item.classList.toggle('active', item === button)); drawChart(); }));
document.querySelectorAll('.drive-key').forEach((button) => { button.addEventListener('pointerdown', (event) => { event.preventDefault(); const command = button.dataset.command; command === 'S' ? sendCommand('S') : pressDrive(command, `button-${command}`); }); button.addEventListener('pointerup', releaseDrive); button.addEventListener('pointerleave', releaseDrive); button.addEventListener('pointercancel', releaseDrive); });
window.addEventListener('keydown', (event) => { if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return; const command = { w: 'F', a: 'L', s: 'B', d: 'R' }[event.key.toLowerCase()]; if (command) { event.preventDefault(); pressDrive(command, event.key.toLowerCase()); } });
window.addEventListener('keyup', (event) => { const key = event.key.toLowerCase(); if (['w', 'a', 's', 'd'].includes(key)) { event.preventDefault(); if (state.pressedKey === key) releaseDrive(); } });
window.addEventListener('blur', releaseDrive); document.addEventListener('visibilitychange', () => { if (document.hidden) releaseDrive(); }); window.addEventListener('resize', drawChart); setInterval(renderSummary, 1000);
applyTheme(localStorage.getItem(THEME_KEY) || 'dark'); setConnection(false); renderSummary();

