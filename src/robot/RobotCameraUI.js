/**
 * 真机相机预览：工具栏「相机」按钮 + 倒三角相机菜单 + 悬浮预览窗口。
 *
 * 数据来自 RobotBridgeClient：
 *  - 相机清单：welcome.cameras / `cameras` 消息（TienKung Dex 桥接扩展）
 *  - 视频帧：订阅后由 `camera_frame` 推送（JPEG base64）
 *
 * 可用性判定（相机未启动时菜单灰显、预览黑屏提示）：
 *  - 打开菜单时对未预览的相机做一次 1 fps 短探测，1.5s 内无帧即标记为不可用；
 *  - 预览订阅后 2.5s 内无首帧同样标记；之后若恢复出帧会自动解除灰显并正常显示。
 */

const CAMERA_FPS = 10;
const FIRST_FRAME_TIMEOUT_MS = 2500;
const PROBE_TIMEOUT_MS = 1500;
const PROBE_INTERVAL_MS = 5000;

const CAMERA_LABELS = {
    head: '头部相机',
    waist: '腰部相机',
    wrist_left: '左腕相机',
    wrist_right: '右腕相机',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RobotCameraUI {
    /**
     * @param {object} deps
     * @param {object} deps.client RobotBridgeClient 实例
     * @param {(level:string, message:string) => void} [deps.log] 日志回调
     */
    constructor({ client, log = () => {} }) {
        this.client = client;
        this.log = log;

        this.cameras = [];
        this.selected = null;
        this.connected = false;
        this.visible = false;

        /** cameraId -> true（有帧）/ false（无帧）/ undefined（未知） */
        this.availability = new Map();

        this._subscribedCamera = null;
        this._watchdog = null;
        this._probing = false;
        this._lastProbeAt = 0;
        this._probePromise = null;

        this._button = null;
        this._caret = null;
        this._menu = null;
        this._panel = null;
        this._img = null;
        this._overlay = null;
        this._overlayTitle = null;
        this._overlayDetail = null;
        this._titleEl = null;
        this._fpsEl = null;
        this._frames = 0;
        this._fpsAt = 0;

        this._init();
    }

    _init() {
        this.client.onCameras = (msg) => this.setCameras(msg.cameras || []);
        this.client.onCameraFrame = (msg) => this._onFrame(msg);

        this._button = document.getElementById('toggle-camera-preview-btn');
        this._caret = document.getElementById('camera-menu-btn');
        if (!this._button || !this._caret) return;

        this._button.addEventListener('click', () => this.toggle());
        this._caret.addEventListener('click', (event) => {
            event.stopPropagation();
            if (this._menu && !this._menu.hidden) this._closeMenu();
            else this._openMenu();
        });

        document.addEventListener('click', (event) => {
            if (!this._menu || this._menu.hidden) return;
            if (this._menu.contains(event.target) || event.target === this._caret) return;
            this._closeMenu();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') this._closeMenu();
        });
    }

    // ---------- 连接 / 清单 ----------

    setConnected(connected, cameras = null) {
        this.connected = Boolean(connected);
        if (!this.connected) {
            this.hide();
            this.cameras = [];
            this.selected = null;
            this.availability.clear();
            this._closeMenu();
            this._updateButton();
            return;
        }
        // Dex 桥接的 welcome 自带 cameras；Node 桥接没有相机通道，按空清单处理
        this.setCameras(Array.isArray(cameras) ? cameras : []);
    }

    setCameras(cameras) {
        this.cameras = (cameras || []).filter((camera) => camera && camera.id);

        const known = new Set(this.cameras.map((camera) => camera.id));
        for (const id of [...this.availability.keys()]) {
            if (!known.has(id)) this.availability.delete(id);
        }

        if (!this.cameras.length) {
            this.selected = null;
            this.hide();
        } else if (!this.selected || !this.cameras.some((camera) => camera.id === this.selected)) {
            this.selected = this.cameras[0].id;
        }

        if (this.visible && this.cameras.length) this._subscribe();
        this._updatePanelTitle();
        if (this._menu && !this._menu.hidden) this._renderMenu();
    }

    // ---------- 预览开关 ----------

    toggle() {
        if (this.visible) this.hide();
        else this.show();
    }

    show() {
        if (!this.connected) {
            this.log('error', '请先连接机器人，再预览相机。');
            return;
        }
        if (!this.cameras.length) {
            this.log('warning', '当前设备没有可用相机（Node 桥接不支持相机通道）。');
            return;
        }
        if (!this.selected) this.selected = this.cameras[0].id;

        // 已选中但已知无信号时，优先切到其他可用相机
        if (this.availability.get(this.selected) === false) {
            const usable = this.cameras.find((camera) => this.availability.get(camera.id) !== false);
            if (usable) this.selected = usable.id;
        }

        this.visible = true;
        this._ensurePanel();
        this._panel.hidden = false;
        this._updatePanelTitle();
        this._subscribe();
        this._updateButton();
    }

    hide() {
        this.visible = false;
        this._unsubscribe();
        clearTimeout(this._watchdog);
        this._watchdog = null;
        if (this._panel) {
            this._panel.hidden = true;
            if (this._img) this._img.removeAttribute('src');
        }
        this._hideOverlay();
        this._updateButton();
    }

    select(cameraId) {
        if (!cameraId || cameraId === this.selected) return;
        if (this.availability.get(cameraId) === false) return;
        this.selected = cameraId;
        this._frames = 0;
        this._fpsAt = 0;
        if (this._fpsEl) this._fpsEl.textContent = '--';
        this._updatePanelTitle();
        if (this.visible) this._subscribe();
    }

    // ---------- 订阅 ----------

    _subscribe() {
        const camera = this.selected;
        if (!camera || this._subscribedCamera === camera) return;
        Promise.resolve(this._resubscribe(camera)).catch((err) => {
            this.log('error', `相机订阅失败：${err?.message || err}`);
        });
    }

    async _resubscribe(camera) {
        // 探测用的临时订阅与预览共用同一个 WS token，必须等探测退订完成再订阅
        if (this._probePromise) {
            try { await this._probePromise; } catch { /* ignore */ }
        }
        await this._unsubscribe();
        if (!this.visible || this.selected !== camera) return;

        this._subscribedCamera = camera;
        this._frames = 0;
        this._fpsAt = 0;
        if (this._fpsEl) this._fpsEl.textContent = '--';

        if (this.availability.get(camera) === false) {
            this._showOverlay('相机无信号', `${this._label(camera)} 未启动或暂无图像`);
        } else {
            this._showOverlay('等待画面…', `正在订阅 ${this._label(camera)}`);
        }

        const ack = await this.client.subscribeCamera(camera, CAMERA_FPS);
        if (this._subscribedCamera !== camera) return;

        if (ack?.accepted) {
            this._armWatchdog(camera);
            this.log('system', `相机预览：${this._label(camera)}（${ack.transport || 'raw'}）`);
        } else {
            this._subscribedCamera = null;
            this.availability.set(camera, false);
            this._showOverlay('相机无信号', ack?.reason || '订阅失败');
            this.log('warning', `相机订阅失败：${this._label(camera)} ${ack?.reason || '未知原因'}`);
        }
    }

    async _unsubscribe() {
        clearTimeout(this._watchdog);
        this._watchdog = null;
        const camera = this._subscribedCamera;
        this._subscribedCamera = null;
        if (!camera) return;
        try {
            await this.client.unsubscribeCamera(camera);
        } catch { /* 断线时忽略 */ }
    }

    /** 订阅后若迟迟没有首帧，判定该路相机未启动。 */
    _armWatchdog(camera) {
        clearTimeout(this._watchdog);
        this._watchdog = setTimeout(() => {
            this._watchdog = null;
            if (this._subscribedCamera !== camera) return;
            if (this.availability.get(camera) === true) return;

            this.availability.set(camera, false);
            this._showOverlay('相机无信号', `${this._label(camera)} 未启动或暂无图像`);
            if (this._menu && !this._menu.hidden) this._renderMenu();
        }, FIRST_FRAME_TIMEOUT_MS);
    }

    _onFrame(msg) {
        if (!msg?.data) return;
        this.availability.set(msg.camera, true);

        // 探测帧只更新可用性，不显示
        if (msg.camera !== this.selected || !this.visible) return;

        clearTimeout(this._watchdog);
        this._watchdog = null;
        this._hideOverlay();
        if (this._img) this._img.src = `data:image/jpeg;base64,${msg.data}`;

        this._frames += 1;
        const now = performance.now();
        if (!this._fpsAt) this._fpsAt = now;
        if (now - this._fpsAt >= 1000) {
            const fps = (this._frames * 1000) / (now - this._fpsAt);
            if (this._fpsEl) {
                this._fpsEl.textContent = `${fps.toFixed(1)} fps · ${msg.width}×${msg.height}`;
            }
            this._frames = 0;
            this._fpsAt = now;
        }
    }

    // ---------- 相机可用性探测 ----------

    async _probeAll() {
        try {
            await this._probeAllInner();
        } catch (err) {
            this.log('warning', `相机可用性探测失败：${err?.message || err}`);
        } finally {
            // 必须无条件复位：否则任何一次异常都会让后续探测永久停摆（菜单一直"检测中"）
            this._probing = false;
            this._probePromise = null;
        }
    }

    async _probeAllInner() {
        if (this._probing) return;
        if (Date.now() - this._lastProbeAt < PROBE_INTERVAL_MS) return;

        // 正在预览的那一路不重复探测：同一个 WS token 会覆盖预览订阅
        const targets = this.cameras
            .map((camera) => camera.id)
            .filter((id) => !(this.visible && id === this.selected));
        if (!targets.length) return;

        this._probing = true;
        this._lastProbeAt = Date.now();
        for (const id of targets) this.availability.delete(id);
        this._renderMenu();

        try {
            // 探针与预览走同一套 camera_subscribe（1fps）/camera_unsubscribe 协议。
            // 必须串行：客户端按消息类型配对 ack，并发请求会互相覆盖导致假超时。
            for (const id of targets) {
                const ack = await this.client.subscribeCamera(id, 1);
                if (!ack?.accepted) this.availability.set(id, false);
            }
            await delay(PROBE_TIMEOUT_MS);
        } finally {
            for (const id of targets) {
                try { await this.client.unsubscribeCamera(id); } catch { /* 断线时忽略 */ }
            }
        }

        for (const id of targets) {
            if (this.availability.get(id) !== true) this.availability.set(id, false);
        }
        this._renderMenu();
    }

    // ---------- 菜单 ----------

    _ensureMenu() {
        if (this._menu) return this._menu;

        const menu = document.createElement('div');
        menu.className = 'joint-axes-menu camera-menu';
        menu.hidden = true;

        const head = document.createElement('div');
        head.className = 'joint-axes-menu-head';
        const title = document.createElement('span');
        title.textContent = '相机预览话题';
        head.appendChild(title);

        const list = document.createElement('div');
        list.className = 'joint-axes-menu-list camera-menu-list';

        menu.append(head, list);
        menu.addEventListener('click', (event) => event.stopPropagation());
        document.body.appendChild(menu);
        this._menu = menu;
        return menu;
    }

    _openMenu() {
        if (!this.connected) {
            this.log('error', '请先连接机器人，再选择相机。');
            return;
        }
        const menu = this._ensureMenu();
        this._renderMenu();
        menu.hidden = false;
        this._caret.setAttribute('aria-expanded', 'true');

        const rect = this._caret.getBoundingClientRect();
        const width = menu.offsetWidth || 240;
        const height = menu.offsetHeight || 180;
        const left = Math.min(
            Math.max(8, rect.right - width),
            Math.max(8, window.innerWidth - width - 8)
        );
        const below = rect.bottom + 8;
        const top = below + height <= window.innerHeight - 8
            ? below
            : Math.max(8, rect.top - height - 8);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        this._probePromise = this._probeAll();
    }

    _closeMenu() {
        if (this._menu) this._menu.hidden = true;
        this._caret?.setAttribute('aria-expanded', 'false');
    }

    _renderMenu() {
        if (!this._menu) return;
        const list = this._menu.querySelector('.camera-menu-list');
        list.innerHTML = '';

        if (!this.cameras.length) {
            const empty = document.createElement('div');
            empty.className = 'camera-menu-empty';
            empty.textContent = '当前设备没有可用相机';
            list.appendChild(empty);
            return;
        }

        for (const camera of this.cameras) {
            const state = this.availability.get(camera.id);
            const unavailable = state === false;
            const pending = this._probing && state === undefined;

            const item = document.createElement('button');
            item.type = 'button';
            item.className = [
                'camera-menu-item',
                camera.id === this.selected ? 'active' : '',
                unavailable ? 'unavailable' : '',
            ].filter(Boolean).join(' ');
            item.disabled = unavailable;
            item.title = unavailable ? '相机未启动或暂无图像' : `预览 ${this._label(camera.id)}`;

            const name = document.createElement('span');
            name.textContent = this._label(camera.id);

            const tag = document.createElement('span');
            tag.className = 'camera-menu-tag';
            tag.textContent = unavailable
                ? '未启动'
                : pending
                    ? '检测中…'
                    : (camera.transport || camera.id);

            item.append(name, tag);
            item.addEventListener('click', () => {
                this.select(camera.id);
                this._closeMenu();
            });
            list.appendChild(item);
        }
    }

    // ---------- 预览窗口 ----------

    _ensurePanel() {
        if (this._panel) return;

        const panel = document.createElement('div');
        panel.className = 'robot-camera-panel';
        panel.hidden = true;

        const head = document.createElement('div');
        head.className = 'robot-camera-head';
        const title = document.createElement('span');
        title.className = 'robot-camera-title';
        title.textContent = '相机预览';
        const fps = document.createElement('span');
        fps.className = 'robot-camera-fps';
        fps.textContent = '--';
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'robot-camera-close';
        close.title = '关闭预览';
        close.textContent = '×';
        head.append(title, fps, close);

        const body = document.createElement('div');
        body.className = 'robot-camera-body';
        const img = document.createElement('img');
        img.alt = '相机预览';
        const overlay = document.createElement('div');
        overlay.className = 'robot-camera-overlay';
        overlay.hidden = true;
        const overlayTitle = document.createElement('strong');
        const overlayDetail = document.createElement('span');
        overlay.append(overlayTitle, overlayDetail);
        body.append(img, overlay);

        panel.append(head, body);
        document.body.appendChild(panel);

        close.addEventListener('click', () => this.hide());
        this._panel = panel;
        this._img = img;
        this._overlay = overlay;
        this._overlayTitle = overlayTitle;
        this._overlayDetail = overlayDetail;
        this._titleEl = title;
        this._fpsEl = fps;
    }

    _showOverlay(title, detail = '') {
        if (!this._overlay) return;
        this._overlayTitle.textContent = title;
        this._overlayDetail.textContent = detail;
        this._overlay.hidden = false;
    }

    _hideOverlay() {
        if (this._overlay) this._overlay.hidden = true;
    }

    _updatePanelTitle() {
        if (!this._titleEl) return;
        this._titleEl.textContent = this.selected
            ? `相机预览 · ${this._label(this.selected)}`
            : '相机预览';
    }

    _updateButton() {
        if (!this._button) return;
        this._button.classList.toggle('active', this.visible);
        this._button.setAttribute('data-checked', String(this.visible));
        this._button.title = this.visible ? '关闭相机预览' : '预览真机相机画面';
    }

    _label(cameraId) {
        return CAMERA_LABELS[cameraId] || cameraId;
    }
}
