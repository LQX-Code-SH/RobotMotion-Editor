/**
 * 固件一键部署面板。
 *
 * 浏览器不直接连接机器人 SSH：表单（IP / 用户名 / 密码 / 固件类型 / 端口）
 * 提交给操作站 station.js，由 station 通过 SSH/SFTP 推送桥接固件并拉起服务，
 * 执行过程以 NDJSON 流式回传，逐行渲染到日志。
 *
 * 凭据约定：密码只在内存中用于本次请求，不写 localStorage、不写日志。
 */

const STORAGE = {
    host: 'robot-deploy-host',
    username: 'robot-deploy-username',
    sshPort: 'robot-deploy-ssh-port',
    // 固件类型与机型共用一个 key（"固件ID|机型"）：两者本来一一对应，
    // 分开存会在切换固件后出现机型残留，导致部署到错误的机型档案。
    selection: 'robot-deploy-selection',
    legacyFirmware: 'robot-deploy-firmware',
    legacyModel: 'robot-deploy-model',
    ports: 'robot-deploy-ports',
};

const PORT_KEYS = ['control', 'status', 'camera', 'beacon'];

export class RobotDeployUI {
    constructor({ connectionUI = null } = {}) {
        this.connectionUI = connectionUI;
        this.firmwares = [];
        this.busy = false;
        this._streaming = false;
    }

    init() {
        this._bind();
        this._restore();
        this._syncDeployHost();
        this.syncFromDevice();
        this._loadFirmwares();
    }

    // ---------- DOM ----------
    _el(id) {
        return document.getElementById(id);
    }

    _bind() {
        this._el('robot-deploy-preflight-btn')?.addEventListener('click', () => this.preflight());
        this._el('robot-deploy-install-btn')?.addEventListener('click', () => this.install());
        this._el('robot-deploy-start-btn')?.addEventListener('click', () => this.action('start'));
        this._el('robot-deploy-stop-btn')?.addEventListener('click', () => this.action('stop'));
        this._el('robot-deploy-status-btn')?.addEventListener('click', () => this.action('status'));
        this._el('robot-deploy-logs-btn')?.addEventListener('click', () => this.action('logs'));

        this._el('robot-deploy-firmware')?.addEventListener('change', () => {
            this._applyFirmwareDefaults();
            this._persist();
        });
        this._el('robot-deploy-model')?.addEventListener('change', () => this._persist());

        for (const id of ['robot-deploy-host', 'robot-deploy-username', 'robot-deploy-ssh-port']) {
            this._el(id)?.addEventListener('change', () => this._persist());
        }
        this._el('robot-deploy-host')?.addEventListener('input', (event) => {
            delete event.target.dataset.auto;
        });
        for (const key of PORT_KEYS) {
            const input = this._el(`robot-deploy-port-${key}`);
            input?.addEventListener('change', () => {
                input.dataset.dirty = '1';
                this._persist();
            });
        }

        // 展开面板时刷新固件清单（station 可能后启动）
        this._el('robot-deploy')?.addEventListener('toggle', (event) => {
            if (!event.target.open) return;
            this.syncFromDevice();
            if (!this.firmwares.length) this._loadFirmwares();
        });

        // 设备地址是机器人 IP 时，自动带入部署表单
        this._el('robot-device-address')?.addEventListener('change', () => this._syncDeployHost());
    }

    _syncDeployHost() {
        const hostInput = this._el('robot-deploy-host');
        const address = (this._el('robot-device-address')?.value || '').trim();
        if (!hostInput || !address || /^https?:\/\//i.test(address)) return;
        if (hostInput.value.trim() && hostInput.dataset.auto !== '1') return;
        hostInput.value = address.split(':')[0];
        hostInput.dataset.auto = '1';
        this._persist();
    }

    /**
     * 用「当前正在使用」的桥接端口作为部署端口默认值。
     *
     * 优先级：当前连接的桥接实际端口 > 上次用过的端口（_restore）> 固件默认值。
     * 端口一致是重装的前提——装完后网页仍按同一组端口重连。
     *
     * @param {object|null} device connectionUI.device（welcome payload）
     * @returns {boolean} 是否写入了端口
     */
    syncFromDevice(device = this.connectionUI?.device) {
        if (!device) return false;
        const live = {
            control: Number(device.wsPort ?? device.ports?.control),
            status: Number(device.statusPort ?? device.ports?.status),
            camera: Number(device.cameraPort ?? device.ports?.camera),
            beacon: Number(device.beaconPort ?? device.ports?.beacon),
        };
        if (!Number.isInteger(live.control) || live.control <= 0) return false;

        const applied = {};
        for (const key of PORT_KEYS) {
            const input = this._el(`robot-deploy-port-${key}`);
            if (!input) continue;
            const value = Number.isInteger(live[key]) && live[key] >= 0 ? live[key] : 0;
            // 当前实际端口就是默认值：记为 dirty，避免被固件默认值覆盖
            input.dataset.dirty = '1';
            if (String(input.value) === String(value)) continue;
            input.value = value;
            applied[key] = value;
        }
        if (Object.keys(applied).length) {
            this.appendLog('system', `已按当前真机桥接端口填入默认值：${Object.entries(applied)
                .map(([key, value]) => `${key}=${value}`).join(' ')}`);
            this._persist();
        }
        return true;
    }

    // ---------- 配置 ----------
    get stationUrl() {
        const fromConnection = this.connectionUI?.stationUrl;
        if (fromConnection) return fromConnection;

        const address = (this._el('robot-device-address')?.value || '').trim();
        if (/^https?:\/\//i.test(address)) return address.replace(/\/+$/, '');
        const host = window.location.hostname || 'localhost';
        return `http://${host}:8090`;
    }

    _form() {
        return {
            host: (this._el('robot-deploy-host')?.value || '').trim(),
            port: Number(this._el('robot-deploy-ssh-port')?.value || 22),
            username: (this._el('robot-deploy-username')?.value || '').trim(),
            password: this._el('robot-deploy-password')?.value || '',
            firmwareId: this._el('robot-deploy-firmware')?.value || '',
            model: this._el('robot-deploy-model')?.value || '',
            ports: {
                control: Number(this._el('robot-deploy-port-control')?.value || 0),
                status: Number(this._el('robot-deploy-port-status')?.value || 0),
                camera: Number(this._el('robot-deploy-port-camera')?.value || 0),
                beacon: Number(this._el('robot-deploy-port-beacon')?.value || 0),
            },
        };
    }

    _persist() {
        const form = this._form();
        try {
            localStorage.setItem(STORAGE.host, form.host);
            localStorage.setItem(STORAGE.username, form.username);
            localStorage.setItem(STORAGE.sshPort, String(form.port));
            localStorage.setItem(STORAGE.selection,
                form.model ? `${form.firmwareId}|${form.model}` : form.firmwareId);
            localStorage.setItem(STORAGE.ports, JSON.stringify(form.ports));
        } catch { /* ignore quota */ }
    }

    _restore() {
        try {
            const host = localStorage.getItem(STORAGE.host);
            const username = localStorage.getItem(STORAGE.username);
            const sshPort = localStorage.getItem(STORAGE.sshPort);
            const ports = JSON.parse(localStorage.getItem(STORAGE.ports) || 'null');

            if (host) this._el('robot-deploy-host').value = host;
            if (username) this._el('robot-deploy-username').value = username;
            if (sshPort) this._el('robot-deploy-ssh-port').value = sshPort;

            const selection = localStorage.getItem(STORAGE.selection)
                || [localStorage.getItem(STORAGE.legacyFirmware),
                    localStorage.getItem(STORAGE.legacyModel)].filter(Boolean).join('|');
            if (selection) {
                const [firmware, model] = selection.split('|');
                if (firmware) this._firmwarePreferred = firmware;
                if (model) this._modelPreferred = model;
            }

            if (ports) {
                for (const key of PORT_KEYS) {
                    const input = this._el(`robot-deploy-port-${key}`);
                    if (!input || !Number.isInteger(ports[key])) continue;
                    input.value = ports[key];
                    // 上次用过的端口就是默认值：不能被固件默认值覆盖
                    input.dataset.dirty = '1';
                }
            }
        } catch { /* ignore */ }
    }

    // ---------- 固件清单 ----------
    async _loadFirmwares() {
        if (!this.stationUrl) {
            this.appendLog('system', '等待 station 地址：请先填写"操作站网关"并启动 bridge/station.js。');
            return;
        }
        try {
            const res = await fetch(`${this.stationUrl}/api/deploy/firmwares`);
            const data = await res.json();
            if (!data.ok) throw new Error(data.error || 'firmwares 接口失败');
            this.firmwares = data.firmwares || [];
            this._renderFirmwares();
        } catch (err) {
            this.appendLog('error', `获取固件清单失败：${err.message}（确认 station 已启动，且地址可达）`);
        }
    }

    _renderFirmwares() {
        const select = this._el('robot-deploy-firmware');
        if (!select) return;
        const preferred = this._firmwarePreferred || select.value;
        select.innerHTML = this.firmwares
            .map(f => `<option value="${escapeAttr(f.id)}"${f.id === preferred ? ' selected' : ''}>${escapeHtml(f.label)}</option>`)
            .join('');
        this._applyFirmwareDefaults();
    }

    _applyFirmwareDefaults() {
        const firmware = this.firmwares.find(f => f.id === this._el('robot-deploy-firmware')?.value);
        if (!firmware) return;

        const modelSelect = this._el('robot-deploy-model');
        if (modelSelect) {
            const models = firmware.models || [firmware.model];
            modelSelect.innerHTML = models
                .map(m => `<option value="${escapeAttr(m)}"${m === (this._modelPreferred || firmware.model) ? ' selected' : ''}>${escapeHtml(m)}</option>`)
                .join('');
            const wrapper = this._el('robot-deploy-model-field');
            if (wrapper) wrapper.style.display = models.length > 1 ? '' : 'none';
        }

        // 端口：未手动改过则用固件默认值；不提供相机的固件把相机端口固定为 0（禁用）
        const defaults = firmware.ports || {};
        for (const key of PORT_KEYS) {
            const input = this._el(`robot-deploy-port-${key}`);
            if (!input || input.dataset.dirty) continue;
            if (key === 'camera' && firmware.supportsCamera === false) {
                input.value = 0;
                continue;
            }
            if (Number.isInteger(defaults[key])) input.value = defaults[key];
        }
        if (!firmware.supportsCamera) {
            this.appendLog('system', `固件 ${firmware.label} 不提供相机推流，相机端口不会监听。`);
        }
    }

    // ---------- 请求 ----------
    _requireStation() {
        if (!this.stationUrl) {
            this.appendLog('error', '请先填写操作站网关地址（station.js 的 HTTP 地址）。');
            return false;
        }
        return true;
    }

    _payload() {
        const form = this._form();
        if (!form.host) throw new Error('请填写机器人 IP');
        if (!form.username) throw new Error('请填写 SSH 用户名');
        if (!form.password) throw new Error('请填写登录密码');
        if (!form.firmwareId) throw new Error('请选择固件类型');
        return form;
    }

    _setBusy(busy) {
        this.busy = busy;
        for (const id of [
            'robot-deploy-preflight-btn', 'robot-deploy-install-btn',
            'robot-deploy-start-btn', 'robot-deploy-stop-btn',
            'robot-deploy-status-btn', 'robot-deploy-logs-btn',
        ]) {
            const button = this._el(id);
            if (button) button.disabled = busy;
        }
    }

    async preflight() {
        if (this.busy) return;
        if (!this._requireStation()) return;
        let payload;
        try {
            payload = this._payload();
        } catch (err) {
            this.appendLog('error', err.message);
            return;
        }

        this._setBusy(true);
        this.appendLog('system', `预检 ${payload.username}@${payload.host}:${payload.port}…`);
        try {
            const res = await fetch(`${this.stationUrl}/api/deploy/preflight`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (data.error) {
                this.appendLog('error', `预检失败：${data.error}`);
                return;
            }
            for (const check of data.checks || []) {
                const level = check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warning' : 'system';
                this.appendLog(level, `[${check.status.toUpperCase()}] ${check.label}${check.detail ? '：' + check.detail : ''}`);
            }
            this.appendLog(data.ok ? 'system' : 'warning', data.ok ? '预检通过，可以一键安装。' : '预检存在阻塞项，请先处理后重试。');
        } catch (err) {
            this.appendLog('error', `预检请求失败：${err.message}`);
        } finally {
            this._setBusy(false);
        }
    }

    async install() {
        if (this.busy) return;
        if (!this._requireStation()) return;
        let payload;
        try {
            payload = this._payload();
        } catch (err) {
            this.appendLog('error', err.message);
            return;
        }

        this._setBusy(true);
        this._streaming = true;
        this.appendLog('system', `开始部署：${payload.firmwareId} → ${payload.username}@${payload.host}`);
        this.appendLog('system', `端口 控制=${payload.ports.control} 状态=${payload.ports.status} 相机=${payload.ports.camera} 发现=${payload.ports.beacon}`);

        try {
            const res = await fetch(`${this.stationUrl}/api/deploy/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                throw new Error(`station 返回 ${res.status} ${text.slice(0, 200)}`);
            }
            await this._consumeNdjson(res.body);
        } catch (err) {
            this.appendLog('error', `部署中断：${err.message}`);
        } finally {
            this._streaming = false;
            this._setBusy(false);
        }
    }

    async _consumeNdjson(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let result = null;

        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index;
            while ((index = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (!line) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    this.appendLog('system', line);
                    continue;
                }
                result = this._handleEvent(event) || result;
            }
        }

        if (buffer.trim()) {
            try {
                this._handleEvent(JSON.parse(buffer.trim()));
            } catch { /* ignore partial */ }
        }

        if (result?.ok) {
            this.appendLog('system', `部署完成：控制 ${result.directUrls?.control || '-'}`);
            this.appendLog('system', '桥接已启动，可回到上方点“连接”接入该设备。');
            this._el('robot-deploy-password').value = '';
        }
    }

    _handleEvent(event) {
        if (event.type === 'step') {
            const level = event.status === 'fail' ? 'error' : event.status === 'warn' ? 'warning' : 'system';
            const suffix = event.message ? `：${event.message}` : '';
            this.appendLog(level, `${event.label || event.id} … ${event.status}${suffix}`);
            return null;
        }
        if (event.type === 'log') {
            this.appendLog('system', event.message);
            return null;
        }
        if (event.type === 'error') {
            this.appendLog('error', event.message);
            return null;
        }
        if (event.type === 'result') {
            const data = event.data || {};
            this.appendLog('system', `固件：${data.firmwareLabel || data.firmware} · 机型 ${data.model}`);
            this.appendLog('system', `远端目录：${data.baseDir}`);
            const urls = data.directUrls || {};
            for (const [name, url] of Object.entries(urls)) {
                if (url) this.appendLog('system', `${name} 通道：${url}`);
            }
            if (data.logTail) {
                for (const line of String(data.logTail).split('\n').slice(-10)) {
                    if (line.trim()) this.appendLog('system', `  ${line}`);
                }
            }
            return data;
        }
        return null;
    }

    async action(name) {
        if (this.busy) return;
        if (!this._requireStation()) return;
        let payload;
        try {
            payload = this._payload();
        } catch (err) {
            this.appendLog('error', err.message);
            return;
        }

        this._setBusy(true);
        this.appendLog('system', `执行 ${name}…`);
        try {
            const res = await fetch(`${this.stationUrl}/api/deploy/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, action: name }),
            });
            const data = await res.json();
            if (!data.ok) {
                this.appendLog('error', `${name} 失败：${data.error || '未知原因'}`);
                return;
            }
            if (name === 'status') {
                this.appendLog(data.running ? 'system' : 'warning', data.running ? '桥接运行中' : '桥接未运行');
                for (const [port, ok] of Object.entries(data.ports || {})) {
                    this.appendLog(ok ? 'system' : 'warning', `端口 ${port}：${ok ? '可连接' : '未就绪'}`);
                }
            } else if (name === 'logs') {
                for (const line of String(data.log || '').split('\n')) {
                    if (line.trim()) this.appendLog('system', line);
                }
            } else {
                this.appendLog('system', data.message || `${name} 完成`);
            }
            if (data.logTail) {
                this.appendLog('system', '--- 最近日志 ---');
                for (const line of String(data.logTail).split('\n').slice(-8)) {
                    if (line.trim()) this.appendLog('system', `  ${line}`);
                }
            }
            if (name === 'start' || name === 'restart') {
                this.appendLog('system', '可在上方点“连接”接入该设备。');
            }
        } catch (err) {
            this.appendLog('error', `${name} 请求失败：${err.message}`);
        } finally {
            this._setBusy(false);
        }
    }

    // ---------- 日志 ----------
    appendLog(level, message) {
        const logEl = this._el('robot-deploy-log');
        const time = new Date().toLocaleTimeString();
        const line = document.createElement('div');
        line.className = `robot-log-line robot-log-${level}`;
        line.innerHTML = `<span class="robot-log-time">${time}</span>${escapeHtml(message)}`;
        if (logEl) {
            logEl.appendChild(line);
            while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstElementChild);
            logEl.scrollTop = logEl.scrollHeight;
        }
        console.log(`[deploy:${level}] ${message}`);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#39;');
}
